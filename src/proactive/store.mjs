/**
 * 主动聊天的持久化层（SQLite）。
 *
 * 为什么不是 JSON 文件：任务书 §9 要求「触发唯一 + 原子领取 + 原子扣额度 +
 * 每个渠道独立投递记录」。JSON 每次都要整份读改写，两个 tick 交错就互相覆盖；
 * SQLite 的 UNIQUE 与 `UPDATE ... WHERE` 天然把这些做成单条原子语句。
 *
 * 表与任务书 §4 的对应：
 *   user_scope      UserScope
 *   topic           Topic
 *   proactive_state ProactiveState（含每日计数）
 *   trigger         Trigger（trigger_key UNIQUE 是去重的本体）
 *   message         ProactiveMessage
 *   delivery        DeliveryRecord（主键 message_id + channel）
 *
 * 任何异常都不往外抛，置 broken 并安静退化 —— 主动聊天坏掉不能拖垮 QQ 收发。
 */
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

/** 投递状态机（任务书 §10）：pending → sending → sent，失败走 retry_wait / failed。 */
export const DELIVERY_STATUS = Object.freeze(['pending', 'sending', 'sent', 'retry_wait', 'failed', 'unknown']);

/** 触发状态机（任务书 §10）：candidate → evaluating → generating → ready → delivering → completed。 */
export const TRIGGER_STATE = Object.freeze([
  'candidate', 'evaluating', 'generating', 'ready', 'delivering', 'completed',
  'suppressed', 'retry_wait', 'failed',
]);

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_scope (
  user_id          TEXT PRIMARY KEY,
  dsh_session_id   TEXT NOT NULL,
  qq_target_id     TEXT,
  enabled_channels TEXT NOT NULL DEFAULT '["qq","dsh"]',
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS topic (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  summary           TEXT NOT NULL,
  follow_up_at      INTEGER,
  expires_at        INTEGER,
  status            TEXT NOT NULL DEFAULT 'open',
  last_mentioned_at INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topic_user_status ON topic(user_id, status, follow_up_at);

CREATE TABLE IF NOT EXISTS proactive_state (
  user_id             TEXT PRIMARY KEY,
  enabled             INTEGER NOT NULL DEFAULT 1,
  paused_until        INTEGER,
  last_user_message_at INTEGER,
  last_proactive_at   INTEGER,
  daily_count         INTEGER NOT NULL DEFAULT 0,
  daily_calls         INTEGER NOT NULL DEFAULT 0,
  day_key             TEXT NOT NULL DEFAULT '',
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trigger (
  id         TEXT PRIMARY KEY,
  trigger_key TEXT NOT NULL UNIQUE,
  user_id    TEXT NOT NULL,
  type       TEXT NOT NULL,
  topic_id   TEXT,
  reason     TEXT NOT NULL,
  score      INTEGER,
  state      TEXT NOT NULL DEFAULT 'candidate',
  lease_until INTEGER,
  note       TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trigger_state ON trigger(state, created_at);

CREATE TABLE IF NOT EXISTS message (
  id         TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  text       TEXT NOT NULL,
  channels   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery (
  message_id          TEXT NOT NULL,
  channel             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  attempts            INTEGER NOT NULL DEFAULT 0,
  external_message_id TEXT,
  last_error          TEXT,
  next_attempt_at     INTEGER,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (message_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery(status, next_attempt_at);

-- 每次调 AI 的用量流水。单独一张表而不是塞进 proactive_state，是因为面板要的是
-- 「近 N 天的平均」，只有逐条留底才能算；state 里只放得下当天的一个累计值。
-- input/output 允许为 0：provider 没上报时记 0，面板会把这类样本从平均值里剔掉。
CREATE TABLE IF NOT EXISTS call_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  day_key       TEXT NOT NULL,
  trigger_id    TEXT,
  ok            INTEGER NOT NULL DEFAULT 1,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_call_usage_day ON call_usage(day_key, user_id);
`;

/**
 * @param {object} options
 * @param {string} options.file      state/proactive.db
 * @param {(msg: string, err?: unknown) => void} [options.onError]
 */
/**
 * 给老库补后加的列。SQLite 的 CREATE TABLE IF NOT EXISTS 只保证表在，
 * 不管列齐不齐，所以每次打开都拿 PRAGMA 对一遍。
 */
function migrateColumns(handle) {
  const columns = new Set(
    handle
      .prepare('PRAGMA table_info(proactive_state)')
      .all()
      .map((row) => row.name)
  );
  if (!columns.has('daily_calls')) {
    handle.exec('ALTER TABLE proactive_state ADD COLUMN daily_calls INTEGER NOT NULL DEFAULT 0');
  }
}

export function createProactiveStore({ file, onError } = {}) {
  if (!file) throw new Error('createProactiveStore 需要 file');
  let broken = null;
  let db = null;
  const stats = { writes: 0, claims: 0, rejected: 0 };

  const report = (error) => {
    if (!broken) broken = error instanceof Error ? error : new Error(String(error));
    try { onError?.(`主动聊天库异常：${error?.message ?? error}`, error); } catch { /* 日志本身不能抛 */ }
  };

  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 4000');
    db.exec(CREATE_SQL);
    // 老库不会因为 CREATE TABLE IF NOT EXISTS 长出新列，后加的列只能自己 ALTER
    migrateColumns(db);
    db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  } catch (error) {
    report(error);
  }

  /** 一条语句的包装：库坏了就安静返回 fallback，绝不把异常抛给调度器。 */
  const guard = (fallback, fn) => {
    if (!db || broken) return fallback;
    try {
      return fn();
    } catch (error) {
      report(error);
      return fallback;
    }
  };

  // ── user_scope ────────────────────────────────────────────────────────────

  function upsertScope({ userId, dshSessionId, qqTargetId = null, enabledChannels = ['qq', 'dsh'], now = Date.now() }) {
    return guard(false, () => {
      db.prepare(`
        INSERT INTO user_scope(user_id, dsh_session_id, qq_target_id, enabled_channels, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          dsh_session_id = excluded.dsh_session_id,
          qq_target_id   = excluded.qq_target_id,
          enabled_channels = excluded.enabled_channels,
          updated_at     = excluded.updated_at
      `).run(String(userId), String(dshSessionId), qqTargetId == null ? null : String(qqTargetId), JSON.stringify(enabledChannels), now);
      stats.writes += 1;
      return true;
    });
  }

  function getScope(userId) {
    return guard(null, () => {
      const row = db.prepare('SELECT * FROM user_scope WHERE user_id = ?').get(String(userId));
      if (!row) return null;
      return {
        userId: row.user_id,
        dshSessionId: row.dsh_session_id,
        qqTargetId: row.qq_target_id ?? undefined,
        enabledChannels: parseChannels(row.enabled_channels),
      };
    });
  }

  function listScopes() {
    return guard([], () => db.prepare('SELECT * FROM user_scope ORDER BY user_id').all().map((row) => ({
      userId: row.user_id,
      dshSessionId: row.dsh_session_id,
      qqTargetId: row.qq_target_id ?? undefined,
      enabledChannels: parseChannels(row.enabled_channels),
    })));
  }

  // ── proactive_state ───────────────────────────────────────────────────────

  function ensureState(userId, now = Date.now()) {
    return guard(false, () => {
      db.prepare(`
        INSERT INTO proactive_state(user_id, enabled, daily_count, daily_calls, day_key, updated_at)
        VALUES (?, 1, 0, 0, '', ?)
        ON CONFLICT(user_id) DO NOTHING
      `).run(String(userId), now);
      return true;
    });
  }

  function getState(userId) {
    return guard(null, () => {
      const row = db.prepare('SELECT * FROM proactive_state WHERE user_id = ?').get(String(userId));
      if (!row) return null;
      return {
        userId: row.user_id,
        enabled: row.enabled === 1,
        pausedUntil: row.paused_until ?? undefined,
        lastUserMessageAt: row.last_user_message_at ?? undefined,
        lastProactiveAt: row.last_proactive_at ?? undefined,
        dailyCount: row.daily_count,
        dailyCalls: row.daily_calls,
        dayKey: row.day_key,
      };
    });
  }

  /** 现有 QQ 入口每次收到用户消息时调用（任务书 §2 第 1 步）。 */
  function touchUserMessage(userId, at = Date.now()) {
    return guard(false, () => {
      ensureState(userId, at);
      db.prepare('UPDATE proactive_state SET last_user_message_at = ?, updated_at = ? WHERE user_id = ?')
        .run(at, at, String(userId));
      stats.writes += 1;
      return true;
    });
  }

  function setPaused(userId, pausedUntil, now = Date.now()) {
    return guard(false, () => {
      ensureState(userId, now);
      db.prepare('UPDATE proactive_state SET paused_until = ?, updated_at = ? WHERE user_id = ?')
        .run(pausedUntil == null ? null : Number(pausedUntil), now, String(userId));
      stats.writes += 1;
      return true;
    });
  }

  function setEnabled(userId, enabled, now = Date.now()) {
    return guard(false, () => {
      ensureState(userId, now);
      db.prepare('UPDATE proactive_state SET enabled = ?, updated_at = ? WHERE user_id = ?')
        .run(enabled ? 1 : 0, now, String(userId));
      stats.writes += 1;
      return true;
    });
  }

  /**
   * 跨日重置。日期按用户时区算好传进来（dayKey），这里不碰时区逻辑。
   * 返回 true 表示这次发生了重置。
   */
  function rollDay(userId, dayKey, now = Date.now()) {
    return guard(false, () => {
      ensureState(userId, now);
      const res = db.prepare(`
        UPDATE proactive_state SET daily_count = 0, daily_calls = 0, day_key = ?, updated_at = ?
        WHERE user_id = ? AND day_key <> ?
      `).run(dayKey, now, String(userId), dayKey);
      return res.changes > 0;
    });
  }

  /**
   * 原子预留当日额度：一条 UPDATE 里判上限，并发/重入都超不了（任务书 §9）。
   * 返回 true = 抢到了名额，false = 已到上限。
   */
  function reserveDailyQuota(userId, dayKey, limit, now = Date.now()) {
    return guard(false, () => {
      ensureState(userId, now);
      rollDay(userId, dayKey, now);
      const res = db.prepare(`
        UPDATE proactive_state SET daily_count = daily_count + 1, updated_at = ?
        WHERE user_id = ? AND daily_count < ?
      `).run(now, String(userId), Math.max(0, Number(limit) || 0));
      if (res.changes !== 1) {
        stats.rejected += 1;
        return false;
      }
      stats.writes += 1;
      return true;
    });
  }

  /** 退还一次额度：生成失败/被抑制时用，避免白吃当天的名额。 */
  function releaseDailyQuota(userId, dayKey, now = Date.now()) {
    return guard(false, () => {
      const res = db.prepare(`
        UPDATE proactive_state SET daily_count = MAX(0, daily_count - 1), updated_at = ?
        WHERE user_id = ? AND day_key = ?
      `).run(now, String(userId), dayKey);
      return res.changes > 0;
    });
  }
  /**
   * 占用一次「调用额度」。与消息额度分开记：
   * 一条消息可能被规则拦下而不花钱，一次调用则一定花了钱。
   * @returns {boolean} 还有额度并已占用
   */
  function reserveCallQuota(userId, dayKey, limit, now = Date.now()) {
    const max = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 0;
    return guard(false, () => {
      ensureState(userId, now);
      rollDay(userId, dayKey, now);
      const info = db
        .prepare(
          `UPDATE proactive_state SET daily_calls = daily_calls + 1, updated_at = ?
          WHERE user_id = ? AND daily_calls < ?`
        )
        .run(now, userId, max);
      return Number(info.changes) === 1;
    });
  }

  /** 生成失败时把调用额度退回去。 */
  function releaseCallQuota(userId, now = Date.now()) {
    guard(undefined, () => {
      db.prepare(
        `UPDATE proactive_state SET daily_calls = MAX(0, daily_calls - 1), updated_at = ?
        WHERE user_id = ?`
      ).run(now, userId);
    });
  }

  /** 今天的账：给设置面板看的几个数。 */
  function statsToday(userId, dayKey) {
    return guard(
      { userId, dayKey, messages: 0, calls: 0, topics: 0, triggers: 0, sent: 0, suppressed: 0, pending: 0 },
      () => {
        const st = getState(userId);
        const sameDay = Boolean(st) && st.dayKey === dayKey;
        const counts =
          db
            .prepare(
              `SELECT
                (SELECT COUNT(*) FROM topic WHERE user_id = ? AND status = 'open') AS topics,
                (SELECT COUNT(*) FROM trigger WHERE user_id = ? AND state = 'suppressed') AS suppressed,
                (SELECT COUNT(*) FROM trigger WHERE user_id = ?
                  AND state IN ('candidate','retry_wait','generating','ready','delivering')) AS pending,
                (SELECT COUNT(*) FROM delivery d JOIN message m ON m.id = d.message_id
                  WHERE m.user_id = ? AND d.status = 'sent') AS sent`
            )
            .get(userId, userId, userId, userId) || {};
        return {
          userId,
          dayKey,
          messages: sameDay ? Number(st.dailyCount ?? 0) : 0,
          calls: sameDay ? Number(st.dailyCalls ?? 0) : 0,
          topics: Number(counts.topics ?? 0),
          triggers: Number(counts.triggers ?? 0),
          sent: Number(counts.sent ?? 0),
          suppressed: Number(counts.suppressed ?? 0),
          pending: Number(counts.pending ?? 0),
        };
      }
    );
  }


  function markProactiveSent(userId, at = Date.now()) {
    ensureState(userId, at);
    return guard(false, () => {
      const res = db.prepare('UPDATE proactive_state SET last_proactive_at = ?, updated_at = ? WHERE user_id = ?')
        .run(at, at, String(userId));
      return res.changes > 0;
    });
  }

  // ── topic ─────────────────────────────────────────────────────────────────

  function addTopic({ id, userId, summary, followUpAt = null, expiresAt = null, now = Date.now() }) {
    return guard(false, () => {
      db.prepare(`
        INSERT INTO topic(id, user_id, summary, follow_up_at, expires_at, status, last_mentioned_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)
      `).run(String(id), String(userId), String(summary), followUpAt, expiresAt, now, now, now);
      stats.writes += 1;
      return true;
    });
  }

  function getTopic(id) {
    return guard(null, () => {
      const row = db.prepare('SELECT * FROM topic WHERE id = ?').get(String(id));
      return row ? mapTopic(row) : null;
    });
  }

  function listTopics(userId, { status } = {}) {
    return guard([], () => {
      const rows = status
        ? db.prepare('SELECT * FROM topic WHERE user_id = ? AND status = ? ORDER BY COALESCE(follow_up_at, created_at)').all(String(userId), status)
        : db.prepare('SELECT * FROM topic WHERE user_id = ? ORDER BY COALESCE(follow_up_at, created_at)').all(String(userId));
      return rows.map(mapTopic);
    });
  }

  /** 到期待跟进的话题：open、follow_up_at 已到、没过期。 */
  function listDueTopics(userId, now = Date.now()) {
    return guard([], () => db.prepare(`
      SELECT * FROM topic
      WHERE user_id = ? AND status = 'open'
        AND follow_up_at IS NOT NULL AND follow_up_at <= ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY follow_up_at
    `).all(String(userId), now, now).map(mapTopic));
  }

  function setTopicStatus(id, status, now = Date.now()) {
    return guard(false, () => {
      const res = db.prepare('UPDATE topic SET status = ?, updated_at = ? WHERE id = ?').run(String(status), now, String(id));
      return res.changes > 0;
    });
  }

  /** 过期清扫：到 expiresAt 还 open 的直接标 expired（任务书 §11「过期不再跟进」）。 */
  function expireTopics(now = Date.now()) {
    return guard(0, () => {
      const res = db.prepare(`
        UPDATE topic SET status = 'expired', updated_at = ?
        WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?
      `).run(now, now);
      return res.changes;
    });
  }

  // ── trigger ───────────────────────────────────────────────────────────────

  /**
   * 写候选触发。trigger_key 唯一 ⇒ 同一话题/事件重复到达只留一条（任务书 §9）。
   * 返回 true 表示真的新建了，false 是重复（已存在或写失败）。
   */
  function addTrigger({ id, triggerKey, userId, type, topicId = null, reason, now = Date.now() }) {
    return guard(false, () => {
      const res = db.prepare(`
        INSERT OR IGNORE INTO trigger(id, trigger_key, user_id, type, topic_id, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(String(id), String(triggerKey), String(userId), String(type), topicId == null ? null : String(topicId), String(reason), now, now);
      if (res.changes !== 1) {
        stats.rejected += 1;
        return false;
      }
      stats.writes += 1;
      return true;
    });
  }

  /**
   * 原子领取一条候选触发（lease 模式，任务书 §9/§10）。
   * 两步：先选一条可领的，再带条件 UPDATE；changes 才是判据 —— 声称领到但没改到行
   * 就等于没领到。
   */
  /**
   * 候选清单：同一用户的、还领得到的 trigger，按分数从高到低。
   * 事件合并靠它——一个 tick 里同一个人只处理一条，其余的合并掉。
   */
  function listCandidates({ userId = null, limit = 8, now = Date.now() } = {}) {
    return guard([], () => {
      const rows = userId == null
        ? db.prepare(`
            SELECT * FROM trigger
            WHERE state IN ('candidate', 'retry_wait')
              AND (lease_until IS NULL OR lease_until < ?)
            ORDER BY COALESCE(score, 0) DESC, created_at ASC LIMIT ?
          `).all(now, Math.max(1, Number(limit) || 8))
        : db.prepare(`
            SELECT * FROM trigger
            WHERE user_id = ? AND state IN ('candidate', 'retry_wait')
              AND (lease_until IS NULL OR lease_until < ?)
            ORDER BY COALESCE(score, 0) DESC, created_at ASC LIMIT ?
          `).all(String(userId), now, Math.max(1, Number(limit) || 8));
      return rows.map(mapTrigger);
    });
  }

  function claimTrigger({ now = Date.now(), leaseMs = 60_000, id = null, userId = null } = {}) {
    return guard(null, () => {
      const row = id
        ? db.prepare(`
            SELECT * FROM trigger
            WHERE id = ? AND state IN ('candidate', 'retry_wait')
              AND (lease_until IS NULL OR lease_until < ?)
          `).get(String(id), now)
        : userId
          ? db.prepare(`
              SELECT * FROM trigger
              WHERE user_id = ? AND state IN ('candidate', 'retry_wait')
                AND (lease_until IS NULL OR lease_until < ?)
              ORDER BY COALESCE(score, 0) DESC, created_at ASC LIMIT 1
            `).get(String(userId), now)
          : db.prepare(`
              SELECT * FROM trigger
              WHERE state IN ('candidate', 'retry_wait')
                AND (lease_until IS NULL OR lease_until < ?)
              ORDER BY created_at LIMIT 1
            `).get(now);
      if (!row) return null;
      const res = db.prepare(`
        UPDATE trigger SET state = 'evaluating', lease_until = ?, updated_at = ?
        WHERE id = ? AND state IN ('candidate', 'retry_wait')
          AND (lease_until IS NULL OR lease_until < ?)
      `).run(now + leaseMs, now, row.id, now);
      if (res.changes !== 1) return null;
      stats.claims += 1;
      return mapTrigger({ ...row, state: 'evaluating' });
    });
  }

  function setTriggerState(id, state, { score = null, note = null, leaseUntil = null, now = Date.now() } = {}) {
    return guard(false, () => {
      const res = db.prepare(`
        UPDATE trigger SET state = ?, score = COALESCE(?, score), note = COALESCE(?, note),
          lease_until = ?, updated_at = ?
        WHERE id = ?
      `).run(String(state), score, note, leaseUntil, now, String(id));
      return res.changes > 0;
    });
  }

  function getTrigger(id) {
    return guard(null, () => {
      const row = db.prepare('SELECT * FROM trigger WHERE id = ?').get(String(id));
      return row ? mapTrigger(row) : null;
    });
  }

  function listTriggers({ state, limit = 20 } = {}) {
    return guard([], () => {
      const rows = state
        ? db.prepare('SELECT * FROM trigger WHERE state = ? ORDER BY created_at DESC LIMIT ?').all(String(state), Number(limit) || 20)
        : db.prepare('SELECT * FROM trigger ORDER BY created_at DESC LIMIT ?').all(Number(limit) || 20);
      return rows.map(mapTrigger);
    });
  }

  // ── message / delivery ────────────────────────────────────────────────────

  /**
   * 消息先落 outbox，再投递（任务书 §9「生成成功后先写 outbox」）。
   * 同一 trigger 只允许一条消息：靠 trigger_id 的唯一索引兜底。
   */
  function addMessage({ id, triggerId, userId, sessionId, text, channels, now = Date.now() }) {
    return guard(false, () => {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_message_trigger ON message(trigger_id)');
      const res = db.prepare(`
        INSERT OR IGNORE INTO message(id, trigger_id, user_id, session_id, text, channels, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(String(id), String(triggerId), String(userId), String(sessionId), String(text), JSON.stringify(channels), now);
      if (res.changes !== 1) {
        stats.rejected += 1;
        return false;
      }
      stats.writes += 1;
      return true;
    });
  }

  function getMessage(id) {
    return guard(null, () => {
      const row = db.prepare('SELECT * FROM message WHERE id = ?').get(String(id));
      return row ? mapMessage(row) : null;
    });
  }

  function getMessageByTrigger(triggerId) {
    return guard(null, () => {
      const row = db.prepare('SELECT * FROM message WHERE trigger_id = ?').get(String(triggerId));
      return row ? mapMessage(row) : null;
    });
  }

  function listMessages({ limit = 20 } = {}) {
    return guard([], () => db.prepare('SELECT * FROM message ORDER BY created_at DESC LIMIT ?')
      .all(Number(limit) || 20).map(mapMessage));
  }

  function ensureDelivery({ messageId, channel, now = Date.now() }) {
    return guard(false, () => {
      const res = db.prepare(`
        INSERT OR IGNORE INTO delivery(message_id, channel, status, attempts, updated_at)
        VALUES (?, ?, 'pending', 0, ?)
      `).run(String(messageId), String(channel), now);
      return res.changes === 1;
    });
  }

  function listDeliveries(messageId) {
    return guard([], () => db.prepare('SELECT * FROM delivery WHERE message_id = ? ORDER BY channel')
      .all(String(messageId)).map(mapDelivery));
  }

  /** 待投递的（含 retry_wait 到期），用于重启后恢复（任务书 §9）。 */
  function listPendingDeliveries({ now = Date.now(), limit = 50 } = {}) {
    return guard([], () => db.prepare(`
      SELECT * FROM delivery
      WHERE status IN ('pending', 'retry_wait')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY updated_at LIMIT ?
    `).all(now, Number(limit) || 50).map(mapDelivery));
  }

  /**
   * 领取一条投递：pending/retry_wait → sending。
   * 「结果未知」的（unknown）不在可领范围内 —— 那要先人工/下次核实，不能盲目重发。
   */
  function claimDelivery({ messageId, channel, now = Date.now() }) {
    return guard(false, () => {
      const res = db.prepare(`
        UPDATE delivery SET status = 'sending', attempts = attempts + 1, updated_at = ?
        WHERE message_id = ? AND channel = ? AND status IN ('pending', 'retry_wait')
      `).run(now, String(messageId), String(channel));
      if (res.changes !== 1) return false;
      stats.claims += 1;
      return true;
    });
  }

  function markDelivery({ messageId, channel, status, externalMessageId = null, lastError = null, nextAttemptAt = null, now = Date.now() }) {
    return guard(false, () => {
      const res = db.prepare(`
        UPDATE delivery SET status = ?, external_message_id = COALESCE(?, external_message_id),
          last_error = ?, next_attempt_at = ?, updated_at = ?
        WHERE message_id = ? AND channel = ?
      `).run(String(status), externalMessageId, lastError, nextAttemptAt, now, String(messageId), String(channel));
      return res.changes > 0;
    });
  }

  /** 启动时把上一进程遗留的 sending 标成 unknown：发给谁了不知道，不能重发（任务书 §9 末条）。 */
  function reconcileInflightDeliveries(now = Date.now()) {
    return guard(0, () => {
      const res = db.prepare(`
        UPDATE delivery SET status = 'unknown',
          last_error = COALESCE(last_error, '进程在投递中途退出，结果未核实'),
          updated_at = ?
        WHERE status = 'sending'
      `).run(now);
      return res.changes;
    });
  }

  /** 僵死触发放回候选（进程崩在 evaluating 时留下的）。 */
  function releaseStaleTriggers(now = Date.now()) {
    return guard(0, () => {
      const res = db.prepare(`
        UPDATE trigger SET state = 'retry_wait', lease_until = NULL, updated_at = ?
        WHERE state IN ('evaluating', 'generating') AND (lease_until IS NULL OR lease_until < ?)
      `).run(now, now);
      return res.changes;
    });
  }

  /**
   * 记一笔调用用量。
   *
   * 字段名不统一是常态（不同 provider 用 inputTokens / prompt_tokens / input 都见过），
   * 这里做一层宽松归一：认识的键挨个试，全不认识就记 0 —— 记 0 表示「没上报」，
   * 面板算平均时会把这些样本剔掉，而不是把平均值拉低。
   */
  function recordCallUsage({ userId, dayKey, triggerId = null, ok = true, usage = null, at = Date.now() }) {
    const picked = pickTokenUsage(usage);
    return guard(false, () => {
      const res = db
        .prepare(
          `INSERT INTO call_usage (user_id, day_key, trigger_id, ok, input_tokens, output_tokens, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(String(userId), String(dayKey), triggerId == null ? null : String(triggerId), ok ? 1 : 0, picked.input, picked.output, at);
      return res.changes > 0;
    });
  }

  /** 某天的调用用量汇总：次数、有效样本数、平均输入/输出 token。 */
  function usageStats({ dayKey, userId = null } = {}) {
    return guard({ calls: 0, sampled: 0, avgInputTokens: 0, avgOutputTokens: 0, inputTokens: 0, outputTokens: 0 }, () => {
      const where = userId == null ? 'day_key = ?' : 'day_key = ? AND user_id = ?';
      const args = userId == null ? [String(dayKey)] : [String(dayKey), String(userId)];
      const row =
        db
          .prepare(
            `SELECT
               COUNT(*) AS calls,
               SUM(CASE WHEN input_tokens > 0 OR output_tokens > 0 THEN 1 ELSE 0 END) AS sampled,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens
             FROM call_usage WHERE ${where}`
          )
          .get(...args) || {};
      const sampled = Number(row.sampled ?? 0);
      return {
        calls: Number(row.calls ?? 0),
        sampled,
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        avgInputTokens: sampled > 0 ? Math.round(Number(row.input_tokens ?? 0) / sampled) : 0,
        avgOutputTokens: sampled > 0 ? Math.round(Number(row.output_tokens ?? 0) / sampled) : 0,
      };
    });
  }

  /** 近 N 天逐日汇总（老的在前），给面板画趋势用。 */
  function usageSeries({ days = 7, userId = null, now = Date.now(), timeZone } = {}) {
    return guard([], () => {
      const n = Math.max(1, Math.min(Number(days) || 7, 30));
      const out = [];
      for (let i = n - 1; i >= 0; i -= 1) {
        const day = dayKeyOf(now - i * 86_400_000, timeZone);
        out.push({ dayKey: day, ...usageStats({ dayKey: day, userId }) });
      }
      return out;
    });
  }

  function statsSnapshot() {
    return guard({}, () => ({
      ...stats,
      topics: db.prepare('SELECT COUNT(*) AS n FROM topic').get()?.n ?? 0,
      triggers: db.prepare('SELECT COUNT(*) AS n FROM trigger').get()?.n ?? 0,
      messages: db.prepare('SELECT COUNT(*) AS n FROM message').get()?.n ?? 0,
      deliveries: db.prepare('SELECT COUNT(*) AS n FROM delivery').get()?.n ?? 0,
      broken: broken ? String(broken.message ?? broken) : null,
    }));
  }

  function close() {
    if (!db) return;
    try { db.close(); } catch { /* 关不上也没有补救手段 */ }
    db = null;
  }

  return {
    file,
    upsertScope, getScope, listScopes,
    ensureState, getState, touchUserMessage, setPaused, setEnabled, rollDay,
    reserveDailyQuota, releaseDailyQuota, markProactiveSent,
    reserveCallQuota, releaseCallQuota, statsToday,
    recordCallUsage, usageStats, usageSeries,
    addTopic, getTopic, listTopics, listDueTopics, setTopicStatus, expireTopics,
    addTrigger, claimTrigger, listCandidates, setTriggerState, getTrigger, listTriggers,
    addMessage, getMessage, getMessageByTrigger, listMessages,
    ensureDelivery, listDeliveries, listPendingDeliveries, claimDelivery, markDelivery,
    reconcileInflightDeliveries, releaseStaleTriggers,
    stats: statsSnapshot,
    get broken() { return broken; },
    close,
  };
}

/** 从各种 provider 形状里挑出输入/输出 token。全不认识就返回 0/0（表示未上报）。 */
function pickTokenUsage(raw) {
  if (!raw || typeof raw !== 'object') return { input: 0, output: 0 };
  const num = (...keys) => {
    for (const key of keys) {
      const v = raw[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v);
    }
    return 0;
  };
  // 输入侧：缓存命中/未命中是分开报的，只认总量键；没有总量就把几块加起来。
  let input = num('inputTokens', 'promptTokens', 'prompt_tokens', 'input_tokens', 'input');
  if (input === 0) {
    const parts = num('cacheHit', 'cache_hit') + num('cacheMiss', 'cache_miss') + num('cacheWrite', 'cache_write');
    if (parts > 0) input = parts;
  }
  const output = num('outputTokens', 'completionTokens', 'completion_tokens', 'output_tokens', 'output');
  return { input, output };
}

/**
 * 「YYYY-MM-DD」日键。
 *
 * 不用 toISOString：那按 UTC 切日，晚上 8 点后就跨天了。
 * 传了 timeZone 就按它算（与引擎算配额时用的是同一个时区，否则面板和预算会差一天）。
 */
function dayKeyOf(at, timeZone) {
  const d = new Date(at);
  if (timeZone) {
    try {
      return d.toLocaleDateString('sv-SE', { timeZone }); // sv-SE 直接给 YYYY-MM-DD
    } catch { /* 时区名不合法就退回本地时区 */ }
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── 行映射 ──────────────────────────────────────────────────────────────────

function parseChannels(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c) => c === 'qq' || c === 'dsh') : ['qq', 'dsh'];
  } catch {
    return ['qq', 'dsh'];
  }
}

function mapTopic(row) {
  return {
    id: row.id,
    userId: row.user_id,
    summary: row.summary,
    followUpAt: row.follow_up_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    status: row.status,
    lastMentionedAt: row.last_mentioned_at,
    createdAt: row.created_at,
  };
}

function mapTrigger(row) {
  return {
    id: row.id,
    triggerKey: row.trigger_key,
    userId: row.user_id,
    type: row.type,
    topicId: row.topic_id ?? undefined,
    reason: row.reason,
    score: row.score ?? undefined,
    state: row.state,
    leaseUntil: row.lease_until ?? undefined,
    note: row.note ?? undefined,
    createdAt: row.created_at,
  };
}

function mapMessage(row) {
  let channels;
  try { channels = JSON.parse(row.channels); } catch { channels = ['qq', 'dsh']; }
  return {
    id: row.id,
    triggerId: row.trigger_id,
    userId: row.user_id,
    sessionId: row.session_id,
    text: row.text,
    channels: Array.isArray(channels) ? channels : ['qq', 'dsh'],
    createdAt: row.created_at,
  };
}

function mapDelivery(row) {
  return {
    messageId: row.message_id,
    channel: row.channel,
    status: row.status,
    attempts: row.attempts,
    externalMessageId: row.external_message_id ?? undefined,
    lastError: row.last_error ?? undefined,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    updatedAt: row.updated_at,
  };
}