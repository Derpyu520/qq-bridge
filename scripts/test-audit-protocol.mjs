// Offline regression tests. No real DSH/QQ endpoints or local credentials are read.
import assert from 'node:assert/strict';
import { NodeApiClient, setWebSocketImplementation } from '../src/dsh-client.js';

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const originalHome = process.env.DSH_HOME;
process.env.DSH_HOME = new URL('./.no-real-dsh-home', import.meta.url).pathname;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const unhandled = [];
const onUnhandled = (error) => unhandled.push(error);
process.on('unhandledRejection', onUnhandled);
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
// 用回环地址：launch token 交换默认**拒绝非回环 baseUrl**（凭据只应交给 127.0.0.1），
// 所以夹具不能用 dsh.invalid 这类域名，否则测的是新加的那道闸门而不是协议行为。
const client = (timeoutMs = 1000) => new NodeApiClient('http://127.0.0.1:9', timeoutMs, { token: 'fixture-token' });

test('session/cancel uses the DSH request wrapper and unwraps the envelope', async () => {
  const api = client();
  api.cookie = 'fixture=ok';
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(input).pathname, '/api/session/cancel');
    const envelope = JSON.parse(init.body);
    assert.equal(envelope.method, 'session/cancel');
    assert.deepEqual(envelope.payload, { args: { request: { sessionId: 'session-a' } } });
    return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { accepted: true } } });
  };
  const response = await api.callUnary('session/cancel', { sessionId: 'session-a' });
  assert.equal(response.result.value.accepted, true);
});

test('a handled auth exchange failure has no orphan rejection', async () => {
  globalThis.fetch = async () => new Response('', { status: 401 });
  const api = client();
  const before = unhandled.length;
  await assert.rejects(api.ensureAuth(), /token exchange failed/);
  await tick();
  assert.equal(api.cookiePromise, null);
  assert.equal(unhandled.length, before);
});

test('concurrent stale 401 responses share one fresh auth exchange', async () => {
  const api = client();
  api.cookie = 'fixture=old';
  let exchanges = 0;
  let resolveExchange;
  let resolveSecond;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/') {
      exchanges += 1;
      return new Promise((resolve) => { resolveExchange = resolve; });
    }
    if (new Headers(init?.headers).get('cookie') === 'fixture=old') {
      if (url.pathname === '/a') return new Response('', { status: 401 });
      return new Promise((resolve) => { resolveSecond = resolve; });
    }
    return new Response('ok');
  };
  const first = api.doFetch('http://dsh.invalid/a');
  const second = api.doFetch('http://dsh.invalid/b');
  const outcomes = Promise.allSettled([first, second]);
  await tick();
  assert.equal(exchanges, 1);
  const finishFirstExchange = resolveExchange;
  resolveSecond(new Response('', { status: 401 }));
  await tick();
  // Resolve every exchange even in the defective implementation, so the test cannot hang.
  finishFirstExchange(new Response('', { headers: { 'set-cookie': 'fixture=new; HttpOnly' } }));
  if (resolveExchange !== finishFirstExchange) resolveExchange(new Response('', { headers: { 'set-cookie': 'fixture=new; HttpOnly' } }));
  const results = await outcomes;
  await tick();
  assert.equal(exchanges, 1, 'old 401 must not invalidate an in-flight refresh');
  assert.ok(results.every((result) => result.status === 'fulfilled'));
});

