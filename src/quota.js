// 发送/唤醒的统一限额检查（滑动窗口 + 本地日历日）。
//
// 设计目标：
//   · 现有 maxSendPerMinute/Hour、maxWakePerMinute/Hour 继续生效；
//   · 新增 maxSendPer2Hours/Day、maxWakePer2Hours/Day；
//   · 0 表示不限；非法值按 0；
//   · 只做纯计算，不读写状态，方便单测和在 bridge.js 里复用。
//
// 时间窗口：
//   · 每分钟 / 每小时 / 每 2 小时：滑动窗口，按时间戳过滤；
//   · 每日：本地日历日（默认系统时区，生产环境为 Asia/Shanghai），次日 00:00 重置。

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const TWO_HOURS_MS = 2 * HOUR_MS;

const WINDOWS = [
  ['perMinute', MINUTE_MS, '每分钟'],
  ['perHour', HOUR_MS, '每小时'],
  ['per2Hours', TWO_HOURS_MS, '每 2 小时']
];

/** 本地当天 00:00:00.000 的时间戳。 */
export function startOfLocalDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 下一个本地 00:00:00.000 的时间戳（用于“明天再试”的 retryAfter）。 */
export function nextLocalMidnight(now = Date.now()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function normalizeTimes(times, now) {
  if (!Array.isArray(times)) return [];
  const out = [];
  for (const value of times) {
    const t = Number(value);
    // 只接受“已经发生”的合法时间戳；未来时间（时钟偏差/脏数据）不计入额度。
    if (Number.isFinite(t) && t > 0 && t <= now) out.push(t);
  }
  return out;
}

/**
 * 检查一组时间戳是否还能再发/再唤醒 count 次。
 *
 * @param {number[]} times 历史时间戳（发送或唤醒）
 * @param {{perMinute?:number, perHour?:number, per2Hours?:number, perDay?:number}} limits
 * @param {number} count 本次要占用的次数
 * @param {number} now 当前时间
 * @param {string} label 错误信息里的名词（“发送”“唤醒”）
 * @returns {{ok:true}|{ok:false, window:string, windowName:string, used:number, limit:number, retryAfterMs:number, error:string}}
 */
export function checkRollingQuota(times, limits = {}, count = 1, now = Date.now(), label = '发送') {
  const list = normalizeTimes(times, now);
  const n = Math.max(1, Math.floor(Number(count) || 1));

  for (const [key, windowMs, windowName] of WINDOWS) {
    const limit = Math.max(0, Math.floor(Number(limits[key]) || 0));
    if (!limit) continue;
    const inWindow = list.filter((t) => now - t < windowMs);
    const used = inWindow.length;
    if (used + n > limit) {
      const oldest = inWindow.length ? Math.min(...inWindow) : now;
      const retryAfterMs = Math.max(1000, windowMs - (now - oldest) + 250);
      return {
        ok: false,
        window: key,
        windowName,
        used,
        limit,
        retryAfterMs,
        error: `${label}超过${windowName}上限（${used}/${limit}），请稍后再试`
      };
    }
  }

  const dayLimit = Math.max(0, Math.floor(Number(limits.perDay) || 0));
  if (dayLimit) {
    const dayStart = startOfLocalDay(now);
    const used = list.filter((t) => t >= dayStart).length;
    if (used + n > dayLimit) {
      const retryAfterMs = Math.max(1000, nextLocalMidnight(now) - now + 250);
      return {
        ok: false,
        window: 'perDay',
        windowName: '每日',
        used,
        limit: dayLimit,
        retryAfterMs,
        error: `${label}超过每日上限（${used}/${dayLimit}），明天再试`
      };
    }
  }

  return { ok: true };
}

/** 从 socialV2.send 配置里取发送限额；未配置的键为 0（不限）。 */
export function sendQuotaLimits(sendCfg = {}) {
  return {
    perMinute: sendCfg.maxSendPerMinute,
    perHour: sendCfg.maxSendPerHour,
    per2Hours: sendCfg.maxSendPer2Hours,
    perDay: sendCfg.maxSendPerDay
  };
}

/** 从 socialV2.wake 配置里取唤醒限额；未配置的键为 0（不限）。 */
export function wakeQuotaLimits(wakeCfg = {}) {
  return {
    perMinute: wakeCfg.maxWakePerMinute,
    perHour: wakeCfg.maxWakePerHour,
    per2Hours: wakeCfg.maxWakePer2Hours,
    perDay: wakeCfg.maxWakePerDay
  };
}
