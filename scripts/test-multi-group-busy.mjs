import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createTurnCollector } from '../src/dsh-client.js';

async function fixture(t) {
  const h = await bridgeHarness({ config: { allow: { groups: ['456', '789'], private: ['123'] },
    socialV2: { wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 }, sticker: { enabled: false } } } });
  h.setMode('reserved2');
  // End a deliberately action-free fixture turn without creating reminder work.
  h.cfg.socialV2.wake.maxWakeConfigReminders = 1;
  for (const key of ['group:456', 'group:789']) {
    await h.ensureSession(key);
    h.getSocialV2State(key);
  }
  t.after(() => h.close());
  return h;
}
const event = (h, key, type, data) => ({ payload: { type: 'session/event', sessionId: h.state.sessions[key], event: { type, data } } });
const busy = (h, key) => h.isConversationBusyV2(key, h.getSocialV2State(key));

test('session title/config events do not make an idle group permanently busy', async (t) => {
  const h = await fixture(t);
  const observations = [];
  h.api.events.mux = async function* () {
    yield event(h, 'group:456', 'session/title', { title: '群聊测试' });
    observations.push(busy(h, 'group:456'));
    yield event(h, 'group:456', 'model/selection', { provider: 'fixture', model: 'fixture' });
    observations.push(busy(h, 'group:456'));
  };
  await h.pumpMux();
  assert.deepEqual(observations, [false, false]);
});

test('a title before the first turn does not block submitting that first wake', async (t) => {
  const h = await fixture(t);
  const observations = [];
  h.api.events.mux = async function* () {
    yield event(h, 'group:456', 'session/title', { title: '预先命名', source: { kind: 'user' }, messageSeqs: [] });
    observations.push(busy(h, 'group:456'));
    await h.sendWakePromptV2('group:456', 'admin');
    assert.equal(h.calls.prompts.length, 1);
    // The submitted wake is busy even before turn/start arrives.
    observations.push(busy(h, 'group:456'));
    yield event(h, 'group:456', 'turn/start', { turn: 1 });
    observations.push(busy(h, 'group:456'));
    yield event(h, 'group:456', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    observations.push(busy(h, 'group:456'));
  };
  await h.pumpMux();
  assert.deepEqual(observations, [false, true, true, false]);
  assert.equal(h.calls.cancelled.length, 0);
});

test('a title during a tracked first turn preserves busy state until its end', async (t) => {
  const h = await fixture(t);
  await h.sendWakePromptV2('group:456', 'bootstrap');
  const observations = [];
  h.api.events.mux = async function* () {
    yield event(h, 'group:456', 'turn/start', { turn: 1 });
    observations.push(busy(h, 'group:456'));
    yield event(h, 'group:456', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '第一条提示' }] });
    yield event(h, 'group:456', 'session/title', { title: '首次聊天', source: { kind: 'fallback' }, messageSeqs: [1] });
    observations.push(busy(h, 'group:456'));
    yield event(h, 'group:456', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    observations.push(busy(h, 'group:456'));
  };
  await h.pumpMux();
  assert.deepEqual(observations, [true, true, false]);
  assert.equal(h.calls.prompts.length, 1);
});

test('a late title after turn/end leaves the group idle and its next eligible wake is delivered', async (t) => {
  const h = await fixture(t);
  await h.sendWakePromptV2('group:456', 'bootstrap');
  const observations = [];
  h.api.events.mux = async function* () {
    yield event(h, 'group:456', 'turn/start', { turn: 1 });
    yield event(h, 'group:456', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    observations.push(busy(h, 'group:456'));
    yield event(h, 'group:456', 'session/title', { title: '后台晚到的标题', source: { kind: 'provider', provider: 'fixture' }, messageSeqs: [1] });
    observations.push(busy(h, 'group:456'));
    // Keep the production one-wake-per-minute limit; simulate the prior wake aging out.
    h.getSocialV2State('group:456').wakeTimes[0] = Date.now() - 61000;
    await h.sendWakePromptV2('group:456', 'atMention');
    assert.equal(h.calls.prompts.length, 2);
    assert.equal(h.calls.prompts[1].sessionId, h.state.sessions['group:456']);
    observations.push(busy(h, 'group:456'));
    yield event(h, 'group:456', 'turn/start', { turn: 2 });
    yield event(h, 'group:456', 'turn/end', { turn: 2, reason: { kind: 'completed' } });
    observations.push(busy(h, 'group:456'));
  };
  await h.pumpMux();
  assert.deepEqual(observations, [false, false, true, false]);
  assert.equal(h.calls.cancelled.length, 0);
});

test('disconnect clears old records and reconnect rebuilds a still-running turn from tool activity', async (t) => {
  const h = await fixture(t);
  const beforeDisconnect = [];
  h.api.events.mux = async function* () {
    yield event(h, 'group:456', 'turn/start', { turn: 1 });
    beforeDisconnect.push(busy(h, 'group:456'));
  };
  await h.pumpMux();
  assert.deepEqual(beforeDisconnect, [true]);
  // The real pumpMux finally block clears collectors when the event stream ends.
  assert.equal(busy(h, 'group:456'), false);
  const observations = [];
  h.api.events.mux = async function* () {
    yield event(h, 'group:456', 'session/title', { title: '重连期间的标题' });
    observations.push(busy(h, 'group:456'));
    yield event(h, 'group:456', 'tool/call', { turn: 1, name: 'mcp__snowluma__qq_wait_for_messages', callId: 'wait-reconnect', arguments: '{}' });
    observations.push(busy(h, 'group:456'));
    yield event(h, 'group:456', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    observations.push(busy(h, 'group:456'));
  };
  await h.pumpMux();
  assert.deepEqual(observations, [false, true, false]);
});

test('the existing per-group wake limit still applies without blocking another group', async (t) => {
  const h = await fixture(t);
  assert.equal(h.cfg.socialV2.wake.maxWakePerMinute, 1);
  await h.sendWakePromptV2('group:456', 'bootstrap');
  const observations = [];
  h.api.events.mux = async function* () {
    yield event(h, 'group:456', 'turn/start', { turn: 1 });
    yield event(h, 'group:456', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    observations.push(busy(h, 'group:456'));
    await h.sendWakePromptV2('group:456', 'admin');
    observations.push(h.calls.prompts.length);
    observations.push(busy(h, 'group:456'));
    await h.sendWakePromptV2('group:789', 'atMention');
    observations.push(h.calls.prompts.length);
    observations.push(h.calls.prompts.at(-1).sessionId === h.state.sessions['group:789']);
    yield event(h, 'group:789', 'turn/start', { turn: 1 });
    yield event(h, 'group:789', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  };
  await h.pumpMux();
  assert.deepEqual(observations, [false, 1, false, 2, true]);
  assert.equal(h.calls.cancelled.length, 0);
});

for (const observeStart of [true, false]) {
  test(`collector keeps assistant text without double-counting chunks (start observed: ${observeStart})`, () => {
    const collector = createTurnCollector();
    if (observeStart) collector.push({ type: 'turn/start', data: { turn: 1 } });
    collector.push({ type: 'assistant/chunk', data: { turn: 1, text: '收到' } });
    collector.push({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '收到' }] } } });
    collector.push({ type: 'session/title', data: { title: '消息标题' } });
    assert.deepEqual(collector.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }), {
      turn: 1, reason: { kind: 'completed' }, text: '收到'
    });
    assert.equal(collector.has(1), false);
  });
}

