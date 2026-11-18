import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWsTarget, planWsPairUpdate, planConfigUpdate } from '../src/ws-token.js';

const disc = (url, token) => ({ ok: true, wsUrl: url, wsToken: token });

test('explicit token + follow + different endpoint: configured pair pinned, discovery ignored', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    configuredWsToken: 'Token-A',
    discovered: disc('ws://127.0.0.1:3999', 'Token-B'),
    followEndpoint: true,
  });
  assert.equal(r.url, 'ws://127.0.0.1:3001');
  assert.equal(r.token, 'Token-A');
  assert.equal(r.source, 'config');
  assert.match(r.warning, /pins the configured endpoint/);
});

test('explicit token + follow + same endpoint: configured pair, no warning', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    configuredWsToken: 'Token-A',
    discovered: disc('ws://127.0.0.1:3001/', 'Token-B'),
    followEndpoint: true,
  });
  assert.equal(r.token, 'Token-A');
  assert.equal(r.warning, null);
});

test('no explicit token + follow: discovered pair used', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    discovered: disc('ws://127.0.0.1:3999', 'Token-B'),
    followEndpoint: true,
  });
  assert.equal(r.url, 'ws://127.0.0.1:3999');
  assert.equal(r.token, 'Token-B');
  assert.equal(r.source, 'discovery-pair');
});

test('follow off + same endpoint + no explicit token: discovered token, configured URL', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    discovered: disc('ws://127.0.0.1:3001', 'Token-B'),
    followEndpoint: false,
  });
  assert.equal(r.url, 'ws://127.0.0.1:3001');
  assert.equal(r.token, 'Token-B');
  assert.equal(r.source, 'discovery-same-endpoint');
});

test('follow off + same endpoint + explicit token: explicit wins', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    configuredWsToken: 'Token-A',
    discovered: disc('ws://127.0.0.1:3001', 'Token-B'),
    followEndpoint: false,
  });
  assert.equal(r.token, 'Token-A');
  assert.equal(r.warning, null);
});

test('follow off + different endpoint + explicit token: configured pair with warning', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    configuredWsToken: 'Token-A',
    discovered: disc('ws://127.0.0.1:3999', 'Token-B'),
    followEndpoint: false,
  });
  assert.equal(r.url, 'ws://127.0.0.1:3001');
  assert.equal(r.token, 'Token-A');
  assert.match(r.warning, /pins the configured endpoint/);
});

test('follow off + different endpoint + no explicit token: flagged HTTP fallback', () => {
  const r = resolveWsTarget({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    httpToken: 'http-token',
    discovered: disc('ws://127.0.0.1:3999', 'Token-B'),
    followEndpoint: false,
  });
  assert.equal(r.token, 'http-token');
  assert.equal(r.source, 'http-fallback');
  assert.match(r.warning, /may fail/);
});

test('no discovery + explicit token: config used', () => {
  const r = resolveWsTarget({ configuredWsUrl: 'ws://127.0.0.1:3001', configuredWsToken: 'Token-A' });
  assert.equal(r.token, 'Token-A');
  assert.equal(r.source, 'config');
});

test('no tokens at all: undefined plus warning', () => {
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

// The heal/restart sequence: an explicit token must keep the configured pair across multiple heals and a
// process restart; discovery B/Token-B must never be persisted under the old Token-A.
test('explicit pair survives two heals and a restart', () => {
  const config = { wsUrl: 'ws://127.0.0.1:3001', wsToken: 'Token-A', followEndpoint: true };
  const discovery = disc('ws://127.0.0.1:3999', 'Token-B');
  for (let i = 0; i < 2; i += 1) {
    const plan = planWsPairUpdate({
      configuredWsUrl: config.wsUrl,
      configuredWsToken: config.wsToken,
      discovered: discovery,
      followEndpoint: config.followEndpoint,
      currentUrl: config.wsUrl,
      currentToken: config.wsToken,
    });
    assert.equal(plan.url, 'ws://127.0.0.1:3001');
    assert.equal(plan.token, 'Token-A');
    const update = planConfigUpdate({
      plan,
      followEndpoint: config.followEndpoint,
      configuredWsToken: config.wsToken,
      configuredWsUrl: config.wsUrl,
      configuredHttpUrl: 'http://127.0.0.1:3000',
      discoveredBaseUrl: discovery.wsUrl,
    });
    assert.equal(update.wsUrl, config.wsUrl, 'config URL must not be repointed while Token-A is explicit');
    assert.deepEqual(update.persist, {});
    config.wsUrl = update.wsUrl;
  }
  const restart = resolveWsTarget({
    configuredWsUrl: config.wsUrl,
    configuredWsToken: config.wsToken,
    discovered: discovery,
    followEndpoint: true,
  });
  assert.equal(restart.url, 'ws://127.0.0.1:3001');
  assert.equal(restart.token, 'Token-A');
});

test('no explicit token: discovered pair persists and survives a restart', () => {
  const discovery = disc('ws://127.0.0.1:3999', 'Token-B');
  const first = planWsPairUpdate({
    configuredWsUrl: 'ws://127.0.0.1:3001',
    discovered: discovery,
    followEndpoint: true,
    currentUrl: 'ws://127.0.0.1:3001',
    currentToken: undefined,
  });
  assert.equal(first.url, 'ws://127.0.0.1:3999');
  assert.equal(first.token, 'Token-B');
  const update = planConfigUpdate({
    plan: first,
    followEndpoint: true,
    configuredWsToken: '',
    configuredWsUrl: 'ws://127.0.0.1:3001',
    configuredHttpUrl: 'http://127.0.0.1:3000',
    discoveredBaseUrl: 'http://127.0.0.1:3000',
  });
  assert.equal(update.wsUrl, 'ws://127.0.0.1:3999');
  assert.equal(update.persist.wsUrl, 'ws://127.0.0.1:3999');
  const second = planWsPairUpdate({
    configuredWsUrl: update.wsUrl,
    discovered: discovery,
    followEndpoint: true,
    currentUrl: first.url,
    currentToken: first.token,
  });
  assert.equal(second.url, 'ws://127.0.0.1:3999');
  assert.equal(second.token, 'Token-B');
  assert.equal(second.changed, false);
});
