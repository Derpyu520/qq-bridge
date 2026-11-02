// 记忆条目：由**模型自己**决定记什么（不是规则替它决定）。
//
// 与「聊天流水」的区别：
//   · CHATLOG.md / events-*.jsonl 是自动的原始记录（用于检索兜底与审计）；
//   · MEMORY.md / memories.json 是模型主动写下的记忆，带 scope（长期/短期）与重要度，
//     并按重要度自动**保留 / 压缩 / 遗忘**——这是"拟人"的一半：人会忘，也会只记重要的。
//
// 一条记忆：
//   { id, t, text, scope: 'long'|'short', importance: 1..5, who, source, lastAccess, accessCount, status }
import fs from 'node:fs';
import path from 'node:path';
import { DAY_MS, ensureDir, readJsonSafe, writeJsonAtomic, truncate } from './util.js';

export const MEMORY_FILE = 'memories.json';
export const MEMORY_MD = 'MEMORY.md';

export const SCOPE = { LONG: 'long', SHORT: 'short' };
// 记忆的「归属层级」：global = 跨会话的总体记忆（关于某个人本身，任何群/私聊都查得到）；
// session = 只在这个会话里有效（群梗、本群约定、这里发生的事）。
export const LAYER = { GLOBAL: 'global', SESSION: 'session' };

// 保留/压缩/遗忘策略（可按需在 config.memory.retention 覆盖）
export const DEFAULT_RETENTION = {
  shortTermDays: 3,        // 短期记忆默认保留 3 天
  promoteImportance: 3,    // 短期到期时，重要度 >=3 升为长期，否则遗忘
  longStaleDays: 90,       // 长期记忆多久没被回忆算"陈旧"
  longForgetImportance: 2, // 陈旧且重要度 <=2 → 遗忘
  longCompressChars: 80,   // 压缩时保留的字数
};

const IMPORTANCE_LABEL = ['', '随口', '一般', '值得记', '重要', '很重要'];

function normalizeImportance(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

function normalizeScope(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (s === 'long' || s === '长期') return SCOPE.LONG;
  if (s === 'short' || s === '短期') return SCOPE.SHORT;
  return SCOPE.SHORT;
}

function normalizeLayer(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (s === 'global' || s === '总体' || s === '共享') return LAYER.GLOBAL;
  return LAYER.SESSION;
}

export function loadMemories(dir) {
  const raw = readJsonSafe(path.join(dir, MEMORY_FILE), null, () => {});
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) {
    return { version: 1, nextId: 1, entries: [] };
  }
  return {
    version: 1,
    nextId: Number(raw.nextId) || (raw.entries.length + 1),
    entries: raw.entries.filter((e) => e && typeof e === 'object' && typeof e.text === 'string'),
  };
}

export function saveMemories(dir, store) {
  ensureDir(dir);
  writeJsonAtomic(path.join(dir, MEMORY_FILE), store);
}

/** 模型写一条记忆。返回落库后的条目。 */
export function addMemory(dir, { text, scope, importance, who, layer, source = 'model', now = Date.now() }) {
  const store = loadMemories(dir);
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('记忆内容不能为空');
  const entry = {
    id: `m${store.nextId}`,
    t: Number(now) || Date.now(),
    text: truncate(clean, 400),
    scope: normalizeScope(scope),
    layer: normalizeLayer(layer),
    importance: normalizeImportance(importance),
    who: truncate(String(who ?? ''), 40),
    source: String(source ?? 'model').slice(0, 20),
    lastAccess: 0,
    accessCount: 0,
    status: 'active',
  };
  store.nextId += 1;
  store.entries.push(entry);
  // 容量护栏：长期+短期合计最多 400 条，超出先丢最不重要的陈旧条目
  if (store.entries.length > 400) {
    store.entries.sort((a, b) => (a.importance * 100 + (a.t / DAY_MS)) - (b.importance * 100 + (b.t / DAY_MS)));
    store.entries.splice(0, store.entries.length - 400);
  }
  saveMemories(dir, store);
  writeMemoryMarkdown(dir, store);
  return entry;
}

export function forgetMemory(dir, id) {
  const store = loadMemories(dir);
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.id !== String(id));
  if (store.entries.length === before) return false;
  saveMemories(dir, store);
  writeMemoryMarkdown(dir, store);
  return true;
}

/** 记一次"被回忆"（供衰减策略判断是否还有用）。 */
export function touchMemory(dir, id, now = Date.now()) {
  const store = loadMemories(dir);
  const entry = store.entries.find((e) => e.id === String(id));
  if (!entry) return false;
  entry.lastAccess = Number(now) || Date.now();
  entry.accessCount = (Number(entry.accessCount) || 0) + 1;
  saveMemories(dir, store);
  return true;
}

/**
 * 执行遗忘策略：短期到期 → 重要的升长期、其余遗忘；长期陈旧 → 压缩或遗忘。
 * 纯规则、可解释；不调模型。返回本次动作统计。
 */
