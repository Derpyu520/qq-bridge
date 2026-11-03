import assert from 'node:assert/strict';
import test from 'node:test';
import { CONVERSATION_MODES, ConversationModes, isConversationMode } from './conversation-modes.mjs';

const ownerQQ = 42; // Synthetic test identity.
const ownerKey = `private:${ownerQQ}`;

function make(overrides = {}) {
  const modes = new ConversationModes({ ownerQQ, now: () => 1_700_000_000_000, ...overrides });
  modes.setFallback('reserved2', 'qq-chat-v2');
  return modes;
}

test('a conversation without an override follows the global fallback', () => {
  const modes = make();
  assert.equal(modes.overrideFor('group:7'), null);
  assert.equal(modes.modeFor('group:7'), 'reserved2');
  assert.equal(modes.presetFor('group:7'), 'qq-chat-v2');
  assert.equal(modes.fingerprintFor('group:7'), JSON.stringify(['reserved2', 'qq-chat-v2']));
});

test('an override wins over the global fallback and survives a fallback change', () => {
  const modes = make();
  modes.setConversation('group:7', { mode: 'chat', preset: 'qq-chat', updatedBy: 'console' });
  assert.equal(modes.modeFor('group:7'), 'chat');
  assert.equal(modes.presetFor('group:7'), 'qq-chat');
  // The global mode moving must not drag the overridden conversation with it.
  modes.setFallback('chat', 'qq-chat');
  assert.equal(modes.modeFor('group:7'), 'chat');
  assert.equal(modes.modeFor('group:8'), 'chat');
  // ...and an un-overridden conversation follows the new global mode.
  modes.setFallback('reserved', 'qq-chat');
  assert.equal(modes.modeFor('group:8'), 'reserved');
  assert.equal(modes.presetFor('group:8'), 'qq-chat');
});

test('closed-agent is refused for every key except the owner private conversation', () => {
  const modes = make();
  assert.throws(
    () => modes.setConversation('group:7', { mode: 'closed-agent', preset: 'standard', updatedBy: 'console' }),
    /owner private conversation/,
  );
  assert.throws(
    () => modes.setConversation('private:7', { mode: 'closed-agent', preset: 'standard', updatedBy: 'console' }),
    /owner private conversation/,
  );
  const ok = modes.setConversation(ownerKey, { mode: 'closed-agent', preset: 'standard', updatedBy: 'console' });
  assert.equal(ok.key, ownerKey);
  assert.equal(modes.modeFor(ownerKey), 'closed-agent');
});

test('without an ownerQQ the privileged mode is unreachable', () => {
  const modes = new ConversationModes({ ownerQQ: null, now: () => 1_700_000_000_000 });
  modes.setFallback('reserved2', 'qq-chat-v2');
  assert.throws(
    () => modes.setConversation(ownerKey, { mode: 'closed-agent', preset: 'standard', updatedBy: 'console' }),
    /owner private conversation/,
  );
});

test('unknown modes and malformed presets are rejected', () => {
  const modes = make();
  for (const mode of ['simulation', 'CHAT', 'reserved3', '', null, 42, undefined]) {
    assert.throws(
      () => modes.setConversation('group:7', { mode, preset: 'qq-chat', updatedBy: 'console' }),
      /Unknown conversation mode/,
      String(mode),
    );
  }
  for (const preset of ['', '  ', 'qq chat', null, undefined, 7]) {
    assert.throws(
      () => modes.setConversation('group:7', { mode: 'chat', preset, updatedBy: 'console' }),
      /preset must be a valid preset name/,
      String(preset),
    );
  }
});

test('the actor must be an authenticated console or the owner command channel', () => {
  const modes = make();
  for (const updatedBy of ['', 'owner', 'command:private:7', null, undefined]) {
    assert.throws(
      () => modes.setConversation('group:7', { mode: 'chat', preset: 'qq-chat', updatedBy }),
      /updatedBy must identify console or the owner private command/,
      String(updatedBy),
    );
  }
  // The owner may act through their own private command channel.
  modes.setConversation('group:7', { mode: 'chat', preset: 'qq-chat', updatedBy: `command:${ownerKey}` });
});

test('invalid conversation keys are rejected instead of silently ignored', () => {
  const modes = make();
  for (const key of ['group:0', 'group:-1', 'group:1.5', 'Group:1', 'private:1:2', '', null, undefined]) {
    assert.throws(
      () => modes.setConversation(key, { mode: 'chat', preset: 'qq-chat', updatedBy: 'console' }),
      /Invalid conversation key/,
      String(key),
    );
    assert.equal(modes.overrideFor(key), null, String(key));
  }
});

test('a leading-zero key is the same conversation, so it cannot be stored twice', () => {
  const modes = make();
  modes.setConversation('private:042', { mode: 'chat', preset: 'qq-chat', updatedBy: 'console' });
  assert.equal(modes.overrideFor('private:42')?.mode, 'chat');
  assert.deepEqual(Object.keys(modes.snapshot().conversations), ['private:42']);
});

