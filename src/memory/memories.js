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
// 记忆的「归属层级」：global = 跨会话的共享记忆（关于某个人本身，任何群/私聊都查得到）；
// session = 只在这个会话里有效（群梗、本群约定、这里发生的事）。
export const LAYER = { GLOBAL: 'global', SESSION: 'session' };

// 保留策略：**只决定"什么时候该复核"，不替模型做删除/压缩的决定**。
// 到期条目会被标记 needsReview，由模型（qq_memory_review）判断留、改、合并还是忘。
export const DEFAULT_RETENTION = {
  shortTermDays: 3,        // 短期记忆 3 天后进入复核队列
  longStaleDays: 90,       // 长期记忆 90 天没被想起 → 进入复核队列
  capacityPerSession: 400, // 单会话容量告警线（超出时标记待复核，由模型决定删哪些）
  forgottenGraceDays: 7,   // 已遗忘条目保留几天便于追溯
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
  if (s === 'global' || s === '共享' || s === '总体') return LAYER.GLOBAL;
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
 * 到期检查：**只标记"该复核了"，不删除、不压缩**。
 *
 * 为什么不再自动遗忘：判断一条记忆"还重不重要、是否已过时、该并到哪条"
 * 需要语义理解，纯规则（★ + 天数）会误删事实（"载舟是徐文杰"当时给了 ★2，
 * 90 天后就被删了，但它是事实而不是"不重要"）。所以这里只把到期条目放进
 * 复核队列（needsReview），由模型用 qq_memory_review 决定去留。
 *
 * 纯机械的兜底仍在这里做（不需要判断）：已遗忘条目过期物理删除、容量超限丢尾部。
 */
export function applyRetention(dir, { now = Date.now(), retention = DEFAULT_RETENTION } = {}) {
  const r = { ...DEFAULT_RETENTION, ...(retention ?? {}) };
  const store = loadMemories(dir);
  const stats = { flagged: 0, purged: 0, trimmed: 0, kept: 0 };
  const nowMs = Number(now) || Date.now();
  const shortMs = Math.max(1, Number(r.shortTermDays) || 3) * DAY_MS;
  const staleMs = Math.max(1, Number(r.longStaleDays) || 90) * DAY_MS;

  for (const entry of store.entries) {
    if (entry.status !== 'active') continue;
    const age = nowMs - Number(entry.t || nowMs);
    const lastSeen = Math.max(Number(entry.lastAccess) || 0, Number(entry.t) || 0);
    const idle = nowMs - lastSeen;

    // 短期到期 / 长期陈旧 → 进复核队列（不自动处理）
    const due = entry.scope === SCOPE.SHORT ? age >= shortMs : idle >= staleMs;
    if (due && !entry.needsReview) {
      entry.needsReview = true;
      entry.reviewFlaggedAt = nowMs;
      entry.reviewReason = entry.scope === SCOPE.SHORT ? '短期到期' : '长期已久未想起';
      stats.flagged += 1;
    } else if (!due) {
      stats.kept += 1;
    }
  }

  // 机械兜底 1：已遗忘条目过了宽限期就物理删除
  const cutoff = nowMs - Math.max(0, Number(r.forgottenGraceDays) || 7) * DAY_MS;
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => !(e.status === 'forgotten' && Number(e.forgottenAt) < cutoff));
  stats.purged = before - store.entries.length;

  // 容量告警（**不删**）：超过上限时把最不重要且最旧的若干条标记为待复核，
  // 让模型在下次「睡眠」时自己决定删哪些——代码不替它做删除决定。
  const cap = Math.max(1, Number(r.capacityPerSession) || 400);
  const activeCount = store.entries.filter((e) => e.status === 'active').length;
  if (activeCount > cap) {
    const candidates = store.entries
      .filter((e) => e.status === 'active' && !e.needsReview)
      .sort((a, b) => (a.importance * 100 + (a.t / DAY_MS)) - (b.importance * 100 + (b.t / DAY_MS)));
    for (const e of candidates.slice(0, activeCount - cap)) {
      e.needsReview = true;
      e.reviewFlaggedAt = nowMs;
      e.reviewReason = '容量超限';
      stats.flagged += 1;
    }
    stats.overCapacity = activeCount - cap;
  }

  saveMemories(dir, store);
  writeMemoryMarkdown(dir, store);
  return stats;
}