test('RPC cancellation interrupts waiting for shared auth without cancelling other callers', async () => {
  const api = client();
  let resolveExchange;
  let rpcCalls = 0;
  globalThis.fetch = async (input) => {
    if (new URL(input).pathname === '/') return new Promise((resolve) => { resolveExchange = resolve; });
    rpcCalls += 1;
    return new Response('ok');
  };
  const abort = new AbortController();
  const pending = api.doFetch('http://dsh.invalid/a', { signal: abort.signal });
  const pendingOutcome = pending.then(() => 'fulfilled', (error) => error);
  const shared = api.ensureAuth();
  const reason = new Error('fixture cancellation');
  abort.abort(reason);
  await tick();
  const marker = {};
  const result = await Promise.race([pendingOutcome, Promise.resolve(marker)]);
  resolveExchange(new Response('', { headers: { 'set-cookie': 'fixture=new' } }));
  await shared;
  await pendingOutcome;
  assert.equal(result, reason, 'cancelled RPC must settle before the exchange finishes');
  assert.equal(rpcCalls, 0, 'cancelled RPC must never be sent');
});

test('auth exchange has an independent bounded timeout', async () => {
  let suppliedSignal;
  globalThis.fetch = async (_input, init) => {
    suppliedSignal = init?.signal;
    assert.ok(suppliedSignal instanceof AbortSignal);
    return new Promise((_resolve, reject) => suppliedSignal.addEventListener('abort', () => reject(suppliedSignal.reason), { once: true }));
  };
  const keepAlive = setTimeout(() => {}, 250);
  try { await assert.rejects(client(30).ensureAuth(), (error) => error.name === 'TimeoutError'); }
  finally { clearTimeout(keepAlive); }
  assert.equal(new NodeApiClient('http://127.0.0.1:9', undefined, {}).timeoutMs, 30000);
});

// 新增闸门：launch token 是进程启动凭据，交换时必须放进 URL，因此默认只允许回环地址。
test('non-loopback baseUrl is refused unless allowRemote is set explicitly', async () => {
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return new Response('', { status: 303 }); };
  await assert.rejects(
    new NodeApiClient('http://dsh.example.com', 1000, { token: 'fixture-token' }).ensureAuth(),
    /非本机地址/,
  );
  assert.equal(fetched, false, '拒绝时不应该发出任何请求');
  // 127.0.0.0/8、localhost 都算回环；显式 opt-in 后放行（这里只验证不再被闸门拦下）
  await assert.rejects(
    new NodeApiClient('http://127.1.2.3:3080', 1000, { token: 'fixture-token' }).ensureAuth(),
    /token exchange failed/,
  );
  await assert.rejects(
    new NodeApiClient('http://dsh.example.com', 1000, { token: 'fixture-token', allowRemote: true }).ensureAuth(),
    /token exchange failed/,
  );
});

class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
  static sockets = [];
  constructor() { this.readyState = 0; this.listeners = new Map(); this.frames = []; FakeWebSocket.sockets.push(this); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, data = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn(data); }
  open() { this.readyState = 1; this.emit('open'); }
  send(data) { if (this.failSend) throw new Error('fixture transport failure'); this.frames.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
  frame(frame) { this.emit('message', { data: JSON.stringify(frame) }); }
}

// 退役会话要清掉 DSH 侧未跑的队列。读队列有两条路（见 src/dsh-client.js）：
//   主路径 session/projections（0.2.0 的一元 RPC，不开 WebSocket）
//   回退   session/control 开场 baseline（endpoint 不存在时）
// 下面四条把两条路都钉住，并钉住 0.2.0 的 baseline 形状
// （value.projections[<id>].values.inbox；0.1.7 的 value.queues 已不存在）。
const projectionValues = (inbox) => ({ title: null, ...(inbox === undefined ? {} : { inbox }) });
/** 让 session/projections 这条一元 RPC 不可用，逼出回退路径。 */
const unavailableProjections = async (method, payload) => (
  method === 'session/projections'
    ? { result: { ok: false, error: { code: 'gateway/not-found', message: 'unknown endpoint' } } }
    : { result: { ok: true, value: { accepted: true } } }
);

