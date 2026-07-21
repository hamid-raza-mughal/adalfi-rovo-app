// test/04-callback.test.mjs
// Covers: POST /api/webhook/callback — authentication and correlation handling.
// Uses a temporary SQLite database; no real secrets or network calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Set env vars BEFORE dynamic imports that transitively open lib/db.js.
const tempDir = join(tmpdir(), `rovo-callback-${randomUUID()}`);
mkdirSync(tempDir, { recursive: true });
process.env.SQLITE_DB_PATH = join(tempDir, 'callback-test.db');
process.env.CALLBACK_SHARED_SECRET = 'test-callback-secret-abc';
delete globalThis.__adalfiDb;

// Dynamic imports after env setup.
const { POST } = await import('../app/api/webhook/callback/route.js');
const dbMod = await import('../lib/db.js');
const { default: db, createSession, addMessage, createRun, getMessage } = dbMod;

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
  const session = createSession('Callback test');
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
  return { correlationId, assistantMessageId: assistant.id };
}

// --- tests ---

test('missing token returns 401', async () => {
  const req = makeCallbackRequest({ correlationId: 'x', content: 'hi', status: 'ok' }, null);
  const res = await POST(req);
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.error, 'unauthorized');
});

test('wrong token returns 401', async () => {
  const req = makeCallbackRequest({ correlationId: 'x', content: 'hi', status: 'ok' }, 'wrong-token');
  const res = await POST(req);
  assert.strictEqual(res.status, 401);
});

test('valid token is accepted (200)', async () => {
  const { correlationId } = makeRun();
  const req = makeCallbackRequest({ correlationId, content: 'answer', status: 'ok' });
  const res = await POST(req);
  assert.strictEqual(res.status, 200);
});

test('known correlationId updates assistant message and returns matched:true', async () => {
  const { correlationId, assistantMessageId } = makeRun();
  const req = makeCallbackRequest({ correlationId, content: 'The answer.', status: 'ok' });
  const res = await POST(req);
  const body = await res.json();
  assert.ok(body.matched);
  const msg = getMessage(assistantMessageId);
  assert.strictEqual(msg.content, 'The answer.');
  assert.strictEqual(msg.status, 'completed');
});

test('unknown correlationId returns matched:false without error', async () => {
  const req = makeCallbackRequest({ correlationId: 'nonexistent-id', content: 'data', status: 'ok' });
  const res = await POST(req);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.matched, false);
  assert.ok(body.ok);
});

test('duplicate callback (same correlationId) returns matched:false on second call', async () => {
  const { correlationId, assistantMessageId } = makeRun();
  const req1 = makeCallbackRequest({ correlationId, content: 'first', status: 'ok' });
  await POST(req1);

  const req2 = makeCallbackRequest({ correlationId, content: 'second', status: 'ok' });
  const res2 = await POST(req2);
  const body2 = await res2.json();

  assert.strictEqual(body2.matched, false);
  const msg = getMessage(assistantMessageId);
  assert.strictEqual(msg.content, 'first'); // unchanged
});

test('missing correlationId returns 400', async () => {
  const req = makeCallbackRequest({ content: 'answer', status: 'ok' });
  const res = await POST(req);
  assert.strictEqual(res.status, 400);
});

test('error response does not expose stack traces or db paths', async () => {
  // Send a request with a valid token but no body (triggers parse failure → 400).
  const req = new Request('http://localhost/api/webhook/callback', {
    method: 'POST',
    headers: { 'x-callback-token': process.env.CALLBACK_SHARED_SECRET },
    body: 'NOT JSON',
  });
  const res = await POST(req);
  const text = await res.text();
  // Must not expose filesystem paths or SQL details
  assert.ok(!text.includes('/Users/'), 'must not expose file paths');
  assert.ok(!text.includes('SQLITE'), 'must not expose SQLite internals');
  assert.ok(!text.includes('stack'), 'must not expose stack traces');
});

test('status=error marks assistant message as failed', async () => {
  const { correlationId, assistantMessageId } = makeRun();
  const req = makeCallbackRequest({ correlationId, content: 'Agent crashed.', status: 'error' });
  await POST(req);
  const msg = getMessage(assistantMessageId);
  assert.strictEqual(msg.status, 'failed');
});
