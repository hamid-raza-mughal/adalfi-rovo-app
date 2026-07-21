# Architecture State — Baseline v0.1.0

This document captures the architecture of the working local baseline as of the first Git commit. It is a snapshot, not a roadmap.

---

## Request flow

```
User (browser)
  │
  │  POST /api/sessions/:id/messages  (sends prompt + correlationId + callbackUrl)
  ▼
Next.js API Route  ──►  Rovo Incoming Webhook
                                │
                                │  Rovo Studio automation runs:
                                │    1. Incoming webhook trigger receives the payload
                                │    2. "Use Rovo Agent" action runs the agent
                                │    3. "Create variable" saves agentResponse.asString
                                │    4. "Send web request" POSTs the reply to callbackUrl
                                │
  ◄───────────────────  POST /api/webhook/callback
  │
  │  Validates X-Callback-Token, matches correlationId, writes reply to SQLite
  │
Browser (polling GET /api/sessions/:id/messages every 2.5 s)
  │
  ▼
Reply appears in the chat UI, rendered as Markdown
```

---

## Components

### Local Next.js application (App Router, port 3000)

- `app/page.js` — Chat UI: sidebar for sessions, message thread, composer. Polls the local database every 2.5 seconds for new replies.
- `app/api/sessions/**` — REST routes for listing, creating, opening, renaming, and deleting sessions.
- `app/api/sessions/[id]/messages` — `POST` saves the outbound message and fires the Rovo webhook. `GET` returns messages for the session and runs the watchdog timer.
- `app/api/webhook/callback` — Receives the Rovo `Send web request` POST. Validates the `X-Callback-Token` header, parses the JSON body, matches `correlationId`, and writes the reply to SQLite.

### SQLite persistence (`better-sqlite3`)

Three tables managed by `lib/db.js`:

- `sessions` — one row per conversation (id, title, timestamps).
- `messages` — all turns (role: user / assistant / system, content, status).
- `webhook_runs` — correlation tracking between the outbound webhook call and the inbound callback.

The database is created at runtime as `data/app.db` and is never committed.

### Rovo incoming webhook

`lib/rovo.js` fires a `POST` to `ROVO_WEBHOOK_URL` with:

- `X-Automation-Webhook-Token` — the webhook secret for inbound authentication.
- A JSON body containing `prompt`, `correlationId`, and `callbackUrl`.

### Cloudflare Quick Tunnel callback

`scripts/dev.mjs` spawns `cloudflared tunnel --url http://localhost:3000` alongside the Next.js dev server. It parses the tunnel's stderr output to capture the `*.trycloudflare.com` URL and writes it to `.runtime/public-url.json`.

`lib/publicUrl.js` reads this file to resolve the callback URL. Because the URL is captured automatically at startup, the Rovo flow's `Send web request` target is always current — no manual edit needed when the Quick Tunnel URL changes on restart.

### Automatic tunnel URL capture

