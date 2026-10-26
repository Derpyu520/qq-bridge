/**
 * 话题管理（任务书 §3 Topic / §11 过期清理）。
 *
 * 第一版只支持**显式登记**的话题 —— 话题必须由人/工具明确写进来
 * （「下次问问她面试怎么样了」「三天后提醒我」），引擎不去猜。
 * 没有显式话题时，调度器一次 AI 都不会调。
 */
import { randomUUID } from 'node:crypto';

const MAX_SUMMARY_CHARS = 200;

/** 把一段话收敛成能存能读的摘要：压掉空白、截断、拒绝空串。 */
export function normalizeSummary(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > MAX_SUMMARY_CHARS ? `${clean.slice(0, MAX_SUMMARY_CHARS - 1)}…` : clean;
}

/**
 * @param {object} deps
 * @param {object} deps.store    createProactiveStore 的返回值
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.idFactory]
 */
export function createTopicManager({ store, now = Date.now, idFactory = randomUUID } = {}) {
  if (!store) throw new Error('createTopicManager 需要 store');

  /**
   * 登记一个话题。
   * @returns {{ok: true, topic: object} | {ok: false, error: string}}
   */
  function record({ userId, summary, followUpAt = null, expiresAt = null }) {
    const text = normalizeSummary(summary);
    if (!text) return { ok: false, error: '话题内容是空的' };
    if (!userId) return { ok: false, error: '缺少 userId' };

    const at = now();
    const topic = {
      id: idFactory(),
      userId: String(userId),
      summary: text,
      followUpAt: followUpAt == null ? null : Number(followUpAt),
      expiresAt: expiresAt == null ? null : Number(expiresAt),
      status: 'open',
      lastMentionedAt: at,
      createdAt: at,
    };
    const written = store.addTopic(topic);
    if (!written) return { ok: false, error: '话题没写进去（库不可用？）' };
    return { ok: true, topic: store.getTopic(topic.id) ?? topic };
  }

  function list(userId, { status } = {}) {
    return store.listTopics(String(userId), { status });
  }

  function get(id) {
    return store.getTopic(String(id));
  }

  /** 到期待跟进的（open + follow_up_at 已到 + 未过期）。 */
  function due(userId) {
    return store.listDueTopics(String(userId), now());
  }

  function close(id, status = 'closed') {
    return store.setTopicStatus(String(id), status, now());
  }

  /** 每次 tick 先清一遍过期话题，避免它们反复进候选。 */
  function sweep() {
    return store.expireTopics(now());
  }

  return { record, list, get, due, close, sweep };
}