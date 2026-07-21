# AdalFi Rovo App

A local Next.js interface that sends requests to Atlassian Rovo and receives responses through a Cloudflare callback tunnel.

**Status:** Working local baseline — early alpha.

---

## Stack

- **Next.js 16** (App Router)
- **React 18**
- **SQLite** via `better-sqlite3`
- **`react-markdown`** + **`remark-gfm`** for Markdown rendering
- **Atlassian Rovo** webhook automation (Incoming webhook + Send web request)
- **Cloudflare Quick Tunnel** for exposing the local callback endpoint to Rovo

---

## Prerequisites

- **Node.js 24.18.0 and npm 12.0.1** — the repository's standardized development environment.
  `package.json` declares `"engines": ">=24.15.0 <25"` and `"packageManager": "npm@12.0.1"`.
  npm 12 requires Node `^22.22.2 || ^24.15.0 || >=26.0.0`; Node 24 is the tested overlap.
  Next.js 16 itself only requires Node ≥ 20.9, but that lower bound is not sufficient here.

  Select Node 24.18.0 with **nvm**:
  ```bash
  nvm install 24.18.0
  nvm use            # reads .nvmrc automatically
  node -v            # v24.18.0
  npm --version      # 12.0.1  (npm 12 ships with Node 24)
  ```

  Or with **fnm**:
  ```bash
  fnm install 24.18.0
  fnm use
  node -v && npm --version
  ```

  The `packageManager` field documents the required npm version. It does not switch your
  active npm automatically — installing Node 24.18.0 is what puts npm 12 on your PATH.

- **cloudflared** on your PATH — `brew install cloudflared` or download the macOS binary from Cloudflare. `npm run dev` starts the tunnel automatically.
- A **Rovo Studio automation flow** with an Incoming webhook trigger and a Send web request action (see `docs/architecture-state.md` for the request flow).

---

## Installation

```bash
git clone https://github.com/hamid-raza-mughal/adalfi-rovo-app.git
cd adalfi-rovo-app
npm ci
```

---

## Environment variables

Copy the example file and fill in the values — never commit `.env.local`:

```bash
cp .env.local.example .env.local
```

Required variables (names only — never commit real values):

| Variable | Purpose |
|---|---|
| `ROVO_WEBHOOK_URL` | The Incoming webhook URL from your Rovo Studio flow |
| `ROVO_WEBHOOK_SECRET` | The Secret shown on the Incoming webhook trigger screen |
| `CALLBACK_SHARED_SECRET` | A long random string you invent; also set as `X-Callback-Token` in the Rovo Send web request action |

Optional variables:

| Variable | Purpose |
|---|---|
| `TUNNEL_NAME` | Set only when using a named (permanent) Cloudflare tunnel |
| `PUBLIC_BASE_URL` | Set only when using a named tunnel with a fixed hostname |
| `PHASE_TIMEOUT_SECONDS` | Seconds before a pending reply is marked failed (default: 180) |

---

## Development

```bash
npm run dev
```

Opens the Next.js app at <http://localhost:3000> and starts a Cloudflare Quick Tunnel. The tunnel's public URL is **captured automatically** and written to `.runtime/public-url.json`. The app reads this file to construct the callback URL it sends to Rovo — no manual copy/paste required, even when the Quick Tunnel URL changes on each restart.

---

## Project structure

```
adalfi-rovo-app/
├── app/
│   ├── api/
│   │   ├── sessions/           # Session list, create, rename, delete
│   │   │   └── [id]/
│   │   │       └── messages/   # Send message → fire Rovo; poll replies + watchdog
│   │   └── webhook/
│   │       └── callback/       # Receives Rovo's Send web request POST
│   ├── globals.css
│   ├── layout.js
│   └── page.js                 # Chat UI — sidebar, messages, composer, polling
├── lib/
│   ├── db.js                   # SQLite schema and queries
│   ├── publicUrl.js            # Resolves the app's public callback URL
│   ├── rovo.js                 # Fires the Rovo incoming webhook
│   └── textDecode.js           # Callback payload decode helpers
├── scripts/
│   └── dev.mjs                 # npm run dev launcher (Next.js + cloudflared)
├── data/                       # Runtime SQLite database (git-ignored)
├── .runtime/                   # Tunnel URL written here at runtime (git-ignored)
├── .env.local.example          # Template for required environment variables
├── cloudflared.config.example.yml
├── docs/
│   └── architecture-state.md  # Baseline architecture and known limitations
├── next.config.mjs
└── package.json
```

---

## Testing

```bash
npm test
```

The suite uses Node.js's built-in test runner (`node:test`) and built-in assertions — no extra testing framework is installed.

### What is covered

| Area | Tests |
|---|---|
| Public callback URL resolution | `PUBLIC_BASE_URL` priority, runtime file, request-host fallback, trailing-slash stripping, missing/malformed file, localhost → `TUNNEL_NOT_READY` |
| Rovo outgoing payload | Correct fields (sessionId, correlationId, prompt, callbackUrl), auth header, missing env vars throw, non-200 throws |
| Callback authentication | Valid/missing/wrong token, known/unknown/duplicate correlationId, error responses contain no secrets or stack traces |
| Database run transitions | `pending → completed`, `pending → failed`, `pending → timed out`, cascade deletes, duplicate idempotency |
| Session CRUD | Create, list, get, rename, empty-title rejection, 404 for missing, delete, cascade to messages and runs |
| Tunnel-not-ready guard | Returns 503, creates zero messages/runs, makes no Rovo call |
| Lifecycle instrumentation | Event shape (name, timestamp, correlationId), sensitive-field stripping (URL, secret, prompt, content, stack), logging failures do not throw, message and callback routes emit correct events, duration and matched fields are accurate |

### Isolation guarantees

- Each test file runs in its own child process with a fresh temporary SQLite database.
- Temporary databases and directories are cleaned up after every run.
- No live Rovo webhook or Cloudflare tunnel is required.
- No real secrets are used; test-only values are set per-process.
- The production `data/app.db` database is never read or written by tests.

---

## Security

The following must **never** be committed:

- `.env.local` — contains webhook URLs, webhook secrets, and the callback shared secret
- `data/*.db`, `data/*.db-wal`, `data/*.db-shm` — runtime SQLite database (may contain conversation history)
- `.runtime/` — tunnel state and captured public URL written at runtime
- `.next/` and `node_modules/` — build and dependency caches

All of these are listed in `.gitignore`.

---

## License

No open-source license has been selected yet. All rights reserved until further notice.
