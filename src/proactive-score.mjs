// 每会话「主动概率调整」（纯逻辑，可离线回归）。
//
// 语义（与 v2 全局基础概率配合）：
//   某会话的主动概率 = clamp( socialV2.proactive.probability + 该会话的 proactiveDelta, 0, 1 )
// 再乘调度器里的四道修正（待说想法 / 刚回过话 / 夜间 / 刷屏）。
//
// 为什么是有符号调整而不是"额外概率"：基础概率是所有会话共用的底，只加不减的话
// 就没法把某个群调得比全局更安静，只能 /mute 一刀切。
export const PROACTIVE_DELTA_MIN = -1;
export const PROACTIVE_DELTA_MAX = 1;

/** 归一化调整值：缺省/非法 → 0，超出 ±1 夹回去。 */
export function normalizeProactiveDelta(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(PROACTIVE_DELTA_MAX, Math.max(PROACTIVE_DELTA_MIN, n));
}

/** 基础概率 + 本会话调整，夹在 0~1。 */
export function effectiveProactiveProbability(base, delta) {
  const b = Number(base);
  const baseProb = Number.isFinite(b) ? Math.min(1, Math.max(0, b)) : 0;
  return Math.min(1, Math.max(0, baseProb + normalizeProactiveDelta(delta)));
}

/** 日志/控制台用：0.2 → '20%'，0.155 → '16%'（四舍五入到整数百分比）。 */
export function formatProbability(value) {
  const n = Math.min(1, Math.max(0, Number(value) || 0));
  return `${Math.round(n * 100)}%`;
}

/** 日志用：0 → '0'，0.2 → '+20%'，-0.15 → '-15%'。 */
export function formatDelta(value) {
  const n = normalizeProactiveDelta(value);
  if (n === 0) return '0';
  const pct = Math.round(n * 100);
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

/**
 * 一次主动判定的完整算式（调度器只负责取状态、打日志、发唤醒）。
 *
 * 顺序：基础 + 本会话调整 → 夹取 → 乘四道修正（待说想法 / 刚回过话 / 夜间 / 刷屏）
 *      → 再要求「安静够久」且「会话不忙」。
 *
 * @param {object} p
 * @param {number} p.base 全局基础概率（socialV2.proactive.probability）
 * @param {number} p.delta 本会话调整（−1~1）
 * @param {number} p.idleMs 距最后一条进线消息的毫秒数
 * @param {number} p.idleThresholdMs 安静阈值
 * @param {number} [p.pendingThoughts] 未过期的「待说想法」条数
 * @param {number} [p.lastAiReplyAt] 上次自己发言的时间戳（0=没有）
 * @param {number} [p.aiCount] 最近一小时内自己发的条数
 * @param {number} [p.now] 判定时刻
 * @param {boolean} [p.busy] 会话是否正忙（回合未结束）
 * @param {() => number} [p.random] 注入随机源，便于测试
 * @returns {{base:number, delta:number, combined:number, probability:number, mods:string[], idleOk:boolean, busy:boolean, fire:boolean}}
 */
export function evaluateProactiveCheck({
  base,
  delta,
  idleMs,
  idleThresholdMs,
  pendingThoughts = 0,
  lastAiReplyAt = 0,
  aiCount = 0,
  now = Date.now(),
  busy = false,
  random = Math.random
} = {}) {
  const baseProb = Math.min(1, Math.max(0, Number(base) || 0));
  const normalizedDelta = normalizeProactiveDelta(delta);
  const combined = effectiveProactiveProbability(baseProb, normalizedDelta);
  let probability = combined;
  const mods = [];
  if (Number(pendingThoughts) > 0) { probability = Math.min(1, probability * 1.4); mods.push('有待说想法×1.4'); }
  if (Number(lastAiReplyAt) > 0 && now - Number(lastAiReplyAt) < 30 * 60 * 1000) { probability *= 0.5; mods.push('刚回过话×0.5'); }
  const hour = new Date(now).getHours();
  if (hour >= 23 || hour < 8) { probability *= 0.3; mods.push('夜间×0.3'); }
  if (Number(aiCount) >= 5) { probability *= 0.3; mods.push('一小时≥5条×0.3'); }
  const idleOk = Number(idleMs) >= Number(idleThresholdMs);
  const fire = idleOk && busy !== true && random() < probability;
  return { base: baseProb, delta: normalizedDelta, combined, probability, mods, idleOk, busy: busy === true, fire };
}
