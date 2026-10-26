// Exercise real bridge HTTP handlers and prompt delivery with isolated files,
// fixture-only QQ/DSH peers, and no production process or credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const ACTIVE = { mode: 'active' };
const DIVING = { mode: 'diving', infinite: true, triggers: { atMention: true, anyMessage: false } };
const plain = (value) => JSON.parse(JSON.stringify(value));
const seqs = (messages) => Array.from(messages, (message) => message.seq);
let failures = 0;
let tests = 0;

async function test(name, run, { observe = false } = {}) {
  tests++;
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { preSleepWaitEnabled: observe, preSleepWaitMs: 1000 },
    wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
    proactive: { enabled: false },
    sticker: { enabled: false },
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, { body, token = st.agentToken, key = KEY, admin = false, query = '' } = {}) => new Promise((resolve, reject) => {
    const headers = { 'x-console-token': 'fixture-console-token' };
    if (!admin) headers['x-agent-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `${route.startsWith('/') ? route : `/api/socialV2/${route}`}?key=${encodeURIComponent(key)}${query}`,
      method: body === undefined ? 'GET' : 'POST', headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('fixture HTTP request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  const append = (text, { key = KEY, id = `fixture-${h.getSocialV2State(key).lastUnreadSeq + 1}`, media = [], forwards = [] } = {}) => {
    h.appendSocialV2Message(key, 'fixture-person', text, text, false, false, id, media, '789', forwards);
    return h.getSocialV2State(key).lastUnreadSeq;
  };
  try { await run({ h, st, request, append }); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.stack); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

await test('mark-read acknowledges only the displayed watermark and preserves a message arriving afterwards', async ({ st, request, append }) => {
  append('first displayed message');
  const read = await request('unread');
  assert.equal(read.status, 200);
  assert.equal(read.data.readThroughSeq, 1);
  append('new arrival while model thinks');
  const marked = await request('mark-read', { body: { throughSeq: read.data.readThroughSeq } });
  assert.equal(marked.status, 200);
  assert.equal(marked.data.markedCount, 1);
  assert.deepEqual(seqs(st.unread), [2]);
  assert.equal(st.lastReadThroughSeq, 1);
});

await test('wake-config atomically acknowledges its displayed watermark while preserving later unread', async ({ st, request, append }) => {
  append('first displayed message');
  const read = await request('unread');
  append('unseen new arrival');
  const result = await request('wake-config', { body: { config: ACTIVE, throughSeq: read.data.readThroughSeq } });
  assert.equal(result.status, 200);
  assert.equal(result.data.markedCount, 1);
  assert.equal(st.wakeConfig.confirmedBy, 'set_wake_config');
  assert.equal(st.wakeConfig.mode, 'active');
  assert.deepEqual(seqs(st.unread), [2]);
});

await test('invalid watermarks cannot change unread, wake config, action or observation state', async ({ st, request, append }) => {
  append('protected unread');
  await request('unread');
  st.preSleepWaitObservedAt = Date.now();
  const snapshot = () => plain({ unread: st.unread, wakeConfig: st.wakeConfig, lastActionAt: st.lastActionAt,
    observedAt: st.preSleepWaitObservedAt, satisfiedAt: st.preSleepWaitSatisfiedAt, lastReadThroughSeq: st.lastReadThroughSeq });
  for (const route of ['mark-read', 'wake-config']) {
    for (const throughSeq of [null, '1', true, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
      const before = snapshot();
      const result = await request(route, { body: { throughSeq, config: ACTIVE } });
      assert.equal(result.status, 400, `${route} should reject ${JSON.stringify(throughSeq)}`);
      assert.deepEqual(snapshot(), before, `${route} invalid request must be atomic`);
    }
  }
});

await test('a late slice cannot authorize clearing an earlier unseen message', async ({ st, request, append }) => {
  append('older unseen message');
  append('latest message');
  const latest = await request('unread', { query: '&limit=1' });
  assert.deepEqual(seqs(latest.data.messages), [2]);
  assert.equal(latest.data.readThroughSeq, 0);
  const denied = await request('mark-read', { body: { throughSeq: 2 } });
  assert.equal(denied.status, 400);
  assert.deepEqual(seqs(st.unread), [1, 2]);
  const older = await request('recent', { query: '&limit=1&offset=1' });
  assert.deepEqual(seqs(older.data.messages), [1]);
  assert.equal(older.data.readThroughSeq, 2);
  const marked = await request('mark-read', { body: { throughSeq: older.data.readThroughSeq } });
  assert.equal(marked.status, 200);
  assert.equal(marked.data.markedCount, 2);
  assert.deepEqual(seqs(st.unread), []);
});

await test('console browsing does not authorize the agent to acknowledge unseen messages', async ({ st, request, append }) => {
  append('console-only read');
  const read = await request('unread', { admin: true });
  assert.equal(read.status, 200);
  const denied = await request('wake-config', { body: { throughSeq: 1, config: ACTIVE } });
  assert.equal(denied.status, 400);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('my-recent returns an existing safe cursor without authorizing unrelated unread', async ({ h, st, request, append }) => {
  append('not yet seen');
  h.recordSentMessagesV2(KEY, ['my own earlier reply']);
  const mine = await request('my-recent');
  assert.equal(mine.status, 200);
  assert.equal(mine.data.messages.length, 1);
  assert.equal(mine.data.readThroughSeq, 0);
  assert.equal((await request('mark-read', { body: { throughSeq: 1 } })).status, 400);
  await request('unread');
  assert.equal((await request('my-recent')).data.readThroughSeq, 1);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('combined close cannot bypass the pre-sleep observation guard', async ({ st, request, append }) => {
  append('still discussing a normal topic');
  const read = await request('unread');
  const before = plain(st.wakeConfig);
  for (const route of ['mark-read', 'wake-config']) {
    const result = await request(route, { body: { throughSeq: read.data.readThroughSeq, config: DIVING } });
    assert.equal(result.status, 400);
    assert.ok(result.data.preSleepWaitRemainingMs > 0);
    assert.deepEqual(seqs(st.unread), [1]);
    assert.deepEqual(plain(st.wakeConfig), before);
  }
}, { observe: true });

await test('a full quiet observation allows a single combined close', async ({ h, st, request, append }) => {
  h.cfg.socialV2.wake.preSleepWaitMs = 100;
  append('ordinary topic');
  const read = await request('unread');
  const waited = await request('wait', { body: { timeoutMs: 100, quietMs: 0 } });
  assert.equal(waited.status, 200);
  assert.equal(waited.data.preSleepWaitSatisfied, true);
  assert.equal(waited.data.readThroughSeq, read.data.readThroughSeq);
  const close = await request('wake-config', { body: { config: DIVING, throughSeq: waited.data.readThroughSeq } });
  assert.equal(close.status, 200);
  assert.equal(close.data.markedCount, 1);
  assert.deepEqual(seqs(st.unread), []);
}, { observe: true });

await test('wait exposes new messages and grants only their actually observed cursor', async ({ st, request, append }) => {
  append('message before wait');
  await request('unread');
  const waiting = request('wait', { body: { timeoutMs: 1000, quietMs: 0 } });
  const timer = setTimeout(() => append('message during observation'), 60);
  let waited;
  try { waited = await waiting; } finally { clearTimeout(timer); }
  assert.equal(waited.status, 200);
  assert.equal(waited.data.arrived, true);
  assert.equal(waited.data.preSleepWaitObserved, true);
  assert.deepEqual(seqs(waited.data.newMessages), [2]);
  assert.equal(waited.data.readThroughSeq, 2);
  const close = await request('wake-config', { body: { config: DIVING, throughSeq: waited.data.readThroughSeq } });
  assert.equal(close.status, 200);
  assert.equal(close.data.markedCount, 2);
  assert.deepEqual(seqs(st.unread), []);
}, { observe: true });

await test('another conversation token, pause, mode and allowlist guards still reject combined close', async ({ h, st, request, append }) => {
  append('protected conversation');
  await request('unread');
  const otherToken = h.getSocialV2State('private:123').agentToken;
  const body = { config: ACTIVE, throughSeq: 1 };
  // 跨会话控制现在是受控能力（crossSessionControl，默认 owner）。这里先关掉它，
  // 验证"别的会话令牌不能动这个会话"的旧边界仍然成立；开着它的正例在
  // scripts/test-admin-ops-api.mjs 的跨会话静音用例里。
  const prevControl = h.cfg.botPerms.scope.crossSessionControl;
  h.cfg.botPerms.scope.crossSessionControl = 'none';
  assert.equal((await request('wake-config', { body, token: otherToken })).status, 403);
  h.cfg.botPerms.scope.crossSessionControl = prevControl;
  h.socialV2.paused = true;
  assert.equal((await request('wake-config', { body })).status, 403);
  h.socialV2.paused = false;
  h.setMode('chat');
  assert.equal((await request('wake-config', { body })).status, 403);
  h.setMode('reserved2');
  h.cfg.allow.groups = [];
  assert.equal((await request('wake-config', { body })).status, 403);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('legacy mark-read still clears all unread and legacy wake-config preserves unread', async ({ st, request, append }) => {
  append('legacy message');
  const config = await request('wake-config', { body: { config: ACTIVE } });
  assert.equal(config.status, 200);
  assert.deepEqual(seqs(st.unread), [1]);
  append('legacy second message');
  const marked = await request('mark-read', { body: {} });
  assert.equal(marked.status, 200);
  assert.equal(marked.data.markedCount, 2);
  assert.deepEqual(seqs(st.unread), []);
});

await test('an invalid wake configuration cannot acknowledge an otherwise valid cursor', async ({ st, request, append }) => {
  append('must remain unread');
  await request('unread');
  const before = plain(st.wakeConfig);
  const result = await request('wake-config', { body: { throughSeq: 1, config: {
    mode: 'diving', infinite: true, triggers: { atMention: false, nameMention: false, question: false,
      poke: false, anyMessage: false, probability: 0, keywords: [], speakerIds: [] },
  } } });
  assert.equal(result.status, 400);
  assert.deepEqual(seqs(st.unread), [1]);
  assert.deepEqual(plain(st.wakeConfig), before);
});

await test('zero and repeated watermarks never acknowledge a later unseen arrival', async ({ st, request, append }) => {
  append('first seen');
  await request('unread');
  assert.equal((await request('mark-read', { body: { throughSeq: 0 } })).data.markedCount, 0);
  assert.deepEqual(seqs(st.unread), [1]);
  assert.equal((await request('mark-read', { body: { throughSeq: 1 } })).data.markedCount, 1);
  append('later unseen');
  assert.equal((await request('mark-read', { body: { throughSeq: 1 } })).data.markedCount, 0);
  assert.deepEqual(seqs(st.unread), [2]);
  assert.equal((await request('mark-read', { body: { throughSeq: 2 } })).status, 400);
});

await test('combined close respects the separate mark-read and wake-config tool flags', async ({ h, st, request, append }) => {
  append('protected by tool flags');
  await request('unread');
  h.cfg.socialV2.tools.markRead = false;
  // Closing is one action: with markRead off the watermark is ignored, not fatal, so
  // the wake config still lands and the unread messages stay pending.
  const ignoredCursor = await request('wake-config', { body: { throughSeq: 1, config: ACTIVE } });
  assert.equal(ignoredCursor.status, 200, 'a disabled markRead must not fail the closing call');
  assert.equal(ignoredCursor.data.markedCount, 0);
  assert.equal((await request('mark-read', { body: { throughSeq: 1 } })).status, 403);
  assert.deepEqual(seqs(st.unread), [1], 'no unread may be cleared while markRead is off');
  assert.equal((await request('wake-config', { body: { config: ACTIVE } })).status, 200);
  h.cfg.socialV2.tools.markRead = true;
  h.cfg.socialV2.tools.setWakeConfig = false;
  assert.equal((await request('wake-config', { body: { throughSeq: 1, config: ACTIVE } })).status, 403);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('an in-flight wait cannot authorize new messages after its session token is retired', async ({ h, st, request, append }) => {
  await h.ensureSession(KEY);
  append('before wait');
  const oldToken = st.agentToken;
  const waiting = request('wait', { body: { timeoutMs: 1000, quietMs: 0 }, token: oldToken });
  const timer = setTimeout(() => { h.retireSession(KEY); append('arrived after token retirement'); }, 60);
  let result;
  try { result = await waiting; } finally { clearTimeout(timer); }
  assert.equal(result.status, 403);
  assert.notEqual(st.agentToken, oldToken);
  assert.equal(st.preSleepWaitObservedAt, 0);
  assert.equal((await request('mark-read', { body: { throughSeq: 2 }, token: st.agentToken })).status, 400);
}, { observe: true });

await test('an in-flight wait cannot write observation into a replaced conversation state', async ({ h, st, request, append }) => {
  append('old state');
  const waiting = request('wait', { body: { timeoutMs: 100, quietMs: 0 } });
  const timer = setTimeout(() => {
    h.socialV2.conversations.delete(KEY);
    append('new conversation state');
  }, 60);
  let result;
  try { result = await waiting; } finally { clearTimeout(timer); }
  assert.equal(result.status, 403);
  assert.equal(st.preSleepWaitSatisfiedAt, 0);
  const replacement = h.getSocialV2State(KEY);
  assert.equal(replacement.preSleepWaitSatisfiedAt, 0);
  assert.equal((await request('mark-read', { body: { throughSeq: 1 }, token: replacement.agentToken })).status, 400);
}, { observe: true });

await test('an in-flight wait rechecks mode permission before exposing a new arrival', async ({ h, request, append }) => {
  append('before mode change');
  const waiting = request('wait', { body: { timeoutMs: 1000, quietMs: 0 } });
  const timer = setTimeout(() => { h.setMode('chat'); append('after mode change'); }, 60);
  let result;
  try { result = await waiting; } finally { clearTimeout(timer); }
  assert.equal(result.status, 403);
  assert.equal(result.data.newMessages, undefined);
});

await test('building a budgeted snapshot preserves whole oldest messages without granting a receipt', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.wakeMessageLimit = 2;
  h.cfg.socialV2.context.wakeRecentLimit = 0;
  append('first'); append('second'); append('third');
  const snapshot = h.buildWakeSnapshotV2(KEY);
  assert.deepEqual(seqs(snapshot.messages), [1, 2]);
  assert.equal(snapshot.includedUnreadCount, 2);
  assert.equal(snapshot.unreadCount, 3);
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.readThroughSeq, 2);
  assert.ok(JSON.stringify(snapshot).length <= h.cfg.socialV2.context.wakeMaxChars);
  assert.equal((await request('mark-read', { body: { throughSeq: 2 } })).status, 400);
  assert.deepEqual(seqs(st.unread), [1, 2, 3]);
});

await test('an in-flight wait rechecks paused, feature, tool and allowlist permissions without granting observation', async ({ h, st, request, append }) => {
  append('unread before policy changes');
  const cases = [
    ['pause', () => { h.socialV2.paused = true; }, () => { h.socialV2.paused = false; }],
    ['feature disable', () => { h.cfg.socialV2.enabled = false; }, () => { h.cfg.socialV2.enabled = true; }],
    ['tool disable', () => { h.cfg.socialV2.tools.waitMessages = false; }, () => { h.cfg.socialV2.tools.waitMessages = true; }],
    ['allowlist removal', () => { h.cfg.allow.groups = []; }, () => { h.cfg.allow.groups = ['456']; }],
  ];
  const before = () => plain({ unread: st.unread, wakeConfig: st.wakeConfig, lastReadThroughSeq: st.lastReadThroughSeq,
    observedAt: st.preSleepWaitObservedAt, satisfiedAt: st.preSleepWaitSatisfiedAt });
  for (const [label, revoke, restore] of cases) {
    const snapshot = before();
    const waiting = request('wait', { body: { timeoutMs: 100, quietMs: 0 } });
    const timer = setTimeout(revoke, 60);
    let result;
    try { result = await waiting; } finally { clearTimeout(timer); restore(); }
    assert.equal(result.status, 403, label);
    assert.equal(result.data.newMessages, undefined, label);
    assert.deepEqual(before(), snapshot, `${label} cannot modify observation, unread or wake config`);
  }
}, { observe: true });

await test('oversized first stored unread remains intact and cannot be skipped by the snapshot', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.wakeMaxChars = 500;
  // Existing bridge storage keeps head/tail excerpts. Distinct long excerpts
  // exceed this snapshot budget and must not be truncated a second time.
  const long = '消息前半部分'.repeat(100) + '消息后半部分'.repeat(100);
  append(long); append('small but newer');
  const storedBefore = plain(st.unread[0]);
  const snapshot = h.buildWakeSnapshotV2(KEY);
  assert.equal(snapshot.messages.length, 0);
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.readThroughSeq, 0);
  assert.ok(JSON.stringify(snapshot).length <= 500);
  assert.deepEqual(plain(st.unread[0]), storedBefore);
  const unread = await request('unread');
  assert.deepEqual(unread.data.messages[0], storedBefore);
});

await test('snapshot recent history stays chronological and does not duplicate unread', async ({ h, request, append }) => {
  append('history 1'); append('history 2'); append('history 3');
  await request('mark-read', { body: {} });
  append('current unread');
  h.cfg.socialV2.context.wakeRecentLimit = 2;
  const snapshot = h.buildWakeSnapshotV2(KEY);
  assert.deepEqual(seqs(snapshot.messages), [4]);
  assert.deepEqual(seqs(snapshot.recent), [2, 3]);
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.readThroughSeq, 4);
});

await test('snapshot feature and tool flags cannot be bypassed through inline recent history', async ({ h, request, append }) => {
  append('authorized old history');
  await request('mark-read', { body: {} });
  append('unread requiring getUnread');
  h.cfg.socialV2.tools.getUnread = false;
  let snapshot = h.buildWakeSnapshotV2(KEY);
  assert.equal(snapshot.messages.length, 0);
  assert.deepEqual(seqs(snapshot.recent), [1]);
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.readThroughSeq, 1);
  h.cfg.socialV2.tools.getRecent = false;
  assert.equal(h.buildWakeSnapshotV2(KEY), null);
  h.cfg.socialV2.tools.getUnread = true;
  snapshot = h.buildWakeSnapshotV2(KEY);
  assert.deepEqual(seqs(snapshot.messages), [2]);
  assert.equal(snapshot.recent.length, 0);
  h.cfg.socialV2.context.inlineWakeMessages = false;
  assert.equal(h.buildWakeSnapshotV2(KEY), null);
});

await test('a compact image handle still resolves after unread outlives the recent buffer', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.recentLimit = 1;
  append('old unread image', { id: '900719925474099312345', media: [{ kind: 'image', file: 'fixture-kept-image' }] });
  append('newer text');
  assert.deepEqual(seqs(st.recentMessages), [2]);
  assert.deepEqual(seqs(st.unread), [1, 2]);
  const snapshot = h.buildWakeSnapshotV2(KEY);
  assert.equal(snapshot.messages[0].media[0].index, 1);
  assert.equal(snapshot.messages[0].media[0].file, undefined);
  for (const messageId of ['1', '900719925474099312345']) {
    const result = await request('/api/images/message', { query: `&messageId=${messageId}` });
    assert.equal(result.status, 200);
    assert.equal(result.data.media[0].file, 'fixture-kept-image');
    assert.equal(result.data.images[0].mimeType, 'image/png');
    assert.ok(result.data.images[0].data.length > 0, 'fixture gateway should return an actual image');
  }
  assert.deepEqual(h.calls.images, ['fixture-kept-image', 'fixture-kept-image']);
});

await test('busy and rate-limited wake attempts preserve the current observation state', async ({ h, st, append }) => {
  append('already observed');
  const setObservation = () => { st.preSleepWaitObservedAt = 123; st.preSleepWaitSatisfiedAt = 456; st.preSleepWaitAccumMs = 789; };
  const checkObservation = () => assert.deepEqual([st.preSleepWaitObservedAt, st.preSleepWaitSatisfiedAt, st.preSleepWaitAccumMs], [123, 456, 789]);
  setObservation();
  h.promptQueues.set(KEY, { running: true, queue: [] });
  await h.sendWakePromptV2(KEY, 'question');
  checkObservation();
  h.promptQueues.delete(KEY);
  h.cfg.socialV2.wake.maxWakePerMinute = 1;
  st.wakeTimes = [Date.now()];
  await h.sendWakePromptV2(KEY, 'question');
  checkObservation();
  assert.equal(h.calls.prompts.length, 0);
});

await test('a rejected prompt does not authorize the undelivered snapshot', async ({ h, st, request, append }) => {
  append('rejected snapshot');
  h.api.sessions.prompt = async (params) => {
    h.calls.prompts.push(params);
    return { result: { ok: false, error: { code: 'FIXTURE_REJECT', message: 'fixture rejection' } } };
  };
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal(h.calls.prompts.length, 1);
  assert.equal((await request('mark-read', { body: { throughSeq: 1 } })).status, 400);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('a new arrival during prompt acceptance is not implicitly part of the delivered snapshot', async ({ h, st, request, append }) => {
  append('snapshot message');
  h.api.sessions.prompt = async (params) => {
    h.calls.prompts.push(params);
    append('arrived after snapshot construction');
    return { result: { ok: true, value: {} } };
  };
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal((await request('mark-read', { body: { throughSeq: 2 } })).status, 400);
  assert.equal((await request('wake-config', { body: { throughSeq: 1, config: ACTIVE } })).status, 200);
  assert.deepEqual(seqs(st.unread), [2]);
});

await test('a retired prompt session cannot grant a receipt when its old acceptance returns', async ({ h, st, request, append }) => {
  append('retired snapshot');
  h.api.sessions.prompt = async (params) => {
    h.calls.prompts.push(params);
    h.retireSession(KEY);
    return { result: { ok: true, value: {} } };
  };
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal((await request('mark-read', { body: { throughSeq: 1 }, token: st.agentToken })).status, 400);
  assert.deepEqual(seqs(st.unread), [1]);
});

await test('offline wake replay builds a fresh snapshot with the current session token', async ({ h, st, request, append }) => {
  await h.ensureSession(KEY);
  const originalToken = st.agentToken;
  append('queued initial message');
  h.setReady(false);
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal(h.calls.prompts.length, 0);
  assert.equal((await request('mark-read', { body: { throughSeq: 1 } })).status, 400);
  h.retireSession(KEY);
  append('queued later message');
  h.setReady(true);
  await h.flushQueue();
  assert.equal(h.calls.prompts.length, 1);
  const content = h.calls.prompts[0].content.map((part) => part.text || '').join('\n');
  assert.ok(content.includes('queued initial message'));
  assert.ok(content.includes('queued later message'));
  assert.ok(content.includes(st.agentToken));
  assert.ok(!content.includes(originalToken));
  assert.equal((await request('mark-read', { body: { throughSeq: 2 }, token: st.agentToken })).status, 200);
});

await test('offline reserved2 wake replay cannot leak into an ordinary chat session', async ({ h, append }) => {
  append('reserved2 queue message');
  h.setReady(false);
  await h.sendWakePromptV2(KEY, 'question');
  h.setMode('chat');
  h.setReady(true);
  await h.flushQueue();
  assert.equal(h.calls.prompts.length, 0);
});

await test('real wake delivery inlines compact messages with exact quote and media handles', async ({ h, st, request, append }) => {
  append('fixture-inline-content', { id: '900719925474099312345',
    media: [{ kind: 'image', file: 'fixture-local-image', url: 'https://images.invalid/fixture-secret' }],
    forwards: ['fixture-forward-123'],
  });
  await h.sendWakePromptV2(KEY, 'question');
  assert.equal(h.calls.prompts.length, 1);
  const text = h.calls.prompts[0].content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  assert.ok(text.includes('fixture-inline-content'));
  assert.ok(text.includes('900719925474099312345'), 'quote ID must remain an exact string');
  assert.ok(text.includes('fixture-forward-123'), 'forward handle must remain fetchable');
  assert.ok(text.includes('readThroughSeq'));
  assert.ok(!text.includes('fixture-secret'), 'media URL is unnecessary when the local seq can resolve it');
  const close = await request('wake-config', { body: { config: ACTIVE, throughSeq: 1 } });
  assert.equal(close.status, 200, 'delivered inline content should authorize its cursor');
  assert.deepEqual(seqs(st.unread), []);
});

await test('oldest-first unread paging can drain a backlog beyond both recent and response limits', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.unreadLimit = 150;
  h.cfg.socialV2.context.recentLimit = 100;
  h.cfg.socialV2.context.inlineWakeMessages = false;
  for (let i = 1; i <= 150; i++) append(`backlog ${i}`);
  const tail = await request('unread', { query: '&limit=100' });
  assert.equal(tail.data.messages[0].seq, 51, 'legacy tail ordering stays unchanged');
  assert.equal(tail.data.readThroughSeq, 0);
  const first = await request('unread', { query: '&limit=30&afterSeq=0' });
  assert.deepEqual(seqs(first.data.messages), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.equal(first.data.readThroughSeq, 30);
  const next = await request('unread', { query: '&limit=30&afterSeq=30' });
  assert.equal(next.data.messages[0].seq, 31);
  assert.equal(next.data.readThroughSeq, 150, 'previous tail receipt now joins the complete prefix');
  append('arrived after complete read');
  assert.equal((await request('wake-config', { body: { config: ACTIVE, throughSeq: next.data.readThroughSeq } })).status, 200);
  assert.deepEqual(seqs(st.unread), [151]);
  for (const value of ['', '-1', '1.2', 'text', '9007199254740992']) {
    assert.equal((await request('unread', { query: `&afterSeq=${value}` })).status, 400);
  }
});

await test('offline queued wakes respect pause and disable at dispatch without exposing messages', async ({ h, st, append }) => {
  append('queued while active');
  for (const policy of ['paused', 'disabled']) {
    h.setReady(false);
    await h.sendWakePromptV2(KEY, 'question');
    if (policy === 'paused') h.socialV2.paused = true;
    else h.cfg.socialV2.enabled = false;
    h.setReady(true);
    await h.flushQueue();
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(st.modelSeenSeqs.size, 0);
    assert.deepEqual(seqs(st.unread), [1]);
    h.socialV2.paused = false;
    h.cfg.socialV2.enabled = true;
  }
});

await test('an evicted unread window cannot drag the acknowledged watermark back to zero', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.unreadLimit = 5;
  h.cfg.socialV2.context.recentLimit = 100;
  h.cfg.socialV2.context.inlineWakeMessages = false;
  for (let i = 1; i <= 5; i++) append(`seen ${i}`);
  const read = await request('unread', { query: '&limit=5&afterSeq=0' });
  assert.equal(read.data.readThroughSeq, 5);
  assert.equal((await request('mark-read', { body: { throughSeq: 5 } })).status, 200);
  assert.equal(st.lastReadThroughSeq, 5, 'the acknowledged watermark is persisted');
  // A burst pushes the retained unread window entirely above the watermark, so the
  // earliest buffered seq is no longer through+1. The watermark is a floor: it must
  // never be reported as 0 just because the buffer evicted the seqs that proved it.
  for (let i = 6; i <= 11; i++) append(`burst ${i}`);
  assert.deepEqual(seqs(st.unread), [7, 8, 9, 10, 11], 'older unread was evicted by unreadLimit');
  const after = await request('unread', { query: '&limit=5&afterSeq=5' });
  assert.ok(after.data.readThroughSeq >= 5, `watermark regressed to ${after.data.readThroughSeq}`);
  assert.equal(after.data.messages.length, 5, `afterSeq returned ${JSON.stringify(seqs(after.data.messages))}`);
  assert.equal(after.data.readThroughSeq, 11, `newly displayed messages must extend the watermark from its floor (got ${after.data.readThroughSeq})`);
  const again = await request('mark-read', { body: { throughSeq: 11 } });
  assert.equal(again.status, 200, 'a cursor earned by the model must stay acceptable after eviction');
  assert.deepEqual(seqs(st.unread), []);
});

await test('a plain query cannot lower the persisted watermark below what was already acknowledged', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.unreadLimit = 3;
  h.cfg.socialV2.context.inlineWakeMessages = false;
  h.cfg.socialV2.wake.preSleepWaitEnabled = false; // isolate the cursor from the sleep gate
  for (let i = 1; i <= 3; i++) append(`seen ${i}`);
  const first = await request('unread', { query: '&limit=3&afterSeq=0' });
  assert.equal(first.data.readThroughSeq, 3);
  assert.equal((await request('mark-read', { body: { throughSeq: 3 } })).status, 200);
  assert.equal(st.lastReadThroughSeq, 3);
  // A burst evicts everything that proved the watermark. The watermark is a floor, so
  // every later report must still start from 3 -- never from 0.
  for (let i = 4; i <= 6; i++) append(`burst ${i}`);
  assert.deepEqual(seqs(st.unread), [4, 5, 6]);
  const state = h.getSocialV2State(KEY);
  const cached = await request('my-recent');
  assert.equal(cached.data.readThroughSeq, 3, `my-recent reported ${cached.data.readThroughSeq}, expected the floor 3`);
  const wake = await request('wake-config', { body: { config: ACTIVE } });
  assert.equal(wake.status, 200);
  assert.equal(wake.data.readThroughSeq, 3, `wake-config reported ${wake.data.readThroughSeq}, expected the floor 3`);
  assert.deepEqual(seqs(state.unread), [4, 5, 6], 'skip-free state: unread is untouched without a cursor');
});

await test('a displayed page extends the watermark across an eviction gap it can never show again', async ({ h, st, request, append }) => {
  h.cfg.socialV2.context.unreadLimit = 4;
  h.cfg.socialV2.context.recentLimit = 100;
  h.cfg.socialV2.context.inlineWakeMessages = false;
  h.cfg.socialV2.wake.preSleepWaitEnabled = false;
  for (let i = 1; i <= 2; i++) append(`early ${i}`);
  const early = await request('unread', { query: '&limit=2&afterSeq=0' });
  assert.equal(early.data.readThroughSeq, 2);
  for (let i = 3; i <= 6; i++) append(`burst ${i}`);
  assert.deepEqual(seqs(st.unread), [3, 4, 5, 6], 'nothing was evicted yet');
  // seq 3 is still pending: a cursor for it must not become acceptable just because a
  // later page was displayed.
  assert.equal((await request('mark-read', { body: { throughSeq: 4 } })).status, 400);
  assert.equal((await request('mark-read', { body: { throughSeq: 6 } })).status, 400);
  const page = await request('unread', { query: '&limit=2&afterSeq=2' });
  assert.deepEqual(seqs(page.data.messages), [3, 4]);
  assert.equal(page.data.messages.some((m) => m.seq === 3), true);
  // With 3 and 4 displayed, the run from the floor 2 is unbroken: the cursor is 4, and
  // seq 5,6 stay pending rather than being cleared by it.
  assert.equal(page.data.readThroughSeq, 4);
  assert.equal((await request('mark-read', { body: { throughSeq: 4 } })).status, 200);
  assert.deepEqual(seqs(st.unread), [5, 6]);
});

await test('message detail reports truncation instead of passing a preview off as the full text', async ({ h, st, request, append }) => {
  append('短消息');
  const short = await request('message-detail', { query: '&messageId=1' });
  assert.equal(short.status, 200);
  assert.equal(short.data.info.textTruncated, false, 'a short message is not truncated');
  // Bridge storage keeps a 200-character head/tail preview; the detail view shows the
  // same preview and must say so rather than implying it holds the whole message.
  append('长'.repeat(400));
  const long = await request('message-detail', { query: '&messageId=2' });
  assert.equal(long.status, 200);
  assert.equal(long.data.info.text.length, 200);
  assert.equal(long.data.info.textTruncated, true, 'a capped preview must be reported as truncated');
});

console.log(`\nToken economy bridge regressions: ${tests - failures}/${tests} passed.`);
if (failures) process.exitCode = 1;
