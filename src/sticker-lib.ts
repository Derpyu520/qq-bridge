// 表情包体系（二代仿真模式）——本地表情知识库与策略提示纯函数。
//
// 职责：
// - state/stickers.json 的读写与字段归一化
// - 把 SnowLuma `fetch_custom_face_detail` 返回的 QQ 收藏表情合并进本地库
// - 支持按 emoji_id / md5 / url 查找、按备注/本地笔记/标签搜索
// - 生成注入 AI 的“表情包策略/可用表情”摘要
//
// 设计原则：
// - QQ 账号的收藏表情是“源”，本地库是“AI 认知层”：保留 AI 学习到的含义/标签/使用次数，
//   不覆盖 QQ 的备注；QQ desc 为空时 AI 可以看图后用 qq_sticker_note 记录自己的理解。
// - 所有文本只做展示/提示，不执行任何本地操作。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type StickerSource = 'manual' | 'ai' | 'qq';

export interface StickerEntry {
  id: string;
  resId: string;
  url: string;
  md5: string;
  desc: string;
  localNote: string;
  tags: string[];
  usage: string;
  source: StickerSource;
  useCount: number;
  lastUsedAt: number;
  lastContext: string;
  createdAt: string;
  updatedAt: string;
}

export interface StickerNotePatch {
  note?: string;
  tags?: string[];
  usage?: string;
  source?: StickerSource;
}

type AnyRecord = Record<string, any>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw: unknown): StickerEntry | null {
  const entry: AnyRecord = raw && typeof raw === 'object' ? (raw as AnyRecord) : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t: unknown) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  const rawSource = entry.source;
  const source: StickerSource =
    rawSource === 'manual' ? 'manual' : rawSource === 'ai' ? 'ai' : 'qq';
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    source,
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso()),
  };
}

export function loadStickerStore(file: string): StickerEntry[] {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStickerEntry).filter((e): e is StickerEntry => e != null);
  } catch {
    return [];
  }
}

export function saveStickerStore(file: string, entries: StickerEntry[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 把 SnowLuma 返回的 QQ 收藏表情详情合并进本地库。
// 保留本地 AI 认知字段（localNote/tags/usage/useCount/lastUsedAt/lastContext），
// 只更新 QQ 侧字段（id/resId/url/md5/desc）。
export function mergeStickerLibrary(existing: StickerEntry[], fetched: unknown): StickerEntry[] {
  const out: StickerEntry[] = existing.map(normalizeStickerEntry).filter((e): e is StickerEntry => e != null);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedArr = Array.isArray(fetched) ? fetched : [];
  const fetchedIds = new Set<string>();
  for (const item of fetchedArr) {
    const id = String((item as AnyRecord)?.emoji_id || (item as AnyRecord)?.resId || (item as AnyRecord)?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const raw of fetchedArr) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as AnyRecord;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso(),
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
    }
  }
  // 清理已被 QQ 端删除的收藏表情（保留手动/本地新增的非 qq 来源条目）。
  return out.filter((e) => e.source !== 'qq' || fetchedIds.has(e.id));
}

// 通过 emoji_id / md5 / url（支持模糊：去掉大小写、尾斜杠、URL 查询）查找。
export function findSticker(entries: unknown, ref: unknown): StickerEntry | null {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const id = raw;
  const md5 = raw.toUpperCase();
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  return (
    (Array.isArray(entries) ? entries : []).find((e) => {
      if (!e) return false;
      if (e.id === id || e.resId === id) return true;
      if (e.md5 && e.md5 === md5) return true;
      const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
      if (eUrl && urlNormalized && (eUrl === urlNormalized || eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))) return true;
      return false;
    }) || null
  );
}

// 格式化给 AI 看的表情列表；query 会匹配 desc/localNote/tags/usage/id/md5。
export function formatStickerList(
  entries: unknown,
  query = '',
  limit = 48,
): { total: number; matched: number; truncated: boolean; stickers: StickerEntry[] } {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter((e): e is StickerEntry => e != null);
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max);
  return {
    total: list.length,
    matched: filtered.length,
    truncated: filtered.length > max,
    stickers: items,
  };
}

// 生成注入 AI 的“可用表情包”摘要（不暴露完整 URL，避免上下文爆炸）。
export function buildStickerContext(entries: unknown, max = 8): string {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter((e): e is StickerEntry => e != null);
  if (!list.length) return '';
  const top = [...list]
    .sort(
      (a, b) =>
        (b.useCount || 0) - (a.useCount || 0) ||
        (b.desc || b.localNote ? 1 : 0) - (a.desc || a.localNote ? 1 : 0),
    )
    .slice(0, Math.max(1, Math.min(30, Number(max) || 8)));
  const lines = top.map((e) => {
    const label = e.desc || e.localNote || '（无备注，可先看图）';
    const extra = e.tags?.length ? ` [${e.tags.join('/')}]` : '';
    const used = e.useCount ? `（用过${e.useCount}次）` : '';
    return `- ${label}${extra}${used}`;
  });
  return `【可用表情包】你的 QQ 收藏表情里有 ${list.length} 个表情（以下为常用/有备注的 ${top.length} 个，完整列表请用 qq_list_stickers 查看）：\n${lines.join('\n')}`;
}

// 二代仿真模式下的“真人发表情包”策略提示。
// 这是软策略：AI 仍自主判断是否使用，桥接不强制。
export function buildStickerStrategyHint(): string {
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    '- 频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '- 选择：优先用备注（desc）和你的记忆（localNote/tags）能准确对上语境的；没有备注/不确定的表情，先 qq_get_sticker_image 看图再决定，不要瞎发。',
    '- 发送：用 qq_send_sticker；一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话先用 qq_send_message / qq_reply 作为单独气泡发出，再单独发表情。需要引用/点名时传 replyToMessageId / atUserId（群聊）。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里；不要把表情包当回复的唯一内容（偶尔可以，但别让群友觉得你在敷衍）。',
    '- 学习：看到新表情不确定含义时，先用 qq_get_sticker_image 看图，再用 qq_sticker_note 记下你的理解，下次就能更准地选。',
  ].join('\n');
}

// 把 AI 本地认知（note/tags/usage）更新到一条表情记录上，并返回新数组。
export function applyStickerNote(
  entries: unknown,
  id: unknown,
  patch: StickerNotePatch = {},
): { entries: StickerEntry[]; entry: StickerEntry | null } {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter((e): e is StickerEntry => e != null);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso(),
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

// 记录一次“使用”，返回新数组。
export function markStickerUsed(
  entries: unknown,
  id: unknown,
  context = '',
): { entries: StickerEntry[]; entry: StickerEntry | null } {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter((e): e is StickerEntry => e != null);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso(),
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}
