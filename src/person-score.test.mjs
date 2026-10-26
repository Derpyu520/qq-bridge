// 熟悉度计分与关系档位的离线回归（对应 src/person-score.mjs）。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAMILIAR_MIN_MESSAGES,
  FAMILIAR_THRESHOLD,
  PEOPLE_SCALE_VERSION,
  REGULAR_MIN_MESSAGES,
  REGULAR_THRESHOLD,
  backfillFamiliarity,
  displayFamiliarity,
  familiarityDelta,
  nextFamiliarity,
  relationTier
} from './person-score.mjs';

test('计分：普通 0.5、接机器人的话 2、同一人连发 0.2', () => {
  assert.equal(familiarityDelta({}), 0.5);
  assert.equal(familiarityDelta({ respondingToBot: true }), 2);
  assert.equal(familiarityDelta({ atSelf: true }), 1);
  assert.equal(familiarityDelta({ consecutive: true }), 0.2);
  // 优先级：回机器人的话 > 被 @ > 连发
  assert.equal(familiarityDelta({ respondingToBot: true, atSelf: true }), 2);
  assert.equal(familiarityDelta({ atSelf: true, consecutive: true }), 1);
  assert.equal(familiarityDelta({ respondingToBot: true, consecutive: true }), 2);
});

test('档位只由熟悉度 + 消息数决定，不再看 type 是否被锁成 regular', () => {
  // 旧的坏状态：3 条消息、熟悉度 1 → 以前 type=regular 就永远算常客
  assert.equal(relationTier({ type: 'regular', familiarity: 1, messages: 3 }), 'new');
  // 到阈值、但消息数不够 → 不升档
  assert.equal(relationTier({ type: 'new', familiarity: REGULAR_THRESHOLD, messages: REGULAR_MIN_MESSAGES - 1 }), 'new');
  assert.equal(relationTier({ type: 'new', familiarity: REGULAR_THRESHOLD, messages: REGULAR_MIN_MESSAGES }), 'regular');
  assert.equal(relationTier({ type: 'new', familiarity: FAMILIAR_THRESHOLD, messages: FAMILIAR_MIN_MESSAGES }), 'familiar');
  // 熟悉度够但消息数不够熟人门槛 → 退回常客，而不是新人
  assert.equal(relationTier({ type: 'new', familiarity: FAMILIAR_THRESHOLD, messages: REGULAR_MIN_MESSAGES }), 'regular');
});

test('档位保留 owner 与人工标记的 stranger', () => {
  assert.equal(relationTier({ type: 'owner', familiarity: 0, messages: 0 }), 'owner');
  assert.equal(relationTier({ type: 'stranger', familiarity: 0, messages: 1 }), 'stranger');
  // 陌生人聊熟了照样升级
  assert.equal(relationTier({ type: 'stranger', familiarity: 30, messages: 20 }), 'familiar');
});

test('熟悉度累加夹在 0~100', () => {
  assert.equal(nextFamiliarity(0, 0.5), 0.5);
  assert.equal(nextFamiliarity(99.8, 2), 100);
  assert.equal(nextFamiliarity(0.1, -1), 0);
  assert.equal(nextFamiliarity(undefined, 2), 2);
});

test('展示保留一位小数，不再把 0.1~0.4 显示成 0', () => {
  assert.equal(displayFamiliarity(0.1), '0.1');
  assert.equal(displayFamiliarity(0.5), '0.5');
  assert.equal(displayFamiliarity(3), '3');
  assert.equal(displayFamiliarity(3.14159), '3.1');
  assert.equal(displayFamiliarity(0), '0');
  assert.equal(displayFamiliarity(undefined), '0');
});

test('一次性回填：按每条 0.5 补齐，并重算档位', () => {
  const people = {
    'u1': { relation: { type: 'regular', familiarity: 1 }, stats: { messages: 3 } },
    'u2': { relation: { type: 'regular', familiarity: 18.85 }, stats: { messages: 184 } },
    'u3': { relation: { type: 'owner', familiarity: 0 }, stats: { messages: 500 } },
    'u4': { relation: { type: 'new', familiarity: 40 }, stats: { messages: 50 } }
  };
  const changed = backfillFamiliarity(people);
  assert.ok(changed > 0);
  // 3 条消息的老"常客"：回填到 1.5，档位退回新人
  assert.equal(people.u1.relation.familiarity, 1.5);
  assert.equal(people.u1.relation.type, 'new');
  // 184 条消息的老群友：18.85 → 92，升熟人
  assert.equal(people.u2.relation.familiarity, 92);
  assert.equal(people.u2.relation.type, 'familiar');
  // owner 不参与
  assert.equal(people.u3.relation.familiarity, 0);
  assert.equal(people.u3.relation.type, 'owner');
  // 已经比下限高的保持不变（只取 max），档位按分数重算
  assert.equal(people.u4.relation.familiarity, 40);
  assert.equal(people.u4.relation.type, 'familiar');
});

test('回填是幂等的', () => {
  const people = { a: { relation: { type: 'new', familiarity: 2 }, stats: { messages: 10 } } };
  backfillFamiliarity(people);
  const snapshot = JSON.stringify(people);
  assert.equal(backfillFamiliarity(people), 0);
  assert.equal(JSON.stringify(people), snapshot);
});

test('迁移版本号是 2（写进 state 的 peopleScale）', () => {
  assert.equal(PEOPLE_SCALE_VERSION, 2);
});
