// test/10-sessionEvents.test.mjs
// Covers: lib/sessionEvents.ts — the process-local, session-scoped SSE subscriber
// registry. Pure unit tests: no database, no network, no route involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { subscribe, unsubscribe, publish, subscriberCount } from '../lib/sessionEvents.ts';

// --- registry storage ---

test('the subscriber registry is cached on globalThis, not a private closure variable', () => {
  assert.ok(globalThis.__adalfiSessionSubscribers instanceof Map);
});

// --- subscribe / publish ---

test('subscribe registers a subscriber that receives published events', () => {
  const sessionId = 'session-events-a';
  const received = [];
  const unsub = subscribe(sessionId, (event) => received.push(event));
  assert.strictEqual(subscriberCount(sessionId), 1);

  publish(sessionId, { type: 'message' });

  assert.deepStrictEqual(received, [{ type: 'message' }]);
  unsub();
});

test('publish delivers to every subscriber of a session', () => {
  const sessionId = 'session-events-b';
  const receivedX = [];
  const receivedY = [];
  const unsubX = subscribe(sessionId, (event) => receivedX.push(event));
  const unsubY = subscribe(sessionId, (event) => receivedY.push(event));

  publish(sessionId, { type: 'connected' });

  assert.deepStrictEqual(receivedX, [{ type: 'connected' }]);
  assert.deepStrictEqual(receivedY, [{ type: 'connected' }]);

  unsubX();
  unsubY();
});

test('publishing to a session with no subscribers is a safe no-op', () => {
  assert.doesNotThrow(() => publish('session-events-nobody-subscribed', { type: 'message' }));
});

// --- session isolation ---

test('publish for one session never reaches another session\'s subscribers', () => {
  const sessionA = 'session-events-isolated-a';
  const sessionB = 'session-events-isolated-b';
  const receivedA = [];
  const receivedB = [];
  const unsubA = subscribe(sessionA, (event) => receivedA.push(event));
  const unsubB = subscribe(sessionB, (event) => receivedB.push(event));

  publish(sessionA, { type: 'message' });

  assert.deepStrictEqual(receivedA, [{ type: 'message' }]);
  assert.deepStrictEqual(receivedB, [], 'session B must not receive session A\'s event');

  unsubA();
  unsubB();
});

// --- unsubscribe ---

test('unsubscribe removes exactly the returned subscriber, leaving others intact', () => {
  const sessionId = 'session-events-c';
  const receivedX = [];
  const receivedY = [];
  const unsubX = subscribe(sessionId, (event) => receivedX.push(event));
  const unsubY = subscribe(sessionId, (event) => receivedY.push(event));
  assert.strictEqual(subscriberCount(sessionId), 2);

  unsubX();
  assert.strictEqual(subscriberCount(sessionId), 1);

  publish(sessionId, { type: 'message' });
  assert.deepStrictEqual(receivedX, [], 'unsubscribed callback must not fire');
  assert.deepStrictEqual(receivedY, [{ type: 'message' }]);

  unsubY();
  assert.strictEqual(subscriberCount(sessionId), 0);
});

test('unsubscribe is idempotent and safe for unknown session/subscriber pairs', () => {
  assert.doesNotThrow(() => unsubscribe('session-events-never-subscribed', () => {}));

  const sessionId = 'session-events-d';
  const unsub = subscribe(sessionId, () => {});
  unsub();
  assert.doesNotThrow(() => unsub(), 'calling the same unsubscribe function twice must not throw');
  assert.strictEqual(subscriberCount(sessionId), 0);
});

test('subscriberCount is 0 for a session that has never been subscribed to', () => {
  assert.strictEqual(subscriberCount('session-events-never-existed'), 0);
});
