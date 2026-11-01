import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalConversationKey,
  createInitialConversationState,
  migrateLegacyMode,
  SessionRouter,
} from './session-router.mjs';

const ownerQQ = 42; // Synthetic test identity.
const ownerKey = `private:${ownerQQ}`;

function stateWith(key, policy) {
  const state = createInitialConversationState(ownerQQ, { closedAgentEnabled: false });
  state.conversations[key] = { updatedBy: 'console', ...policy };
  return state;
}

test('conversation keys remove leading zeros and surrounding whitespace', () => {
  assert.equal(canonicalConversationKey('  private:00042  '), ownerKey);
  assert.equal(canonicalConversationKey('group:00042'), 'group:42');
});

test('invalid, zero, and unsafe integer keys never become conversations', () => {
  for (const key of ['private:0', 'group:-1', 'group:1.5', 'Group:1',
    'private:9007199254740992', 'private:1:2', null]) {
    assert.equal(canonicalConversationKey(key), null, String(key));
  }
});

test('initial owner private is closed-agent and all other channels simulate', () => {
  const router = new SessionRouter({ ownerQQ });
  assert.equal(router.modeFor(ownerKey), 'closed-agent');
  assert.equal(router.presetFor(ownerKey), 'standard');
  assert.equal(router.modeFor('private:9'), 'simulation');
  assert.equal(router.modeFor('group:9'), 'simulation');
  assert.equal(router.presetFor('group:9'), 'qq-chat-v2');
  // Whatever this constructor emits must be loadable by it. Keeping the raw
  // legacy `reserved2` spelling in `defaults.mode` next to the canonical
  // `qq-chat-v2` preset produces a state this very loader rejects (the legacy
  // spelling only accepts the legacy preset), so the persisted default is
  // canonicalised on the way out.
  const reloaded = new SessionRouter({ ownerQQ, state: router.snapshot() });
  assert.equal(reloaded.defaultMode, router.defaultMode);
  assert.equal(reloaded.presetFor('group:9'), 'qq-chat-v2');
  assert.equal(reloaded.policyFingerprint('group:9'), router.policyFingerprint('group:9'));
});

test('missing ownerQQ keeps every conversation in simulation', () => {
  const router = new SessionRouter();
  assert.equal(router.ownerQQ, null);
  assert.equal(router.modeFor(ownerKey), 'simulation');
  assert.equal(router.modeFor('group:9'), 'simulation');
});

test('owner may explicitly disable closed-agent at first run', () => {
  const state = createInitialConversationState(ownerQQ, { closedAgentEnabled: false });
  const router = new SessionRouter({ ownerQQ, state });
  assert.deepEqual(state.conversations, {});
  assert.equal(router.modeFor(ownerKey), 'simulation');
});

test('invalid ownerQQ is rejected rather than silently trusted', () => {
  for (const invalid of [0, -1, 'abc', '9007199254740992']) {
    assert.throws(() => new SessionRouter({ ownerQQ: invalid }), /ownerQQ/);
  }
});

test('closed-agent cannot be the global default', () => {
  const state = createInitialConversationState(ownerQQ);
  state.defaults = { mode: 'closed-agent', preset: 'standard' };
  assert.throws(() => new SessionRouter({ ownerQQ, state }), /defaults must remain simulation/);
});

test('closed-agent cannot be assigned to a group', () => {
  const state = stateWith('group:8', { mode: 'closed-agent', preset: 'standard' });
  assert.throws(() => new SessionRouter({ ownerQQ, state }), /restricted to the owner/);
});

test('closed-agent cannot be assigned to another private conversation', () => {
  const state = stateWith('private:8', { mode: 'closed-agent', preset: 'standard' });
  assert.throws(() => new SessionRouter({ ownerQQ, state }), /restricted to the owner/);
});

test('closed-agent is rejected when no owner is configured', () => {
  const state = stateWith(ownerKey, { mode: 'closed-agent', preset: 'standard' });
  assert.throws(() => new SessionRouter({ state }), /restricted to the owner/);
});

test('missing and unknown modes fail closed at load', () => {
  for (const policy of [
    { preset: 'qq-chat-v2' },
    { mode: 'reserved2', preset: 'qq-chat' },
    { mode: 'mystery', preset: 'qq-chat-v2' },
    { mode: { toString: () => 'closed-agent' }, preset: 'standard' },
  ]) {
    assert.throws(() => new SessionRouter({ ownerQQ, state: stateWith('group:8', policy) }));
  }
});

