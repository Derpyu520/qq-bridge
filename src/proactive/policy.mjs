/**
 * 主动聊天的判定策略 —— 纯函数，不许碰 IO、不许看时间以外的副作用。
 *
 * 任务书 §6 的分工必须严格守住：
 *   硬门槛（能不能）与评分（值不值）是两件事。
 *   硬门槛由本地状态决定，**不允许被分数抵消**：用户关了就是关了，
 *   到了安静时段就是安静，绝不会因为「这个话题 +35 分」就半夜发消息。
 *
 * 这里的每个函数都只接收已经查好的数据（state / 候选 / 现在几点），
 * 浏览器以外的环境也能直接测。
 */

/** 默认值全部来自任务书 §7，任何一项都可以被配置覆盖。 */
export const DEFAULT_POLICY = Object.freeze({
  checkIntervalMs: 60_000,
  idleThresholdMs: 30 * 60_000,
  minProactiveIntervalMs: 3 * 60 * 60_000,
  maxPerDay: 3,
  /** 每天最多让 AI 说几次。maxPerDay 管「发出去几条消息」，这个管「花几次钱」。 */
  maxCallsPerDay: 60,
  /**
   * 事件合并窗口：这段时间内陆续到期的话题，合并成一次生成。
   * 0 表示不合并（每个话题各问一次模型）——账单会随之翻倍，别轻易关。
   */
  mergeWindowMs: 5 * 60_000,
  /** 上下文按需加载：生成时只带最近几条相关消息（0 = 一条都不带）。 */
  contextMessages: 3,
  quietHours: Object.freeze({ start: '23:00', end: '08:00' }),
  scoreThreshold: 55,
});

/** 评分信号初值（任务书 §7 的表格）。 */
export const SCORE_SIGNALS = Object.freeze({
  topicDue: 35,
  topicActive: 25,
  idle: 15,
  contactedBefore: -40,
});

/** 硬门槛的拒绝原因，值会原样进日志与 dry-run 报告，改字面量前先想清楚。 */
export const BLOCK = Object.freeze({
  disabled: 'engine-disabled',
  userDisabled: 'user-disabled',
  paused: 'paused',
  quietHours: 'quiet-hours',
  dailyLimit: 'daily-limit',
  tooSoonAfterUser: 'recent-user-message',
  cooling: 'cooldown',
  noTopic: 'no-topic',
  topicClosed: 'topic-not-open',
  topicExpired: 'topic-expired',
  noSession: 'session-missing',
  noTarget: 'target-missing',
  busy: 'conversation-busy',
  callLimit: 'call-limit',
});

