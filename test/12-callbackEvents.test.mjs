// test/12-callbackEvents.test.mjs
// Covers: POST /api/webhook/callback — publishing a session-scoped `message` SSE event
// after successful persistence (Phase 3.2). Uses a temporary SQLite database; no real
// secrets or network calls. Subscribes directly via lib/sessionEvents.ts, the same way
// the SSE route (app/api/sessions/[id]/events/route.ts) does internally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Set env vars BEFORE dynamic imports that transitively open lib/db.js.
const tempDir = join(tmpdir(), `rovo-callback-events-${randomUUID()}`);
mkdirSync(tempDir, { recursive: true });
process.env.SQLITE_DB_PATH = join(tempDir, 'callback-events-test.db');
process.env.CALLBACK_SHARED_SECRET = 'test-callback-secret-abc';
delete globalThis.__adalfiDb;

// Dynamic imports after env setup.
const { POST } = await import('../app/api/webhook/callback/route.ts');
const dbMod = await import('../lib/db.ts');
const { default: db, createSession, addMessage, createRun, getMessage } = dbMod;
const { subscribe } = await import('../lib/sessionEvents.ts');

process.on('exit', () => {
  try { db.close(); } catch {}
  rmSync(tempDir, { recursive: true, force: true });
});

// --- helpers ---

function makeCallbackRequest(body, tokenOverride) {
  const token = tokenOverride !== undefined ? tokenOverride : process.env.CALLBACK_SHARED_SECRET;
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers['x-callback-token'] = token;
  return new Request('http://localhost/api/webhook/callback', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function makeRun() {
  const session = createSession('Callback events test');
  const user = addMessage({ sessionId: session.id, role: 'user', content: 'q', status: 'completed' });
  const assistant = addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'pending' });
  const correlationId = randomUUID();
  createRun({
    sessionId: session.id,
    userMessageId: user.id,
    assistantMessageId: assistant.id,
    correlationId,
    webhookUrl: 'https://rovo.example.com/w',
    requestPayload: '{}',
  });
  return { sessionId: session.id, correlationId, assistantMessageId: assistant.id };
}

function collect(sessionId) {
  const received = [];
  const unsubscribe = subscribe(sessionId, (event) => received.push(event));
  return { received, unsubscribe };
}

// --- successful callback publishes ---

test('a successful callback publishes exactly one message event to the correct session', async () => {
  const { sessionId, correlationId } = makeRun();
  const { received, unsubscribe } = collect(sessionId);

  const req = makeCallbackRequest({ correlationId, content: 'The answer.', status: 'ok' });
  const res = await POST(req);

  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(received, [{ type: 'message' }]);
  unsubscribe();
});

test('subscribers of a different session receive nothing', async () => {
  const runA = makeRun();
  const runB = makeRun();
  const a = collect(runA.sessionId);
  const b = collect(runB.sessionId);

  const req = makeCallbackRequest({ correlationId: runA.correlationId, content: 'For A only.', status: 'ok' });
  await POST(req);

  assert.deepStrictEqual(a.received, [{ type: 'message' }]);
  assert.deepStrictEqual(b.received, [], "session B's subscriber must not see session A's event");

  a.unsubscribe();
  b.unsubscribe();
});

test('a matched callback reporting an agent error (ok:false) still publishes - the session changed either way', async () => {
  const { sessionId, correlationId } = makeRun();
  const { received, unsubscribe } = collect(sessionId);

  const req = makeCallbackRequest({ correlationId, content: 'Agent crashed.', status: 'error' });
  await POST(req);

  assert.deepStrictEqual(received, [{ type: 'message' }]);
  unsubscribe();
});

// --- invalid / rejected callbacks publish nothing ---

test('missing auth token (401) publishes no event', async () => {
  const { sessionId, correlationId } = makeRun();
  const { received, unsubscribe } = collect(sessionId);

  const req = makeCallbackRequest({ correlationId, content: 'hi', status: 'ok' }, null);
  const res = await POST(req);

  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(received, []);
  unsubscribe();
});

test('wrong auth token (401) publishes no event', async () => {
  const { sessionId, correlationId } = makeRun();
  const { received, unsubscribe } = collect(sessionId);

  const req = makeCallbackRequest({ correlationId, content: 'hi', status: 'ok' }, 'wrong-token');
  const res = await POST(req);

  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(received, []);
  unsubscribe();
});

test('malformed JSON body (400) publishes no event', async () => {
  const { sessionId } = makeRun();
  const { received, unsubscribe } = collect(sessionId);

  const req = new Request('http://localhost/api/webhook/callback', {
    method: 'POST',
    headers: { 'x-callback-token': process.env.CALLBACK_SHARED_SECRET },
    body: 'NOT JSON',
  });
  const res = await POST(req);

  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(received, []);
  unsubscribe();
});

test('missing correlationId (400) publishes no event', async () => {
  const { sessionId } = makeRun();
  const { received, unsubscribe } = collect(sessionId);

  const req = makeCallbackRequest({ content: 'hi', status: 'ok' });
  const res = await POST(req);

  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(received, []);
  unsubscribe();
});

// --- persistence failure (no matching pending run) publishes nothing ---

test('unknown correlationId (matched:false) publishes no event', async () => {
  const { sessionId } = makeRun(); // an unrelated, subscribed session
  const { received, unsubscribe } = collect(sessionId);

  const req = makeCallbackRequest({ correlationId: 'nonexistent-correlation-id', content: 'x', status: 'ok' });
  const res = await POST(req);
  const body = await res.json();

  assert.strictEqual(body.matched, false);
  assert.deepStrictEqual(received, []);
  unsubscribe();
});

test('a duplicate callback (same correlationId twice) publishes exactly once, not twice', async () => {
  const { sessionId, correlationId } = makeRun();
  const { received, unsubscribe } = collect(sessionId);

  const req1 = makeCallbackRequest({ correlationId, content: 'first', status: 'ok' });
  await POST(req1);
  const req2 = makeCallbackRequest({ correlationId, content: 'second', status: 'ok' });
  const res2 = await POST(req2);
  const body2 = await res2.json();

  assert.strictEqual(body2.matched, false, 'second callback for the same correlationId must not match');
  assert.deepStrictEqual(received, [{ type: 'message' }], 'exactly one publish, from the first callback only');
  unsubscribe();
});

// --- ordering: publish only after the completion transaction has committed ---

test('publication happens only after the completion transaction has committed, not before', async () => {
  const { sessionId, correlationId, assistantMessageId } = makeRun();
  let observedAtPublishTime = null;
  const unsubscribe = subscribe(sessionId, () => {
    // Read the row synchronously, inside the subscriber callback, at the exact moment
    // publish() delivers the event - proves the DB write already happened by then.
    observedAtPublishTime = getMessage(assistantMessageId);
  });

  const req = makeCallbackRequest({ correlationId, content: 'The durable answer.', status: 'ok' });
  await POST(req);

  assert.ok(observedAtPublishTime, 'subscriber must have been invoked');
  assert.strictEqual(observedAtPublishTime.status, 'completed');
  assert.strictEqual(observedAtPublishTime.content, 'The durable answer.');
  unsubscribe();
});