test('the snapshot round-trips through the constructor', () => {
  const modes = make();
  modes.setConversation('group:7', { mode: 'chat', preset: 'qq-chat', updatedBy: 'console' });
  modes.setConversation(ownerKey, { mode: 'closed-agent', preset: 'standard', updatedBy: 'console' });
  const snapshot = modes.snapshot();
  const reloaded = make({ state: snapshot });
  assert.equal(reloaded.modeFor('group:7'), 'chat');
  assert.equal(reloaded.presetFor('group:7'), 'qq-chat');
  assert.equal(reloaded.modeFor(ownerKey), 'closed-agent');
  assert.deepEqual(reloaded.snapshot(), snapshot);
});

test('a corrupt persisted state is refused rather than silently half-loaded', () => {
  for (const state of [
    { version: 2, conversations: {} },
    { version: 1 },
    { version: 1, conversations: [] },
    { version: 1, conversations: { 'group:0': { mode: 'chat', preset: 'qq-chat', updatedBy: 'console', at: 1 } } },
    { version: 1, conversations: { 'group:7': { mode: 'nope', preset: 'qq-chat', updatedBy: 'console', at: 1 } } },
    { version: 1, conversations: { 'group:7': { mode: 'chat', preset: 'qq-chat', at: 1 } } },
    { version: 1, conversations: { 'group:7': { mode: 'chat', preset: 'qq-chat', updatedBy: 'console', at: -1 } } },
    // closed-agent on a non-owner key must not survive a reload either.
    { version: 1, conversations: { 'group:7': { mode: 'closed-agent', preset: 'standard', updatedBy: 'console', at: 1 } } },
  ]) {
    assert.throws(() => new ConversationModes({ ownerQQ, state, now: () => 1 }), /must|Invalid|requires|restricted|Duplicate|unknown/, JSON.stringify(state));
  }
});

test('duplicate conversation keys in a persisted state are refused', () => {
  const state = {
    version: 1,
    conversations: {
      'private:42': { mode: 'chat', preset: 'qq-chat', updatedBy: 'console', at: 1 },
      'private:042': { mode: 'reserved', preset: 'qq-chat', updatedBy: 'console', at: 1 },
    },
  };
  assert.throws(() => new ConversationModes({ ownerQQ, state, now: () => 1 }), /Duplicate conversation key/);
});

test('setting the same policy twice is not reported as a policy change', () => {
  const modes = make();
  const first = modes.setConversation('group:7', { mode: 'chat', preset: 'qq-chat', updatedBy: 'console' });
  assert.deepEqual(first.changedKeys, ['group:7']);
  assert.equal(first.auditEvent.policyChanged, true);
  // Re-saving the same mode and preset must not look like a change: the
  // fingerprint deliberately excludes the audit timestamp and the actor.
  const second = modes.setConversation('group:7', { mode: 'chat', preset: 'qq-chat', updatedBy: 'console' });
  assert.deepEqual(second.changedKeys, []);
  assert.equal(second.auditEvent.policyChanged, false);
  assert.equal(second.auditEvent.hadOverride, true);
});

test('deleting an override returns the conversation to the global mode', () => {
  const modes = make();
  modes.setConversation('group:7', { mode: 'chat', preset: 'qq-chat', updatedBy: 'console' });
  const removed = modes.deleteConversation('group:7', { updatedBy: 'console' });
  assert.deepEqual(removed.changedKeys, ['group:7']);
  assert.equal(removed.auditEvent.policyChanged, true);
  assert.equal(removed.auditEvent.noOp, false);
  assert.equal(modes.overrideFor('group:7'), null);
  assert.equal(modes.modeFor('group:7'), 'reserved2');
  // Deleting again is a visible no-op, not a second change.
  const again = modes.deleteConversation('group:7', { updatedBy: 'console' });
  assert.deepEqual(again.changedKeys, []);
  assert.equal(again.auditEvent.noOp, true);
});

test('the audit event records the actor, the time, and both sides of the change', () => {
  const modes = make();
  const result = modes.setConversation('group:7', { mode: 'chat', preset: 'qq-chat', updatedBy: 'console' });
  const event = result.auditEvent;
  assert.equal(event.type, 'conversation-mode-set');
  assert.equal(event.key, 'group:7');
  assert.equal(event.mode, 'chat');
  assert.equal(event.preset, 'qq-chat');
  assert.equal(event.updatedBy, 'console');
  assert.equal(event.at, 1_700_000_000_000);
  assert.equal(event.before, null);
  assert.equal(event.hadOverride, false);
  assert.equal(event.after.mode, 'chat');
});

test('the mode list is exactly the four modes the bridge knows', () => {
  assert.deepEqual([...CONVERSATION_MODES], ['chat', 'reserved', 'reserved2', 'reserved2-full', 'closed-agent']);
  assert.equal(isConversationMode('reserved2'), true);
  assert.equal(isConversationMode('simulation'), false);
  assert.equal(isConversationMode('reserved2 '), false);
});
