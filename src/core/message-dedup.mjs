/**
 * 消息去重：同一条 QQ 消息只处理一次。
 *
 * 为什么需要这层：桥接现在对 `handleIncoming` 没有任何入参级去重，而重复投递至少有三条来路——
 *   1. SnowLuma 的 WS 断线重连，协议端会把掉线期间的消息再推一遍；
 *   2. 桥接自己的「重启桥接」是 spawn 接力子进程，父子交接那 1.5 秒里两端都可能收到同一条；
 *   3. 协议端重发（超时未 ack 的那条）。
 * 没有去重时，一条消息会二次进未读、二次参与唤醒判定，概率触发下甚至可能二次唤醒。
 *
 * 设计约束：
 *  - **纯内存、无 fs、无定时器**。持久化去重会让「桥重启后不重放」变成一个新问题（重启前刚收的消息
 *    到底算不算处理过？），这里不做；重启窗口内的重复由 `state/social-v2.json` 的未读序号兜着。
 *  - **没有 message_id 的消息一律放行**。宁可重复也不能吞：OneBot 实现不保证每条都带 id。
 *  - **按会话分域**。不同群的 `message_id` 可能撞号，必须带 scope。
 *  - **有界**。容量与 TTL 双保险，不会随运行时长无限长。
 */

/** 默认保留 2048 条 id，覆盖高频群聊半小时的窗口；超出按插入顺序淘汰最旧。 */
const DEFAULT_CAPACITY = 2048;
/** 默认 30 分钟。协议端重投基本落在秒到分钟级，半小时足够宽。 */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

const SEP = '\u0000';

function toRefList(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  return list.map((value) => String(value ?? '').trim()).filter(Boolean);
}

/**
 * @param {{ capacity?: number, ttlMs?: number }} [options]
 */
export function createMessageDedup(options = {}) {
  const capacity = Number.isFinite(Number(options.capacity)) && Number(options.capacity) > 0
    ? Math.floor(Number(options.capacity))
    : DEFAULT_CAPACITY;
  const ttlMs = Number.isFinite(Number(options.ttlMs)) && Number(options.ttlMs) > 0
    ? Math.floor(Number(options.ttlMs))
    : DEFAULT_TTL_MS;

  /** Map 保持插入序，也就是时间序：从头部删就等于丢最旧的。 */
  const seen = new Map();
  const stats = { accepted: 0, duplicates: 0, evicted: 0, unidentifiable: 0 };

  function trimSize() {
    while (seen.size > capacity) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
      stats.evicted++;
    }
  }

  function prune(now = Date.now()) {
    const cutoff = now - ttlMs;
    for (const [key, at] of seen) {
      if (at >= cutoff) break;
      seen.delete(key);
      stats.evicted++;
    }
    trimSize();
  }

  return {
    /**
     * 判定并占用。返回 `true` 表示「这条可以处理」，`false` 表示「已经处理过，丢掉」。
     * 一条事件带多个引用（`message_id` + `message_seq`）时，**任意一个命中即算重复**，
     * 并且命中后不再登记剩下的引用——已经确定的重复不需要额外占坑。
     */
    accept(scope, ids, now = Date.now()) {
      const name = String(scope ?? '');
      const list = toRefList(ids);
      if (list.length === 0) {
        stats.unidentifiable++;
        return true;
      }
      prune(now);
      for (const id of list) {
        if (seen.has(name + SEP + id)) {
          stats.duplicates++;
          return false;
        }
      }
      for (const id of list) seen.set(name + SEP + id, now);
      trimSize();
      stats.accepted++;
      return true;
    },

    /** 会话被重置（`/reset`）时清掉这个会话的痕迹，避免它把新会话的消息当成旧的。 */
    forget(scope) {
      const prefix = String(scope ?? '') + SEP;
      for (const key of [...seen.keys()]) {
        if (key.startsWith(prefix)) seen.delete(key);
      }
    },

    prune,

    get size() {
      return seen.size;
    },

    stats() {
      return { ...stats, size: seen.size, capacity, ttlMs };
    },
  };
}