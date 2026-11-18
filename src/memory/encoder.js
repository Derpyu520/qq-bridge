// 编码层：把一条 QQ 消息变成一条可持久化的记忆事件。
//
// 人类侧对应：编码加工深度 + 情绪唤醒 + 与"我"的相关性 + 新颖性。
// 这里全是规则算分（不调模型）：salience ∈ [0,1]，≥ 阈值才落盘到 L1 事件流，
// 否则只留在内存 ring buffer —— 对应"没走心的闲聊不进长期记忆"。
//
// 注意：salience 只决定"要不要记"，不决定"能不能改人格"。权重 w 在检索时另算（weights.js）。
import { clamp01, truncate } from './util.js';
import { jaccard } from './tokenize.js';

export const DEFAULT_BOT_NAMES = ['小鲸鱼', 'DeepSeek', 'deepseek', '大肥鱼', '鲸鱼', 'D指导', 'd指导', 'D老师', 'd老师', 'DS'];

const EMOTION_RE = /(?:哈{2,}|笑死|笑不活|哭了|气死|烦死|难受|破防|离谱|卧槽|牛逼|绝了|好耶|难受|破防|寄了|绷不住|yyds|乐死|太.{0,2}了)/i;
const EMOTION_SCORE = 1;

export function isAddressedToBot(msg, botNames = DEFAULT_BOT_NAMES) {
  if (msg?.quoteTargetIsSelf) return true;
  const text = String(msg?.plain ?? msg?.text ?? '').toLowerCase();
  return botNames.some((name) => text.includes(String(name).toLowerCase()));
}

/**
 * 计算一条消息的 salience 及分项，便于调参与测试。
 * 权重：0.30 直接对我 + 0.20 情绪 + 0.20 新颖 + 0.15 关系 + 0.10 重复 + 0.05 时间感
 * （与设计文档 §4.1 对齐；"重复"在这里表示与同一个人的重复互动，稳定的关系更值得记）
 */
export function salienceBreakdown(msg, ctx = {}) {
  const now = Number(ctx.now) || Date.now();
  const botNames = Array.isArray(ctx.botNames) && ctx.botNames.length ? ctx.botNames : DEFAULT_BOT_NAMES;
  const text = String(msg?.plain ?? msg?.text ?? '');
  const recentTexts = Array.isArray(ctx.recentTexts) ? ctx.recentTexts : [];
  const profile = ctx.profile || null;

  const addressed = isAddressedToBot(msg, botNames) ? 1 : 0;
  const emotion = EMOTION_RE.test(text) ? EMOTION_SCORE * 0.8 : 0;
  const novelty = recentTexts.length
    ? clamp01(1 - Math.max(...recentTexts.map((prev) => jaccard(text, prev))))
    : 1;
  const relation = profile
    ? clamp01(0.15 + 0.12 * Math.log1p(Math.max(0, Number(profile.count) || 0)))
    : 0.1;
  const repetition = profile ? clamp01(Math.log1p(Math.max(0, Number(profile.count) || 0)) / 4) : 0;
  const hour = new Date(now).getHours();
  const timeFit = hour >= 19 || hour <= 1 ? 1 : hour >= 11 && hour <= 14 ? 0.7 : 0.5;

  const parts = { addressed, emotion, novelty, relation, repetition, timeFit };
  const weights = { addressed: 0.3, emotion: 0.2, novelty: 0.2, relation: 0.15, repetition: 0.1, timeFit: 0.05 };
  let score = 0;
  for (const key of Object.keys(weights)) score += weights[key] * parts[key];

  return { score: clamp01(score), parts };
}

/** 什么时候无论如何都要记：owner 说话、引用我、拍一拍 → 即使分数低也算"有意义的互动"。 */
export function isForcedMemory(msg) {
  return Boolean(msg?.isOwner || msg?.quoteTargetIsSelf || msg?.kind === 'poke');
}

/**
 * 消息 → 事件对象（L1 的存储形态）。
 * 字段刻意扁平、可 JSON 序列化；text 截断到 160 字，避免一条消息把事件文件撑大。
 */
export function eventFromMessage(msg, { salience = 0.5, kind = null, source = null, now = Date.now() } = {}) {
  const time = Number(msg?.time) || now;
  const isSelf = Boolean(msg?.isSelf);
  const evKind = kind || (msg?.kind === 'poke' ? 'poke' : isSelf ? 'self' : 'msg');
  const evSource = source || (msg?.isOwner ? 'owner' : isSelf ? 'ai-observed' : 'group-claimed');
  return {
    v: 1,
    t: time,
    seq: Number(msg?.seq) || 0,
    kind: evKind,
    source: evSource,
    sender: truncate(String(msg?.sender ?? (isSelf ? '我' : '未知')), 40),
    userId: msg?.userId != null ? String(msg.userId) : null,
    isOwner: Boolean(msg?.isOwner),
    isSelf,
    quotedSelf: Boolean(msg?.quoteTargetIsSelf),
    text: truncate(String(msg?.plain ?? msg?.text ?? ''), 160),
    importance: clamp01(salience),
    strength: 1,
    accessCount: 0,
  };
}

/**
 * 自己的发言要不要进事件流？
 *
 * 以前是「每条都记」，结果自己占事件流 60%~94%（"草""？""哈哈"全进），
 * 把群友说的偏好/约定挤出「最近的记忆」。这里按信息量过一遍：
 *   · 约定/偏好/提醒类词句 —— 一定记（以后要兑现、或别踩雷）；
 *   · 提问/反问 —— 记（说明当时在追问什么）；
 *   · 其余要有一定长度才记（太短的语气词没有连续性价值）。
 */
const SELF_INFO_RE = /(说好|约好|答应|记得|别忘|提醒|明天|后天|下周|改天|生日|喜欢|讨厌|不爱|最怕|帮你|告诉我|回头|待会|等我)/;

export function isSelfEventWorthKeeping(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (SELF_INFO_RE.test(s)) return true;
  if (/[?？]$/.test(s) && Array.from(s).length >= 6) return true;
  return Array.from(s).length >= 12;
}

/** 自己说过的话：也进事件流（"我上次说过什么"是人格连续的一部分）。 */
export function selfEventFromText(text, { now = Date.now(), seq = 0, importance = 0.4 } = {}) {
  return {
    v: 1,
    t: now,
    seq,
    kind: 'self',
    source: 'ai-observed',
    sender: '我',
    userId: null,
    isOwner: false,
    isSelf: true,
    quotedSelf: false,
    text: truncate(String(text ?? ''), 160),
    // 0.4 而不是 0.5：自己说的话对「记得别人」的价值低于别人说的，
    // 也让它在权重排序里自然排在群友信息之后，而不是靠数量压过去。
    importance,
    strength: 1,
    accessCount: 0,
  };
}

/** 更新"关于他们"的画像（纯计数，不存任何推断性结论）。 */
export function updateProfile(profile, msg, now = Date.now()) {
  const name = String(msg?.sender ?? '').trim() || (msg?.userId != null ? String(msg.userId) : '未知');
  const isSelf = Boolean(msg?.isSelf);
  if (isSelf) return profile;
  const base = profile && typeof profile === 'object' ? profile : {};
  const text = truncate(String(msg?.plain ?? msg?.text ?? ''), 80);
  return {
    name,
    userId: msg?.userId != null ? String(msg.userId) : base.userId ?? null,
    isOwner: Boolean(msg?.isOwner ?? base.isOwner),
    count: Math.max(0, Number(base.count) || 0) + 1,
    firstSeen: Number(base.firstSeen) || now,
    lastSeen: now,
    lastText: text || base.lastText || '',
  };
}
