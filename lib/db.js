// lib/db.js
// SQLite data layer for the orchestrator. One file (data/app.db), three tables.
// better-sqlite3 is synchronous, which keeps this code simple to read.

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT 'New chat',
  external_ref TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_runs (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  correlation_id       TEXT NOT NULL,
  webhook_url          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  request_payload      TEXT,
  response_payload     TEXT,
  error_message        TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status      ON webhook_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_correlation ON webhook_runs(correlation_id);
`;

function createDb() {
  // SQLITE_DB_PATH env var allows tests to use a temp database instead of data/app.db.
  const dbPath = process.env.SQLITE_DB_PATH ?? path.join(process.cwd(), "data", "app.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

// Singleton: Next.js hot-reload re-imports modules in dev, which would otherwise open
// many connections. Cache the instance on globalThis so we reuse one connection.
const db = globalThis.__adalfiDb ?? (globalThis.__adalfiDb = createDb());
export default db;

// ---------- sessions ----------
export function listSessions() {
  return db
    .prepare(`SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC`)
    .all();
}

export function createSession(title = "New chat") {
  const id = randomUUID();
  db.prepare(`INSERT INTO sessions (id, title) VALUES (?, ?)`).run(id, title);
  return getSession(id);
}

export function getSession(id) {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
}

export function renameSession(id, title) {
  db.prepare(`UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(title, id);
  return getSession(id);
}

export function deleteSession(id) {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

export function touchSession(id) {
  db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(id);
}

// ---------- messages ----------
export function getMessages(sessionId) {
  return db
    .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`)
    .all(sessionId);
}

export function getMessage(id) {
  return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
}

export function addMessage({ sessionId, role, content = "", status = "completed" }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, status) VALUES (?, ?, ?, ?, ?)`
  ).run(id, sessionId, role, content, status);
  return getMessage(id);
}

// ---------- webhook runs ----------
export function createRun({
  sessionId,
  userMessageId,
  assistantMessageId,
  correlationId,
  webhookUrl,
  requestPayload,
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO webhook_runs
       (id, session_id, user_message_id, assistant_message_id, correlation_id, webhook_url, request_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, sessionId, userMessageId, assistantMessageId, correlationId, webhookUrl, requestPayload);
  return id;
}

// Fill a pending reply when the callback arrives. Idempotent: if no pending run matches
// (unknown id, or already completed by an earlier/duplicate callback), returns false and does nothing.
export function completeRunByCorrelation({ correlationId, ok, content, rawPayload }) {
  const run = db
    .prepare(`SELECT * FROM webhook_runs WHERE correlation_id = ? AND status = 'pending'`)
    .get(correlationId);
  if (!run) return false;

  const tx = db.transaction(() => {
    db.prepare(`UPDATE messages SET content = ?, status = ? WHERE id = ?`).run(
      content,
      ok ? "completed" : "failed",
      run.assistant_message_id
    );
    db.prepare(
      `UPDATE webhook_runs
         SET status = ?, response_payload = ?, error_message = ?, completed_at = datetime('now')
       WHERE id = ?`
    ).run(ok ? "completed" : "failed", rawPayload ?? null, ok ? null : content || "agent error", run.id);
    db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(run.session_id);
  });
  tx();
  return true;
}

// Watchdog: any pending run older than `timeoutSeconds` is marked failed, so a lost
// callback can never leave the UI spinning forever.
export function failStaleRuns(timeoutSeconds) {
  const stale = db
    .prepare(`SELECT * FROM webhook_runs WHERE status = 'pending' AND created_at <= datetime('now', ?)`)
    .all(`-${Number(timeoutSeconds)} seconds`);

  const tx = db.transaction(() => {
    for (const run of stale) {
      db.prepare(
        `UPDATE messages
           SET status = 'failed',
               content = CASE WHEN content = '' THEN 'No response from the agent within the time limit.' ELSE content END
         WHERE id = ? AND status = 'pending'`
      ).run(run.assistant_message_id);
      db.prepare(
        `UPDATE webhook_runs
           SET status = 'failed', error_message = 'no callback within timeout', completed_at = datetime('now')
         WHERE id = ?`
      ).run(run.id);
    }
  });
  tx();
  return stale.length;
}