test('missing, null, unknown, and cross-mode presets fail closed', () => {
  for (const policy of [
    { mode: 'simulation' },
    { mode: 'simulation', preset: null },
    { mode: 'simulation', preset: 'standard' },
    { mode: 'simulation', preset: 'standard' },
  ]) {
    assert.throws(() => new SessionRouter({ ownerQQ, state: stateWith('group:8', policy) }));
  }
  assert.throws(() => new SessionRouter({ ownerQQ,
    state: stateWith(ownerKey, { mode: 'closed-agent', preset: 'qq-chat-v2' }) }));
});

test('defaults also require known mode and preset', () => {
  for (const defaults of [
    { preset: 'qq-chat-v2' },
    { mode: 'simulation' },
    { mode: 'simulation', preset: 'standard' },
  ]) {
    const state = createInitialConversationState(ownerQQ);
    state.defaults = defaults;
    assert.throws(() => new SessionRouter({ ownerQQ, state }));
  }
});

test('mode, preset, model, and effort resolve independently per conversation', () => {
  const state = createInitialConversationState(ownerQQ);
  state.defaults.model = 'default-model';
  state.defaults.reasoningEffort = 'low';
  state.conversations[ownerKey].model = 'owner-model';
  state.conversations[ownerKey].reasoningEffort = 'high';
  state.conversations['group:8'] = {
    mode: 'simulation', preset: 'qq-chat-v2', model: null, updatedBy: 'console',
  };
  const router = new SessionRouter({ ownerQQ, state });
  assert.deepEqual([router.modeFor(ownerKey), router.presetFor(ownerKey),
    router.modelFor(ownerKey), router.effortFor(ownerKey)],
  ['closed-agent', 'standard', 'owner-model', 'high']);
  assert.deepEqual([router.modeFor('group:8'), router.presetFor('group:8'),
    router.modelFor('group:8'), router.effortFor('group:8')],
  ['simulation', 'qq-chat-v2', null, 'low']);
  assert.equal(router.modelFor('private:8'), 'default-model');
});

test('simulation permissions deny local tools and admin commands', () => {
  const router = new SessionRouter({ ownerQQ });
  assert.deepEqual(router.permissionsFor('group:8'), {
    localExecution: false, localFiles: false, adminCommands: false,
  });
  assert.deepEqual(router.permissionsFor('private:8'), router.permissionsFor('group:8'));
  assert.deepEqual(router.permissionsFor(ownerKey), {
    localExecution: true, localFiles: true, adminCommands: true,
  });
});

test('invalid caller key is rejected instead of receiving default privileges', () => {
  const router = new SessionRouter({ ownerQQ });
  assert.throws(() => router.modeFor('group:0'), /Invalid conversation key/);
  assert.throws(() => router.permissionsFor('private:9007199254740992'), /Invalid conversation key/);
});

test('a policy change reports only its canonical conversation key', () => {
  const router = new SessionRouter({ ownerQQ });
  const ownerBefore = router.policyFingerprint(ownerKey);
  const otherBefore = router.policyFingerprint('group:9');
  const result = router.setConversation('group:0008', {
    mode: 'simulation', preset: 'qq-chat-v2', model: 'small', reasoningEffort: 'low',
    updatedBy: 'console',
  });
  assert.deepEqual(result.changedKeys, ['group:8']);
  assert.equal(router.policyFingerprint(ownerKey), ownerBefore);
  assert.equal(router.policyFingerprint('group:9'), otherBefore);
  assert.notEqual(router.policyFingerprint('group:8'), otherBefore);
});

test('model and effort edits each change only that conversation fingerprint', () => {
  const router = new SessionRouter({ ownerQQ });
  const groupBefore = router.policyFingerprint('group:8');
  const first = router.setConversation(ownerKey, {
    mode: 'closed-agent', preset: 'standard', model: 'm1', reasoningEffort: null,
    updatedBy: 'command:' + ownerKey,
  });
  const afterModel = router.policyFingerprint(ownerKey);
  const second = router.setConversation(ownerKey, {
    mode: 'closed-agent', preset: 'standard', model: 'm1', reasoningEffort: 'high',
    updatedBy: 'console',
  });
  assert.deepEqual(first.changedKeys, [ownerKey]);
  assert.deepEqual(second.changedKeys, [ownerKey]);
  assert.notEqual(afterModel, router.policyFingerprint(ownerKey));
  assert.equal(router.policyFingerprint('group:8'), groupBefore);
});

