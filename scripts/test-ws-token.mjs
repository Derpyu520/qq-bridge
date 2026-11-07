import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWsToken } from '../src/ws-token.js';

test('explicit configured WS token wins over discovery and HTTP tokens', () => {
  const r = resolveWsToken({
    configuredWsToken: ' ws-config ',
    discovered: { ok: true, wsToken: 'ws-discovered' },
    httpToken: 'http-token',
  });
  assert.equal(r.token, 'ws-config');
  assert.equal(r.source, 'config');
  assert.equal(r.warning, null);
});

test('discovery WS token is used when no explicit token is configured', () => {
  const r = resolveWsToken({
    discovered: { ok: true, wsToken: 'ws-discovered' },
    httpToken: 'http-token',
  });
  assert.equal(r.token, 'ws-discovered');
  assert.equal(r.source, 'discovery');
  assert.equal(r.warning, null);
});

test('failed discovery falls back to the HTTP token with an explicit warning', () => {
  const r = resolveWsToken({ discovered: { ok: false }, httpToken: 'http-token' });
  assert.equal(r.token, 'http-token');
  assert.equal(r.source, 'http-fallback');
  assert.match(r.warning, /WS token not found/);
});

test('no tokens yields undefined and a warning, never a fake token', () => {
  const r = resolveWsToken({});
  assert.equal(r.token, undefined);
  assert.equal(r.source, 'none');
  assert.match(r.warning, /cannot authenticate/);
});

test('whitespace-only values are treated as absent', () => {
  const r = resolveWsToken({ configuredWsToken: '   ', httpToken: '  ' });
  assert.equal(r.token, undefined);
  assert.equal(r.source, 'none');
});
