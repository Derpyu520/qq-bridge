/**
 * 主动聊天引擎（任务书 §2 主流程 / §5 状态机 / §7 默认参数）。
 *
 * 一句话：**每 60 秒只看本地状态，不碰 AI。** 只有硬门槛全过、评分够线、
 * 且拿到一条独占的 trigger，才会去生成一句话。
 *
 * 阶段 1+2 的能力边界（这一版交付的）：
 *   - 用户/渠道/话题/状态/触发都能存能查能改
 *   - tick 判定完整可用，dry-run 会给出「为什么这次不发」的完整理由
 *   - 生成与投递留了两个注入点（generate / deliver），阶段 3 接上它们即可
 *   - 没有注入 generate 时，判定到 candidate 也只记一条 `no-generator`，绝不瞎发
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_POLICY,
  decide,
  dayKeyOf,
  normalizePolicy,
  BLOCK,
} from './policy.mjs';
import { createTopicManager } from './topic-manager.mjs';
import { createTriggerManager, TRIGGER_TYPE } from './trigger-manager.mjs';

/** dry-run 报告最多留这么多条，防止内存无限涨。 */
/** 等回复的超时上限：比一轮正常回合长得多，又不至于把会话永远挂住。 */
const TURN_TIMEOUT_MS = 180_000;

/**
 * 只跟踪一个 turn 的精简收集器。
 * 结构与 dsh-client 的 createTurnCollector 一致（assistant/chunk 必须忽略，
 * 否则同一段话会被 assistant/message 再算一遍，回复翻倍）。
 */