test('metadata-only edits do not restart a conversation', () => {
  const router = new SessionRouter({ ownerQQ });
  const fingerprint = router.policyFingerprint(ownerKey);
  const result = router.setConversation(ownerKey, {
    mode: 'closed-agent', preset: 'standard', model: null,
    reasoningEffort: null, updatedBy: 'console', note: 'renamed',
  });
  assert.deepEqual(result.changedKeys, []);
  assert.equal(router.policyFingerprint(ownerKey), fingerprint);
});

test('rejected update leaves all conversation policies unchanged', () => {
  const router = new SessionRouter({ ownerQQ });
  const before = router.snapshot();
  assert.throws(() => router.setConversation('group:8', {
    mode: 'closed-agent', preset: 'standard', updatedBy: 'console',
  }), /restricted to the owner/);
  assert.deepEqual(router.snapshot(), before);
});

test('removing owner override returns only owner to simulation', () => {
  const router = new SessionRouter({ ownerQQ });
  const groupBefore = router.policyFingerprint('group:8');
  assert.deepEqual(router.deleteConversation(ownerKey, { updatedBy: 'console' }).changedKeys, [ownerKey]);
  assert.equal(router.modeFor(ownerKey), 'simulation');
  assert.equal(router.policyFingerprint('group:8'), groupBefore);
});

test('legacy chat, reserved, and reserved2 migrate explicitly with audit events', () => {
  for (const mode of ['chat', 'reserved', 'reserved2']) {
    const { state, events } = migrateLegacyMode({ mode, ownerQQ });
    const router = new SessionRouter({ ownerQQ, state });
    assert.equal(router.modeFor(ownerKey), 'simulation');
    assert.equal(router.modeFor('group:8'), 'simulation');
    assert.equal(events.length, 1);
    assert.equal(events[0].from, mode);
    assert.equal(events[0].type, 'legacy-mode-migrated');
  }
});

test('legacy closed-agent migrates only to owner private', () => {
  const { state, events } = migrateLegacyMode({ mode: 'closed-agent', ownerQQ });
  const router = new SessionRouter({ ownerQQ, state });
  assert.equal(router.modeFor(ownerKey), 'closed-agent');
  assert.equal(router.modeFor('group:8'), 'simulation');
  assert.equal(state.conversations[ownerKey].updatedBy, 'migration');
  assert.equal(events[0].ownerKey, ownerKey);
});

test('legacy closed-agent without owner is downgraded and audited', () => {
  const { state, events } = migrateLegacyMode({ mode: 'closed-agent' });
  const router = new SessionRouter({ state });
  assert.equal(router.modeFor(ownerKey), 'simulation');
  assert.match(events[0].reason, /missing ownerQQ/);
});

test('unknown legacy mode and unsupported state versions fail closed', () => {
  assert.throws(() => migrateLegacyMode({ mode: 'administrator', ownerQQ }), /Unknown legacy mode/);
  assert.throws(() => migrateLegacyMode({ ownerQQ }), /Unknown legacy mode/);
  const state = createInitialConversationState(ownerQQ);
  state.version = 2;
  assert.throws(() => new SessionRouter({ ownerQQ, state }), /version 1/);
});

test('aliased duplicate keys are rejected rather than overwriting policy', () => {
  const state = createInitialConversationState(ownerQQ);
  state.conversations['private:042'] = {
    mode: 'simulation', preset: 'qq-chat-v2', updatedBy: 'console',
  };
  assert.throws(() => new SessionRouter({ ownerQQ, state }), /Duplicate conversation key/);
});


test('explicit null or damaged state never triggers owner first-run privileges', () => {
  assert.equal(new SessionRouter({ ownerQQ, state: undefined }).modeFor(ownerKey), 'closed-agent');
  for (const state of [null, false, {}, { version: 1, defaults: null, conversations: {} }]) {
    assert.throws(() => new SessionRouter({ ownerQQ, state }), /conversation state|defaults/);
  }
});

