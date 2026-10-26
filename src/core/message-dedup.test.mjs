import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageDedup } from './message-dedup.mjs';

const GROUP = 'group:681528723';
const OTHER = 'group:999999999';

test('同一条消息第二次进来会被拒', () => {
  const dedup = createMessageDedup();
  assert.equal(dedup.accept(GROUP, '1001'), true);
  assert.equal(dedup.accept(GROUP, '1001'), false);
  assert.equal(dedup.stats().duplicates, 1);
});

test('不同会话的同号 id 互不影响', () => {
  // 各群的 message_id 是各自协议端发的，撞号很常见，不能跨会话判重。
  const dedup = createMessageDedup();
  assert.equal(dedup.accept(GROUP, '1'), true);
  assert.equal(dedup.accept(OTHER, '1'), true);
});

test('没有 id 的消息一律放行，宁可重复也不吞', () => {
  const dedup = createMessageDedup();
  assert.equal(dedup.accept(GROUP, ''), true);
  assert.equal(dedup.accept(GROUP, ''), true);
  assert.equal(dedup.accept(GROUP, []), true);
  assert.equal(dedup.accept(GROUP, [null, undefined]), true);
  assert.equal(dedup.stats().unidentifiable, 4);
});

test('带了两个引用时任意一个命中就算重复', () => {
  const dedup = createMessageDedup();
  assert.equal(dedup.accept(GROUP, ['500', '17']), true);
  // 同 message_id、seq 不同：还是同一条
  assert.equal(dedup.accept(GROUP, ['500', '18']), false);
  // seq 相同、没有 message_id：也算同一条
  assert.equal(dedup.accept(GROUP, ['', '17']), false);
  // 两个都不一样：新的
  assert.equal(dedup.accept(GROUP, ['501', '19']), true);
});

test('超过 TTL 的旧 id 不再拦', () => {
  const dedup = createMessageDedup({ ttlMs: 60_000 });
  const t0 = 1_000_000;
  assert.equal(dedup.accept(GROUP, '900', t0), true);
  assert.equal(dedup.accept(GROUP, '900', t0 + 30_000), false);
  assert.equal(dedup.accept(GROUP, '900', t0 + 61_000), true);
  assert.equal(dedup.size, 1);
});

test('容量满了按插入顺序淘汰最旧的', () => {
  const dedup = createMessageDedup({ capacity: 3 });
  for (const id of ['a', 'b', 'c']) assert.equal(dedup.accept(GROUP, id), true);
  assert.equal(dedup.size, 3);
  assert.equal(dedup.accept(GROUP, 'd'), true);
  assert.equal(dedup.size, 3, '不该超过容量');
  assert.equal(dedup.accept(GROUP, 'a'), true, 'a 已被淘汰，重新算新的');
  assert.equal(dedup.accept(GROUP, 'c'), false);
});

test('reset 之后 forget 掉该会话的痕迹', () => {
  const dedup = createMessageDedup();
  assert.equal(dedup.accept(GROUP, '777'), true);
  assert.equal(dedup.accept(OTHER, '777'), true);
  dedup.forget(GROUP);
  assert.equal(dedup.accept(GROUP, '777'), true, '本会话重置后不该再被旧 id 拦住');
  assert.equal(dedup.accept(OTHER, '777'), false, '别的会话不受影响');
});

test('stats 的数字对得上', () => {
  const dedup = createMessageDedup({ capacity: 10, ttlMs: 1000 });
  dedup.accept(GROUP, '1');
  dedup.accept(GROUP, '1');
  dedup.accept(GROUP, '2');
  const stats = dedup.stats();
  assert.equal(stats.accepted, 2);
  assert.equal(stats.duplicates, 1);
  assert.equal(stats.size, 2);
  assert.equal(stats.capacity, 10);
  assert.equal(stats.ttlMs, 1000);
});