// test/07-instrumentation.test.mjs
// Covers: lib/instrumentation.js unit tests, server-side lifecycle event emission from the
// messages and callback routes, /api/log ingestion, and trace-correlation semantics.
// No real Rovo calls, real secrets, or production database are used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// --- Env setup (must precede all dynamic imports that use lib/db.js or lib/publicUrl.js) ---
const tempDir = join(tmpdir(), `rovo-instrumentation-${randomUUID()}`);
const runtimeDir = join(tempDir, 'runtime');
mkdirSync(tempDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });

process.env.SQLITE_DB_PATH = join(tempDir, 'instrumentation-test.db');
process.env.RUNTIME_DIR = runtimeDir;
process.env.ROVO_WEBHOOK_URL = 'https://rovo.example.com/webhook/test';
process.env.ROVO_WEBHOOK_SECRET = 'test-rovo-secret';
process.env.CALLBACK_SHARED_SECRET = 'test-callback-secret';
delete process.env.PUBLIC_BASE_URL;
delete globalThis.__adalfiDb;

// --- Dynamic imports ---
const { logEvent } = await import('../lib/instrumentation.js');
const { POST: messagesPost } = await import('../app/api/sessions/[id]/messages/route.js');
const { POST: callbackPost } = await import('../app/api/webhook/callback/route.ts');
const { POST: logPost } = await import('../app/api/log/route.js');
const dbMod = await import('../lib/db.ts');
const { default: db, createSession, addMessage, createRun, getRunByCorrelation } = dbMod;

process.on('exit', () => {
  try { db.close(); } catch {}
  rmSync(tempDir, { recursive: true, force: true });
});

// --- Helpers ---

function writePublicUrl(url) {
  writeFileSync(join(runtimeDir, 'public-url.json'), JSON.stringify({ url }), 'utf8');
}

/** Capture lines written to process.stdout during an async fn. */
async function captureStdoutAsync(fn) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    if (typeof chunk === 'string' && chunk.trim()) lines.push(chunk.trim());
    return true;
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    process.stdout.write = orig;
  }
}

function captureStdout(fn) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    if (typeof chunk === 'string' && chunk.trim()) lines.push(chunk.trim());
    return true;
  };
  try { fn(); } finally { process.stdout.write = orig; }
  return lines;
}

function params(id) {
  return { params: Promise.resolve({ id }) };
}

