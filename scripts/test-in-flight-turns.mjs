import assert from 'node:assert/strict';
import test from 'node:test';
import { inFlightTurnEvents } from '../src/in-flight-turns.js';

const event = (type, turn, extra = {}) => ({ type, data: { turn, ...extra } });

test('replays only unfinished turns after a disconnect', () => {
  const finished = [event('turn/start', 1), event('assistant/message', 1), event('turn/end', 1)];
  const unfinished = [event('turn/start', 2), event('assistant/message', 2, { text: 'pending reply' })];
  assert.deepEqual(inFlightTurnEvents([...finished, ...unfinished]), {
    turns: [2], events: unfinished
  });
});

test('a seed boundary retires inherited turns without a turn/end record', () => {
  const records = [event('turn/start', 1), event('assistant/message', 1), { type: 'session/end-seed' }];
  assert.deepEqual(inFlightTurnEvents(records), { turns: [], events: [] });
});

test('reused turn numbers do not replay replies inherited from a seed', () => {
  const inherited = [event('turn/start', 1), event('assistant/message', 1, { text: 'old reply' })];
  const current = [event('turn/start', 1), event('assistant/message', 1, { text: 'new reply' })];
  assert.deepEqual(inFlightTurnEvents([...inherited, { type: 'session/end-seed' }, ...current]), {
    turns: [1], events: current
  });
});

test('wrapped events and multiple seed boundaries use the latest epoch', () => {
  const current = [event('turn/start', 3), event('assistant/message', 3)];
  const records = [
    event('turn/start', 1), { type: 'session/end-seed' },
    event('turn/start', 2), { type: 'session/end-seed' }, ...current
  ].map((entry) => ({ type: 'event', event: entry }));
  assert.deepEqual(inFlightTurnEvents(records), { turns: [3], events: current });
});

test('closed turns yield an authoritative empty result', () => {
  assert.deepEqual(inFlightTurnEvents([event('turn/start', 2), event('turn/end', 2)]), {
    turns: [], events: []
  });
});

test('empty and metadata-only snapshots cannot retire live state', () => {
  for (const records of [null, [], [{ type: 'session', id: 'example-session' }]]) {
    assert.equal(inFlightTurnEvents(records), null);
  }
});