test('session retirement reads the inbox projection through session/projections (no socket)', async () => {
  setWebSocketImplementation(FakeWebSocket);
  const before = FakeWebSocket.sockets.length;
  const api = client();
  api.cookie = 'fixture=ok';
  const calls = [];
  api.callUnary = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'session/projections') {
      return { result: { ok: true, value: { asOfSeq: 5, values: projectionValues({
        'next-turn': [{ id: 'own-1' }, { id: 'own-2' }], 'next-step': []
      }) } } };
    }
    return { result: { ok: true, value: { accepted: true } } };
  };
  assert.deepEqual(await api.stopSessionWork('session-a'), { removed: 2 });
  assert.deepEqual(calls, [
    { method: 'session/projections', payload: { sessionId: 'session-a' } },
    { method: 'session/updateQueue', payload: { sessionId: 'session-a', itemId: 'own-1', action: { kind: 'remove' } } },
    { method: 'session/updateQueue', payload: { sessionId: 'session-a', itemId: 'own-2', action: { kind: 'remove' } } },
    { method: 'session/cancel', payload: { sessionId: 'session-a' } }
  ]);
  // 主路径不该开任何 WebSocket。
  assert.equal(FakeWebSocket.sockets.length, before);
});

test('session retirement falls back to the 0.2.0 control baseline shape and removes only its own items', async () => {
  setWebSocketImplementation(FakeWebSocket);
  const api = client();
  api.cookie = 'fixture=ok';
  const calls = [];
  api.callUnary = async (method, payload) => { calls.push({ method, payload }); return unavailableProjections(method, payload); };
  const stopped = api.stopSessionWork('session-a');
  await tick();
  const socket = FakeWebSocket.sockets.at(-1);
  socket.open();
  const opening = socket.frames.at(-1);
  assert.equal(opening.endpoint, 'session/control');
  assert.deepEqual(opening.payload, { args: {} });
  socket.frame({ type: 'item', streamId: opening.streamId, value: { type: 'baseline', value: {
    projections: {
      'session-a': { asOfSeq: 9, values: projectionValues({ 'next-turn': [{ id: 'own-1' }], 'next-step': [{ id: 'own-2' }] }) },
      'session-b': { asOfSeq: 4, values: projectionValues({ 'next-turn': [{ id: 'other' }], 'next-step': [] }) }
    }
  } } });
  assert.deepEqual(await stopped, { removed: 2 });
  assert.deepEqual(calls.filter((c) => c.method === 'session/updateQueue').map((c) => c.payload.itemId), ['own-1', 'own-2']);
  assert.deepEqual(calls.at(-1), { method: 'session/cancel', payload: { sessionId: 'session-a' } });
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});

test('session retirement closes its control socket on timeout', async () => {
  setWebSocketImplementation(FakeWebSocket);
  const api = client();
  api.cookie = 'fixture=ok';
  // 主路径不可用 ⇒ 走 control 流；control 流始终不发 baseline ⇒ 只能被超时中止。
  api.callUnary = async (method, payload, signal) => { signal?.throwIfAborted(); return unavailableProjections(method, payload); };
  const keepAlive = setTimeout(() => {}, 250);
  try {
    const stopped = api.stopSessionWork('session-a', { timeoutMs: 30 });
    await assert.rejects(stopped, (error) => error.name === 'TimeoutError');
    assert.equal(FakeWebSocket.sockets.at(-1).readyState, FakeWebSocket.CLOSED);
  } finally { clearTimeout(keepAlive); }
});

test('session retirement reports control failure while still cancelling active work', async () => {
  setWebSocketImplementation(FakeWebSocket);
  const api = client();
  api.cookie = 'fixture=ok';
  const calls = [];
  api.callUnary = async (method, payload) => { calls.push(method); return unavailableProjections(method, payload); };
  const stopped = api.stopSessionWork('session-a');
  const failure = assert.rejects(stopped, /session\/control ended/);
  await tick();
  const socket = FakeWebSocket.sockets.at(-1);
  socket.open();
  socket.frame({ type: 'error', streamId: socket.frames.at(-1).streamId, error: { code: 'gateway/internal' } });
  await failure;
  // 读队列失败不能阻止取消当前 turn —— 否则旧任务会一直跑下去。
  assert.deepEqual(calls.filter((m) => m !== 'session/projections'), ['session/cancel']);
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});