function createTurnWaiter() {
  let text = '';
  let started = false;
  // 这一轮最后一次上报的用量。多个 chunk 都可能带 usage，取最后那个（同一次调用的终值）。
  let usage = null;
  return {
    push(event) {
      if (!event) return null;
      if (event.data?.usage && typeof event.data.usage === 'object') usage = event.data.usage;
      if (event.type === 'turn/start') {
        started = true;
        return null;
      }
      if (event.type === 'assistant/chunk') return null;
      if (event.type === 'assistant/message') {
        if (!started) return null;
        for (const block of event.data?.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        if (!started) return null;
        return { reason: event.data?.reason, text, usage };
      }
      return null;
    },
  };
}

const MAX_REPORTS = 30;

/**
 * @param {object} deps
 * @param {object} deps.store                  createProactiveStore 的返回值
 * @param {object} [deps.config]                socialV2.proactiveEngine 段
 * @param {(msg: string, ...rest: any[]) => void} [deps.log]
 * @param {string} [deps.timeZone]             用户 IANA 时区
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.idFactory]
 * @param {(ctx: object) => Promise<{text: string} | {error: string}>} [deps.generate]  阶段 3
 * @param {(ctx: object) => Promise<{ok: boolean, error?: string}>} [deps.deliver]      阶段 3
 * @param {(userId: string, sessionId: string) => boolean} [deps.isBusy]
 */
export function createProactiveEngine(deps = {}) {
  const { store, log = () => {} } = deps;
  if (!store) throw new Error('createProactiveEngine 需要 store');

  const now = deps.now ?? Date.now;
  const idFactory = deps.idFactory ?? randomUUID;
  // 抽签用的随机源。测试要可预测，所以留了注入点。
  const random = typeof deps.random === 'function' ? deps.random : Math.random;
  const timeZone = deps.timeZone || 'Asia/Shanghai';

  let config = {
    enabled: false,
    dryRun: true,
    ...deps.config,
  };
  let policy = normalizePolicy(deps.config?.policy ?? deps.config ?? {}, DEFAULT_POLICY);

  const topics = createTopicManager({ store, now, idFactory });
  const triggers = createTriggerManager({ store, now, idFactory });

  /** dry-run 的观察记录。同一（用户+话题）只在结论变化时留新的一条。 */
  const reports = [];
  const reportSignatures = new Map();
  /** 上一次 tick 的完整结果，面板直接读它。 */
  let lastTick = null;
  let inFlight = false;
  const waiting = new Map(); // sessionId -> 我们正等着的那一轮
  let timer = null;
  let lastError = null;

  function effectiveConfig(patch) {
    if (!patch || typeof patch !== 'object') return config;
    config = { ...config, ...patch };
    policy = normalizePolicy({ ...policy, ...(patch.policy ?? patch) }, DEFAULT_POLICY);
    return config;
  }

  function rememberReport(entry) {
    const signature = `${entry.userId}|${entry.topicId ?? '-'}|${entry.decision}|${entry.blocked.join(',')}|${entry.score}`;
    const seen = reportSignatures.get(signature);
    if (seen != null) return false;
    reportSignatures.set(signature, now());
    reports.unshift({ ...entry, at: now() });
    if (reports.length > MAX_REPORTS) {
      const dropped = reports.pop();
      if (dropped) {
        const key = `${dropped.userId}|${dropped.topicId ?? '-'}|${dropped.decision}|${dropped.blocked.join(',')}|${dropped.score}`;
        reportSignatures.delete(key);
      }
    }
    return true;
  }

  /**
   * 一次调度。返回报告对象，任何情况下都不抛。
   *
   * 注意 §3：这里**不许**出现任何 sessions.prompt 调用。
   */
  async function tick() {
    if (inFlight) return { skipped: 'in-flight' };
    if (!config.enabled) {
      lastTick = { at: now(), skipped: 'disabled', userIds: 0, candidates: 0, suppressed: 0 };
      return lastTick;
    }
    inFlight = true;
    // 上一轮（或上一个进程）生成完却没投出去的，先补上再说
    await drainDeliveries();
    const startedAt = now();
    const result = { at: startedAt, skipped: null, userIds: 0, candidates: 0, merged: 0, suppressed: 0, generated: 0, calls: 0, skippedProb: 0, details: [] };
    try {
      topics.sweep();
      triggers.releaseStale();

      const scopes = store.listScopes();
      result.userIds = scopes.length;

      for (const scope of scopes) {
        const userId = scope.userId;
        store.ensureState(userId, startedAt);
        const state = store.getState(userId);
        const dayKey = dayKeyOf(startedAt, timeZone);
        store.rollDay(userId, dayKey, startedAt);

        // 1) 把到期话题排进候选（重复的会被 triggerKey 吃掉）
        const dueTopics = topics.due(userId);
        for (const topic of dueTopics) {
          const { created, triggerKey } = triggers.enqueueTopic({ userId, topic });
          if (created) log(`主动聊天：话题到期排入候选 ${triggerKey}`);
        }

        // 2) 领候选来判。事件合并：同一个人的多个候选只处理一个最高分的，
        //    其余的标记合并掉，避免短时间内连着触发多次 AI 请求（省 token 第 2 条）。
        const candidates = store.listCandidates({ userId, now: startedAt, limit: 8 });
        if (!candidates.length) continue;
        const best = candidates[0];
        if (candidates.length > 1) {
          for (const extra of candidates.slice(1)) {
            triggers.transition(extra.id, 'suppressed', { note: `merged-into:${best.id}` });
          }
          result.merged += candidates.length - 1;
          result.suppressed += candidates.length - 1;
          log(`主动聊天：合并 ${candidates.length} 个候选，只处理 ${best.triggerKey ?? best.id}`);
        }
        const claimed = store.claimTrigger({ id: best.id, now: startedAt, leaseMs: Math.max(30_000, policy.checkIntervalMs * 2) });
        if (!claimed) continue;

        const topic = claimed.topicId ? topics.get(claimed.topicId) : null;
        const verdict = decide({
          engineEnabled: config.enabled === true,
          state: store.getState(userId),
          scope,
          topic,
          now: startedAt,
          timeZone,
          policy,
          busy: deps.isBusy ? deps.isBusy(userId, scope.dshSessionId) === true : false,
        });

        const detail = {
          userId,
          triggerId: claimed.id,
          triggerKey: claimed.triggerKey,
          topicId: topic?.id,
          decision: verdict.decision,
          blocked: verdict.blocked,
          score: verdict.score,
          signals: verdict.signals,
          threshold: verdict.threshold,
        };

        if (verdict.decision === 'suppress') {
          result.suppressed += 1;
          triggers.transition(claimed.id, 'suppressed', {
            score: verdict.score,
            note: verdict.blocked.join(','),
          });
          detail.dryRun = true;
          const fresh = rememberReport(detail);
          if (fresh) log(`主动聊天：不打扰（${verdict.blocked.join(',') || '低分'}）${userId}`);
          result.details.push(detail);
          continue;
        }

        // 3) 通过了 —— 只有这里才允许花钱（调 AI）
        result.candidates += 1;
        detail.dryRun = config.dryRun !== false;

        if (detail.dryRun) {
          triggers.transition(claimed.id, 'candidate', { score: verdict.score, note: 'dry-run：判定通过但没发' });
          const fresh = rememberReport(detail);
          if (fresh) log(`主动聊天（dry-run）：可以发，但按配置只记录 ${userId} 分数 ${verdict.score}`);
          result.details.push(detail);
          continue;
        }

        if (!deps.generate) {
          triggers.transition(claimed.id, 'retry_wait', { score: verdict.score, note: BLOCK.noSession + ':no-generator' });
          detail.blocked = ['no-generator'];
          rememberReport(detail);
          result.details.push(detail);
          continue;
        }

        // 4) 概率抽签：分数够了，不等于这一次就要开口。
        //    sendProbability=1 时这里整段跳过（老行为一个字节都不变）；
        //    中间值每次机会独立抽一次，抽不中不花额度、不动配额，下次 tick 再抽。
        const chance = Number.isFinite(policy.sendProbability) ? policy.sendProbability : 1;
        if (chance < 1 && (chance <= 0 || random() >= chance)) {
          triggers.transition(claimed.id, 'retry_wait', { score: verdict.score, note: BLOCK.probability });
          detail.decision = 'skip';
          detail.blocked = [BLOCK.probability];
          result.skippedProb += 1;
          rememberReport(detail);
          result.details.push(detail);
          continue;
        }

        // 5) 生成 → outbox → 投递（阶段 3 接上）
        triggers.transition(claimed.id, 'generating', { score: verdict.score });
        const quotaDay = dayKeyOf(startedAt, timeZone);
        // 省 token 第 1 条：硬性调用预算。消息额度是「发出去几条」，
        // 调用额度是「问 AI 几次」——后者才是烧 token 的地方，先卡它。
        if (!store.reserveCallQuota(userId, quotaDay, policy.maxCallsPerDay, startedAt)) {
          triggers.transition(claimed.id, 'suppressed', { score: verdict.score, note: BLOCK.callLimit });
          detail.decision = 'suppress';
          detail.blocked = [BLOCK.callLimit];
          result.suppressed += 1;
          rememberReport(detail);
          result.details.push(detail);
          continue;
        }
        if (!store.reserveDailyQuota(userId, quotaDay, policy.maxPerDay, startedAt)) {
          store.releaseCallQuota(userId, startedAt);
          triggers.transition(claimed.id, 'suppressed', { score: verdict.score, note: BLOCK.dailyLimit });
          detail.decision = 'suppress';
          detail.blocked = [BLOCK.dailyLimit];
          result.suppressed += 1;
          rememberReport(detail);
          result.details.push(detail);
          continue;
        }

        try {
          // 省 token 第 3 条：上下文按需加载。默认只给话题摘要 + 最近几条，
          // 需要更多历史时由 AI 自己调工具去读（桥的 recent 接口有配额）。
          const recent = typeof deps.recentMessages === 'function'
            ? deps.recentMessages(userId, policy.contextMessages)
            : [];
          result.calls += 1;
          const generated = await deps.generate({
            userId,
            sessionId: scope.dshSessionId,
            topic,
            trigger: claimed,
            signals: verdict.signals,
            score: verdict.score,
            context: Array.isArray(recent) ? recent : [],
            contextLimit: policy.contextMessages,
          });
          if (!generated || typeof generated.text !== 'string' || !generated.text.trim()) {
            // 失败也花了钱：调用次数照记，token 用量有就记没有就 0。
            store.recordCallUsage({
              userId, dayKey: quotaDay, triggerId: claimed.id, ok: false,
              usage: generated?.usage ?? null, at: startedAt,
            });
            store.releaseDailyQuota(userId, quotaDay, startedAt);
            store.releaseCallQuota(userId, startedAt);
            triggers.transition(claimed.id, 'retry_wait', { note: `生成失败：${generated?.error ?? '空回复'}` });
            detail.blocked = ['generate-failed'];
            rememberReport(detail);
            result.details.push(detail);
            continue;
          }
          store.recordCallUsage({
            userId, dayKey: quotaDay, triggerId: claimed.id, ok: true,
            usage: generated.usage ?? null, at: startedAt,
          });
          store.markProactiveSent(userId, startedAt);
          result.generated += 1;
          detail.text = generated.text.slice(0, 200);

          // 落一条共享记录：QQ 与 DSH 面板看到的必须是**同一条**消息（任务书硬要求 ④），
          // 所以文本只在这里写一次，两个渠道只是它的两个 delivery。
          const channels = Array.isArray(generated.channels) && generated.channels.length
            ? generated.channels
            : ['qq'];
          const messageId = idFactory();
          store.addMessage({
            id: messageId,
            triggerId: claimed.id,
            userId,
            sessionId: scope.dshSessionId,
            text: generated.text,
            channels,
            now: startedAt,
          });
          for (const channel of channels) store.ensureDelivery({ messageId, channel, now: startedAt });
          triggers.transition(claimed.id, 'delivering', { note: '开始投递' });

          const outcomes = await deliverMessage({
            messageId,
            channels,
            userId,
            sessionId: scope.dshSessionId,
            targetId: scope.qqTargetId,
            topic,
            text: generated.text,
            triggerId: claimed.id,
          });
          detail.deliveries = outcomes;
          detail.delivered = outcomes.some((o) => o.ok);
          result.delivered = (result.delivered ?? 0) + outcomes.filter((o) => o.ok).length;
          triggers.transition(
            claimed.id,
            outcomes.every((o) => o.ok) ? 'completed' : 'partial_failure',
            { note: outcomes.map((o) => `${o.channel}:${o.ok ? 'ok' : o.error || 'failed'}`).join(',') },
          );
          result.details.push(detail);
        } catch (error) {
          store.releaseDailyQuota(userId, quotaDay, startedAt);
          lastError = String(error?.message ?? error);
          triggers.transition(claimed.id, 'retry_wait', { note: `生成异常：${lastError}` });
          log(`主动聊天：生成异常 ${lastError}`);
          result.details.push({ ...detail, blocked: ['generate-error'], error: lastError });
        }
      }
    } catch (error) {
      lastError = String(error?.message ?? error);
      log(`主动聊天：tick 异常 ${lastError}`);
      result.error = lastError;
    } finally {
      inFlight = false;
      result.durationMs = now() - startedAt;
      lastTick = result;
    }
    return result;
  }

  /**
   * 会话事件观察者：桥把每一条 session/event 都喂进来，这里只认「自己等着的那一轮」。
   * 返回 true 表示这个事件被本引擎认领（桥那边据此可以跳过转发）。
   *
   * 判断依据是 turn 事件自带的 sessionId，不是会话是否在我们表里 —— 主动聊天
   * 复用的是用户已有的会话，我们不拥有它，只能被动截胡自己发起的那一次。
   */
  function observe(sessionId, event) {
    const slot = waiting.get(sessionId);
    if (!slot) return false;
    const ended = slot.collector.push(event);
    if (!ended) return true;
    clearTimeout(slot.timer);
    waiting.delete(sessionId);
    slot.resolve(ended);
    return true;
  }

  /**
   * 等这一轮说完，拿到 assistant 的完整文本。
   * 同一个会话同时只允许一个等待者：桥是串行投递的，两轮叠在一起说明调用方写错了。
   */
  function expectTurn(sessionId, timeoutMs = TURN_TIMEOUT_MS) {
    if (!sessionId) return Promise.reject(new Error('没有会话，等不了回复'));
    const prev = waiting.get(sessionId);
    if (prev) {
      clearTimeout(prev.timer);
      waiting.delete(sessionId);
      prev.reject(new Error('上一轮还没结束就又要了一轮'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(sessionId);
        reject(new Error('等 DSH 回复超时'));
      }, timeoutMs);
      timer.unref?.();
      waiting.set(sessionId, { collector: createTurnWaiter(), resolve, reject, timer });
    });
  }

  /**
   * 逐渠道投递。每个渠道单独记账：QQ 发成功、DSH 面板失败时，下次只重试 DSH 那一行，
   * 不会把已经发出去的 QQ 消息再发一遍（任务书要求「QQ 成功 DSH 失败只重试 DSH」）。
   *
   * 没注入 deps.deliver 时：只把 delivery 留在 pending，绝不假装发过。
   */
  async function deliverMessage(ctx) {
    const outcomes = [];
    for (const channel of ctx.channels) {
      const stamp = now();
      if (!store.claimDelivery({ messageId: ctx.messageId, channel, now: stamp })) {
        outcomes.push({ channel, ok: false, error: 'claim-failed' });
        continue;
      }
      if (typeof deps.deliver !== 'function') {
        store.markDelivery({ messageId: ctx.messageId, channel, status: 'pending', now: stamp });
        outcomes.push({ channel, ok: false, error: 'no-deliverer' });
        continue;
      }
      try {
        const res = await deps.deliver({ ...ctx, channel });
        if (res?.ok) {
          store.markDelivery({
            messageId: ctx.messageId,
            channel,
            status: 'sent',
            externalMessageId: res.externalMessageId ?? null,
            now: now(),
          });
          outcomes.push({ channel, ok: true });
        } else {
          store.markDelivery({
            messageId: ctx.messageId,
            channel,
            status: 'retry_wait',
            lastError: res?.error ?? '投递失败',
            nextAttemptAt: now() + 60_000,
            now: now(),
          });
          outcomes.push({ channel, ok: false, error: res?.error ?? '投递失败' });
        }
      } catch (error) {
        const message = String(error?.message ?? error);
        store.markDelivery({
          messageId: ctx.messageId,
          channel,
          status: 'retry_wait',
          lastError: message,
          nextAttemptAt: now() + 60_000,
          now: now(),
        });
        outcomes.push({ channel, ok: false, error: message });
      }
    }
    return outcomes;
  }

  /**
   * 把「生成完了但没投完」的消息补上（进程重启、QQ 掉线都会留在这）。
   * 只在 tick 里做：不额外起定时器，避免和主调度抢。
   */
  async function drainDeliveries() {
    const pending = store.listPendingDeliveries({ now: now(), limit: 5 });
    if (!pending.length) return 0;
    let sent = 0;
    for (const row of pending) {
      const message = store.getMessage(row.messageId);
      if (!message) {
        store.markDelivery({ messageId: row.messageId, channel: row.channel, status: 'failed', lastError: '消息记录不见了', now: now() });
        continue;
      }
      const scope = store.getScope(message.userId);
      const [outcome] = await deliverMessage({
        messageId: message.id,
        channels: [row.channel],
        userId: message.userId,
        sessionId: message.sessionId,
        targetId: scope?.qqTargetId ?? '',
        topic: message.topicId ? topics.get(message.topicId) : null,
        text: message.text,
        triggerId: message.triggerId,
      });
      if (outcome?.ok) sent += 1;
    }
    if (sent) log(`主动聊天：补投 ${sent} 条`);
    return sent;
  }

  function start() {
    if (timer) return false;
    timer = setInterval(() => { void tick(); }, policy.checkIntervalMs);
    timer.unref?.();
    log(`主动聊天：调度已启动，每 ${Math.round(policy.checkIntervalMs / 1000)} 秒看一次${config.dryRun !== false ? '（dry-run）' : ''}`);
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  function status() {
    store.reconcileInflightDeliveries(now());
    const scopeUserId = store.listScopes()[0]?.userId ?? '';
    return {
      enabled: config.enabled === true,
      dryRun: config.dryRun !== false,
      running: timer != null,
      timeZone,
      policy: { ...policy },
      stats: store.stats(),
      today: store.statsToday(scopeUserId, dayKeyOf(now(), timeZone)),
      // 面板要的两块：今天这次的平均 token，和近 7 天趋势（老的在前）
      usage: store.usageStats({ dayKey: dayKeyOf(now(), timeZone) }),
      usageSeries: store.usageSeries({ days: 7, now: now(), timeZone }),
      awaiting: waiting.size,
      lastTick,
      lastError,
      reports: reports.slice(0, MAX_REPORTS),
      topics: [],
      triggers: triggers.list({ limit: 10 }),
      deliveries: store.listPendingDeliveries({ now: now(), limit: 10 }),
    };
  }

  return {
    tick,
    observe,
    expectTurn,
    start,
    stop,
    status,
    configure: effectiveConfig,
    topics,
    triggers,
    get policy() { return policy; },
    get config() { return config; },
    get running() { return timer != null; },
    store,
  };
}