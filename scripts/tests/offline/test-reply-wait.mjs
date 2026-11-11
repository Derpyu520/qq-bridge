// First-reply quiet-window regressions. Real bridge handlers, fixture peers only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from '../../audit/audit-bridge-harness.mjs';

async function fixture(run, cfg = {}) {
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { preSleepWaitEnabled: true, preSleepWaitMs: 300000 },
    wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100 },
    proactive: { enabled: false }, sticker: { enabled: false },
    ...cfg,
  } } });
  h.setMode('reserved2');
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/${route}?key=${encodeURIComponent(key)}`,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  // GET routes carry their options in the query string, not the body.
  const get = (route, query = '') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/${route}?key=${encodeURIComponent(key)}${query}`,
      method: 'GET',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out')));
    req.end();
  });
  const append = text => h.appendSocialV2Message(key, 'fixture-person', text, text, false, false, `fixture-${st.lastUnreadSeq + 1}`, [], '789', []);
  try { await run({ h, key, st, request, get, append }); }
  finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}

test('first reply does not wait out timeout when the snapshot message is already quiet', () => fixture(async ({ h, key, st, request, append }) => {
  append('a complete first message');
  st.lastIncomingAt = Date.now() - 10000; // batching and model reading already consumed the quiet window
  await h.sendWakePromptV2(key, 'question');
  const started = Date.now();
  const result = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100 });
  assert.equal(result.status, 200);
  assert.ok(Date.now() - started < 600, `already-quiet message waited ${result.data.waitedMs}ms`);
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.timeout, false);
  assert.equal(result.data.arrived, false);
  assert.equal(result.data.preSleepWaitObserved, false);
  assert.equal(result.data.preSleepWaitSatisfied, false);
  assert.equal('preSleepWaitRemainingMs' in result.data, false, 'first reply must not be presented as an unfinished sleep countdown');
}));

test('reply waits only for the remaining quiet time after model reading', () => fixture(async ({ h, key, st, request, append }) => {
  append('complete message');
  await h.sendWakePromptV2(key, 'question');
  st.lastIncomingAt = Date.now() - 600;
  const result = await request('wait', { purpose: 'reply', timeoutMs: 1500, quietMs: 800 });
  assert.equal(result.data.quiet, true);
  assert.ok(result.data.waitedMs >= 100 && result.data.waitedMs < 600, `remaining wait was ${result.data.waitedMs}ms`);
}));

test('a message between snapshot and wait is returned without duplicate snapshot content', () => fixture(async ({ h, key, st, request, append }) => {
  append('in snapshot');
  await h.sendWakePromptV2(key, 'question');
  append('arrived while model was thinking');
  st.lastIncomingAt = Date.now() - 1000;
  const result = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100, minNewMessages: 20 });
  assert.equal(result.data.arrived, true);
  assert.equal(result.data.quiet, true);
  assert.deepEqual(result.data.newMessages.map(m => m.seq), [2]);
  assert.equal(result.data.readThroughSeq, 2);
  assert.equal(st.unread.length, 2, 'visibility never acknowledges messages');
}));

test('each supplement restarts quiet from its actual arrival, and appears exactly once', () => fixture(async ({ st, request, append }) => {
  append('first');
  await request('unread');
  st.lastIncomingAt = Date.now();
  const timers = [setTimeout(() => append('second'), 120), setTimeout(() => append('third'), 240)];
  try {
    const result = await request('wait', { purpose: 'reply', timeoutMs: 1500, quietMs: 300 });
    assert.equal(result.data.quiet, true);
    assert.ok(result.data.waitedMs >= 500 && result.data.waitedMs < 1200);
    assert.deepEqual(result.data.newMessages.map(m => m.seq), [2, 3]);
    assert.equal(result.data.readThroughSeq, 3);
  } finally { timers.forEach(clearTimeout); }
}));

test('reply timeout is a hard budget and cannot grant sleep observation, even with a long requested budget', () => fixture(async ({ h, st, request, append }) => {
  h.cfg.socialV2.wake.preSleepWaitMs = 200;
  append('first');
  await request('unread');
  const timer = setTimeout(() => append('supplement near deadline'), 220);
  try {
    const result = await request('wait', { purpose: 'reply', timeoutMs: 300, quietMs: 600 });
    assert.equal(result.data.timeout, true);
    assert.equal(result.data.quiet, false);
    assert.equal(result.data.speakerLikelyDone, false);
    assert.ok(result.data.waitedMs >= 300 && result.data.waitedMs < 900);
    assert.equal(result.data.preSleepWaitObserved, false);
    assert.equal(result.data.preSleepWaitSatisfied, false);
    assert.equal(st.preSleepWaitObservedAt, 0);
    assert.equal(st.preSleepWaitSatisfiedAt, 0);
  } finally { clearTimeout(timer); }
}));

