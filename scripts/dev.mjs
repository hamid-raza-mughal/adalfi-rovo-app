// scripts/dev.mjs
// One command to run the app + a Cloudflare tunnel. Two modes, chosen by env (.env.local):
//
//   NAMED tunnel (custom, permanent URL) - set TUNNEL_NAME:
//     runs `cloudflared tunnel run <TUNNEL_NAME>` (needs one-time setup - see README).
//     The public address is your fixed PUBLIC_BASE_URL, e.g. https://adalfi-ux-kb.yourdomain.com
//
//   QUICK tunnel (no account, random URL) - leave TUNNEL_NAME unset:
//     runs `cloudflared tunnel --url http://localhost:3000`, detects the *.trycloudflare.com URL,
//     saves it to .runtime/public-url.json, and uses it automatically for Rovo callbacks.
//
// Requires `cloudflared` on your PATH:  brew install cloudflared

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(new URL(".", import.meta.url)));
const RUNTIME_DIR = path.join(ROOT, ".runtime");
const PUBLIC_URL_FILE = path.join(RUNTIME_DIR, "public-url.json");

// Minimal .env.local reader so THIS launcher can see TUNNEL_NAME / PUBLIC_BASE_URL (Next loads its own copy).
function loadEnv() {
  try {
    const text = readFileSync(path.join(ROOT, ".env.local"), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env.local yet - fine */
  }
}
loadEnv();

// Clear any stale tunnel URL from the previous run.
function clearRuntimeUrl() {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    rmSync(PUBLIC_URL_FILE, { force: true });
  } catch {}
}

function saveRuntimeUrl(url) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(PUBLIC_URL_FILE, JSON.stringify({ url, savedAt: new Date().toISOString() }), "utf8");
  } catch (err) {
    console.warn(`[dev] Could not write ${PUBLIC_URL_FILE}: ${err.message}`);
  }
}

const C = { cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" };
const procs = [];
let down = false;
const shutdown = () => {
  if (down) return;
  down = true;
  for (const p of procs) {
    try { p.kill(); } catch {}
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

clearRuntimeUrl();

// Next.js dev server
const next = spawn("npm", ["run", "dev:next"], { stdio: "inherit" });
procs.push(next);
next.on("exit", shutdown);

const TUNNEL_NAME = process.env.TUNNEL_NAME?.trim();
const PUBLIC = process.env.PUBLIC_BASE_URL?.trim();
const echo = (chunk) => process.stdout.write(`${C.dim}${chunk}${C.reset}`);

let tunnel;
if (TUNNEL_NAME) {
  // NAMED tunnel: fixed URL known from PUBLIC_BASE_URL.
  tunnel = spawn("cloudflared", ["tunnel", "run", TUNNEL_NAME], { stdio: ["ignore", "pipe", "pipe"] });
  const shown = PUBLIC || `https://${TUNNEL_NAME}.<your-domain>  (set PUBLIC_BASE_URL)`;
  if (PUBLIC) saveRuntimeUrl(PUBLIC);
  console.log(`\n${C.green}${C.bold}Local application:${C.reset}`);
  console.log(`  ${C.cyan}http://localhost:3000${C.reset}`);
  console.log(`\n${C.green}${C.bold}Public Rovo callback:${C.reset}`);
  console.log(`  ${C.cyan}${shown}/api/webhook/callback${C.reset}\n`);
  tunnel.stdout.on("data", echo);
  tunnel.stderr.on("data", echo);
} else {
  // QUICK tunnel: random URL - detect from cloudflared output, save to .runtime/public-url.json.
  tunnel = spawn("cloudflared", ["tunnel", "--url", "http://localhost:3000"], { stdio: ["ignore", "pipe", "pipe"] });
  let announced = false;
  const scan = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(`${C.dim}${text}${C.reset}`);
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m && !announced) {
      announced = true;
      const tunnelUrl = m[0];
      saveRuntimeUrl(tunnelUrl);
      console.log(`\n${C.green}${C.bold}Local application:${C.reset}`);
      console.log(`  ${C.cyan}http://localhost:3000${C.reset}`);
      console.log(`\n${C.green}${C.bold}Public Rovo callback:${C.reset}`);
      console.log(`  ${C.cyan}${tunnelUrl}/api/webhook/callback${C.reset}\n`);
    }
  };
  tunnel.stdout.on("data", scan);
  tunnel.stderr.on("data", scan);
}
procs.push(tunnel);

tunnel.on("error", (err) => {
  if (err.code === "ENOENT") {
    console.log(
      `\n${C.yellow}cloudflared not found.${C.reset} Install once:  brew install cloudflared\n` +
        `The app still runs at http://localhost:3000, but Rovo can't reach it without the tunnel.\n`
    );
  } else {
    console.log(`tunnel error: ${err.message}`);
  }
});
