// DSH 0.2.0 会话队列（inbox 投影）解析的登记期回归测试。
//
// 为什么需要这个文件
// ------------------
// 桥接退役/重置 QQ 会话时要先清掉 DSH 侧还没跑的**待处理队列**，再取消当前 turn
// （`stopSessionWork`）。读队列这一步过去只认 `session/control` 开场 baseline 里的
// `value.queues[<sessionId>]`：
//
//     const queues = frame.value.value?.queues;
//     if (!queues || ...) throw new Error('invalid session/control baseline');
//
// DSH 0.2.0 把队列并进了**投影表**——`value.projections[<sessionId>].values.inbox`
// （形状 `{ 'next-turn': UserMessage[], 'next-step': UserMessage[] }`）——
// `queues` 这个键不复存在。后果不是「少清几条」，而是**每一次退役都抛错**：
// 队列清不掉、旧任务继续在 DSH 里跑，桥接日志里只有一行
// 「⚠️ 停止旧会话失败 … invalid session/control baseline」。
// 这条缺陷在升级到 0.2.0 后才被注意到，说明它此前**没有任何测试覆盖**。
//
// 本文件用**从真实 DSH 0.2.0 采样下来的帧骨架**把解析钉死：
// 结构再变就是测试红，而不是线上静默漏水。
//
// ⚠️ 这里的帧骨架刻意保留 `asOfSeq`/`values`/`inbox` 的真实层级与键名
// （含 `next-turn` 这种带连字符的键），因为**层级写错**正是上一版缺陷的形态。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inboxItemsOfProjections,
  inboxItemIds,
  controlBaselineInboxItems,
} from '../../../src/dsh/dsh-client.js';

/** 一条真实的 DSH 0.2.0 inbox 项（2026 实测采样，内容已替换为占位符）。 */
const realInboxItem = (id, text) => ({
  content: [{ type: 'text', text }],
  source: { kind: 'user', rpcId: 'rpc-0000-0000-0000-000000000000' },
  role: 'user',
  id,
});

/** DSH 0.2.0 的 SessionProjectionValues 骨架（只保留本测试关心的键）。 */
const projectionValues = (inbox) => ({
  title: 'QQ 聊天',
  tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ...(inbox === undefined ? {} : { inbox }),
});

/** DSH 0.2.0 的 session/control 开场 baseline 帧（真实采样层级）。 */
const controlBaseline = (sessions) => ({
  type: 'baseline',
  value: {
    projections: Object.fromEntries(
      Object.entries(sessions).map(([id, values]) => [id, { asOfSeq: 7, values }]),
    ),
  },
});

// ── 1. 投影解析 ─────────────────────────────────────────────────────────────
test('inbox 投影：两个边界一起取，顺序为 next-turn → next-step', () => {
  const values = projectionValues({
    'next-turn': [realInboxItem('m-1', '第一轮')],
    'next-step': [realInboxItem('m-2', '插话')],
  });
  assert.deepEqual(inboxItemsOfProjections(values).map((i) => i.id), ['m-1', 'm-2']);
});

test('inbox 投影：空队列返回空数组（不是错误）', () => {
  assert.deepEqual(inboxItemsOfProjections(projectionValues({ 'next-turn': [], 'next-step': [] })), []);
});

test('inbox 投影：能力缺失（无 inbox 键 / values 为 null）视为无待处理项', () => {
  // 会话没有活动 agent 时，投影表里可能没有 inbox 这一项。
  assert.deepEqual(inboxItemsOfProjections(projectionValues(undefined)), []);
  assert.deepEqual(inboxItemsOfProjections(null), []);
  // session/projections 对不存在的会话返回 null。
  assert.deepEqual(inboxItemsOfProjections(undefined), []);
});

test('inbox 投影：只有一个边界存在时也能解析（另一个是可选能力）', () => {
  assert.deepEqual(
    inboxItemsOfProjections(projectionValues({ 'next-turn': [realInboxItem('m-1', 'x')] })).map((i) => i.id),
    ['m-1'],
  );
  assert.deepEqual(
    inboxItemsOfProjections(projectionValues({ 'next-step': [] })).map((i) => i.id),
    [],
  );
});

