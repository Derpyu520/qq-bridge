// 分条发送的节流计算：消息之间隔多久。
//
// 2026-10-26 从 src/bridge.js 的 main() 里搬出来（原样搬运，一行没改）。
// 全是纯函数：不读配置对象之外的东西，不碰时间、不碰网络 —— 只有 `auto` 模式里
// 用 Math.random 抽抖动，抽完仍会 clampGapV2 收进区间，所以测试只能断言范围，
// 不能断言具体数值。

export function clampGapV2(ms, sendCfg) {
  const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
  const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
  return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
}

export function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
  const delays = [];
  if (!messages || messages.length <= 1) return delays;
  const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
  if (mode === 'fixed') {
    if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
      for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
    } else {
      const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
      for (let i = 0; i < messages.length - 1; i++) delays.push(g);
    }
  } else if (mode === 'byLength') {
    const base = Number(sendCfg.gapBaseMs) || 800;
    const perChar = Number(sendCfg.gapPerCharMs) || 20;
    for (let i = 0; i < messages.length - 1; i++) {
      const chars = Math.max(1, String(messages[i] || '').length);
      delays.push(clampGapV2(base + chars * perChar, sendCfg));
    }
  } else {
    const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
    for (let i = 0; i < messages.length - 1; i++) {
      const useLong = longProb > 0 && Math.random() < longProb;
      const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
      const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
      delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
    }
  }
  return delays;
}

export const randInt = (min, max) => {
  if (min > max) [min, max] = [max, min];
  return Math.floor(min + Math.random() * (max - min + 1));
};
