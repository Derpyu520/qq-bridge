// Offline endpoint regressions: all credentials and network responses are fixtures.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { discoverDshSessionCookie, NodeApiClient } from '../src/dsh-client.js';
import { normalizeDshBaseUrl, probeDshBaseUrl } from '../src/dsh-endpoint.js';

function mockCredentials(t) {
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file).endsWith('.credentials.yaml')) {
      reads++;
      return `records:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: ${Buffer.alloc(32, 7).toString('base64url')}\n`;
    }
    return read(file, ...args);
  });
  return () => reads;
}

test('endpoint normalization rejects embedded credentials', () => {
  assert.equal(normalizeDshBaseUrl('http://user:pass@127.0.0.1:3080/'), '');
  assert.equal(normalizeDshBaseUrl('http://127.0.0.1:3080/?unused=1#fragment'), 'http://127.0.0.1:3080');
});

test('automatic cookie discovery never reads local secrets for remote endpoints', (t) => {
  const reads = mockCredentials(t);
  for (const base of ['https://example.com', 'http://10.0.0.1', 'invalid']) {
    assert.equal(discoverDshSessionCookie(base), '');
  }
  assert.equal(reads(), 0);
  assert.match(discoverDshSessionCookie('http://127.0.0.1:3080'), /^dsh-auth-/);
  assert.equal(reads(), 1);
});

test('endpoint probes reject remote candidates before reading credentials or connecting', async (t) => {
  const reads = mockCredentials(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected connection'); });
  assert.equal(await probeDshBaseUrl('https://example.com'), false);
  assert.equal(reads(), 0);
  assert.equal(calls, 0);
});

test('local probes reject redirects and close their response bodies', async (t) => {
  mockCredentials(t);
  let closed = false;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    assert.equal(new URL(input).host, '127.0.0.1:3080');
    assert.equal(init.redirect, 'manual');
    assert.match(init.headers.cookie, /^dsh-auth-/);
    return new Response(new ReadableStream({ cancel() { closed = true; } }), {
      status: 307, headers: { location: 'https://example.com/collect' },
    });
  });
  assert.equal(await probeDshBaseUrl('http://127.0.0.1:3080'), false);
  assert.equal(closed, true);
});

test('local probes still recognize successful DSH responses', async (t) => {
  mockCredentials(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    type: 'server-response', result: { ok: true, value: {} },
  }));
  assert.equal(await probeDshBaseUrl('http://127.0.0.1:3080'), true);
});

test('authenticated RPC rejects redirect following even if requested by the caller', async (t) => {
  const api = new NodeApiClient('http://127.0.0.1:3080', 1000, { token: 'fixture-token' });
  api.cookie = 'fixture=cookie';
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.get('cookie'), 'fixture=cookie');
    throw new TypeError('Unexpected redirect');
  });
  await assert.rejects(api.doFetch('http://127.0.0.1:3080/api/session/prompt', {
    method: 'POST', body: 'fixture private prompt', redirect: 'follow',
  }), /Unexpected redirect/);
});
