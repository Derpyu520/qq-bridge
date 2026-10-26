// 每 2 小时 / 每日限额的纯计算回归。
//
// 运行：node scripts/test-quota.mjs
import assert from 'node:assert/strict';
import { checkRollingQuota, sendQuotaLimits, wakeQuotaLimits, startOfLocalDay, nextLocalMidnight } from '../src/quota.js';

const now = new Date(2026, 9, 24, 12, 0, 0).getTime();
const minute = 60 * 1000;
const hour = 60 * minute;
const twoHours = 2 * hour;

function fail(result, windowName) {
  assert.equal(result.ok, false);
  assert.equal(result.windowName, windowName);
  assert.ok(result.retryAfterMs > 0, 'retryAfterMs 必须为正');
  assert.match(result.error, new RegExp(windowName));
}

// 1. 没有限额 = 不限
assert.deepEqual(checkRollingQuota([], {}, 100, now), { ok: true });

// 2. 每分钟
fail(checkRollingQuota([now - 10_000, now - 20_000], { perMinute: 3 }, 2, now), '每分钟');
assert.equal(checkRollingQuota([now - 10_000, now - 20_000], { perMinute: 3 }, 1, now).ok, true);

// 3. 每小时
fail(checkRollingQuota([now - 10 * minute, now - 20 * minute, now - 30 * minute], { perHour: 3 }, 1, now), '每小时');
// 超过一小时的不算
assert.equal(checkRollingQuota([now - 61 * minute, now - 62 * minute], { perHour: 2 }, 1, now).ok, true);

// 4. 每 2 小时
fail(checkRollingQuota([now - hour, now - 90 * minute, now - 110 * minute], { per2Hours: 3 }, 1, now), '每 2 小时');
assert.equal(checkRollingQuota([now - twoHours - 1000, now - twoHours - 2000], { per2Hours: 2 }, 1, now).ok, true);

// 5. 每日：只算本地当天
const todayStart = startOfLocalDay(now);
fail(checkRollingQuota([todayStart + 1000, todayStart + 2000], { perDay: 2 }, 1, now), '每日');
assert.equal(checkRollingQuota([todayStart - 1000, todayStart - 2000], { perDay: 2 }, 1, now).ok, true);
assert.ok(nextLocalMidnight(now) > now);

// 6. 0 = 不限
assert.equal(checkRollingQuota([now - 1000, now - 2000, now - 3000], { perMinute: 0, perHour: 0, per2Hours: 0, perDay: 0 }, 10, now).ok, true);

// 7. 未来时间戳/脏数据不计入
assert.equal(checkRollingQuota([now + 60_000, 'x', null, undefined], { perMinute: 1 }, 1, now).ok, true);

// 8. count 默认 1，非法 count 夹到 1
fail(checkRollingQuota([now - 1000], { perMinute: 1 }, undefined, now), '每分钟');

// 9. 配置映射
assert.deepEqual(sendQuotaLimits({
  maxSendPerMinute: 1,
  maxSendPerHour: 2,
  maxSendPer2Hours: 3,
  maxSendPerDay: 4
}), { perMinute: 1, perHour: 2, per2Hours: 3, perDay: 4 });
assert.deepEqual(wakeQuotaLimits({
  maxWakePerMinute: 5,
  maxWakePerHour: 6,
  maxWakePer2Hours: 7,
  maxWakePerDay: 8
}), { perMinute: 5, perHour: 6, per2Hours: 7, perDay: 8 });

console.log('✅ quota tests passed');