/** 复核队列：列出到期条目，交给模型判断去留。 */
export function listReviewQueue(dir, { now = Date.now(), limit = 20 } = {}) {
  const store = loadMemories(dir);
  const nowMs = Number(now) || Date.now();
  return store.entries
    .filter((e) => e.status === 'active' && e.needsReview)
    .sort((a, b) => (Number(a.importance) || 3) - (Number(b.importance) || 3))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 20)))
    .map((e) => ({
      id: e.id,
      text: e.text,
      scope: e.scope,
      layer: normalizeLayer(e.layer),
      importance: e.importance,
      who: e.who || '',
      ageDays: Math.round((nowMs - Number(e.t)) / DAY_MS),
      idleDays: Math.round((nowMs - Math.max(Number(e.lastAccess) || 0, Number(e.t))) / DAY_MS),
      reviewReason: e.reviewReason || '',
    }));
}

/**
 * 模型对一条记忆做复核决定。
 * action:
 *   · 'keep'     保留（清掉复核标记，刷新"被想起"时间 → 重新计时）
 *   · 'forget'   遗忘（标记 forgotten，宽限期后物理删除）
 *   · 'compress' 压缩到 maxChars（保留核心信息）
 *   · 'promote'  短期升为长期
 *   · 'update'   改写内容（模型给新 text，也用于合并后的版本）
 */
export function reviewMemory(dir, id, action, { text, maxChars = 80, now = Date.now() } = {}) {
  const store = loadMemories(dir);
  const entry = store.entries.find((e) => e.id === String(id));
  if (!entry || entry.status !== 'active') return null;
  const nowMs = Number(now) || Date.now();

  switch (String(action || '').toLowerCase()) {
    case 'keep':
      entry.needsReview = false;
      entry.reviewedAt = nowMs;
      entry.lastAccess = nowMs;
      break;
    case 'forget':
      entry.status = 'forgotten';
      entry.forgottenAt = nowMs;
      entry.needsReview = false;
      break;
    case 'compress':
      entry.text = compressText(entry.text, Math.max(20, Number(maxChars) || 80));
      entry.compressed = true;
      entry.needsReview = false;
      entry.reviewedAt = nowMs;
      break;
    case 'promote':
      entry.scope = SCOPE.LONG;
      entry.promotedAt = nowMs;
      entry.needsReview = false;
      entry.reviewedAt = nowMs;
      break;
    case 'update': {
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
      if (!clean) throw new Error('update 需要新的 text');
      entry.text = truncate(clean, 400);
      entry.needsReview = false;
      entry.reviewedAt = nowMs;
      entry.lastAccess = nowMs;
      break;
    }
    default:
      throw new Error(`未知的复核动作：${action}（可用 keep/forget/compress/promote/update）`);
  }

  saveMemories(dir, store);
  writeMemoryMarkdown(dir, store);
  return entry;
}

function compressText(text, maxChars) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length <= maxChars) return s;
  return chars.slice(0, maxChars).join('') + '…';
}

/** 生成给模型/人看的 MEMORY.md（共享记忆在前，然后长期、短期）。 */
export function writeMemoryMarkdown(dir, store = loadMemories(dir)) {
  const active = store.entries.filter((e) => e.status === 'active');
  const lines = [];
  lines.push('# 记忆');
  lines.push('');
  lines.push('> 这些是**你自己决定记下**的事（不是聊天流水）。按重要度和新旧排序，会自动压缩与遗忘。');
  lines.push('> 修改请用 qq_memory_save / qq_memory_forget，手改会被下一次写入覆盖。');
  lines.push('');

  // 只渲染这个文件里**真实存在**的分区：共享层目录里不该出现"本会话"分区（反之亦然）。
  const hasLayer = (layer) => active.some((e) => normalizeLayer(e.layer) === layer);
  const sections = [
    [LAYER.GLOBAL, SCOPE.LONG, '## 共享记忆', '（关于这个人/这件事本身，任何会话都查得到）'],
    [LAYER.SESSION, SCOPE.LONG, '## 本会话 · 长期记忆', '（重要，长期保留；很久不被想起且不重要时会压缩或遗忘）'],
    [LAYER.SESSION, SCOPE.SHORT, '## 本会话 · 短期记忆', `（默认保留 ${DEFAULT_RETENTION.shortTermDays} 天：够重要就升为长期，否则遗忘）`],
  ].filter(([layer]) => hasLayer(layer));
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
        // 待复核的条目在文件里也标出来，方便人/模型一眼看到
        const review = e.needsReview ? ' `⏳待复核`' : '';
        lines.push(`- [${e.id}] ${date} ${star} ${who}${e.text}${comp}${review}`);
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







