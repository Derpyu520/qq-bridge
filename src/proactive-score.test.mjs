// 每会话主动概率调整的离线回归（对应 src/proactive-score.mjs）。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROACTIVE_DELTA_MAX,
  PROACTIVE_DELTA_MIN,
  effectiveProactiveProbability,
  evaluateProactiveCheck,
  formatDelta,
  formatProbability,
  normalizeProactiveDelta
} from './proactive-score.mjs';

test('调整值归一：缺省/垃圾值 → 0，超出 ±1 夹回', () => {
  assert.equal(normalizeProactiveDelta(undefined), 0);
  assert.equal(normalizeProactiveDelta(null), 0);
  assert.equal(normalizeProactiveDelta(''), 0);
  assert.equal(normalizeProactiveDelta('abc'), 0);
  assert.equal(normalizeProactiveDelta('0.2'), 0.2);
  assert.equal(normalizeProactiveDelta(0.35), 0.35);
  assert.equal(normalizeProactiveDelta(5), PROACTIVE_DELTA_MAX);
  assert.equal(normalizeProactiveDelta(-5), PROACTIVE_DELTA_MIN);
});

test('最终概率 = 基础 + 调整，夹在 0~1', () => {
  const eq = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
  eq(effectiveProactiveProbability(0.4, 0.2), 0.6);
  eq(effectiveProactiveProbability(0.4, -0.4), 0);
  eq(effectiveProactiveProbability(0.4, -0.1), 0.3);
  // 溢出夹回 1：60% + 80% 不该变成 140%
  eq(effectiveProactiveProbability(0.6, 0.8), 1);
  // 基础缺失按 0 算；调整仍能单独把某个群点亮
  eq(effectiveProactiveProbability(undefined, 0.5), 0.5);
  eq(effectiveProactiveProbability(0, 0), 0);
  eq(effectiveProactiveProbability(-3, 0), 0);
  eq(effectiveProactiveProbability(3, 0), 1);
});

test('缺省调整不改变基础概率（升级后行为不变）', () => {
  for (const base of [0, 0.2, 0.5, 1]) {
    assert.equal(effectiveProactiveProbability(base, undefined), base);
  }
});

test('展示格式：百分比取整、调整带符号', () => {
  assert.equal(formatProbability(0), '0%');
  assert.equal(formatProbability(0.5), '50%');
  assert.equal(formatProbability(0.155), '16%');
  assert.equal(formatProbability(undefined), '0%');
  assert.equal(formatDelta(0), '0');
  assert.equal(formatDelta(0.2), '+20%');
  assert.equal(formatDelta(-0.15), '-15%');
  assert.equal(formatDelta(undefined), '0');
});

const DAY = new Date(2026, 9, 25, 15, 0, 0).getTime();
const NIGHT = new Date(2026, 9, 25, 23, 30, 0).getTime();

test('判定：基础 + 本会话调整，安静够久才可能冒泡', () => {
  const base = { base: 0.4, delta: 0.2, idleMs: 60 * 60 * 1000, idleThresholdMs: 15 * 60 * 1000, now: DAY };
  const hit = evaluateProactiveCheck({ ...base, random: () => 0.1 });
  assert.equal(hit.combined, 0.6000000000000001);
  assert.equal(hit.fire, true);
  const miss = evaluateProactiveCheck({ ...base, random: () => 0.99 });
  assert.equal(miss.fire, false);
  const notIdle = evaluateProactiveCheck({ ...base, idleMs: 60 * 1000, random: () => 0 });
  assert.equal(notIdle.idleOk, false);
  assert.equal(notIdle.fire, false);
  const busy = evaluateProactiveCheck({ ...base, busy: true, random: () => 0 });
  assert.equal(busy.fire, false);
});

test('判定：四道修正依次生效', () => {
  const common = { base: 0.4, delta: 0.2, idleMs: 60 * 60 * 1000, idleThresholdMs: 1000, now: DAY };
  const pending = evaluateProactiveCheck({ ...common, pendingThoughts: 1, random: () => 0 });
  assert.ok(pending.mods.includes('有待说想法×1.4'));
  // 0.6 × 1.4 = 0.84
  assert.ok(Math.abs(pending.probability - 0.84) < 1e-9);

  const recent = evaluateProactiveCheck({ ...common, lastAiReplyAt: DAY - 5 * 60 * 1000, random: () => 0 });
  assert.ok(recent.mods.includes('刚回过话×0.5'));
  assert.ok(Math.abs(recent.probability - 0.3) < 1e-9);

  const night = evaluateProactiveCheck({ ...common, now: NIGHT, random: () => 0 });
  assert.ok(night.mods.includes('夜间×0.3'));
  assert.ok(Math.abs(night.probability - 0.18) < 1e-9);

  const spam = evaluateProactiveCheck({ ...common, aiCount: 5, random: () => 0 });
  assert.ok(spam.mods.includes('一小时≥5条×0.3'));
  assert.ok(Math.abs(spam.probability - 0.18) < 1e-9);

  const all = evaluateProactiveCheck({
    ...common, now: NIGHT, pendingThoughts: 1, lastAiReplyAt: NIGHT - 1000, aiCount: 9, random: () => 0
  });
  // 0.6 ×1.4 =0.84 → ×0.5 =0.42 → ×0.3=0.126 → ×0.3≈0.0378
  assert.ok(Math.abs(all.probability - 0.0378) < 1e-9);
  assert.equal(all.mods.length, 4);
});

test('判定：调整值缺省/越界仍按夹取后的值算', () => {
  const common = { idleMs: 999999, idleThresholdMs: 1000, now: DAY, random: () => 0 };
  const none = evaluateProactiveCheck({ ...common, base: 0.3 });
  assert.equal(none.delta, 0);
  assert.ok(Math.abs(none.combined - 0.3) < 1e-9);
  const over = evaluateProactiveCheck({ ...common, base: 0.9, delta: 5 });
  assert.equal(over.delta, 1);
  assert.equal(over.combined, 1);
});