/** 把 'HH:mm' 解析成一天里的第几分钟；非法返回 null。 */
export function parseClock(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 把时间点换算成用户时区里的分钟数（0–1439）。时区坏了就按 UTC。 */
export function minutesOfDay(now, timeZone) {
  const at = new Date(now);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return (hour % 24) * 60 + minute;
}

/**
 * 是否落在安静时段。支持跨夜（23:00–08:00 就是 start > end 的那种）。
 * start === end 视为「没有安静时段」，而不是「全天安静」。
 */
export function isQuietHours(now, timeZone, quietHours) {
  const start = parseClock(quietHours?.start);
  const end = parseClock(quietHours?.end);
  if (start == null || end == null || start === end) return false;
  const at = minutesOfDay(now, timeZone);
  return start < end
    ? at >= start && at < end
    : at >= start || at < end;
}

/** 用户时区里的日期键，用于「每天最多 N 条」的跨日判断。 */
export function dayKeyOf(now, timeZone) {
  const at = new Date(now);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(at);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '00';
  const day = parts.find((p) => p.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}`;
}

/**
 * 硬门槛：返回所有拦下这次主动聊天的理由。
 * 顺序按「越根本越靠前」排，报告里看第一条就知道最要紧的原因。
 *
 * @param {object} input
 * @param {boolean} input.engineEnabled
 * @param {object|null} input.state        proactive_state 行
 * @param {object|null} input.scope        user_scope 行
 * @param {object|null} input.topic        候选话题（可以是 null）
 * @param {number} input.now
 * @param {string} input.timeZone
 * @param {object} input.policy            已合并好的策略
 * @param {boolean} [input.busy]           会话正在跑一轮
 */
export function checkHardGates(input) {
  const { engineEnabled, state, scope, topic, now, timeZone, policy, busy } = input;
  const blocked = [];

  if (!engineEnabled) blocked.push(BLOCK.disabled);
  if (!state) blocked.push(BLOCK.userDisabled);
  else {
    if (state.enabled === false) blocked.push(BLOCK.userDisabled);
    if (state.pausedUntil && state.pausedUntil > now) blocked.push(BLOCK.paused);
    if (state.lastUserMessageAt && now - state.lastUserMessageAt < policy.idleThresholdMs) {
      blocked.push(BLOCK.tooSoonAfterUser);
    }
    if (state.lastProactiveAt && now - state.lastProactiveAt < policy.minProactiveIntervalMs) {
      blocked.push(BLOCK.cooling);
    }
    if ((state.dailyCount ?? 0) >= policy.maxPerDay) blocked.push(BLOCK.dailyLimit);
  }

  if (isQuietHours(now, timeZone, policy.quietHours)) blocked.push(BLOCK.quietHours);
  if (busy) blocked.push(BLOCK.busy);

  if (!scope?.dshSessionId) blocked.push(BLOCK.noSession);
  if (!(scope?.enabledChannels ?? []).includes('qq') && !(scope?.enabledChannels ?? []).includes('dsh')) {
    blocked.push(BLOCK.noTarget);
  }
  if (scope?.enabledChannels?.includes('qq') && !scope?.qqTargetId) blocked.push(BLOCK.noTarget);

  if (!topic) blocked.push(BLOCK.noTopic);
  else {
    if (topic.status !== 'open') blocked.push(BLOCK.topicClosed);
    if (topic.expiresAt && topic.expiresAt <= now) blocked.push(BLOCK.topicExpired);
  }

  return { allowed: blocked.length === 0, blocked: [...new Set(blocked)] };
}

/**
 * 评分：只加不减硬门槛。返回明细，方便 dry-run 报告解释「为什么这条值 55 分」。
 *
 * @param {object} input
 * @param {object|null} input.topic
 * @param {object|null} input.state
 * @param {number} input.now
 * @param {object} input.policy
 */
export function scoreCandidate(input) {
  const { topic, state, now, policy } = input;
  const signals = [];

  if (topic?.followUpAt && topic.followUpAt <= now) signals.push(['话题到期', SCORE_SIGNALS.topicDue]);
  if (topic && topic.status === 'open') signals.push(['有有效话题', SCORE_SIGNALS.topicActive]);
  if (state?.lastUserMessageAt && now - state.lastUserMessageAt >= policy.idleThresholdMs) {
    signals.push(['达到空闲阈值', SCORE_SIGNALS.idle]);
  }
  if (state?.lastProactiveAt) signals.push(['以前主动联系过', SCORE_SIGNALS.contactedBefore]);

  const score = signals.reduce((sum, [, value]) => sum + value, 0);
  return { score, signals };
}

/**
 * 完整判定：硬门槛 → 评分 → 阈值。
 * 返回 decision：'suppress' 表示这一次不主动，'candidate' 表示可以往下走。
 */
export function decide(input) {
  const gates = checkHardGates(input);
  const scored = scoreCandidate(input);
  const threshold = Number.isFinite(input.policy?.scoreThreshold) ? input.policy.scoreThreshold : DEFAULT_POLICY.scoreThreshold;

  if (!gates.allowed) {
    return { decision: 'suppress', blocked: gates.blocked, score: scored.score, signals: scored.signals, threshold };
  }
  if (scored.score < threshold) {
    return { decision: 'suppress', blocked: ['score-below-threshold'], score: scored.score, signals: scored.signals, threshold };
  }
  return { decision: 'candidate', blocked: [], score: scored.score, signals: scored.signals, threshold };
}

/** 把配置里可能写歪的值收敛成可用策略。写歪了就用默认值，不抛错。 */
export function normalizePolicy(raw = {}, base = DEFAULT_POLICY) {
  const pickInt = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  const quiet = raw.quietHours && typeof raw.quietHours === 'object'
    ? {
      start: parseClock(raw.quietHours.start) == null ? base.quietHours.start : raw.quietHours.start,
      end: parseClock(raw.quietHours.end) == null ? base.quietHours.end : raw.quietHours.end,
    }
    : base.quietHours;

  return {
    checkIntervalMs: pickInt(raw.checkIntervalMs, base.checkIntervalMs, { min: 5_000, max: 3_600_000 }),
    idleThresholdMs: pickInt(raw.idleThresholdMs, base.idleThresholdMs, { min: 0, max: 7 * 86_400_000 }),
    minProactiveIntervalMs: pickInt(raw.minProactiveIntervalMs, base.minProactiveIntervalMs, { min: 0, max: 7 * 86_400_000 }),
    maxPerDay: pickInt(raw.maxPerDay, base.maxPerDay, { min: 0, max: 50 }),
    // 省 token 第 1 条：每日 AI 调用硬上限。和 maxPerDay 是两件事 ——
    // 一条消息重试几次就花几次调用，所以「发几条」与「花几次」分开记、分开管。
    maxCallsPerDay: pickInt(raw.maxCallsPerDay, base.maxCallsPerDay, { min: 0, max: 2000 }),
    // 省 token 第 2 条：同一批事件在这个窗口内合并成一次判断。
    mergeWindowMs: pickInt(raw.mergeWindowMs, base.mergeWindowMs, { min: 0, max: 86_400_000 }),
    // 省 token 第 3 条：上下文按需加载时默认带几条最近消息。
    contextMessages: pickInt(raw.contextMessages, base.contextMessages, { min: 0, max: 50 }),
    quietHours: quiet,
    scoreThreshold: pickInt(raw.scoreThreshold, base.scoreThreshold, { min: 0, max: 1000 }),
  };
}