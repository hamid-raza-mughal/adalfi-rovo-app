// test/11-eventsRoute.test.mjs
// Covers: GET /api/sessions/:id/events — the SSE transport route itself. Uses a temporary
// SQLite database only to exercise getSession's 404/200 branch; no real Rovo callback, no
// real browser client. Tests call lib/sessionEvents.ts's publish() directly, the same way
// Phase 3.2's callback route eventually will - this phase does not wire that call itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const tempDir = join(tmpdir(), `rovo-events-${randomUUID()}`);
mkdirSync(tempDir, { recursive: true });
process.env.SQLITE_DB_PATH = join(tempDir, 'events-test.db');
delete globalThis.__adalfiDb;

const { GET: eventsGet } = await import('../app/api/sessions/[id]/events/route.ts');
const { publish, subscriberCount } = await import('../lib/sessionEvents.ts');
const dbMod = await import('../lib/db.ts');
const { default: db, createSession } = dbMod;

process.on('exit', () => {
  try { db.close(); } catch {}
  rmSync(tempDir, { recursive: true, force: true });
});

// --- helpers ---

function params(id) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest(id, signal) {
  const opts = {};
  if (signal) opts.signal = signal;
  return new Request(`http://localhost/api/sessions/${id}/events`, opts);
}

async function readChunk(reader) {
  const { value, done } = await reader.read();
  if (done) return null;
  return new TextDecoder().decode(value);
}

// --- unknown session ---

test('GET returns 404 for a nonexistent session', async () => {
  const res = await eventsGet(makeRequest('nonexistent-session-id'), params('nonexistent-session-id'));
  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.strictEqual(body.error, 'Session not found');
});

test('GET does not create a subscriber when the session does not exist', async () => {
  const id = 'nonexistent-session-id-2';
  await eventsGet(makeRequest(id), params(id));
  assert.strictEqual(subscriberCount(id), 0);
});

// --- headers ---

test('GET returns correctly configured SSE headers for an existing session', async () => {
  const session = createSession('Headers test');
  const res = await eventsGet(makeRequest(session.id), params(session.id));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.strictEqual(res.headers.get('cache-control'), 'no-cache, no-transform');
  assert.strictEqual(res.headers.get('connection'), 'keep-alive');
  await res.body.getReader().cancel();
});

// --- initial connected event ---

test('GET emits a well-formed initial connected event', async () => {
  const session = createSession('Connected event test');
  const res = await eventsGet(makeRequest(session.id), params(session.id));
  const reader = res.body.getReader();
  const chunk = await readChunk(reader);
  assert.strictEqual(chunk, 'event: connected\ndata: {}\n\n');
  await reader.cancel();
});

// --- publish reaches the route's open connection ---
// Cross-session isolation of publish() itself is covered at the module level in
// test/10-sessionEvents.test.mjs; this confirms the route actually wires subscribe().

test("publishing an event for a session reaches that session's open connection", async () => {
  const session = createSession('Publish reaches route test');
  const res = await eventsGet(makeRequest(session.id), params(session.id));
  const reader = res.body.getReader();
  await readChunk(reader); // consume 'connected'

  publish(session.id, { type: 'message' });

  const chunk = await readChunk(reader);
  assert.strictEqual(chunk, 'event: message\ndata: {}\n\n');
  await reader.cancel();
});

// --- heartbeats ---

test('GET sends a well-formed heartbeat comment on the configured interval', async () => {
  process.env.SSE_HEARTBEAT_MS = '20';
  try {
    const session = createSession('Heartbeat test');
    const res = await eventsGet(makeRequest(session.id), params(session.id));
    const reader = res.body.getReader();
    await readChunk(reader); // consume 'connected'
    const chunk = await readChunk(reader);
    assert.strictEqual(chunk, ': heartbeat\n\n');
    await reader.cancel();
  } finally {
    delete process.env.SSE_HEARTBEAT_MS;
  }
});

test('heartbeats do not register as subscribers or create extra subscriptions', async () => {
  process.env.SSE_HEARTBEAT_MS = '15';
  try {
    const session = createSession('Heartbeat subscriber count test');
    const res = await eventsGet(makeRequest(session.id), params(session.id));
    const reader = res.body.getReader();
    await readChunk(reader); // connected
    await readChunk(reader); // one heartbeat
    assert.strictEqual(subscriberCount(session.id), 1, 'heartbeats must not touch the subscriber registry');
    await reader.cancel();
  } finally {
    delete process.env.SSE_HEARTBEAT_MS;
  }
});

// --- cancellation / cleanup ---

test('cancelling the stream reader removes the subscriber', async () => {
  const session = createSession('Stream cancel cleanup test');
  const res = await eventsGet(makeRequest(session.id), params(session.id));
  const reader = res.body.getReader();
  await readChunk(reader); // connected
  assert.strictEqual(subscriberCount(session.id), 1);

  await reader.cancel();
  assert.strictEqual(subscriberCount(session.id), 0);
});

test('a published event after the stream is cancelled is not delivered to the stale subscriber', async () => {
  const session = createSession('Post-cancel publish test');
  const res = await eventsGet(makeRequest(session.id), params(session.id));
  const reader = res.body.getReader();
  await readChunk(reader);
  await reader.cancel();

  assert.doesNotThrow(() => publish(session.id, { type: 'message' }));
  assert.strictEqual(subscriberCount(session.id), 0);
});

test('aborting the request signal also removes the subscriber', async () => {
  const session = createSession('Abort cleanup test');
  const controller = new AbortController();
  const res = await eventsGet(makeRequest(session.id, controller.signal), params(session.id));
  const reader = res.body.getReader();
  await readChunk(reader); // connected
  assert.strictEqual(subscriberCount(session.id), 1);

  controller.abort();
  await Promise.resolve(); // flush the abort-event dispatch
  assert.strictEqual(subscriberCount(session.id), 0);

  await reader.cancel().catch(() => {}); // stream already closed by cleanup - ignore
});
