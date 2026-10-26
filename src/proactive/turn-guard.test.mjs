// 回归：主动聊天等回复时，不能把用户自己正在跑的那一轮当成自己的回复。
// 2026-10-26 20:49 实测：用户在会话里说了句「等这次跑完。」，它的 turn/end 被
// 主动聊天当成生成结果发了出去 —— delivery 显示 sent，但那是用户的话。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createProactiveEngine } from './engine.mjs';

const textEvent = (text) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
});

test('等回复时跳过用户已在跑的那一轮', async () => {
  const engine = createProactiveEngine({ store: {} });
  const sessionId = 's1';

  // 用户自己的一轮开始了（我们还没开始等）
  engine.observe(sessionId, { type: 'turn/start' });

  const waiter = engine.expectTurn(sessionId, 5000);

  // 用户那一轮说完——这不是我们的回复，必须被跳过
  engine.observe(sessionId, textEvent('用户自己说的话'));
  engine.observe(sessionId, { type: 'turn/end', data: { reason: 'ok' } });

  // 我们 prompt 换来的那一轮
  engine.observe(sessionId, { type: 'turn/start' });
  engine.observe(sessionId, textEvent('我主动说的一句话'));
  engine.observe(sessionId, { type: 'turn/end', data: { reason: 'ok' } });

  const turn = await waiter;
  assert.equal(turn.ok, true);
  assert.equal(turn.text, '我主动说的一句话');
});

test('会话空闲时不需要跳过，第一轮就是自己的回复', async () => {
  const engine = createProactiveEngine({ store: {} });
  const sessionId = 's2';

  const waiter = engine.expectTurn(sessionId, 5000);
  engine.observe(sessionId, { type: 'turn/start' });
  engine.observe(sessionId, textEvent('空窗里的主动消息'));
  engine.observe(sessionId, { type: 'turn/end', data: { reason: 'ok' } });

  const turn = await waiter;
  assert.equal(turn.text, '空窗里的主动消息');
});