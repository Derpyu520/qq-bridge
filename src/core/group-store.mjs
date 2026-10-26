import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 群聊长历史。桥本来只在 state/social-v2.json 里留最近 200 条（还得整个文件重写一遍），
 * 超出这个窗口的对话就永久丢了 —— 她翻不到三天前群里说过什么。
 *
 * 这里用 node:sqlite（Node ≥22.5，本机 v24）单独存一份：只追加、只按会话查，
 * 不和 social-v2.json 抢职责。social-v2.json 仍然是「未读 + 唤醒配置」的真相源，
 * 这张表纯粹是给她「往前翻」用的档案。
 *
 * 三条硬约束：
 *  1. 任何失败都不能反过来影响收消息 —— 所有方法自己吞错误，坏了就返回空。
 *  2. 重复投递靠 (conv_key, message_id) 唯一索引挡住，不靠调用方判断。
 *  3. 有保留期，别把磁盘吃满。
 */

export const DEFAULT_RETENTION_DAYS = 30;
export const MAX_TEXT_CHARS = 2000;

export function createGroupStore(options = {}) {
  const file = String(options.file ?? '');
  if (!file) throw new Error('createGroupStore 需要 file');
  const retentionDays = Number(options.retentionDays ?? DEFAULT_RETENTION_DAYS);
  const now = options.now ?? Date.now;
  const onError = options.onError ?? (() => {});

  let db = null;
  let broken = null;
  let appended = 0;
  let duplicates = 0;
  let rejected = 0;

  function open(asOf) {
    if (db) return db;
    if (broken) return null;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const handle = new DatabaseSync(file);
      handle.exec('PRAGMA journal_mode = WAL');
      handle.exec('PRAGMA synchronous = NORMAL');
      handle.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conv_key TEXT NOT NULL,
          message_id TEXT,
          seq INTEGER,
          ts INTEGER NOT NULL,
          user_id TEXT,
          nickname TEXT,
          kind TEXT,
          is_self INTEGER NOT NULL DEFAULT 0,
          text TEXT
        )
      `);
      // message_id 可能是空（协议端偶尔不给）：那就退化成 seq，两个都没有就允许重复。
      handle.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup
        ON messages(conv_key, message_id) WHERE message_id IS NOT NULL
      `);
      handle.exec('CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conv_key, ts DESC, id DESC)');
      db = handle;
      prune(asOf ?? now());
      return db;
    } catch (error) {
      broken = error?.message ?? String(error);
      db = null;
      onError(error);
      return null;
    }
  }

  function append(record) {
    const handle = open();
    if (!handle) return false;
    try {
      const ts = Number(record?.ts ?? Date.now());
      // 比保留期还旧的记录直接不写：补录历史没有意义，还会让 prune 白跑一趟。
      if (ts < now() - retentionDays * 24 * 60 * 60 * 1000) {
        rejected += 1;
        return false;
      }
      const text = String(record?.text ?? '').slice(0, MAX_TEXT_CHARS);
      const info = handle
        .prepare(
          `INSERT OR IGNORE INTO messages
           (conv_key, message_id, seq, ts, user_id, nickname, kind, is_self, text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          String(record?.convKey ?? ''),
          record?.messageId === undefined || record?.messageId === null ? null : String(record.messageId),
          record?.seq === undefined || record?.seq === null ? null : Number(record.seq),
          ts,
          record?.userId === undefined || record?.userId === null ? null : String(record.userId),
          record?.nickname ? String(record.nickname) : null,
          record?.kind ? String(record.kind) : null,
          record?.isSelf ? 1 : 0,
          text,
        );
      if (Number(info?.changes) > 0) {
        appended += 1;
        return true;
      }
      duplicates += 1;
      return false;
    } catch (error) {
      broken = error?.message ?? String(error);
      onError(error);
      return false;
    }
  }

  /** 最近的若干条，返回按时间正序（最老在前），和 prompt 里看历史的习惯一致。 */
  function recent(convKey, limit = 20) {
    const handle = open();
    if (!handle) return [];
    const size = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(200, Math.floor(Number(limit)))) : 20;
    try {
      const rows = handle
        .prepare(
          `SELECT message_id, seq, ts, user_id, nickname, kind, is_self, text
           FROM messages WHERE conv_key = ?
           ORDER BY ts DESC, id DESC LIMIT ?`,
        )
        .all(String(convKey ?? ''), size);
      return rows
        .map((row) => ({
          messageId: row.message_id,
          seq: row.seq,
          ts: row.ts,
          userId: row.user_id,
          nickname: row.nickname,
          kind: row.kind,
          isSelf: Boolean(row.is_self),
          text: row.text ?? '',
        }))
        .reverse();
    } catch (error) {
      broken = error?.message ?? String(error);
      onError(error);
      return [];
    }
  }

  function count(convKey) {
    const handle = open();
    if (!handle) return 0;
    try {
      const row = handle.prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_key = ?').get(String(convKey ?? ''));
      return Number(row?.n ?? 0);
    } catch {
      return 0;
    }
  }

  function prune(at = now()) {
    const handle = open(at);
    if (!handle) return 0;
    const cutoff = Number(at) - retentionDays * 24 * 60 * 60 * 1000;
    try {
      const info = handle.prepare('DELETE FROM messages WHERE ts < ?').run(cutoff);
      return Number(info?.changes ?? 0);
    } catch (error) {
      onError(error);
      return 0;
    }
  }

  function stats() {
    const base = { file, retentionDays, appended, duplicates, rejected, broken };
    const handle = open();
    if (!handle) return { ...base, rows: 0 };
    try {
      const row = handle.prepare('SELECT COUNT(*) AS n FROM messages').get();
      return { ...base, rows: Number(row?.n ?? 0) };
    } catch {
      return { ...base, rows: 0 };
    }
  }

  function close() {
    if (!db) return;
    try {
      db.close();
    } catch {
      // 关不掉也没什么可做的
    }
    db = null;
  }

  return { append, recent, count, prune, stats, close, get broken() { return broken; } };
}