// test/03-db.test.mjs
// Covers: core database run-state lifecycle and cascade behaviour.
// Uses a temporary SQLite file; the real data/app.db is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Set SQLITE_DB_PATH BEFORE importing lib/db.js — the singleton is created on first import.
const tempDir = join(tmpdir(), `rovo-db-${randomUUID()}`);
mkdirSync(tempDir, { recursive: true });
process.env.SQLITE_DB_PATH = join(tempDir, 'db-test.db');
delete globalThis.__adalfiDb;

const {
  default: db,
  createSession,
  addMessage,
  createRun,
  getSession,
  getMessages,
  getMessage,
  listSessions,
  touchSession,
  completeRunByCorrelation,
  failStaleRuns,
  deleteSession,
} = await import('../lib/db.js');

process.on('exit', () => {
  try { db.close(); } catch {}
  rmSync(tempDir, { recursive: true, force: true });
});

// --- helpers ---

function makeRun(sessionId) {
  const user = addMessage({ sessionId, role: 'user', content: 'question', status: 'completed' });
  const assistant = addMessage({ sessionId, role: 'assistant', content: '', status: 'pending' });
  const correlationId = randomUUID();
  const runId = createRun({
    sessionId,
    userMessageId: user.id,
    assistantMessageId: assistant.id,
    correlationId,
    webhookUrl: 'https://rovo.example.com/webhook',
    requestPayload: '{}',
  });
  return { runId, correlationId, assistantMessageId: assistant.id };
}

function getRun(runId) {
  return db.prepare('SELECT * FROM webhook_runs WHERE id = ?').get(runId);
}

// --- tests ---

test('pending → completed: completeRunByCorrelation ok=true', () => {
  const session = createSession('Test session');
  const { correlationId, assistantMessageId } = makeRun(session.id);

  const matched = completeRunByCorrelation({
    correlationId,
    ok: true,
    content: 'The answer is 42.',
    rawPayload: '{"status":"ok"}',
  });

  assert.ok(matched, 'should return true for known correlationId');
  const msg = getMessage(assistantMessageId);
  assert.strictEqual(msg.content, 'The answer is 42.');
  assert.strictEqual(msg.status, 'completed');
});

test('pending → failed: completeRunByCorrelation ok=false', () => {
  const session = createSession('Fail session');
  const { correlationId, assistantMessageId } = makeRun(session.id);

  completeRunByCorrelation({
    correlationId,
    ok: false,
    content: 'Agent error.',
    rawPayload: '{"status":"error"}',
  });

  const msg = getMessage(assistantMessageId);
  assert.strictEqual(msg.status, 'failed');
  assert.strictEqual(msg.content, 'Agent error.');
});

test('run status is set to completed when ok=true', () => {
  const session = createSession('Run status session');
  const { correlationId, runId } = makeRun(session.id);
  completeRunByCorrelation({ correlationId, ok: true, content: 'ok', rawPayload: null });
  const run = getRun(runId);
  assert.strictEqual(run.status, 'completed');
  assert.ok(run.completed_at, 'completed_at should be set');
});

test('run status is set to failed when ok=false', () => {
  const session = createSession('Run failed session');
  const { correlationId, runId } = makeRun(session.id);
  completeRunByCorrelation({ correlationId, ok: false, content: 'oops', rawPayload: null });
  const run = getRun(runId);
  assert.strictEqual(run.status, 'failed');
});

test('unknown correlationId returns false and changes nothing', () => {
  const session = createSession('Unknown corr session');
  const { assistantMessageId } = makeRun(session.id);
  const before = getMessage(assistantMessageId);

  const matched = completeRunByCorrelation({
    correlationId: 'no-such-correlation-id',
    ok: true,
    content: 'ghost',
    rawPayload: null,
  });

  assert.strictEqual(matched, false);
  const after = getMessage(assistantMessageId);
  assert.strictEqual(after.status, before.status); // unchanged
  assert.strictEqual(after.content, before.content);
});

test('duplicate callback is idempotent (second call returns false)', () => {
  const session = createSession('Dupe session');
  const { correlationId, assistantMessageId } = makeRun(session.id);

  completeRunByCorrelation({ correlationId, ok: true, content: 'first', rawPayload: null });
  const matched2 = completeRunByCorrelation({ correlationId, ok: true, content: 'second', rawPayload: null });

  assert.strictEqual(matched2, false);
  // Content should still be from the first completion
  const msg = getMessage(assistantMessageId);
  assert.strictEqual(msg.content, 'first');
});

test('pending → timed out: failStaleRuns marks run as failed', () => {
  const session = createSession('Timeout session');
  const { runId, assistantMessageId } = makeRun(session.id);

  // 0 seconds threshold: any run with created_at <= now() is stale.
  const count = failStaleRuns(0);

  assert.ok(count >= 1);
  const run = getRun(runId);
  assert.strictEqual(run.status, 'failed');
  assert.strictEqual(run.error_message, 'no callback within timeout');

  const msg = getMessage(assistantMessageId);
  assert.strictEqual(msg.status, 'failed');
});

test('failStaleRuns with large threshold does not touch recent runs', () => {
  const session = createSession('Fresh session');
  const { runId } = makeRun(session.id);

  failStaleRuns(9999); // 9999 seconds in the future

  const run = getRun(runId);
  assert.strictEqual(run.status, 'pending'); // untouched
});

test('unrelated runs are unchanged after completeRunByCorrelation', () => {
  const session = createSession('Multi-run session');
  const run1 = makeRun(session.id);
  const run2 = makeRun(session.id);

  completeRunByCorrelation({ correlationId: run1.correlationId, ok: true, content: 'done', rawPayload: null });

  const run2State = getRun(run2.runId);
  assert.strictEqual(run2State.status, 'pending'); // unaffected
  const msg2 = getMessage(run2.assistantMessageId);
  assert.strictEqual(msg2.status, 'pending');
});

test('cascade: deleting a session removes its messages and runs', () => {
  const session = createSession('Cascade session');
  const { runId, assistantMessageId } = makeRun(session.id);

  deleteSession(session.id);

  assert.strictEqual(getSession(session.id), undefined);
  assert.strictEqual(getMessage(assistantMessageId), undefined);
  assert.strictEqual(getRun(runId), undefined);
});

test('cascade: other sessions remain after one is deleted', () => {
  const s1 = createSession('Keep me');
  const s2 = createSession('Delete me');

  deleteSession(s2.id);

  assert.ok(getSession(s1.id), 's1 should still exist');
  assert.strictEqual(getSession(s2.id), undefined);
});

test('listSessions returns newest-touched first (by updated_at)', () => {
  const s1 = createSession('Older touched');
  const s2 = createSession('Newer touched');
  // Touch s1 after s2 so s1 has the most recent updated_at.
  // SQLite datetime('now') has second-level granularity, so we set via raw SQL.
  db.prepare("UPDATE sessions SET updated_at = datetime('now', '+1 second') WHERE id = ?").run(s1.id);

  const sessions = listSessions();
  const ids = sessions.map((s) => s.id);
  // s1 was touched last so should appear first
  assert.ok(ids.indexOf(s1.id) < ids.indexOf(s2.id));
});
