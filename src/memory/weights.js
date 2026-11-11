// 记忆权重与遗忘曲线（纯规则，不需要 LLM 参与）。
//
// 设计依据（docs/design/MEMORY_PLUGIN_DESIGN.md §4.3 / §4.6）：
//   检索分 = 0.60 × 语义相关 + 0.40 × 记忆权重 w
//   w = clamp01(0.30·importance + 0.20·confidence + 0.15·source + 0.15·recency
//              + 0.10·access + 0.10·relation) × kindMultiplier
//
// 关键约束：w 只能由 node 侧按事件字段算出来，模型不能写、不能改 ——
// 否则它一句"这条很重要"就能把任何闲话永久钉在提示词里。
//
// 遗忘曲线用双指数（快/慢两个时间常数）而不是单指数：
//   单指数在"刚发生"处掉得太快、在"很久以前"处又掉得太慢；
//   双指数能同时表达"细节先忘、梗概后忘"，这也是人类遗忘曲线的常见拟合形式。
//   R(Δ) = λ·e^(-Δ/τ_fast) + (1-λ)·e^(-Δ/τ_slow)
//   τ_fast = tauFastDays · importance · strength
//   τ_slow = tauSlowDays · importance · (1 + 0.5·ln(1+accessCount)) · strength
import { DAY_MS, clamp01 } from './util.js';

export const DEFAULT_FORGETTING = {
  tauFastDays: 1.5,
  tauSlowDays: 30,
  fastShare: 0.6,
  profileTauDays: 90,
  eventMaxDays: 30,
  eventMaxCount: 2000,
};

export const DEFAULT_WEIGHTS = {
  importance: 0.3,
  confidence: 0.2,
  source: 0.15,
  recency: 0.15,
  access: 0.1,
  relation: 0.1,
};

export const SOURCE_WEIGHTS = {
  owner: 1.0,          // owner 亲口说的：最高信用
  'ai-observed': 0.7,  // 自己观察到/自己说过的
  'group-claimed': 0.35, // 群友单方面声称的：低信用
};

export const KIND_MULTIPLIERS = {
  promise: 1.15, // 承诺/约定：最该记住
  grouplore: 1.0,
  fact: 1.0,
  event: 0.9,
  trait: 0.85,
  self: 0.95,
  msg: 0.9,
  poke: 0.8,
};

export const W_TIERS = {
  strong: 0.55, // 可主动提起（仅限 3 天内）
  inject: 0.35, // 正常注入
  weak: 0.25,   // 只有被问到才用一句
};

export function sourceWeight(source) {
  return SOURCE_WEIGHTS[source] ?? 0.5;
}

export function kindMultiplier(kind) {
  return KIND_MULTIPLIERS[kind] ?? 1;
}

/**
 * 双指数遗忘曲线。返回 [0,1] 的保留率。
 * @param {number} ageMs 距现在多久
 * @param {{importance?: number, accessCount?: number, strength?: number}} item
 * @param {{tauFastDays?: number, tauSlowDays?: number, fastShare?: number}} [cfg]
 */
export function retention(ageMs, item = {}, cfg = DEFAULT_FORGETTING) {
  const ageDays = Math.max(0, Number(ageMs) || 0) / DAY_MS;
  const importance = clamp01(item.importance ?? 0.5);
  const accessCount = Math.max(0, Number(item.accessCount) || 0);
  const strength = Math.min(2.5, Math.max(0.2, Number(item.strength) || 1));
  const fastShare = clamp01(cfg.fastShare ?? 0.6);
  const tauFast = Math.max(0.05, (cfg.tauFastDays ?? 1.5) * importance * strength);
  const tauSlow = Math.max(0.1, (cfg.tauSlowDays ?? 30) * importance * (1 + 0.5 * Math.log1p(accessCount)) * strength);
  return fastShare * Math.exp(-ageDays / tauFast) + (1 - fastShare) * Math.exp(-ageDays / tauSlow);
}

/** 访问次数归一化：0 次 → 0，越多越接近 1（收益递减）。 */
export function accessNorm(count) {
  return 1 - 1 / (1 + Math.max(0, Number(count) || 0));
}

/** 关系亲密度：owner 最高；聊得越多越近，30 天不见就淡（不归零）。 */
export function profileRapport(profile, now = Date.now(), cfg = DEFAULT_FORGETTING) {
  if (!profile) return 0;
  if (profile.isOwner) return 1;
  const count = Math.max(0, Number(profile.count) || 0);
  const base = Math.min(0.8, 0.25 + 0.12 * Math.log1p(count));
  const lastSeen = Number(profile.lastSeen) || now;
  const ageDays = Math.max(0, now - lastSeen) / DAY_MS;
  return clamp01(base * Math.exp(-ageDays / (cfg.profileTauDays ?? 90)));
}

export function relationNorm(profile, now = Date.now(), cfg = DEFAULT_FORGETTING) {
  if (!profile) return 0.2;
  if (profile.isOwner) return 1;
  return clamp01(0.2 + profileRapport(profile, now, cfg) * 0.8);
}

/**
 * 记忆权重 w：0~1。事件/事实/画像都走同一个公式，便于比较与调参。
 * @param {{t?: number, time?: number, importance?: number, confidence?: number, strength?: number,
 *          source?: string, kind?: string, accessCount?: number}} item
 * @param {{now?: number, profile?: object, weights?: object, forgetting?: object}} [ctx]
 */
export function computeW(item, ctx = {}) {
  const now = Number(ctx.now) || Date.now();
  const weights = { ...DEFAULT_WEIGHTS, ...(ctx.weights ?? {}) };
  const forgetting = { ...DEFAULT_FORGETTING, ...(ctx.forgetting ?? {}) };
  const t = Number(item.t ?? item.time) || now;
  const age = Math.max(0, now - t);
  const importance = clamp01(item.importance ?? 0.5);
  const confidence = clamp01(item.confidence ?? item.strength ?? 0.5);
  const parts = {
    importance,
    confidence,
    source: sourceWeight(item.source),
    recency: Math.sqrt(retention(age, { ...item, importance }, forgetting)),
    access: accessNorm(item.accessCount),
    relation: relationNorm(ctx.profile, now, forgetting),
  };
  let sum = 0;
  for (const name of Object.keys(DEFAULT_WEIGHTS)) sum += (Number(weights[name]) || 0) * parts[name];
  return clamp01(sum * kindMultiplier(item.kind));
}

export function wTier(w) {
  const value = clamp01(w);
  if (value >= W_TIERS.strong) return 'strong';
  if (value >= W_TIERS.inject) return 'inject';
  if (value >= W_TIERS.weak) return 'weak';
  return 'off';
}
