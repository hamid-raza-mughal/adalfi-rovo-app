// test/06-messages.test.mjs
// Covers: POST /api/sessions/:id/messages — tunnel-not-ready behaviour and happy path.
// No real Rovo webhook is called; no real tunnel or database is used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Set env vars BEFORE any module that transitively imports lib/db.js or lib/publicUrl.js.
const tempDir = join(tmpdir(), `rovo-messages-${randomUUID()}`);
const runtimeDir = join(tempDir, 'runtime');
mkdirSync(tempDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });

process.env.SQLITE_DB_PATH = join(tempDir, 'messages-test.db');
process.env.RUNTIME_DIR = runtimeDir;
process.env.ROVO_WEBHOOK_URL = 'https://rovo.example.com/webhook/test';
process.env.ROVO_WEBHOOK_SECRET = 'test-rovo-secret';
process.env.CALLBACK_SHARED_SECRET = 'test-callback-secret';
delete process.env.PUBLIC_BASE_URL;
delete globalThis.__adalfiDb;

// Dynamic imports after env setup.
const { POST: messagesPost } = await import('../app/api/sessions/[id]/messages/route.js');
const { GET: sessionsGet, POST: sessionsCreate } = await import('../app/api/sessions/route.js');
const dbMod = await import('../lib/db.js');
const { default: db, createSession, addMessage, getMessages, getMessage } = dbMod;

process.on('exit', () => {
  try { db.close(); } catch {}
  rmSync(tempDir, { recursive: true, force: true });
});

// --- helpers ---

function params(id) {
  return { params: Promise.resolve({ id }) };
}

