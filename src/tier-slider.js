// 响应档位滑条的换算：滑条位置（0~100）↔ 档位 / 随机概率。
//
// 语义与 QQ Agent（Kondius/qq-agent）的 `src/tier-slider.js` 保持一致，
// 分段与公式逐字复刻，方便两边行为一致、也方便日后对齐：
//
//   0 ──── 10 ──── 20 ───────────────── 90 ──── 100
//   │  1 档  │  2 档 │      3 档（概率线性 0→100%）      │ 4 档 │
//   仅艾特    +关键词   随机响应（概率线性增长）        全响应
//
// 3 档概率线性，公式 prob = (pos - 20) / (90 - 20) * 100
//   pos=20 → 0%   pos=55（该段正中）→ 50%   pos=90 → 100%
//
// 刻意做成**零依赖模块**：不 import bridge.js 里的任何东西，
// 避免配置换算与运行时判定之间形成循环依赖。

/** 滑条各段的分界位置 */
export const TIER_SLIDER_BANDS = {
  tier1End: 10,     // 0~10  → 1 档（仅艾特）
  tier2End: 20,     // 10~20 → 2 档（+关键词）
  tier3End: 90      // 20~90 → 3 档（随机响应）；90~100 → 4 档（全响应）
};

/** 档位名称（与 QQ Agent 的档位语义一致，用于控制台与提示词） */
export const TIER_NAMES = {
  1: '仅艾特',
  2: '关键词',
  3: '随机响应',
  4: '全响应'
};

/** 档位一句话说明 */
export const TIER_DESCRIPTIONS = {
  1: '只有被 @ / 引用 / 叫名字 / 被提问时才回应',
  2: '1 档 + 命中关键词（或被指定成员发言）时回应',
  3: '1~2 档 + 按滑条概率随机回应',
  4: '任何消息都回应'
};

/**
 * 滑条位置 → { tier, randomPercent }
 * @param {number} pos 0~100，非法值或 NaN 按 100（4 档）处理
 */
export function sliderToTier(pos) {
  const b = TIER_SLIDER_BANDS;
  const raw = Number(pos);
  if (!Number.isFinite(raw)) return { tier: 4, randomPercent: 100 };
  const p = Math.min(100, Math.max(0, raw));

  if (p <= b.tier1End) return { tier: 1, randomPercent: 0 };
  if (p <= b.tier2End) return { tier: 2, randomPercent: 0 };
  if (p <= b.tier3End) {
    const pct = ((p - b.tier2End) / (b.tier3End - b.tier2End)) * 100;
    return { tier: 3, randomPercent: Math.round(pct * 10) / 10 };
  }
  return { tier: 4, randomPercent: 100 };
}

/**
 * { tier, randomPercent } → 滑条位置（把已保存的配置还原成滑条位置）
 * @param {number} tier 1~4
 * @param {number} randomPercent 仅 tier===3 时有效（0~100）
 */
export function tierToSlider(tier, randomPercent = 0) {
  const b = TIER_SLIDER_BANDS;
  const t = Math.min(4, Math.max(1, Number(tier) || 4));
  const pct = Math.min(100, Math.max(0, Number(randomPercent) || 0));

  if (t === 1) return Math.round(b.tier1End / 2);                     // 该段中点
  if (t === 2) return Math.round((b.tier1End + b.tier2End) / 2);
  if (t === 3) return Math.round(b.tier2End + (pct / 100) * (b.tier3End - b.tier2End));
  return Math.round((b.tier3End + 100) / 2);
}

/** 便于控制台显示的一句话摘要 */
export function describeTier(pos) {
  const { tier, randomPercent } = sliderToTier(pos);
  const name = TIER_NAMES[tier] ?? `${tier} 档`;
  return tier === 3 ? `${tier} 档 · ${name} ${randomPercent}%` : `${tier} 档 · ${name}`;
}