export function applyRetention(dir, { now = Date.now(), retention = DEFAULT_RETENTION } = {}) {
  const r = { ...DEFAULT_RETENTION, ...(retention ?? {}) };
  const store = loadMemories(dir);
  const stats = { promoted: 0, forgot: 0, compressed: 0, kept: 0 };
  const nowMs = Number(now) || Date.now();
  const shortMs = Math.max(1, Number(r.shortTermDays) || 3) * DAY_MS;

  for (const entry of store.entries) {
    if (entry.status !== 'active') continue;
    const age = nowMs - Number(entry.t || nowMs);
    const lastSeen = Math.max(Number(entry.lastAccess) || 0, Number(entry.t) || 0);
    const idle = nowMs - lastSeen;

    if (entry.scope === SCOPE.SHORT) {
      if (age < shortMs) { stats.kept += 1; continue; }
      // 短期到期：够重要就升长期（同时压缩成一行摘要），否则忘掉
      if (Number(entry.importance) >= Number(r.promoteImportance)) {
        entry.scope = SCOPE.LONG;
        entry.text = compressText(entry.text, Math.max(Number(r.longCompressChars) || 80, 120));
        entry.promotedAt = nowMs;
        stats.promoted += 1;
      } else {
        entry.status = 'forgotten';
        entry.forgottenAt = nowMs;
        stats.forgot += 1;
      }
      continue;
    }

    // 长期：长时间没被回忆 + 重要度不高 → 先压缩，再遗忘。
    // 重要度 >=4 的不压缩（约定、重要经历压缩掉细节就失去价值了）。
    if (idle > Number(r.longStaleDays) * DAY_MS && Number(entry.importance) <= Number(r.longForgetImportance)) {
      entry.status = 'forgotten';
      entry.forgottenAt = nowMs;
      stats.forgot += 1;
    } else if (idle > Number(r.longStaleDays) * DAY_MS && Number(entry.importance) < 4 && !entry.compressed) {
      entry.text = compressText(entry.text, Number(r.longCompressChars) || 80);
      entry.compressed = true;
      stats.compressed += 1;
    } else {
      stats.kept += 1;
    }
  }

  // 已遗忘的条目保留 7 天便于追溯，之后物理删除
  const cutoff = nowMs - 7 * DAY_MS;
  store.entries = store.entries.filter((e) => !(e.status === 'forgotten' && Number(e.forgottenAt) < cutoff));

  saveMemories(dir, store);
  writeMemoryMarkdown(dir, store);
  return stats;
}

function compressText(text, maxChars) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length <= maxChars) return s;
  return chars.slice(0, maxChars).join('') + '…';
}

/** 生成给模型/人看的 MEMORY.md（总体记忆在前，然后长期、短期）。 */
export function writeMemoryMarkdown(dir, store = loadMemories(dir)) {
  const active = store.entries.filter((e) => e.status === 'active');
  const lines = [];
  lines.push('# 记忆');
  lines.push('');
  lines.push('> 这些是**你自己决定记下**的事（不是聊天流水）。按重要度和新旧排序，会自动压缩与遗忘。');
  lines.push('> 修改请用 qq_memory_save / qq_memory_forget，手改会被下一次写入覆盖。');
  lines.push('');

  const sections = [
    [LAYER.GLOBAL, SCOPE.LONG, '## 总体记忆（跨群共享）', '（关于这个人/这件事本身，任何会话都查得到）'],
    [LAYER.SESSION, SCOPE.LONG, '## 本会话 · 长期记忆', '（重要，长期保留；很久不被想起且不重要时会压缩或遗忘）'],
    [LAYER.SESSION, SCOPE.SHORT, '## 本会话 · 短期记忆', `（默认保留 ${DEFAULT_RETENTION.shortTermDays} 天：够重要就升为长期，否则遗忘）`],
  ];
  for (const [layer, scope, title, hint] of sections) {
    const list = active
      .filter((e) => normalizeLayer(e.layer) === layer && e.scope === scope)
      .sort((a, b) => (b.importance - a.importance) || (b.t - a.t));
    lines.push(title + hint);
    if (!list.length) {
      lines.push('- （暂无）');
    } else {
      for (const e of list) {
        const date = formatDate(e.t);
        const star = '★'.repeat(Math.min(5, Number(e.importance) || 3));
        const who = e.who ? `${e.who}：` : '';
        const comp = e.compressed ? '（已压缩）' : '';
        lines.push(`- [${e.id}] ${date} ${star} ${who}${e.text}${comp}`);
      }
    }
    lines.push('');
  }
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, MEMORY_MD), lines.join('\n').trimEnd() + '\n', 'utf8');
  return {
    global: active.filter((e) => normalizeLayer(e.layer) === LAYER.GLOBAL).length,
    long: active.filter((e) => normalizeLayer(e.layer) === LAYER.SESSION && e.scope === SCOPE.LONG).length,
    short: active.filter((e) => normalizeLayer(e.layer) === LAYER.SESSION && e.scope === SCOPE.SHORT).length,
  };
}

export function readMemoryMarkdown(dir) {
  try { return fs.readFileSync(path.join(dir, MEMORY_MD), 'utf8'); } catch { return ''; }
}

function formatDate(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function importanceLabel(n) {
  return IMPORTANCE_LABEL[Math.min(5, Math.max(0, Math.round(Number(n) || 3)))] || '一般';
}

export { normalizeScope, normalizeImportance, normalizeLayer };