test('pre-aborted event stream never opens a WebSocket', async () => {
  setWebSocketImplementation(FakeWebSocket);
  globalThis.fetch = async () => new Response('', { headers: { 'set-cookie': 'fixture=ok' } });
  const api = client();
  const abort = new AbortController();
  abort.abort();
  const before = FakeWebSocket.sockets.length;
  await api.events.mux({}, abort.signal)[Symbol.asyncIterator]().next().catch(() => {});
  assert.equal(FakeWebSocket.sockets.length, before);
});

test('failed follow send can be retried and never stays marked followed', async () => {
  setWebSocketImplementation(FakeWebSocket);
  const api = client();
  api.cookie = 'fixture=ok';
  const abort = new AbortController();
  const iterator = api.events.mux({}, abort.signal)[Symbol.asyncIterator]();
  const next = iterator.next();
  await tick();
  const socket = FakeWebSocket.sockets.at(-1);
  socket.open();
  socket.failSend = true;
  api.events.follow('session-a');
  socket.failSend = false;
  api.events.follow('session-a');
  const retried = socket.frames.some((frame) => frame.endpoint === 'session/follow');
  await tick();
  const ended = socket.readyState === FakeWebSocket.CLOSED;
  abort.abort();
  await next;
  assert.ok(retried || ended, 'failure must permit retry or end transport');
});

for (const type of ['end', 'error']) {
  test(`logical $events ${type} ends the transport so the bridge can reconnect`, async () => {
    setWebSocketImplementation(FakeWebSocket);
    const api = client();
    api.cookie = 'fixture=ok';
    api.events.follow('session-a');
    const abort = new AbortController();
    const iterator = api.events.mux({}, abort.signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    await tick();
    const socket = FakeWebSocket.sockets.at(-1);
    socket.open();
    const events = socket.frames.find((frame) => frame.endpoint === '$events');
    socket.frame({ type, streamId: events.streamId, error: type === 'error' ? { code: 'gateway/internal' } : undefined });
    await tick();
    const marker = {};
    const result = await Promise.race([next, Promise.resolve(marker)]);
    const closed = socket.readyState === FakeWebSocket.CLOSED;
    abort.abort();
    await next;
    assert.equal(result.done, true, 'logical stream failure must wake the generator');
    assert.ok(closed);
    assert.ok(api._desiredFollows.has('session-a'));
  });
}

test('transient follow errors preserve subscriptions and close transport for retry', async () => {
  setWebSocketImplementation(FakeWebSocket);
  const api = client();
  api.cookie = 'fixture=ok';
  api.events.follow('session-a');
  const abort = new AbortController();
  const iterator = api.events.mux({}, abort.signal)[Symbol.asyncIterator]();
  const next = iterator.next();
  await tick();
  const socket = FakeWebSocket.sockets.at(-1);
  socket.open();
  const follow = socket.frames.find((frame) => frame.endpoint === 'session/follow');
  socket.frame({ type: 'error', streamId: follow.streamId, error: { code: 'gateway/internal' } });
  await next;
  const ending = iterator.next();
  await tick();
  const ended = await Promise.race([ending, Promise.resolve({ done: false })]);
  abort.abort(); await ending;
  assert.ok(api._desiredFollows.has('session-a'));
  assert.equal(ended.done, true);
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.message}`); }
  }
} finally {
  globalThis.fetch = originalFetch;
  setWebSocketImplementation(originalWebSocket);
  if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
  process.removeListener('unhandledRejection', onUnhandled);
}
console.log(`${tests.length - failed}/${tests.length} offline protocol regressions passed`);
process.exitCode = failed ? 1 : 0;
