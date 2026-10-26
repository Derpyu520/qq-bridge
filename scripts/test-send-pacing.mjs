// src/qq-send-pacing.js 的单测：分条发送的间隔计算。
//
// 钉三件事：
//   1. fixed 模式：给了 gaps 就逐条用，没给就全部用同一个（且都被 clamp 进区间）；
//   2. byLength 模式：按上一条字数算，长消息隔得久；
//   3. auto 模式：抽随机，但结果必须落在 [burstIntervalMinMs, maxGapMs] 内 ——
//      这是唯一能断言的东西，别写成「等于某个数」。
import assert from 'node:assert/strict';
import { clampGapV2, computeGapsV2, randInt } from '../src/qq-send-pacing.js';

let failures = 0;
function test(name, run) {
  try { run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const CFG = {
  burstIntervalMinMs: 1000,
  burstIntervalMaxMs: 3000,
  maxGapMs: 10000,
  gapBaseMs: 800,
  gapPerCharMs: 20,
};

test('randInt 落在闭区间内，且 min/max 反了也认', () => {
  for (let i = 0; i < 200; i++) {
    const v = randInt(5, 9);
    assert.ok(v >= 5 && v <= 9, `越界：${v}`);
  }
  for (let i = 0; i < 50; i++) {
    const v = randInt(9, 5);
    assert.ok(v >= 5 && v <= 9, `min/max 反了也应收进 5..9：${v}`);
  }
});

test('clampGapV2 把值收进 [burstIntervalMinMs, maxGapMs]', () => {
  assert.equal(clampGapV2(50, CFG), 1000, '低于下限抬到下限');
  assert.equal(clampGapV2(99999, CFG), 10000, '高于上限压到上限');
  assert.equal(clampGapV2('abc', CFG), 1000, '非法值退回下限');
});

test('一条或零条消息不产生间隔', () => {
  assert.deepEqual(computeGapsV2([], 'fixed', 1000, null, CFG), []);
  assert.deepEqual(computeGapsV2(['只有一条'], 'fixed', 1000, null, CFG), []);
  assert.deepEqual(computeGapsV2(null, 'fixed', 1000, null, CFG), []);
});

test('fixed 模式：逐条 gaps 优先', () => {
  const gaps = computeGapsV2(['a', 'b', 'c'], 'fixed', 1000, [1200, 1500], CFG);
  assert.deepEqual(gaps, [1200, 1500]);
});

test('fixed 模式：gaps 不够长时退回统一间隔', () => {
  const gaps = computeGapsV2(['a', 'b', 'c'], 'fixed', 1400, [1200], CFG);
  assert.deepEqual(gaps, [1400, 1400]);
});

test('byLength 模式：字数多的那条后面隔得久', () => {
  const gaps = computeGapsV2(['短', '这是一条明显更长的消息内容'], 'byLength', 0, null, CFG);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0], clampGapV2(800 + 2 * 20, CFG));
});

test('auto 模式：条数对得上，且都落在区间内', () => {
  const messages = ['一', '二', '三', '四'];
  for (let round = 0; round < 20; round++) {
    const gaps = computeGapsV2(messages, 'auto', undefined, undefined, CFG);
    assert.equal(gaps.length, 3, 'n 条消息应当有 n-1 个间隔');
    for (const g of gaps) {
      assert.ok(g >= 1000 && g <= 10000, `auto 间隔越界：${g}`);
    }
  }
});

test('未知模式按 auto 处理，不会抛', () => {
  const gaps = computeGapsV2(['a', 'b'], 'whatever', 0, null, CFG);
  assert.equal(gaps.length, 1);
});

test('配置缺字段时用内置下限，不产生 NaN', () => {
  const gaps = computeGapsV2(['a', 'b'], 'byLength', 0, null, {});
  assert.equal(gaps.length, 1);
  assert.ok(Number.isFinite(gaps[0]), `不能是 NaN：${gaps[0]}`);
  // 空配置时 clampGapV2 的 floor 是 Math.max(100, 300) = 300，820 落在区间里，原样返回。
  assert.equal(gaps[0], 820);
});

if (failures > 0) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');