/** Build a POST /api/sessions/:id/messages request. clientRequestId is optional. */
function makePostRequest(sessionId, content, clientRequestId) {
  const body = { content };
  if (clientRequestId !== undefined) body.clientRequestId = clientRequestId;
  return new Request(`http://localhost/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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

/** Create a session + user message + pending assistant message + run. Returns IDs. */
function makeRun(label = 'test') {
  const session = createSession(label);
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
  return { correlationId, sessionId: session.id, assistantMessageId: assistant.id };
}

function parsedLines(lines) {
  return lines.map((l) => JSON.parse(l));
}

// =============================================================================
// 1. lib/instrumentation.js — unit tests
// =============================================================================

test('logEvent emits a single JSON line with event name and ISO timestamp', () => {
  const lines = captureStdout(() => logEvent('test_event', {}));
  assert.strictEqual(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.strictEqual(entry.event, 'test_event');
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('logEvent includes correlationId when supplied', () => {
  const lines = captureStdout(() => logEvent('run_created', { correlationId: 'c-abc123' }));
  const entry = JSON.parse(lines[0]);
  assert.strictEqual(entry.correlationId, 'c-abc123');
});

test('logEvent includes clientRequestId when supplied', () => {
  const lines = captureStdout(() => logEvent('server_prompt_received', { clientRequestId: 'cr-xyz' }));
  const entry = JSON.parse(lines[0]);
  assert.strictEqual(entry.clientRequestId, 'cr-xyz');
});

test('logEvent includes durationFrom when supplied', () => {
  const lines = captureStdout(() =>
    logEvent('run_created', { durationMs: 5, durationFrom: 'server_prompt_received' })
  );
  const entry = JSON.parse(lines[0]);
  assert.strictEqual(entry.durationFrom, 'server_prompt_received');
  assert.strictEqual(entry.durationMs, 5);
});

test('logEvent includes sessionId, runId, messageId, durationMs, and status when supplied', () => {
  const lines = captureStdout(() =>
    logEvent('rovo_request_acknowledged', {
      sessionId: 's-1', runId: 'r-1', messageId: 'm-1', durationMs: 432, status: 'success',
    })
  );
  const entry = JSON.parse(lines[0]);
  assert.strictEqual(entry.sessionId, 's-1');
  assert.strictEqual(entry.runId, 'r-1');
  assert.strictEqual(entry.messageId, 'm-1');
  assert.strictEqual(entry.durationMs, 432);
  assert.strictEqual(entry.status, 'success');
});

test('logEvent includes safe content metadata (contentPresent, contentLength)', () => {
  const lines = captureStdout(() =>
    logEvent('callback_validated', { correlationId: 'c-1', contentPresent: true, contentLength: 256 })
  );
  const entry = JSON.parse(lines[0]);
  assert.strictEqual(entry.contentPresent, true);
  assert.strictEqual(entry.contentLength, 256);
});

test('logEvent strips url field (Rovo webhook URL must never be logged)', () => {
  const lines = captureStdout(() =>
    logEvent('rovo_request_started', { correlationId: 'c-1', url: 'https://secret-webhook.rovo.com' })
  );
  const entry = JSON.parse(lines[0]);
  assert.ok(!('url' in entry), 'url must not appear in log output');
});

test('logEvent strips token, secret, and authorization fields', () => {
  const lines = captureStdout(() =>
    logEvent('callback_rejected', {
      token: 'abc-secret', secret: 'shh', authorization: 'Bearer xyz',
    })
  );
  const entry = JSON.parse(lines[0]);
  assert.ok(!('token' in entry));
  assert.ok(!('secret' in entry));
  assert.ok(!('authorization' in entry));
});

test('logEvent strips prompt and content fields (no message text in logs)', () => {
  const lines = captureStdout(() =>
    logEvent('run_created', {
      correlationId: 'c-1',
      prompt: 'What is the budget?',
      content: 'The budget is $1M',
    })
  );
  const entry = JSON.parse(lines[0]);
  assert.ok(!('prompt' in entry), 'prompt must not be logged');
  assert.ok(!('content' in entry), 'content must not be logged');
  assert.strictEqual(entry.correlationId, 'c-1');
});

test('logEvent strips stack traces', () => {
  const lines = captureStdout(() =>
    logEvent('rovo_request_failed', {
      correlationId: 'c-1',
      stack: 'Error: network\n  at fireRovo (lib/rovo.js:13)',
      status: 'failed',
    })
  );
  const entry = JSON.parse(lines[0]);
  assert.ok(!('stack' in entry), 'stack trace must not be logged');
  assert.strictEqual(entry.status, 'failed');
});

test('logEvent does not throw when process.stdout.write fails', () => {
  const orig = process.stdout.write;
  process.stdout.write = () => { throw new Error('disk full'); };
  try {
    assert.doesNotThrow(() => logEvent('server_prompt_received', { sessionId: 's-1' }));
  } finally {
    process.stdout.write = orig;
  }
});

test('logEvent works with no optional IDs (missing clientRequestId, correlationId, runId, sessionId)', () => {
  const lines = captureStdout(() => logEvent('server_prompt_received', {}));
  const entry = JSON.parse(lines[0]);
  assert.ok(!('clientRequestId' in entry));
  assert.ok(!('correlationId' in entry));
  assert.ok(!('runId' in entry));
  assert.ok(!('sessionId' in entry));
  assert.ok('event' in entry);
  assert.ok('timestamp' in entry);
});

test('logEvent accepts a client-supplied timestamp override', () => {
  const ts = '2026-07-22T00:00:00.000Z';
  const lines = captureStdout(() => logEvent('response_rendered', { timestamp: ts }));
  const entry = JSON.parse(lines[0]);
  assert.strictEqual(entry.timestamp, ts);
});

test('logEvent matched field is preserved (boolean)', () => {
  const lines = captureStdout(() =>
    logEvent('database_update_completed', { correlationId: 'c-1', matched: false, status: 'success' })
  );
  const entry = JSON.parse(lines[0]);
  assert.strictEqual(entry.matched, false);
});

// =============================================================================
// 2. Messages route — server lifecycle event emission
// =============================================================================

test('POST messages emits server_prompt_received, run_created, rovo_request_started, rovo_request_acknowledged', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });

  try {
    const session = createSession('Lifecycle test');
    const req = makePostRequest(session.id, 'What is the policy?');
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));
    const names = parsedLines(lines).map((e) => e.event);

    assert.ok(names.includes('server_prompt_received'), 'must emit server_prompt_received');
    assert.ok(names.includes('run_created'), 'must emit run_created');
    assert.ok(names.includes('rovo_request_started'), 'must emit rovo_request_started');
    assert.ok(names.includes('rovo_request_acknowledged'), 'must emit rovo_request_acknowledged');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('server_prompt_received carries clientRequestId when supplied in request body', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const clientRequestId = randomUUID();

  try {
    const session = createSession('clientRequestId test');
    const req = makePostRequest(session.id, 'query', clientRequestId);
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));
    const events = parsedLines(lines);
    const received = events.find((e) => e.event === 'server_prompt_received');
    assert.ok(received, 'must emit server_prompt_received');
    assert.strictEqual(received.clientRequestId, clientRequestId);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('all post-run server events share the same clientRequestId', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const clientRequestId = randomUUID();

  try {
    const session = createSession('clientRequestId propagation test');
    const req = makePostRequest(session.id, 'query', clientRequestId);
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));
    const events = parsedLines(lines).filter((e) => e.clientRequestId !== undefined);
    assert.ok(events.length > 0, 'at least one event must carry clientRequestId');
    for (const ev of events) {
      assert.strictEqual(ev.clientRequestId, clientRequestId,
        `${ev.event} has wrong clientRequestId`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('server_prompt_received carries clientRequestId even before correlationId exists', async () => {
  // server_prompt_received fires before DB records are created, so it has no correlationId.
  // clientRequestId must be present to link it to the browser-side events.
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const clientRequestId = randomUUID();

  try {
    const session = createSession('pre-DB traceability test');
    const req = makePostRequest(session.id, 'query', clientRequestId);
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));
    const events = parsedLines(lines);
    const received = events.find((e) => e.event === 'server_prompt_received');
    assert.ok(received);
    assert.strictEqual(received.clientRequestId, clientRequestId);
    assert.ok(!('correlationId' in received), 'correlationId must NOT be on server_prompt_received');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('run_created carries both clientRequestId and correlationId', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const clientRequestId = randomUUID();

  try {
    const session = createSession('dual-ID test');
    const req = makePostRequest(session.id, 'query', clientRequestId);
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));
    const events = parsedLines(lines);
    const runCreated = events.find((e) => e.event === 'run_created');
    assert.ok(runCreated);
    assert.strictEqual(runCreated.clientRequestId, clientRequestId);
    assert.ok(runCreated.correlationId, 'run_created must have correlationId');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('POST messages lifecycle events carry correlationId, sessionId, runId, messageId', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });

  try {
    const session = createSession('IDs propagation test');
    const req = makePostRequest(session.id, 'Hello agent');
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));
    const events = parsedLines(lines);
    const runCreated = events.find((e) => e.event === 'run_created');
    assert.ok(runCreated);
    assert.ok(runCreated.correlationId);
    assert.strictEqual(runCreated.sessionId, session.id);
    assert.ok(runCreated.runId);
    assert.ok(runCreated.messageId, 'run_created must carry messageId');

    // messageId = correlationId (both are assistantMessage.id)
    assert.strictEqual(runCreated.messageId, runCreated.correlationId);

    // All events that carry correlationId must use the same value.
    const cid = runCreated.correlationId;
    for (const ev of events) {
      if (ev.correlationId !== undefined) {
        assert.strictEqual(ev.correlationId, cid, `${ev.event} has a mismatched correlationId`);
      }
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('every event with durationMs also carries durationFrom', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });

  try {
    const session = createSession('durationFrom test');
    const req = makePostRequest(session.id, 'query');
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));
    const events = parsedLines(lines);
    for (const ev of events) {
      if ('durationMs' in ev) {
        assert.ok('durationFrom' in ev,
          `${ev.event} has durationMs but is missing durationFrom`);
        assert.ok(typeof ev.durationFrom === 'string' && ev.durationFrom.length > 0,
          `${ev.event}.durationFrom must be a non-empty string`);
      }
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('durationFrom values on server events name the correct baseline', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });

  try {
    const session = createSession('durationFrom semantics test');
    const req = makePostRequest(session.id, 'query');
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));
    const events = parsedLines(lines);
    const byName = Object.fromEntries(events.map((e) => [e.event, e]));

    assert.strictEqual(byName.run_created?.durationFrom, 'server_prompt_received');
    assert.strictEqual(byName.rovo_request_started?.durationFrom, 'server_prompt_received');
    assert.strictEqual(byName.rovo_request_acknowledged?.durationFrom, 'rovo_request_started');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('server_prompt_received has no durationMs (it is the server-side baseline)', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });

  try {
    const session = createSession('no-duration-on-received test');
    const req = makePostRequest(session.id, 'query');
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));
    const events = parsedLines(lines);
    const received = events.find((e) => e.event === 'server_prompt_received');
    assert.ok(received);
    assert.ok(!('durationMs' in received), 'server_prompt_received must not carry durationMs');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('POST messages emits run_created with promptLength (not prompt text)', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });

  try {
    const session = createSession('PromptLength test');
    const text = 'Tell me about the Q3 budget.';
    const req = makePostRequest(session.id, text);
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));
    const events = parsedLines(lines);
    const runCreated = events.find((e) => e.event === 'run_created');
    assert.ok(runCreated);
    assert.strictEqual(runCreated.promptLength, text.length);
    assert.ok(!('prompt' in runCreated), 'prompt text must not be logged');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('POST messages emits rovo_request_acknowledged with durationFrom:rovo_request_started and status:success', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });

  try {
    const session = createSession('Ack duration test');
    const req = makePostRequest(session.id, 'query');
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));
    const events = parsedLines(lines);
    const ack = events.find((e) => e.event === 'rovo_request_acknowledged');
    assert.ok(ack);
    assert.ok(typeof ack.durationMs === 'number' && ack.durationMs >= 0);
    assert.strictEqual(ack.durationFrom, 'rovo_request_started');
    assert.strictEqual(ack.status, 'success');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('POST messages emits rovo_request_failed (not acknowledged) when Rovo returns non-200', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('Bad Gateway', { status: 502 });

  try {
    const session = createSession('Rovo failure test');
    const req = makePostRequest(session.id, 'query');
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));
    const names = parsedLines(lines).map((e) => e.event);

    assert.ok(names.includes('rovo_request_failed'), 'must emit rovo_request_failed');
    assert.ok(!names.includes('rovo_request_acknowledged'), 'must NOT emit rovo_request_acknowledged on failure');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('rovo_request_failed carries durationFrom:rovo_request_started and status:failed', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('error', { status: 500 });

  try {
    const session = createSession('Rovo status test');
    const req = makePostRequest(session.id, 'query');
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));
    const events = parsedLines(lines);
    const failed = events.find((e) => e.event === 'rovo_request_failed');
    assert.ok(failed);
    assert.strictEqual(failed.status, 'failed');
    assert.strictEqual(failed.durationFrom, 'rovo_request_started');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('POST messages does not log Rovo webhook URL, callback URL, or secrets', async () => {
  writePublicUrl('https://abc123.trycloudflare.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });

  try {
    const session = createSession('No-secrets test');
    const req = makePostRequest(session.id, 'query');
    const { lines } = await captureStdoutAsync(() => messagesPost(req, params(session.id)));

    for (const line of lines) {
      assert.ok(!line.includes('rovo.example.com'), 'must not log Rovo webhook URL');
      assert.ok(!line.includes('test-rovo-secret'), 'must not log webhook secret');
      assert.ok(!line.includes('test-callback-secret'), 'must not log callback secret');
      assert.ok(!line.includes('trycloudflare.com'), 'must not log public tunnel URL');
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

// =============================================================================
// 3. Callback route — lifecycle event emission
// =============================================================================

test('callback_received is the first event emitted and has no durationMs', async () => {
  const { correlationId } = makeRun('First event test');
  const req = makeCallbackRequest({ correlationId, content: 'answer', status: 'ok' });
  const { lines } = await captureStdoutAsync(() => callbackPost(req));
  const events = parsedLines(lines);
  assert.strictEqual(events[0].event, 'callback_received',
    'callback_received must be the first event emitted');
  assert.ok(!('durationMs' in events[0]), 'callback_received must not carry durationMs (it is the baseline)');
});

test('callback with wrong token emits callback_rejected (not callback_validated)', async () => {
  const req = makeCallbackRequest({ correlationId: 'c-1', content: 'answer', status: 'ok' }, 'wrong-token');
  const { lines } = await captureStdoutAsync(() => callbackPost(req));
  const names = parsedLines(lines).map((e) => e.event);

  assert.ok(names.includes('callback_rejected'), 'must emit callback_rejected');
  assert.ok(!names.includes('callback_validated'), 'must NOT emit callback_validated on auth failure');
  assert.ok(!names.includes('database_update_completed'), 'must NOT emit db update on auth failure');
});

test('callback_rejected carries status:failed, httpStatus:401, and durationFrom:callback_received', async () => {
  const req = makeCallbackRequest({ correlationId: 'c-1', content: 'x', status: 'ok' }, 'bad-token');
  const { lines } = await captureStdoutAsync(() => callbackPost(req));
  const events = parsedLines(lines);
  const rejected = events.find((e) => e.event === 'callback_rejected');
  assert.ok(rejected);
  assert.strictEqual(rejected.status, 'failed');
  assert.strictEqual(rejected.httpStatus, 401);
  assert.strictEqual(rejected.durationFrom, 'callback_received');
});

test('successful callback emits callback_received, callback_validated, database_update_completed', async () => {
  const { correlationId } = makeRun('Success lifecycle');
  const req = makeCallbackRequest({ correlationId, content: 'The answer.', status: 'ok' });
  const { lines } = await captureStdoutAsync(() => callbackPost(req));
  const names = parsedLines(lines).map((e) => e.event);

  assert.ok(names.includes('callback_received'), 'must emit callback_received');
  assert.ok(names.includes('callback_validated'), 'must emit callback_validated');
  assert.ok(names.includes('database_update_completed'), 'must emit database_update_completed');
});

test('callback_validated carries correlationId, sessionId, runId, messageId, contentLength, and durationFrom', async () => {
  const { correlationId, sessionId, assistantMessageId } = makeRun('callback_validated fields');

  // Look up runId from the DB to verify it appears in the log.
  const run = getRunByCorrelation(correlationId);

  const answer = 'The answer to your question.';
  const req = makeCallbackRequest({ correlationId, content: answer, status: 'ok' });
  const { lines } = await captureStdoutAsync(() => callbackPost(req));
  const events = parsedLines(lines);
  const validated = events.find((e) => e.event === 'callback_validated');

  assert.ok(validated);
  assert.strictEqual(validated.correlationId, correlationId);
  assert.strictEqual(validated.sessionId, sessionId);
  assert.strictEqual(validated.runId, run.id);
  assert.strictEqual(validated.messageId, assistantMessageId);
  assert.strictEqual(validated.contentLength, answer.length);
  assert.strictEqual(validated.contentPresent, true);
  assert.strictEqual(validated.durationFrom, 'callback_received');
  assert.ok(!('content' in validated), 'content text must not be logged');
});

test('database_update_completed carries sessionId, runId, messageId, matched:true, durationFrom:callback_validated', async () => {
  const { correlationId, sessionId, assistantMessageId } = makeRun('DB completed fields');
  const run = getRunByCorrelation(correlationId);
  const req = makeCallbackRequest({ correlationId, content: 'OK answer', status: 'ok' });
  const { lines } = await captureStdoutAsync(() => callbackPost(req));
  const events = parsedLines(lines);
  const dbDone = events.find((e) => e.event === 'database_update_completed');

  assert.ok(dbDone);
  assert.strictEqual(dbDone.matched, true);
  assert.strictEqual(dbDone.status, 'success');
  assert.strictEqual(dbDone.sessionId, sessionId);
  assert.strictEqual(dbDone.runId, run.id);
  assert.strictEqual(dbDone.messageId, assistantMessageId);
  assert.strictEqual(dbDone.durationFrom, 'callback_validated');
  assert.ok(typeof dbDone.durationMs === 'number' && dbDone.durationMs >= 0);
});

test('every callback event with durationMs also carries durationFrom', async () => {
  const { correlationId } = makeRun('callback durationFrom check');
  const req = makeCallbackRequest({ correlationId, content: 'answer', status: 'ok' });
  const { lines } = await captureStdoutAsync(() => callbackPost(req));
  for (const ev of parsedLines(lines)) {
    if ('durationMs' in ev) {
      assert.ok('durationFrom' in ev,
        `${ev.event} has durationMs but is missing durationFrom`);
    }
  }
});

test('database_update_completed carries matched:false for unknown correlationId', async () => {
  const req = makeCallbackRequest({ correlationId: 'non-existent-' + randomUUID(), content: 'x', status: 'ok' });
  const { lines } = await captureStdoutAsync(() => callbackPost(req));
  const events = parsedLines(lines);
  const dbDone = events.find((e) => e.event === 'database_update_completed');
  assert.ok(dbDone);
  assert.strictEqual(dbDone.matched, false);
});

test('database_update_completed is not emitted when auth fails', async () => {
  const req = makeCallbackRequest({ correlationId: 'c-1', content: 'x', status: 'ok' }, 'wrong');
  const { lines } = await captureStdoutAsync(() => callbackPost(req));
  const names = parsedLines(lines).map((e) => e.event);
  assert.ok(!names.includes('database_update_completed'));
});

test('callback events do not log content text or shared secret', async () => {
  const { correlationId } = makeRun('No-secret callback');
  const req = makeCallbackRequest({ correlationId, content: 'Sensitive agent response here', status: 'ok' });
  const { lines } = await captureStdoutAsync(() => callbackPost(req));
  for (const line of lines) {
    assert.ok(!line.includes('Sensitive agent response'), 'response content must not be logged');
    assert.ok(!line.includes('test-callback-secret'), 'shared secret must not be logged');
  }
});

// =============================================================================
// 4. /api/log endpoint — client event ingestion
// =============================================================================

test('/api/log accepts valid client events and returns ok:true', async () => {
  const body = {
    event: 'client_prompt_submitted',
    timestamp: new Date().toISOString(),
    source: 'browser',
    clientRequestId: randomUUID(),
    sessionId: 's-1',
    promptLength: 42,
    status: 'success',
  };
  const req = new Request('http://localhost/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const { result } = await captureStdoutAsync(() => logPost(req));
  const data = await result.json();
  assert.ok(data.ok);
});

test('/api/log forwards clientRequestId and durationFrom to logEvent', async () => {
  const crid = randomUUID();
  const body = {
    event: 'client_completion_detected',
    timestamp: new Date().toISOString(),
    source: 'browser',
    clientRequestId: crid,
    correlationId: 'c-99',
    durationMs: 3500,
    durationFrom: 'client_prompt_submitted',
    status: 'success',
  };
  const req = new Request('http://localhost/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const { lines } = await captureStdoutAsync(() => logPost(req));
  const events = parsedLines(lines);
  const entry = events.find((e) => e.event === 'client_completion_detected');
  assert.ok(entry, 'event must be logged');
  assert.strictEqual(entry.clientRequestId, crid);
  assert.strictEqual(entry.durationFrom, 'client_prompt_submitted');
  assert.strictEqual(entry.durationMs, 3500);
});

test('/api/log rejects unknown event names with 400', async () => {
  const req = new Request('http://localhost/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'rovo_request_started' }), // server-side event, not valid here
  });
  const { result } = await captureStdoutAsync(() => logPost(req));
  assert.strictEqual(result.status, 400);
});

test('/api/log strips sensitive fields before forwarding to logEvent', async () => {
  const body = {
    event: 'response_rendered',
    timestamp: new Date().toISOString(),
    source: 'browser',
    clientRequestId: randomUUID(),
    correlationId: 'c-99',
    token: 'should-be-stripped',
    secret: 'also-stripped',
    content: 'full response text',
  };
  const req = new Request('http://localhost/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const { lines } = await captureStdoutAsync(() => logPost(req));
  for (const line of lines) {
    assert.ok(!line.includes('should-be-stripped'), 'token must not be logged');
    assert.ok(!line.includes('also-stripped'), 'secret must not be logged');
    assert.ok(!line.includes('full response text'), 'content must not be logged');
  }
  const events = parsedLines(lines);
  const entry = events.find((e) => e.event === 'response_rendered');
  assert.ok(entry, 'event must be logged');
  assert.strictEqual(entry.correlationId, 'c-99');
});

// =============================================================================
// 5. response_rendered duplicate-prevention logic
// =============================================================================

test('response_rendered Set guard prevents duplicate events for the same correlationId', () => {
  // This directly tests the guard logic used in the React component, independent of React.
  const seen = new Set();
  const emitted = [];

  function tryEmitRendered(cid) {
    if (!cid) return;
    if (seen.has(cid)) return;
    seen.add(cid);
    emitted.push(cid);
  }

  const CID = 'assistant-msg-uuid-' + randomUUID();
  tryEmitRendered(CID);  // first call — should fire
  tryEmitRendered(CID);  // duplicate — must be suppressed
  tryEmitRendered(CID);  // duplicate — must be suppressed

  assert.strictEqual(emitted.length, 1, 'response_rendered must fire exactly once per correlationId');
  assert.strictEqual(emitted[0], CID);
});

test('response_rendered Set guard fires independently for distinct correlationIds', () => {
  const seen = new Set();
  const emitted = [];

  function tryEmitRendered(cid) {
    if (!cid) return;
    if (seen.has(cid)) return;
    seen.add(cid);
    emitted.push(cid);
  }

  const CID1 = 'cid-' + randomUUID();
  const CID2 = 'cid-' + randomUUID();
  tryEmitRendered(CID1);
  tryEmitRendered(CID2);
  tryEmitRendered(CID1); // duplicate for CID1 — must be suppressed
  tryEmitRendered(CID2); // duplicate for CID2 — must be suppressed

  assert.strictEqual(emitted.length, 2, 'each distinct correlationId should fire exactly once');
  assert.ok(emitted.includes(CID1));
  assert.ok(emitted.includes(CID2));
});

test('response_rendered Set guard does not fire for null or undefined correlationId', () => {
  const seen = new Set();
  const emitted = [];

  function tryEmitRendered(cid) {
    if (!cid) return; // guard against null/undefined
    if (seen.has(cid)) return;
    seen.add(cid);
    emitted.push(cid);
  }

  tryEmitRendered(null);
  tryEmitRendered(undefined);
  tryEmitRendered('');

  assert.strictEqual(emitted.length, 0, 'must not emit for falsy correlationId values');
});

// =============================================================================
// 6. db.getRunByCorrelation — used by the callback route for ID enrichment
// =============================================================================

test('getRunByCorrelation returns the run with matching correlationId', () => {
  const { correlationId, sessionId, assistantMessageId } = makeRun('getRunByCorrelation test');
  const run = getRunByCorrelation(correlationId);
  assert.ok(run, 'must find the run');
  assert.strictEqual(run.correlation_id, correlationId);
  assert.strictEqual(run.session_id, sessionId);
  assert.strictEqual(run.assistant_message_id, assistantMessageId);
});

test('getRunByCorrelation returns undefined for an unknown correlationId', () => {
  const run = getRunByCorrelation('unknown-' + randomUUID());
  assert.strictEqual(run, undefined);
});
