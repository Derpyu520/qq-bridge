// Isolated protocol peers only; never contact an installed DSH or QQ account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupProbeSession, createProbeDirectory, probeMux, probeTurn } from './adaptation-probe-helpers.mjs';

class FixtureSocket extends EventTarget {
  static respond;
  constructor() {
    super();
    this.closed = false;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(text) {
    this.request = JSON.parse(text);
    FixtureSocket.respond(this, this.request);
  }
  frame(type, value) {
    const event = new Event('message');
    event.data = JSON.stringify({ type, streamId: this.request.streamId, ...value });
    this.dispatchEvent(event);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event('close'));
  }
}

const options = { url: 'ws://fixture.invalid/api/remote.mux', cookie: 'fixture-cookie',
  WebSocketClass: FixtureSocket, timeoutMs: 30 };
const baselineProbe = () => probeMux({ ...options, endpoint: 'session/control', args: {},
  onItem: (value) => value?.type === 'baseline' ? value : undefined });

let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log('PASS', name);
}

await test('concurrent probe directories are exclusive and preserve each other', async () => {
  const first = createProbeDirectory();
  const second = createProbeDirectory();
  try {
    assert.notEqual(first, second);
    fs.writeFileSync(path.join(first, 'marker'), 'preserved');
    fs.rmSync(second, { recursive: true, force: true });
    assert.equal(fs.readFileSync(path.join(first, 'marker'), 'utf8'), 'preserved');
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

await test('required control baseline accepts the actual mux envelope', async () => {
  FixtureSocket.respond = (socket, request) => {
    assert.equal(request.endpoint, 'session/control');
    assert.deepEqual(request.payload, { args: {} });
    socket.frame('item', { value: { type: 'baseline', value: { projections: {} } } });
  };
  assert.deepEqual(await baselineProbe(), { type: 'baseline', value: { projections: {} } });
});

for (const kind of ['error', 'end', 'close', 'timeout']) {
  await test(`required control ${kind} rejects instead of passing or skipping`, async () => {
    FixtureSocket.respond = (socket) => {
      if (kind === 'close') socket.close();
      else if (kind !== 'timeout') socket.frame(kind, { error: { code: 'fixture/unavailable' } });
    };
    await assert.rejects(baselineProbe(), /session\/control/);
  });
}

await test('real turn waits for the follow snapshot and validates prompt acceptance', async () => {
  let socket;
  let prompts = 0;
  FixtureSocket.respond = (peer, request) => {
    socket = peer;
    assert.equal(request.payload.args.request.activate, true);
    assert.equal(prompts, 0);
    peer.frame('item', { value: { type: 'snapshot' } });
  };
  const api = { sessions: { prompt: async (request, signal) => {
    prompts++;
    assert.equal(request.sessionId, 'fixture-turn');
    assert.equal(signal.aborted, false);
    queueMicrotask(() => {
      socket.frame('item', { value: { type: 'event', event: { type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '收到' }] } } } } });
      socket.frame('item', { value: { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } } });
    });
    return { result: { ok: true, value: {} } };
  } } };
  assert.deepEqual(await probeTurn(api, 'fixture-turn', options), { reason: { kind: 'completed' }, text: '收到' });
  assert.equal(prompts, 1);
});

await test('a rejected prompt fails immediately with its RPC error', async () => {
  FixtureSocket.respond = (peer) => peer.frame('item', { value: { type: 'snapshot' } });
  const api = { sessions: { prompt: async () => ({ result: { ok: false,
    error: { code: 'session/not-found', message: 'fixture rejected' } } }) } };
  await assert.rejects(probeTurn(api, 'fixture-turn', options), /session\.prompt failed: session\/not-found/);
});

for (const accepted of [false, true]) {
  await test(`turn/end waits for a delayed ${accepted ? 'successful' : 'rejected'} prompt ACK`, async () => {
    let socket;
    let acknowledge;
    let settled = false;
    const ack = new Promise((resolve) => { acknowledge = resolve; });
    FixtureSocket.respond = (peer) => {
      socket = peer;
      peer.frame('item', { value: { type: 'snapshot' } });
    };
    const api = { sessions: { prompt: async () => {
      socket.frame('item', { value: { type: 'event', event: { type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '收到' }] } } } } });
      socket.frame('item', { value: { type: 'event', event: { type: 'turn/end',
        data: { reason: { kind: 'completed' } } } } });
      return ack;
    } } };
    const result = probeTurn(api, 'fixture-turn', { ...options, timeoutMs: 500 });
    result.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, 'completed events cannot pass verification before the prompt ACK');
    acknowledge({ result: accepted ? { ok: true, value: {} }
      : { ok: false, error: { code: 'fixture/rejected', message: 'delayed rejection' } } });
    if (accepted) assert.deepEqual(await result, { reason: { kind: 'completed' }, text: '收到' });
    else await assert.rejects(result, /session\.prompt failed: fixture\/rejected/);
  });
}

await test('timed out turns abort their prompt and stop work before archive', async () => {
  let promptSignal;
  let active = true;
  const calls = [];
  FixtureSocket.respond = (peer) => peer.frame('item', { value: { type: 'snapshot' } });
  const api = {
    sessions: { prompt: async (_request, signal) => {
      promptSignal = signal;
      return { result: { ok: true, value: {} } };
    } },
    stopSessionWork: async (sessionId) => { calls.push(['stop', sessionId]); active = false; },
    callUnary: async (method, request) => {
      calls.push(['archive', method, request]);
      assert.equal(active, false);
      return { result: { ok: true, value: {} } };
    },
  };
  await assert.rejects(probeTurn(api, 'fixture-turn', options), /session\/follow 超时/);
  assert.equal(promptSignal.aborted, true);
  assert.deepEqual(await cleanupProbeSession(api, 'fixture-turn'), []);
  assert.deepEqual(calls, [['stop', 'fixture-turn'], ['archive', 'workspace/archiveSession',
    { sessionId: 'fixture-turn', stopActivity: true }]]);
});

await test('a closed follow cannot send a delayed prompt after cleanup', async () => {
  let prompts = 0;
  FixtureSocket.respond = (peer) => peer.close();
  const api = { sessions: { prompt: async () => { prompts++; } } };
  await assert.rejects(probeTurn(api, 'fixture-turn', options), /socket closed/);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(prompts, 0);
});

await test('cleanup inspects RPC error results and still attempts archive after stop failure', async () => {
  let archived = false;
  const errors = await cleanupProbeSession({
    stopSessionWork: async () => { throw new Error('fixture stop failed'); },
    callUnary: async (_method, request) => {
      archived = true;
      assert.equal(request.stopActivity, true);
      return { result: { ok: false, error: { code: 'workspace/session-active', message: 'fixture active' } } };
    },
  }, 'fixture-turn');
  assert.equal(archived, true);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /fixture stop failed/);
  assert.match(errors[1], /workspace\/session-active/);
});

console.log(`Adaptation probes: ${passed}/${passed} passed.`);
