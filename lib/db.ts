// lib/db.ts
// SQLite data layer for the orchestrator. One file (data/app.db), three tables.
// better-sqlite3 is synchronous, which keeps this code simple to read.

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

// Next.js hot-reload re-imports modules in dev, which would otherwise open many
// connections - the singleton below is cached on globalThis to reuse one connection.
declare global {
  // eslint-disable-next-line no-var
  var __adalfiDb: Database.Database | undefined;
}

// ---------------------------------------------------------------------------
// Shared lifecycle enum: messages.status and webhook_runs.status share the exact
// same CHECK constraint ('pending','completed','failed') - one type, not two.
// ---------------------------------------------------------------------------
export type LifecycleStatus = "pending" | "completed" | "failed";

// ---------------------------------------------------------------------------
// Row shapes: exactly what `SELECT *` returns for each table - raw column names
// and nullability, matching the CREATE TABLE statements below one-for-one. This
// schema has no separate persistence-vs-domain mapping layer (routes and the UI
// already consume these raw shapes directly), so there is deliberately no second
// "domain model" type duplicating the same fields under different names.
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  title: string;
  /** Always NULL today - no INSERT or UPDATE ever sets it. Kept nullable/typed
   *  honestly rather than assumed-absent, since `SELECT *` can still return it. */
  external_ref: string | null;
  created_at: string;
  updated_at: string;
}

/** listSessions() selects a narrower column set than `SELECT *` - a distinct
 *  query-result shape, not the full SessionRow (no external_ref). */
export interface SessionListItem {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: LifecycleStatus;
  created_at: string;
}

