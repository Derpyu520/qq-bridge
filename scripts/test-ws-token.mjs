import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWsTarget, planWsPairUpdate } from '../src/ws-token.js';

const disc = (url, token) => ({ ok: true, wsUrl: url, wsToken: token });

test('follow enabled + same endpoint + explicit token: explicit config wins', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    configuredWsToken: ' cfg-token ',
    discovered: disc('ws://127.0.0.1:3001/', 'disc-token'),
    followEndpoint: true,
  });
  assert.equal(r.url, 'ws://127.0.0.1:3001');
  assert.equal(r.token, 'cfg-token');
  assert.equal(r.source, 'config');
  assert.equal(r.warning, null);
});

test('follow enabled + different endpoint: discovered pair wins and warns', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    configuredWsToken: 'cfg-token',
    discovered: disc('ws://127.0.0.1:3999', 'disc-token'),
    followEndpoint: true,
  });
  assert.equal(r.url, 'ws://127.0.0.1:3999');
  assert.equal(r.token, 'disc-token');
  assert.equal(r.source, 'discovery-pair');
  assert.match(r.warning, /ignoring the configured wsToken/);
});

test('follow enabled + discovery only: discovered pair used', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    discovered: disc('ws://127.0.0.1:3001', 'disc-token'),
    followEndpoint: true,
  });
  assert.equal(r.token, 'disc-token');
  assert.equal(r.source, 'discovery-pair');
});

test('follow disabled + same endpoint: explicit token wins, no warning', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    configuredWsToken: 'cfg-token',
    discovered: disc('ws://127.0.0.1:3001/', 'disc-token'),
    followEndpoint: false,
  });
  assert.equal(r.url, 'ws://127.0.0.1:3001');
  assert.equal(r.token, 'cfg-token');
  assert.equal(r.source, 'config');
  assert.equal(r.warning, null);
});

test('follow disabled + same endpoint without explicit token: discovered token used', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    discovered: disc('ws://127.0.0.1:3001', 'disc-token'),
    followEndpoint: false,
  });
  assert.equal(r.token, 'disc-token');
  assert.equal(r.source, 'discovery-same-endpoint');
});

test('follow disabled + different endpoint: configured token kept, warning', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    configuredWsToken: 'cfg-token',
    discovered: disc('ws://127.0.0.1:3999', 'disc-token'),
    followEndpoint: false,
  });
  assert.equal(r.url, 'ws://127.0.0.1:3001');
  assert.equal(r.token, 'cfg-token');
  assert.equal(r.source, 'config');
  assert.match(r.warning, /endpoint following is disabled/);
});

test('follow disabled + different endpoint without explicit token: flagged HTTP fallback', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    httpToken: 'http-token',
    discovered: disc('ws://127.0.0.1:3999', 'disc-token'),
    followEndpoint: false,
  });
  assert.equal(r.token, 'http-token');
  assert.equal(r.source, 'http-fallback');
  assert.match(r.warning, /may fail/);
});

test('no discovery + explicit token: config used', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    configuredWsToken: 'cfg-token',
  });
  assert.equal(r.token, 'cfg-token');
  assert.equal(r.source, 'config');
});

test('no tokens at all: undefined plus warning, never a fake token', () => {
  const r = resolveWsTarget({ configuredWsUrl: 'ws://127.0.0.1:3001' });
  assert.equal(r.token, undefined);
  assert.equal(r.source, 'none');
  assert.match(r.warning, /cannot authenticate/);
});

test('whitespace-only values are treated as absent', () => {
  const r = resolveWsTarget({ configuredWsUrl: 'ws://127.0.0.1:3001', configuredWsToken: '   ', httpToken: '  ' });
  assert.equal(r.token, undefined);
  assert.equal(r.source, 'none');
});

// Self-heal / startup consistency: the same plan function drives both, so a close event cannot pair the
// explicit A token with the discovered B endpoint.
test('follow on: plan selects the discovered pair and stays there after a close event', () => {
  const base = {
    configuredWsUrl: 'ws://127.0.0.1:3001',
    configuredWsToken: 'Token-A',
    discovered: { ok: true, wsUrl: 'ws://127.0.0.1:3999', wsToken: 'Token-B' },
    followEndpoint: true,
  };
  const first = planWsPairUpdate({ ...base, currentUrl: 'ws://127.0.0.1:3001', currentToken: 'Token-A' });
  assert.equal(first.url, 'ws://127.0.0.1:3999');
  assert.equal(first.token, 'Token-B');
  assert.equal(first.changed, true);
  const again = planWsPairUpdate({ ...base, currentUrl: first.url, currentToken: first.token });
  assert.equal(again.url, 'ws://127.0.0.1:3999');
  assert.equal(again.token, 'Token-B');
  assert.equal(again.changed, false);
});

test('follow off + different endpoint: plan keeps the configured pair', () => {
  const plan = planWsPairUpdate({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    configuredWsToken: 'Token-A',
    discovered: { ok: true, wsUrl: 'ws://127.0.0.1:3999', wsToken: 'Token-B' },
    followEndpoint: false,
    currentUrl: 'ws://127.0.0.1:3001',
    currentToken: 'Token-A',
  });
  assert.equal(plan.url, 'ws://127.0.0.1:3001');
  assert.equal(plan.token, 'Token-A');
  assert.match(plan.warning, /endpoint following is disabled/);
});

test('follow off + same endpoint: plan keeps the explicit token', () => {
  const plan = planWsPairUpdate({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    configuredWsToken: 'Token-A',
    discovered: { ok: true, wsUrl: 'ws://127.0.0.1:3001/', wsToken: 'Token-B' },
    followEndpoint: false,
    currentUrl: 'ws://127.0.0.1:3001',
    currentToken: 'Token-A',
  });
  assert.equal(plan.token, 'Token-A');
  assert.equal(plan.changed, false);
});