function makePostRequest(sessionId, content, forwardedHost) {
  const headers = { 'Content-Type': 'application/json' };
  if (forwardedHost) headers['x-forwarded-host'] = forwardedHost;
  return new Request(`http://localhost/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content }),
  });
}

function writePublicUrl(url) {
  writeFileSync(join(runtimeDir, 'public-url.json'), JSON.stringify({ url }), 'utf8');
}

function removePublicUrl() {
  try { require('node:fs').rmSync(join(runtimeDir, 'public-url.json')); } catch {}
}

// Use Node's fs.rmSync to remove the runtime file between tests.
import { rmSync as fsRmSync } from 'node:fs';
function clearRuntimeFile() {
  fsRmSync(join(runtimeDir, 'public-url.json'), { force: true });
}

// --- tests: tunnel not ready ---

test('POST messages without tunnel returns 503', async () => {
  clearRuntimeFile(); // no runtime file → localhost fallback → TUNNEL_NOT_READY
  const session = createSession('503 test');
  const req = makePostRequest(session.id, 'Hello?', null); // no x-forwarded-host → localhost fallback
  const res = await messagesPost(req, params(session.id));
  assert.strictEqual(res.status, 503);
  const body = await res.json();
  assert.ok(body.error.toLowerCase().includes('tunnel') || body.error.toLowerCase().includes('starting'));
});

test('POST messages without tunnel does not create a user message', async () => {
  clearRuntimeFile();
  const session = createSession('No user msg test');
  const before = getMessages(session.id).length;
  const req = makePostRequest(session.id, 'Hello?', null);
  await messagesPost(req, params(session.id));
  const after = getMessages(session.id).length;
  assert.strictEqual(after, before, 'no messages should be created on 503');
});

test('POST messages without tunnel does not create an assistant message', async () => {
  clearRuntimeFile();
  const session = createSession('No assistant msg test');
  const req = makePostRequest(session.id, 'Hello?', null);
  await messagesPost(req, params(session.id));
  const msgs = getMessages(session.id);
  assert.ok(!msgs.some((m) => m.role === 'assistant'), 'no assistant message should exist');
});

test('POST messages without tunnel does not create a webhook run', async () => {
  clearRuntimeFile();
  const session = createSession('No run test');
  const req = makePostRequest(session.id, 'Hello?', null);
  await messagesPost(req, params(session.id));
  const runs = db.prepare('SELECT id FROM webhook_runs WHERE session_id = ?').all(session.id);
  assert.strictEqual(runs.length, 0, 'no webhook run should be created on 503');
});

test('POST messages without tunnel does not call Rovo webhook', async () => {
  clearRuntimeFile();
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
  try {
    const session = createSession('No fetch test');
    const req = makePostRequest(session.id, 'Hello?', null);
    await messagesPost(req, params(session.id));
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(!fetchCalled, 'fetch must not be called when tunnel is not ready');
});

// --- tests: valid tunnel ---

test('POST messages with valid tunnel URL creates user and assistant messages', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return new Response('{}', { status: 200 }); };
  try {
    const session = createSession('Happy path test');
    const req = makePostRequest(session.id, 'What is the policy?', null);
    const res = await messagesPost(req, params(session.id));
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.userMessage?.id, 'should return userMessage');
    assert.ok(body.assistantMessage?.id, 'should return assistantMessage');
    assert.strictEqual(body.assistantMessage.status, 'pending');
  } finally {
    globalThis.fetch = original;
  }
});

test('POST messages with valid tunnel creates a webhook run', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    const session = createSession('Run creation test');
    const req = makePostRequest(session.id, 'Query text', null);
    await messagesPost(req, params(session.id));
    const runs = db.prepare('SELECT * FROM webhook_runs WHERE session_id = ?').all(session.id);
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(runs[0].status, 'pending');
  } finally {
    globalThis.fetch = original;
  }
});

// --- tests: content validation (typeof guard before .trim()) ---
// A truthy non-string body.content (number, object, array, boolean) previously reached
// `.trim()` directly and crashed with an unhandled TypeError. These confirm every such
// value now returns the same 400 "content required" response the route already used for
// missing/empty content, instead of throwing or returning 500.

test('valid string content passes validation and proceeds past the content gate', async () => {
  clearRuntimeFile(); // no tunnel: proves this reached the tunnel gate, not rejected for content
  const session = createSession('Valid content test');
  const req = makePostRequest(session.id, 'Hello, agent.', null);
  const res = await messagesPost(req, params(session.id));
  assert.strictEqual(res.status, 503); // tunnel-not-ready, NOT 400 - content was accepted
});

test('string with surrounding whitespace is trimmed and passes validation', async () => {
  clearRuntimeFile();
  const session = createSession('Whitespace trim test');
  const req = makePostRequest(session.id, '   Hello, agent.   ', null);
  const res = await messagesPost(req, params(session.id));
  assert.strictEqual(res.status, 503); // passed content validation, reached the tunnel gate
});

test('empty string content returns 400 content required', async () => {
  const session = createSession('Empty string test');
  const req = makePostRequest(session.id, '', null);
  const res = await messagesPost(req, params(session.id));
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'content required');
});

test('whitespace-only content returns 400 content required', async () => {
  const session = createSession('Whitespace only test');
  const req = makePostRequest(session.id, '   \n\t  ', null);
  const res = await messagesPost(req, params(session.id));
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'content required');
});

test('number content is rejected with 400, not a 500 crash', async () => {
  const session = createSession('Number content test');
  const req = makePostRequest(session.id, 12345, null);
  const res = await messagesPost(req, params(session.id));
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'content required');
});

test('object content is rejected with 400, not a 500 crash', async () => {
  const session = createSession('Object content test');
  const req = makePostRequest(session.id, { nested: 'value' }, null);
  const res = await messagesPost(req, params(session.id));
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'content required');
});

test('array content is rejected with 400, not a 500 crash', async () => {
  const session = createSession('Array content test');
  const req = makePostRequest(session.id, ['a', 'b', 'c'], null);
  const res = await messagesPost(req, params(session.id));
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'content required');
});

test('boolean content is rejected with 400, not a 500 crash', async () => {
  const session = createSession('Boolean content test');
  const req = makePostRequest(session.id, true, null);
  const res = await messagesPost(req, params(session.id));
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'content required');
});

test('null content is rejected with 400 content required', async () => {
  const session = createSession('Null content test');
  const req = makePostRequest(session.id, null, null);
  const res = await messagesPost(req, params(session.id));
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'content required');
});
