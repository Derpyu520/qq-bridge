/**
 * 触发管理（任务书 §3 Trigger / §9 触发唯一 / §10 状态机）。
 *
 * 两条铁律：
 *   1. 同一个「事由」只能有一个 trigger —— triggerKey 在库里是 UNIQUE 的，
 *      所以同一个话题每 60 秒被扫一次，也只会留一条候选，不会堆成 100 条。
 *   2. 领取得是原子的（lease）—— 领到才允许往下走，领不到就当作没发生。
 */
import { randomUUID } from 'node:crypto';

/** 触发类型。第一版只支持 explicit，另外几种先占位，开启要显式配置。 */
export const TRIGGER_TYPE = Object.freeze({
  explicit: 'explicit',          // 显式话题到期
  externalEvent: 'external_event', // 外部事件（阶段 5）
  idle: 'idle',                  // 长时间未互动（阶段 5）
});

/**
 * 生成稳定的去重键。**同一事由必须算出同一个键**，这是唯一的去重依据。
 * 话题重新改期（followUpAt 变了）算新事由，允许再来一次。
 */
export function buildTriggerKey({ type, userId, topicId, followUpAt, externalId, dayKey }) {
  if (!type) throw new Error('buildTriggerKey 需要 type');
  switch (type) {
    case TRIGGER_TYPE.explicit:
      if (!topicId) throw new Error('explicit 触发需要 topicId');
      return `topic:${topicId}:${followUpAt == null ? 'open' : Number(followUpAt)}`;
    case TRIGGER_TYPE.externalEvent:
      if (!externalId) throw new Error('external_event 触发需要 externalId');
      return `event:${externalId}`;
    case TRIGGER_TYPE.idle:
      if (!userId || !dayKey) throw new Error('idle 触发需要 userId 与 dayKey');
      return `idle:${userId}:${dayKey}`;
    default:
      return `misc:${type}:${topicId ?? externalId ?? userId}:${followUpAt ?? 'now'}`;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.idFactory]
 */
export function createTriggerManager({ store, now = Date.now, idFactory = randomUUID } = {}) {
  if (!store) throw new Error('createTriggerManager 需要 store');

  /**
   * 排一条候选。返回 true = 新建，false = 已有同键（重复被吃掉，这是正常的）。
   */
  function enqueue({ userId, type, reason, topicId = null, triggerKey }) {
    const at = now();
    return store.addTrigger({
      id: idFactory(),
      triggerKey,
      userId: String(userId),
      type,
      topicId,
      reason: String(reason ?? ''),
      now: at,
    });
  }

  /** 为话题排候选；同话题同改期时间只会有一条。 */
  function enqueueTopic({ userId, topic }) {
    const key = buildTriggerKey({
      type: TRIGGER_TYPE.explicit,
      userId,
      topicId: topic.id,
      followUpAt: topic.followUpAt,
    });
    return {
      triggerKey: key,
      created: enqueue({
        userId,
        type: TRIGGER_TYPE.explicit,
        reason: topic.summary,
        topicId: topic.id,
        triggerKey: key,
      }),
    };
  }

  /** 原子领取一条候选（lease 默认 60 秒，够一轮生成）。 */
  function claim({ leaseMs = 60_000 } = {}) {
    return store.claimTrigger({ now: now(), leaseMs });
  }

  function transition(id, state, extra = {}) {
    return store.setTriggerState(id, state, { ...extra, now: now() });
  }

  /** 进程重启时把僵死的 evaluating/generating 放回 retry_wait。 */
  function releaseStale() {
    return store.releaseStaleTriggers(now());
  }

  function list({ state, limit = 20 } = {}) {
    return store.listTriggers({ state, limit });
  }

  function get(id) {
    return store.getTrigger(String(id));
  }

  return { enqueue, enqueueTopic, claim, transition, releaseStale, list, get };
}