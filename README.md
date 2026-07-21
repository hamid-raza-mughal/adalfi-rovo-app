# AdalFi Rovo App

A local Next.js interface that sends requests to Atlassian Rovo and receives responses through a Cloudflare callback tunnel.

**Status:** Working local baseline — early alpha.

---

## Stack

- **Next.js 14** (App Router)
- **React 18**
- **SQLite** via `better-sqlite3`
- **`react-markdown`** + **`remark-gfm`** for Markdown rendering
- **Atlassian Rovo** webhook automation (Incoming webhook + Send web request)
- **Cloudflare Quick Tunnel** for exposing the local callback endpoint to Rovo

---

## Prerequisites

- **Node.js 18.17 or later** — check with `node -v`; install from <https://nodejs.org> or `brew install node`.
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
