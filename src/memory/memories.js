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

/** 归一化：去空白/标点、统一全半角、去掉常见语气词，便于判重。 */
function normalizeForCompare(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：,.!?;:（）()【】\[\]"'“”‘’…—-]/g, '')
    .toLowerCase();
}

/**
 * 写入记忆。
 *
 * **合并/去重这类判断交给模型**，这里只做三件机械的事：
 *   1) 完全相同文本 → 不新增（返回已有条目，防止工具重试/手滑重复）；
 *   2) 模型显式给了 `replaceId` → 覆盖那一条（模型先 qq_memory_recall 看过、决定"合并进这条"）；
 *   3) 否则新增。
 *
 * 为什么不在服务端算相似度：判断"两条记忆是不是同一件事、该并成什么措辞"需要语义理解，
 * 字符串相似度既会误合（不同人的相似句式）也会漏合（同一事实换了个说法）。
 * 模型每次写入前会先 recall 相关记忆（提示词与工具描述里都要求这么做），
 * 看到已有条目后自己决定是新增、还是带 replaceId 合并改写。
 */
export function addMemory(dir, {
  text, scope, importance, who, layer, replaceId, source = 'model', now = Date.now(),
}) {
  const store = loadMemories(dir);
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('记忆内容不能为空');
  const nowMs = Number(now) || Date.now();
  const nextScope = normalizeScope(scope);
  const nextLayer = normalizeLayer(layer);
  const nextImportance = normalizeImportance(importance);
  const nextWho = truncate(String(who ?? ''), 40);

  // 1) 完全相同（归一化后）→ 视为重复提交，不新增
  const targetId = String(replaceId ?? '').trim();
  const dup = store.entries.find((e) => e.status === 'active'
    && (e.id === targetId || (!targetId && normalizeForCompare(e.text) === normalizeForCompare(clean))));
  if (dup) {
    const isExplicit = Boolean(targetId);
    if (isExplicit) {
      // 模型明确说"并进这条"：按模型给的内容改写
      dup.text = truncate(clean, 400);
      dup.scope = nextScope;
      dup.layer = nextLayer;
      dup.importance = Math.max(Number(dup.importance) || 3, nextImportance);
      dup.who = nextWho || dup.who;
    }
    // 无论哪种，都算"又被确认了一次"（重要度在反复确认后小幅上调）
    dup.reinforceCount = (Number(dup.reinforceCount) || 1) + 1;
    dup.lastReinforcedAt = nowMs;
    dup.lastAccess = nowMs;
    dup.accessCount = (Number(dup.accessCount) || 0) + 1;
    if (dup.reinforceCount >= 3) dup.importance = Math.min(5, Number(dup.importance) + 1);
    saveMemories(dir, store);
    writeMemoryMarkdown(dir, store);
    return { ...dup, merged: true, mergedInto: dup.id, replaced: isExplicit };
  }

  // 2) 新增
  const entry = {
    id: `m${store.nextId}`,
    t: nowMs,
    text: truncate(clean, 400),
    scope: nextScope,
    layer: nextLayer,
    importance: nextImportance,
    who: nextWho,
    source: String(source ?? 'model').slice(0, 20),
    lastAccess: 0,
    accessCount: 0,
    reinforceCount: 1,
    status: 'active',
  };
  store.nextId += 1;
  store.entries.push(entry);
  // 容量护栏：合计最多 400 条，超出先丢最不重要的陈旧条目
  if (store.entries.length > 400) {
    store.entries.sort((a, b) => (a.importance * 100 + (a.t / DAY_MS)) - (b.importance * 100 + (b.t / DAY_MS)));
    store.entries.splice(0, store.entries.length - 400);
  }
  saveMemories(dir, store);
  writeMemoryMarkdown(dir, store);
  return { ...entry, merged: false };
}

/**
 * 列出候选记忆供模型判断是否该合并（**不自动合并**，只把候选交给模型看）。
 * 用于"写入前先读"：模型拿到同一个人/同一层已有的记忆，自己决定新增还是带 replaceId 改写。
 */
export function listCandidates(dir, { who, layer, limit = 12 } = {}) {
  const store = loadMemories(dir);
  const targetLayer = normalizeLayer(layer);
  const active = store.entries.filter((e) => e.status === 'active' && normalizeLayer(e.layer) === targetLayer);
  const list = who
    ? active.filter((e) => !e.who || e.who === String(who))
    : active;
  return list
    .sort((a, b) => (Number(b.importance) || 3) - (Number(a.importance) || 3))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 12)))
    .map((e) => ({ id: e.id, text: e.text, scope: e.scope, layer: normalizeLayer(e.layer), importance: e.importance, who: e.who || '', t: e.t }));
}
/**
 * 清理**完全重复**的条目（同一文本被重复写入，例如工具重试）。
 *
 * 刻意不做"相似合并"：两条记忆是不是同一件事、该并成什么措辞，交给模型判断
 * （写入时带 replaceId 合并）。这里只处理机械性重复，且保留重要度最高/最常被确认的那条。
 */
export function consolidateMemories(dir, { now = Date.now() } = {}) {
  const store = loadMemories(dir);
  const stats = { merged: 0, kept: 0 };
  const byKey = new Map();
  const drop = new Set();
  for (const entry of store.entries) {
    if (entry.status !== 'active') continue;
    const key = `${normalizeLayer(entry.layer)}|${entry.who || ''}|${normalizeForCompare(entry.text)}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, entry); continue; }
    // 重复：保留重要度更高的那条，把次数/访问量并过去
    const [keep, gone] = (Number(prev.importance) || 3) >= (Number(entry.importance) || 3) ? [prev, entry] : [entry, prev];
    keep.reinforceCount = (Number(keep.reinforceCount) || 1) + (Number(gone.reinforceCount) || 1);
    keep.accessCount = (Number(keep.accessCount) || 0) + (Number(gone.accessCount) || 0);
    keep.lastAccess = Math.max(Number(keep.lastAccess) || 0, Number(gone.lastAccess) || 0);
    keep.lastReinforcedAt = Number(now) || Date.now();
    byKey.set(key, keep);
    drop.add(gone.id);
    stats.merged += 1;
  }
  if (stats.merged) {
    store.entries = store.entries.filter((e) => !drop.has(e.id));
    saveMemories(dir, store);
    writeMemoryMarkdown(dir, store);
  }
  stats.kept = store.entries.filter((e) => e.status === 'active').length;
  return stats;
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