test('mid-turn reconnect tracks real tool activity and a recovered turn/end releases the group', async (t) => {
  const h = await fixture(t);
  const observations = [];
  h.api.events.mux = async function* () {
    // session/follow ignores snapshots: turn/start may predate this connection.
    yield event(h, 'group:456', 'tool/call', { turn: 'turn-a', name: 'mcp__snowluma__qq_wait_for_messages', callId: 'wait-a', arguments: {} });
    observations.push(busy(h, 'group:456'));
    yield event(h, 'group:456', 'turn/end', { turn: 'turn-a', reason: { kind: 'interrupted' } });
    observations.push(busy(h, 'group:456'));
    yield event(h, 'group:456', 'session/title', { title: '后到的标题' });
    observations.push(busy(h, 'group:456'));
  };
  await h.pumpMux();
  assert.deepEqual(observations, [true, false, false]);
});

test('group B starting and ending does not interrupt group A waiting in its own turn', async (t) => {
  const h = await fixture(t);
  const observations = [];
  h.api.events.mux = async function* () {
    yield event(h, 'group:456', 'turn/start', { turn: 'turn-a' });
    yield event(h, 'group:456', 'tool/call', { turn: 'turn-a', name: 'mcp__snowluma__qq_wait_for_messages', callId: 'wait-a', arguments: {} });
    yield event(h, 'group:789', 'turn/start', { turn: 'turn-b' });
    observations.push([busy(h, 'group:456'), busy(h, 'group:789')]);
    yield event(h, 'group:789', 'turn/end', { turn: 'turn-b', reason: { kind: 'completed' } });
    observations.push([busy(h, 'group:456'), busy(h, 'group:789')]);
    yield event(h, 'group:456', 'turn/end', { turn: 'turn-a', reason: { kind: 'completed' } });
    observations.push([busy(h, 'group:456'), busy(h, 'group:789')]);
  };
  await h.pumpMux();
  assert.deepEqual(observations, [[true, true], [true, false], [false, false]]);
  assert.equal(h.calls.cancelled.length, 0);
});

test('an orphan turn/end clears a pending wake even without any observed turn/start or tool/call', async (t) => {
  const h = await fixture(t);
  h.cfg.socialV2.wake.maxWakeConfigReminders = 1;
  h.pendingWakeKeys.add('group:456');
  h.armPendingWakeLease('group:456');
  const observations = [];
  h.api.events.mux = async function* () {
    observations.push(busy(h, 'group:456'));
    yield event(h, 'group:456', 'turn/end', { turn: 'old-turn', reason: { kind: 'interrupted' } });
    observations.push(busy(h, 'group:456'));
  };
  await h.pumpMux();
  assert.deepEqual(observations, [true, false]);
});

test('separate groups long-poll concurrently while another group can submit a prompt', async (t) => {
  const h = await fixture(t);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const wait = (key) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/wait', method: 'POST', headers: {
        'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': h.getSocialV2State(key).agentToken
      } }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ key, timeoutMs: 900, quietMs: 0 }));
    });
    let firstFinished = false;
    const first = wait('group:456').then((r) => { firstFinished = true; return r; });
    const second = wait('group:789');
    await h.deliverPrompt('group:789', '只在模拟模型中确认独立群投递');
    assert.equal(firstFinished, false);
    const results = await Promise.all([first, second]);
    assert.ok(results.every((r) => r.status === 200 && r.waitedMs >= 900));
    assert.notEqual(h.state.sessions['group:456'], h.state.sessions['group:789']);
    assert.equal(h.calls.cancelled.length, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