The public URL capture is the mechanism that makes the Quick Tunnel practical: Rovo (running in Atlassian's cloud) must POST back to a publicly reachable address. Because the Quick Tunnel URL is random and changes on every restart, the app captures and caches it so neither the user nor the Rovo flow configuration needs to be updated manually.

### Markdown rendering

`app/page.js` renders assistant replies using `react-markdown` with `remark-gfm`, supporting tables, lists, headings, fenced code blocks, and inline links (links open in a new tab). User messages are rendered as plain text.

### Polling-based response retrieval

The UI polls `GET /api/sessions/:id/messages` every 2.5 seconds. Each poll also runs the watchdog: if a message has been in `pending` status for longer than `PHASE_TIMEOUT_SECONDS` (default 180 s) without a callback arriving, it is marked as failed.

---

## Lifecycle instrumentation (Phase 1, Chunk 1.1)

`lib/instrumentation.js` emits one structured JSON line per lifecycle stage. The same correlation ID (the pending assistant message's UUID) links every stage from server receipt through client render.

### Event names and timing

| Event | Where | Duration measured |
|---|---|---|
| `client_prompt_submitted` | Browser — `send()` | — |
| `server_prompt_received` | Messages POST handler | — |
| `run_created` | After DB writes succeed | server receipt → run created |
| `rovo_request_started` | Before outgoing fetch | server receipt → request start |
| `rovo_request_acknowledged` | After Rovo returns 200 ACK | request start → acknowledgement |
| `rovo_request_failed` | Rovo fetch threw or non-200 | request start → failure |
| `callback_received` | Callback POST, after auth + parse | callback receipt → now |
| `callback_validated` | Auth and payload checks pass | callback receipt → validated |
| `database_update_completed` | After `completeRunByCorrelation` | validated → DB write done |
| `callback_rejected` | Auth check fails | callback receipt → rejection |
| `client_completion_detected` | Browser poll sees no pending message | `client_prompt_submitted` → now |
| `response_rendered` | React effect, after completed message renders | `client_prompt_submitted` → now |
| `client_poll_failed` | Browser fetch inside poll throws | — |

### How correlation IDs connect the trace

`correlationId` = `assistantMessage.id` (a UUID created at message submission time). It is written to `webhook_runs.correlation_id`, sent to Rovo as part of the request payload, and returned to the browser in the POST response. Every log entry that has this ID at the time it fires includes it:

```
server_prompt_received  (no ID yet — assigned moments later)
run_created             correlationId=<uuid>
rovo_request_started    correlationId=<uuid>
rovo_request_acknowledged correlationId=<uuid>
callback_received       correlationId=<uuid>   ← Rovo sends it back
callback_validated      correlationId=<uuid>
database_update_completed correlationId=<uuid>
client_completion_detected correlationId=<uuid>
response_rendered       correlationId=<uuid>
```

### What is deliberately excluded from logs

- Rovo webhook URLs and outgoing callback URLs
- `X-Automation-Webhook-Token` and `X-Callback-Token` values
- `ROVO_WEBHOOK_URL`, `ROVO_WEBHOOK_SECRET`, `CALLBACK_SHARED_SECRET` env values
- Full user prompt text (only `promptLength` character count)
- Full Rovo response content (only `contentLength` and `contentPresent` flag)
- Stack traces, database file paths, raw request/response payloads
- Any Confluence or Jira content from the agent's reply

The `logEvent` function enforces this via a whitelist of allowed field names; any field not in the whitelist is silently dropped before serialization.

### Capturing logs during manual testing

Both server-side and browser-side events end up on the Next.js process's stdout. Run:

```bash
npm run dev 2>&1 | grep '{"event"'
```

Or pipe the full output and filter on the shell. Browser events are forwarded to `POST /api/log` (fire-and-forget) so they also appear on the server stdout in addition to the browser console.

To trace one complete request, copy the `correlationId` from any event and grep:

```bash
npm run dev 2>&1 | grep <correlationId>
```

---

## Current limitations (documented — not immediate tasks)

| Limitation | Detail |
|---|---|
| **Single-user, local only** | The app binds to localhost and has no multi-user model. Sharing state between users is not supported. |
| **SQLite** | SQLite is appropriate for a single-user local tool. It does not support concurrent writes from multiple processes and is not suitable for a deployed, multi-user service without replacement. |
| **No authentication** | There is no login, session token, or access control. Anyone who can reach the local port can read and write all conversations. |
| **Polling rather than real-time delivery** | Replies appear within ~2.5 s of the callback arriving. A WebSocket or Server-Sent Events connection would eliminate the polling delay and reduce unnecessary API calls. |
| **No structured artifact model** | Rovo's reply is stored and displayed as a single Markdown string. There is no structured representation of embedded data (tables, code, citations) beyond what Markdown conveys. |
| **Quick Tunnel URL changes on restart** | Using a named Cloudflare tunnel with a fixed hostname avoids this. Instructions are in the README and `.env.local.example`. |
