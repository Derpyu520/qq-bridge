// Offline TTS regressions: fake HTTP peers, synthetic WAV, temporary cache only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createTtsSynthesizer, defaultTtsCfg, normalizeTtsCfg } from '../src/tts-core.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function wav() {
  const b = Buffer.alloc(2044);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(32000, 24); b.writeUInt32LE(64000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  return b;
}
function fixture(t, config = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const synth = createTtsSynthesizer({ enabled: true, maxPerMinute: 100, maxPerHour: 100, ...config }, {
    stateDir: path.join(root, 'state'),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(wav()); },
    ...options
  });
  return { synth, calls, root };
}

test('defaults stay off; malformed URLs, credential URLs and invalid limits fail closed', () => {
  assert.equal(defaultTtsCfg().enabled, false);
  for (const config of [
    { baseUrl: 'file:///tmp' }, { baseUrl: 'https://name:secret@tts.invalid' },
    { baseUrl: 'https://tts.invalid?api_key=secret' }, { endpoint: '//other.invalid' },
    { maxPending: 0 }, { maxPerMinute: -1 }, { maxPerHour: 1.5 },
    { cacheMaxEntries: 0 }, { cacheTtlMs: 0 }, { apiKeyEnv: 'Bearer secret' }
  ]) assert.throws(() => normalizeTtsCfg(config));
});

test('disabled, blank and excessive text never call the external service', async t => {
  const off = fixture(t, { enabled: false });
  await assert.rejects(off.synth.synthesize('hello'), /未启用/);
  assert.equal(off.calls.length, 0);
  const f = fixture(t, { maxChars: 10 });
  await assert.rejects(f.synth.synthesize('  '), /为空/);
  await assert.rejects(f.synth.synthesize('x'.repeat(11)), /过长/);
  assert.equal(f.calls.length, 0);
});

test('same text and voice reuse cache; another voice requires synthesis', async t => {
  const f = fixture(t);
  const first = await f.synth.synthesize('hello', { voice: 'one' });
  assert.ok(fs.existsSync(first.wavPath));
  assert.equal(first.cached, false);
  assert.equal((await f.synth.synthesize('hello', { voice: 'one' })).cached, true);
  await f.synth.synthesize('hello', { voice: 'two' });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { text: 'hello', ref: 'one' });
});

test('expired cache is regenerated; changing endpoint never reuses old audio', async t => {
  const f = fixture(t, { cacheTtlMs: 1000 });
  const first = await f.synth.synthesize('hello');
  fs.utimesSync(first.wavPath, new Date(0), new Date(0));
  assert.equal((await f.synth.synthesize('hello')).cached, false);
  const second = createTtsSynthesizer({ enabled: true, endpoint: '/other' }, {
    stateDir: path.join(f.root, 'state'), fetchImpl: async () => new Response(wav())
  });
  assert.notEqual((await second.synthesize('hello')).wavPath, first.wavPath);
  assert.equal(f.calls.length, 2);
});

test('concurrent duplicates share one request; a full queue refuses extra work', async t => {
  let release;
  let requests = 0;
  const f = fixture(t, { maxPending: 1 }, { fetchImpl: async () => {
    requests++;
    await new Promise(resolve => { release = resolve; });
    return new Response(wav());
  } });
  const first = f.synth.synthesize('same');
  const duplicate = f.synth.synthesize('same');
  await assert.rejects(f.synth.synthesize('other'), /队列已满/);
  assert.equal(requests, 1);
  release();
  assert.equal((await first).wavPath, (await duplicate).wavPath);
  assert.equal(f.synth.stats().inflight, 0);
});

test('different requests are serialized and rejected before exceeding call budget', async t => {
  const releases = [];
  let active = 0;
  let peak = 0;
  const f = fixture(t, { maxPerMinute: 2 }, { fetchImpl: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => releases.push(resolve));
    active--;
    return new Response(wav());
  } });
  const first = f.synth.synthesize('one');
  const second = f.synth.synthesize('two');
  await assert.rejects(f.synth.synthesize('three'), /额度/);
  releases.shift()(); await first;
  // The serial continuation has started by the time the caller resumes.
  assert.equal(releases.length, 1);
  releases.shift()(); await second;
  assert.equal(peak, 1);
});

test('failed calls consume quota; minute/hour windows expire without sleeping', async t => {
  let stamp = Date.now();
  let count = 0;
  const f = fixture(t, { maxPerMinute: 1, maxPerHour: 2 }, {
    now: () => stamp, fetchImpl: async () => { count++; throw new Error('private service detail'); }
  });
  await assert.rejects(f.synth.synthesize('one'), /合成失败/);
  await assert.rejects(f.synth.synthesize('two'), /额度/);
  stamp += 60000;
  await assert.rejects(f.synth.synthesize('two'), /合成失败/);
  stamp += 60000;
  await assert.rejects(f.synth.synthesize('three'), /额度/);
  stamp += 3600000;
  await assert.rejects(f.synth.synthesize('three'), /合成失败/);
  assert.equal(count, 3);
});