test('inbox 投影：结构变了必须显式失败，不能静默当成空队列', () => {
  // 静默返回 [] 正是「队列清不掉却毫无提示」的成因。
  for (const bad of [
    { 'next-turn': null },
    { 'next-turn': {} },
    { 'next-turn': 'm-1' },
    { 'next-step': 3 },
  ]) {
    assert.throws(
      () => inboxItemsOfProjections(projectionValues(bad)),
      /invalid session inbox projection/,
      `结构 ${JSON.stringify(bad)} 应抛错`,
    );
  }
  assert.throws(() => inboxItemsOfProjections(projectionValues([])), /invalid session inbox projection/);
  assert.throws(() => inboxItemsOfProjections(projectionValues('inbox')), /invalid session inbox projection/);
});

// ── 2. itemId 抽取 ─────────────────────────────────────────────────────────
test('itemId 抽取：取出 MessageId 字符串', () => {
  assert.deepEqual(
    inboxItemIds([realInboxItem('m-1', 'a'), realInboxItem('m-2', 'b')]),
    ['m-1', 'm-2'],
  );
});

test('itemId 抽取：缺 id / id 非字符串必须抛错（否则 updateQueue 无从下手）', () => {
  for (const bad of [
    [{ content: [] }],
    [{ id: '' }],
    [{ id: 42 }],
    [{ id: null }],
    [null],
    [undefined],
  ]) {
    assert.throws(() => inboxItemIds(bad), /invalid session inbox item/, JSON.stringify(bad));
  }
});

// ── 3. control baseline 帧解析（0.2.0 的真实层级）──────────────────────────
test('control baseline：从 projections[<sessionId>].values.inbox 取队列', () => {
  const frame = controlBaseline({
    'session-a': projectionValues({
      'next-turn': [realInboxItem('m-a1', '给 A 的')],
      'next-step': [],
    }),
    'session-b': projectionValues({
      'next-turn': [realInboxItem('m-b1', '给 B 的'), realInboxItem('m-b2', '还有一条')],
      'next-step': [],
    }),
  });
  assert.deepEqual(inboxItemIds(controlBaselineInboxItems(frame, 'session-b')), ['m-b1', 'm-b2']);
  assert.deepEqual(inboxItemIds(controlBaselineInboxItems(frame, 'session-a')), ['m-a1']);
});

test('control baseline：会话不在 baseline 里 ⇒ 没有活动 agent ⇒ 无待处理项', () => {
  const frame = controlBaseline({ 'session-a': projectionValues({ 'next-turn': [], 'next-step': [] }) });
  assert.deepEqual(controlBaselineInboxItems(frame, 'session-zzz'), []);
});

test('control baseline：0.1.7 的旧形状 queues 已不存在——旧字段必须不再被接受', () => {
  // 这一条钉的是「缺陷本身」：把 queues 形状喂进去必须**拿不到队列**，
  // 而不是像老实现那样先撞上结构校验、把每一次退役都变成一次报错。
  const legacy = {
    type: 'baseline',
    value: { queues: { 'session-a': [{ id: 'm-a1' }] } },
  };
  assert.throws(() => controlBaselineInboxItems(legacy, 'session-a'), /invalid session\/control baseline/);
});

test('control baseline：投影表结构不符必须抛错', () => {
  for (const bad of [
    { type: 'baseline', value: {} },
    { type: 'baseline', value: { projections: null } },
    { type: 'baseline', value: { projections: [] } },
    { type: 'baseline', value: { projections: 'x' } },
    { type: 'baseline' },
    undefined,
  ]) {
    assert.throws(
      () => controlBaselineInboxItems(bad, 'session-a'),
      /invalid session\/control baseline/,
      JSON.stringify(bad),
    );
  }
});

test('control baseline：投影项缺 values 时视为能力缺失（无待处理项）', () => {
  const frame = { type: 'baseline', value: { projections: { 'session-a': { asOfSeq: 3 } } } };
  assert.deepEqual(controlBaselineInboxItems(frame, 'session-a'), []);
});