export interface WebhookRunRow {
  id: string;
  session_id: string;
  user_message_id: string;
  assistant_message_id: string;
  correlation_id: string;
  webhook_url: string;
  status: LifecycleStatus;
  /** Serialized JSON (JSON.stringify'd request payload). Opaque: no code in this
   *  app ever JSON.parses it back - it exists for manual/debug inspection only. */
  request_payload: string | null;
  /** Serialized JSON on success, or a plain error string on Rovo-unreachable
   *  failures (see completeRunByCorrelation). Equally opaque - never parsed back. */
  response_payload: string | null;
  error_message: string | null;
  created_at: string;
  /** NULL until the run completes or times out. */
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Insert / update input shapes: distinct from the row shapes above - camelCase,
// and omit whatever the database generates or defaults (id, timestamps, status
// transitions). These mirror exactly what each function's callers already pass;
// optional fields match the JS default values that existed before this file was
// typed, so no calling behaviour changes.
// ---------------------------------------------------------------------------

export interface AddMessageInput {
  sessionId: string;
  role: "user" | "assistant" | "system";
  content?: string;
  status?: LifecycleStatus;
}

export interface CreateRunInput {
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  correlationId: string;
  webhookUrl: string;
  requestPayload: string;
}

/** completeRunByCorrelation's input is domain-shaped, not row-shaped: callers pass
 *  a boolean `ok`, mapped internally to the same 'completed'/'failed' status string
 *  used everywhere else - preserving that mapping exactly, not introducing a new one. */
export interface CompleteRunInput {
  correlationId: string;
  ok: boolean;
  content: string;
  /** Nullable and optional: existing callers pass a JSON string, an error string,
   *  explicit null, or omit it entirely - the `?? null` below already normalizes
   *  all three to the same bound value, unchanged from the original code. */
  rawPayload?: string | null;
}

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

function createDb(): Database.Database {
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
export function listSessions(): SessionListItem[] {
  return db
    .prepare<[], SessionListItem>(`SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC`)
    .all();
}

export function createSession(title: string = "New chat"): SessionRow {
  const id = randomUUID();
  db.prepare<[string, string]>(`INSERT INTO sessions (id, title) VALUES (?, ?)`).run(id, title);
  // Just inserted, in this synchronous, single-connection database - the row is
  // guaranteed to exist. getSession's `| undefined` return is for the general lookup
  // case (an arbitrary id that may not exist); this call site is not that case.
  return getSession(id) as SessionRow;
}

export function getSession(id: string): SessionRow | undefined {
  return db.prepare<[string], SessionRow>(`SELECT * FROM sessions WHERE id = ?`).get(id);
}

export function renameSession(id: string, title: string): SessionRow | undefined {
  db.prepare<[string, string]>(`UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(
    title,
    id
  );
  return getSession(id);
}

export function deleteSession(id: string): void {
  db.prepare<[string]>(`DELETE FROM sessions WHERE id = ?`).run(id);
}

export function touchSession(id: string): void {
  db.prepare<[string]>(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(id);
}

// ---------- messages ----------
export function getMessages(sessionId: string): MessageRow[] {
  return db
    .prepare<[string], MessageRow>(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`)
    .all(sessionId);
}

export function getMessage(id: string): MessageRow | undefined {
  return db.prepare<[string], MessageRow>(`SELECT * FROM messages WHERE id = ?`).get(id);
}

export function addMessage({ sessionId, role, content = "", status = "completed" }: AddMessageInput): MessageRow {
  const id = randomUUID();
  db.prepare<[string, string, string, string, string]>(
    `INSERT INTO messages (id, session_id, role, content, status) VALUES (?, ?, ?, ?, ?)`
  ).run(id, sessionId, role, content, status);
  // Just inserted, same invariant as createSession above.
  return getMessage(id) as MessageRow;
}

// ---------- webhook runs ----------
export function createRun({
  sessionId,
  userMessageId,
  assistantMessageId,
  correlationId,
  webhookUrl,
  requestPayload,
}: CreateRunInput): string {
  const id = randomUUID();
  db.prepare<[string, string, string, string, string, string, string]>(
    `INSERT INTO webhook_runs
       (id, session_id, user_message_id, assistant_message_id, correlation_id, webhook_url, request_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, sessionId, userMessageId, assistantMessageId, correlationId, webhookUrl, requestPayload);
  return id;
}

// Look up a run by correlationId regardless of status — for instrumentation only.
// Returns undefined if no run matches (unknown correlationId).
export function getRunByCorrelation(correlationId: string): WebhookRunRow | undefined {
  return db.prepare<[string], WebhookRunRow>(`SELECT * FROM webhook_runs WHERE correlation_id = ? LIMIT 1`).get(
    correlationId
  );
}

// Fill a pending reply when the callback arrives. Idempotent: if no pending run matches
// (unknown id, or already completed by an earlier/duplicate callback), returns false and does nothing.
export function completeRunByCorrelation({ correlationId, ok, content, rawPayload }: CompleteRunInput): boolean {
  const run = db
    .prepare<[string], WebhookRunRow>(`SELECT * FROM webhook_runs WHERE correlation_id = ? AND status = 'pending'`)
    .get(correlationId);
  if (!run) return false;

  const tx = db.transaction(() => {
    db.prepare<[string, string, string]>(`UPDATE messages SET content = ?, status = ? WHERE id = ?`).run(
      content,
      ok ? "completed" : "failed",
      run.assistant_message_id
    );
    db.prepare<[string, string | null, string | null, string]>(
      `UPDATE webhook_runs
         SET status = ?, response_payload = ?, error_message = ?, completed_at = datetime('now')
       WHERE id = ?`
    ).run(ok ? "completed" : "failed", rawPayload ?? null, ok ? null : content || "agent error", run.id);
    db.prepare<[string]>(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(run.session_id);
  });
  tx();
  return true;
}

// Watchdog: any pending run older than `timeoutSeconds` is marked failed, so a lost
// callback can never leave the UI spinning forever.
export function failStaleRuns(timeoutSeconds: number): number {
  const stale = db
    .prepare<[string], WebhookRunRow>(
      `SELECT * FROM webhook_runs WHERE status = 'pending' AND created_at <= datetime('now', ?)`
    )
    .all(`-${Number(timeoutSeconds)} seconds`);

  const tx = db.transaction(() => {
    for (const run of stale) {
      db.prepare<[string]>(
        `UPDATE messages
           SET status = 'failed',
               content = CASE WHEN content = '' THEN 'No response from the agent within the time limit.' ELSE content END
         WHERE id = ? AND status = 'pending'`
      ).run(run.assistant_message_id);
      db.prepare<[string]>(
        `UPDATE webhook_runs
           SET status = 'failed', error_message = 'no callback within timeout', completed_at = datetime('now')
         WHERE id = ?`
      ).run(run.id);
    }
  });
  tx();
  return stale.length;
}