test('cached audio remains available after synthesis quota is used up', async t => {
  const f = fixture(t, { maxPerMinute: 1 });
  await f.synth.synthesize('one');
  assert.equal((await f.synth.synthesize('one')).cached, true);
  await assert.rejects(f.synth.synthesize('two'), /额度/);
  assert.equal(f.calls.length, 1);
});

test('bearer credential comes only from environment; redirects are refused', async t => {
  const f = fixture(t, { apiKeyEnv: 'TTS_FIXTURE_KEY' }, { env: { TTS_FIXTURE_KEY: 'fixture-only' } });
  await f.synth.synthesize('hello');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer fixture-only');
  assert.equal(f.calls[0].init.redirect, 'error');
  const missing = fixture(t, { apiKeyEnv: 'TTS_FIXTURE_KEY' }, { env: {} });
  await assert.rejects(missing.synth.synthesize('hello'));
  assert.equal(missing.calls.length, 0);
});

test('provider errors and invalid audio are not cached or reflected to callers', async t => {
  for (const fetchImpl of [
    async () => new Response('secret=fixture-only', { status: 401 }),
    async () => { throw new Error('Bearer fixture-only'); },
    async () => new Response('tiny')
  ]) {
    const f = fixture(t, {}, { fetchImpl });
    await assert.rejects(f.synth.synthesize('hello'), e => /合成失败/.test(e.message) && !/fixture-only/.test(e.message));
    assert.equal(f.synth.stats().inflight, 0);
    assert.equal(f.synth.stats().failures, 1);
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'state/tts-cache')), []);
  }
});

function call(port, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: {
      'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
      ...(token ? { 'x-agent-token': token } : {})
    } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('fixture request hung')));
    req.end(JSON.stringify(body));
  });
}

test('real AI route rejects disabled tools, bad tokens and exhausted send quota before synthesis', async () => {
  let requests = 0;
  const h = await bridgeHarness({ config: { socialV2: {
    tts: { enabled: true }, tools: { synthesizeVoice: true },
    voice: { enabled: true, maxPerMinute: 1 }
  } }, globals: { createTtsSynthesizer: () => ({ synthesize: async () => { requests++; throw new Error('fixture stop'); } }) } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    h.setMode('reserved2');
    const token = h.getSocialV2State('group:456').agentToken;
    const body = { key: 'group:456', text: 'hello' };
    const post = (b = body, tok = token) => call(server.address().port, '/api/socialV2/synthesize-voice', b, tok);
    assert.equal((await post(body, 'bad-token')).status, 403);
    h.cfg.socialV2.tools.synthesizeVoice = false;
    assert.equal((await post()).status, 403);
    h.cfg.socialV2.tools.synthesizeVoice = true;
    h.cfg.socialV2.tts.enabled = false;
    assert.equal((await post()).status, 403);
    h.cfg.socialV2.tts.enabled = true;
    assert.equal((await post({ ...body, key: 'group:999' })).status, 403);
    assert.equal(requests, 0);
    h.voiceBudgetCommit('group:456');
    assert.equal((await post()).status, 429);
    assert.equal((await post({ ...body, dryRun: true })).status, 429);
    h.voiceBudgetCommit('operator:cli');
    assert.equal((await call(server.address().port, '/api/tts/send', body)).status, 429);
    assert.equal(requests, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});

test('operator preview and AI send share cached synthesis; fake gateway verifies delivery', async () => {
  let requests = 0;
  const h = await bridgeHarness({ config: { socialV2: {
    tts: { enabled: true }, tools: { synthesizeVoice: true }, voice: { enabled: true }
  } }, globals: { createTtsSynthesizer: (cfg, options) => createTtsSynthesizer(cfg, {
    ...options, fetchImpl: async () => { requests++; return new Response(wav()); }
  }) } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    const port = server.address().port;
    const preview = await call(port, '/api/tts/preview-status', { text: 'hello' });
    assert.equal(preview.status, 200);
    assert.equal(h.calls.http.length, 0, 'preview does not send to QQ');
    h.setMode('reserved2');
    const token = h.getSocialV2State('group:456').agentToken;
    const sent = await call(port, '/api/socialV2/synthesize-voice', { key: 'group:456', text: 'hello' }, token);
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.verified, true);
    assert.equal(sent.data.cached, true);
    assert.equal(requests, 1);
    assert.ok(h.calls.http.some(c => c.url.endsWith('/send_group_msg')));
    assert.ok(h.calls.http.some(c => c.url.endsWith('/get_msg')));
    h.cfg.socialV2.voice.enabled = false;
    const file = path.join(h.temp, 'fixture.wav');
    fs.writeFileSync(file, wav());
    const manual = await call(port, '/api/voice/send', { target: 'group:456', file, dryRun: true });
    assert.equal(manual.status, 200, 'AI voice switch must not disable operator audio preview');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});