test('ordinary and omitted purpose keep waiting for future messages', () => fixture(async ({ st, request, append }) => {
  append('already known');
  await request('unread');
  st.lastIncomingAt = Date.now() - 10000;
  for (const purpose of [undefined, 'messages']) {
    const result = await request('wait', { purpose, timeoutMs: 600, quietMs: 100 });
    assert.ok(result.data.waitedMs >= 600);
    assert.equal(result.data.timeout, true);
    assert.equal(result.data.quiet, false);
    assert.deepEqual(result.data.newMessages, []);
  }
}));

test('reply mode rejects a session permission change during its remaining quiet window', () => fixture(async ({ h, st, request, append }) => {
  append('still fresh');
  const timer = setTimeout(() => h.setMode('chat'), 100);
  try {
    const result = await request('wait', { purpose: 'reply', timeoutMs: 1000, quietMs: 300 });
    assert.equal(result.status, 403);
    assert.equal(st.modelSeenSeqs.size, 0);
    assert.equal(st.preSleepWaitObservedAt, 0);
  } finally { clearTimeout(timer); }
}));

test('reply mode cannot expose historical messages when both history tools are disabled', () => fixture(async ({ h, st, request, append }) => {
  h.cfg.socialV2.tools.getUnread = false;
  h.cfg.socialV2.tools.getRecent = false;
  append('hidden historical message');
  st.lastIncomingAt = Date.now() - 10000;
  const result = await request('wait', { purpose: 'reply', timeoutMs: 1000, quietMs: 100 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.newMessages, []);
  assert.equal(result.data.readThroughSeq, 0);
}));

test('invalid purpose is rejected without authorizing history or observation', () => fixture(async ({ st, request, append }) => {
  append('pending message');
  for (const purpose of ['quiet', '', null, 1]) {
    const result = await request('wait', { purpose, timeoutMs: 1000, quietMs: 100 });
    assert.equal(result.status, 400);
  }
  assert.equal(st.modelSeenSeqs.size, 0);
  assert.equal(st.preSleepWaitObservedAt, 0);
  assert.equal(st.unread.length, 1);
}));

test('each reply-wait buffer obeys its own tool switch, never the other one', () => fixture(async ({ h, st, request, get, append }) => {
  h.cfg.socialV2.context.recentLimit = 5;
  h.cfg.socialV2.context.unreadLimit = 30;
  for (let i = 1; i <= 3; i++) append(`m${i}`);
  const read = await get('unread', '&limit=30');
  assert.equal(read.data.readThroughSeq, 3);

  // getRecent off. Only getUnread may feed the reply path. A message that arrived
  // after the model's last read is exactly what this purpose exists to surface, but
  // the buffer the closed switch governs must stay out of it.
  h.cfg.socialV2.tools.getRecent = false;
  append('arrived after the last read');
  st.lastIncomingAt = Date.now() - 10000;
  const r1 = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100 });
  assert.deepEqual(r1.data.newMessages.map((m) => m.seq), [4], 'the enabled getUnread still reports the arrival');
  assert.equal(r1.data.readThroughSeq, 4);
  assert.equal(JSON.stringify(st.unread.map((m) => m.seq)), '[1,2,3,4]', `a reply wait never consumes unread; got ${JSON.stringify(st.unread.map((m) => m.seq))}`);

  // getUnread off: the enabled getRecent still carries arrivals, and the unread
  // buffer must not be the one answering.
  h.cfg.socialV2.tools.getRecent = true;
  h.cfg.socialV2.tools.getUnread = false;
  append('while getUnread is closed');
  st.lastIncomingAt = Date.now() - 10000;
  const r2 = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100 });
  assert.deepEqual(r2.data.newMessages.map((m) => m.seq), [5]);

  // Both switches off: nothing may be exposed or authorised, whatever is buffered.
  h.cfg.socialV2.tools.getRecent = false;
  append('while everything is closed');
  st.lastIncomingAt = Date.now() - 10000;
  const r3 = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100 });
  assert.deepEqual(r3.data.newMessages, []);
  assert.equal(r3.data.readThroughSeq, 5, 'a message nobody was allowed to see may not advance the watermark');
}));
