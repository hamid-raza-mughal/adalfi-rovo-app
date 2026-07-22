// test/05-sessions.test.mjs
// Covers: session CRUD via GET/POST /api/sessions and GET/PATCH/DELETE /api/sessions/:id.
// Uses a temporary SQLite database; no real data is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Set SQLITE_DB_PATH before any import that touches lib/db.js.
const tempDir = join(tmpdir(), `rovo-sessions-${randomUUID()}`);
mkdirSync(tempDir, { recursive: true });
process.env.SQLITE_DB_PATH = join(tempDir, 'sessions-test.db');
delete globalThis.__adalfiDb;

// Dynamic imports after env setup.
const { GET: listRoute, POST: createRoute } = await import('../app/api/sessions/route.js');
const { GET: getRoute, PATCH: patchRoute, DELETE: deleteRoute } = await import('../app/api/sessions/[id]/route.js');
const dbMod = await import('../lib/db.ts');
const { default: db, addMessage, createRun, getMessage } = dbMod;

process.on('exit', () => {
  try { db.close(); } catch {}
  rmSync(tempDir, { recursive: true, force: true });
});

// --- helpers ---

function makeRequest(method = 'GET', body, headers = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request('http://localhost/api/sessions', opts);
}

function makeIdRequest(method = 'GET', id = '', body, headers = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request(`http://localhost/api/sessions/${id}`, opts);
}

function params(id) {
  return { params: Promise.resolve({ id }) };
}

// --- tests ---

test('POST /sessions creates a session with a default title', async () => {
  const res = await createRoute(makeRequest('POST'));
  assert.strictEqual(res.status, 201);
  const body = await res.json();
  assert.ok(body.session.id);
  assert.strictEqual(body.session.title, 'New chat');
});

test('POST /sessions creates a session with a custom title', async () => {
  const res = await createRoute(makeRequest('POST', { title: 'My Project' }));
  assert.strictEqual(res.status, 201);
  const body = await res.json();
  assert.strictEqual(body.session.title, 'My Project');
});

test('GET /sessions lists all sessions', async () => {
  // Create a known session.
  const createRes = await createRoute(makeRequest('POST', { title: 'Listed Session' }));
  const { session } = await createRes.json();

  const res = await listRoute(makeRequest('GET'));
  const body = await res.json();
  assert.ok(Array.isArray(body.sessions));
  assert.ok(body.sessions.some((s) => s.id === session.id));
});

test('GET /sessions/:id returns session and empty messages array', async () => {
  const createRes = await createRoute(makeRequest('POST', { title: 'Get Me' }));
  const { session } = await createRes.json();

  const res = await getRoute(makeIdRequest('GET', session.id), params(session.id));
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.session.id, session.id);
  assert.ok(Array.isArray(body.messages));
});

test('GET /sessions/:id returns 404 for missing session', async () => {
  const res = await getRoute(makeIdRequest('GET', 'nonexistent-id'), params('nonexistent-id'));
  assert.strictEqual(res.status, 404);
});

test('PATCH /sessions/:id renames the session', async () => {
  const createRes = await createRoute(makeRequest('POST', { title: 'Old Title' }));
  const { session } = await createRes.json();

  const res = await patchRoute(makeIdRequest('PATCH', session.id, { title: 'New Title' }), params(session.id));
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.session.title, 'New Title');
});

test('PATCH /sessions/:id with empty title returns 400', async () => {
  const createRes = await createRoute(makeRequest('POST', { title: 'Will Fail' }));
  const { session } = await createRes.json();

  const res = await patchRoute(makeIdRequest('PATCH', session.id, { title: '' }), params(session.id));
  assert.strictEqual(res.status, 400);
});

test('PATCH /sessions/:id with whitespace-only title returns 400', async () => {
  const createRes = await createRoute(makeRequest('POST', { title: 'Will Fail 2' }));
  const { session } = await createRes.json();

  const res = await patchRoute(makeIdRequest('PATCH', session.id, { title: '   ' }), params(session.id));
  assert.strictEqual(res.status, 400);
});

test('PATCH /sessions/:id with no title field returns 400', async () => {
  const createRes = await createRoute(makeRequest('POST', { title: 'No Field' }));
  const { session } = await createRes.json();

  const res = await patchRoute(makeIdRequest('PATCH', session.id, { something: 'else' }), params(session.id));
  assert.strictEqual(res.status, 400);
});

test('PATCH /sessions/:id returns 404 for missing session', async () => {
  const res = await patchRoute(makeIdRequest('PATCH', 'ghost', { title: 'X' }), params('ghost'));
  assert.strictEqual(res.status, 404);
});

test('DELETE /sessions/:id deletes the session', async () => {
  const createRes = await createRoute(makeRequest('POST', { title: 'Delete Me' }));
  const { session } = await createRes.json();

  const delRes = await deleteRoute(makeIdRequest('DELETE', session.id), params(session.id));
  assert.strictEqual(delRes.status, 200);
  const body = await delRes.json();
  assert.ok(body.ok);

  // Confirm it's gone.
  const getRes = await getRoute(makeIdRequest('GET', session.id), params(session.id));
  assert.strictEqual(getRes.status, 404);
});

test('DELETE /sessions/:id returns 404 for missing session', async () => {
  const res = await deleteRoute(makeIdRequest('DELETE', 'nope'), params('nope'));
  assert.strictEqual(res.status, 404);
});

test('DELETE /sessions/:id cascades to messages and runs', async () => {
  const createRes = await createRoute(makeRequest('POST', { title: 'Cascade Test' }));
  const { session } = await createRes.json();

  // Add messages and a run directly via db helpers.
  const user = addMessage({ sessionId: session.id, role: 'user', content: 'q', status: 'completed' });
  const assistant = addMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'pending' });
  const corrId = randomUUID();
  createRun({
    sessionId: session.id,
    userMessageId: user.id,
    assistantMessageId: assistant.id,
    correlationId: corrId,
    webhookUrl: 'https://rovo.example.com/w',
    requestPayload: '{}',
  });

  await deleteRoute(makeIdRequest('DELETE', session.id), params(session.id));

  // Messages should be gone (cascade).
  assert.strictEqual(getMessage(user.id), undefined);
  assert.strictEqual(getMessage(assistant.id), undefined);
  // Run should be gone (cascade).
  const run = db.prepare('SELECT id FROM webhook_runs WHERE correlation_id = ?').get(corrId);
  assert.strictEqual(run, undefined);
});

test('DELETE /sessions/:id does not affect other sessions', async () => {
  const r1 = await createRoute(makeRequest('POST', { title: 'Keep 1' }));
  const { session: s1 } = await r1.json();
  const r2 = await createRoute(makeRequest('POST', { title: 'Delete 2' }));
  const { session: s2 } = await r2.json();

  await deleteRoute(makeIdRequest('DELETE', s2.id), params(s2.id));

  const checkRes = await getRoute(makeIdRequest('GET', s1.id), params(s1.id));
  assert.strictEqual(checkRes.status, 200);
});