test('persisted conversation without a valid updatedBy is rejected', () => {
  const state = createInitialConversationState(ownerQQ, { closedAgentEnabled: false });
  state.conversations['group:8'] = { mode: 'simulation', preset: 'qq-chat-v2' };
  assert.throws(() => new SessionRouter({ ownerQQ, state }), /updatedBy/);
  state.conversations['group:8'].updatedBy = 'command:private:8';
  assert.throws(() => new SessionRouter({ ownerQQ, state }), /updatedBy/);
});

test('setConversation requires a live actor and leaves state untouched on rejection', () => {
  const router = new SessionRouter({ ownerQQ });
  const before = router.snapshot();
  for (const updatedBy of [undefined, '', 'migration', 'first-run', 'command:private:8']) {
    assert.throws(() => router.setConversation('group:8', {
      mode: 'simulation', preset: 'qq-chat-v2', updatedBy,
    }), /updatedBy/);
    assert.deepEqual(router.snapshot(), before);
  }
});

test('setConversation returns actor, time, and before/after for a valid owner command', () => {
  const router = new SessionRouter({ ownerQQ, now: () => 1_750_000_000_000 });
  const before = router.policyFor(ownerKey);
  const result = router.setConversation(ownerKey, {
    mode: 'simulation', preset: 'qq-chat-v2', updatedBy: 'command:' + ownerKey,
  });
  assert.deepEqual(result.changedKeys, [ownerKey]);
  assert.deepEqual(result.auditEvent, {
    type: 'conversation-set', key: ownerKey,
    updatedBy: 'command:' + ownerKey,
    at: 1_750_000_000_000, before, after: router.policyFor(ownerKey),
    hadOverride: true, policyChanged: true,
  });
  assert.equal(result.auditEvent.before.mode, 'closed-agent');
  assert.equal(result.auditEvent.after.mode, 'simulation');
});

test('deleteConversation requires an actor and returns a structured audit event', () => {
  const router = new SessionRouter({ ownerQQ, now: () => 1_750_000_000_001 });
  const beforePolicy = router.policyFor(ownerKey);
  const before = router.snapshot();
  assert.throws(() => router.deleteConversation(ownerKey), /updatedBy/);
  assert.throws(() => router.deleteConversation(ownerKey, {
    updatedBy: 'command:private:8',
  }), /updatedBy/);
  assert.deepEqual(router.snapshot(), before);
  const result = router.deleteConversation(ownerKey, { updatedBy: 'console' });
  assert.deepEqual(result.changedKeys, [ownerKey]);
  assert.deepEqual(result.auditEvent, {
    type: 'conversation-deleted', key: ownerKey,
    updatedBy: 'console', at: 1_750_000_000_001,
    before: beforePolicy, after: router.policyFor(ownerKey),
    hadOverride: true, noOp: false, policyChanged: true,
  });
  assert.equal(result.auditEvent.before.mode, 'closed-agent');
  assert.equal(result.auditEvent.after.mode, 'simulation');
});


test('deleting an absent override is visibly a no-op', () => {
  const router = new SessionRouter({ ownerQQ, now: () => 1_750_000_000_002 });
  const before = router.policyFor('group:8');
  const result = router.deleteConversation('group:8', { updatedBy: 'console' });
  assert.deepEqual(result.changedKeys, []);
  assert.deepEqual(result.auditEvent, {
    type: 'conversation-deleted', key: 'group:8', updatedBy: 'console',
    at: 1_750_000_000_002, before, after: router.policyFor('group:8'),
    hadOverride: false, noOp: true, policyChanged: false,
  });
});

test('invalid audit clock cannot commit a policy change', () => {
  const router = new SessionRouter({ ownerQQ, now: () => Number.NaN });
  const before = router.snapshot();
  assert.throws(() => router.setConversation(ownerKey, {
    mode: 'simulation', preset: 'qq-chat-v2', updatedBy: 'console',
  }), /audit time/);
  assert.deepEqual(router.snapshot(), before);
  assert.throws(() => router.deleteConversation(ownerKey, { updatedBy: 'console' }), /audit time/);
  assert.deepEqual(router.snapshot(), before);
});
