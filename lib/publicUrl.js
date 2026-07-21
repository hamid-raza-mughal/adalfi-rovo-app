// lib/publicUrl.js
// Resolve the app's public base URL for Rovo callbacks.
//
// Priority:
//   1. PUBLIC_BASE_URL env var  — use it verbatim (named tunnel or deployed URL).
//   2. .runtime/public-url.json — written by scripts/dev.mjs when the quick tunnel starts.
//      Lets the user open the app at http://localhost:3000 without losing the correct callback URL.
//   3. Request headers (x-forwarded-host / host) — works when the browser opened via the tunnel URL.
//
// TUNNEL_NOT_READY is returned (not thrown) when the runtime file is absent/malformed and the
// request came from localhost. Callers should surface a "try again in a moment" message.

import { readFileSync } from "node:fs";
import path from "node:path";

const PUBLIC_URL_FILE = path.join(process.cwd(), ".runtime", "public-url.json");

export const TUNNEL_NOT_READY = Symbol("TUNNEL_NOT_READY");

function readRuntimeUrl() {
  try {
    const raw = readFileSync(PUBLIC_URL_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const url = parsed?.url?.trim();
    return url || null;
  } catch {
    return null;
  }
}

export function getPublicBaseUrl(request) {
  // 1. Explicit override always wins.
  const envUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");

  // 2. Runtime file written by scripts/dev.mjs (quick-tunnel URL).
  const runtimeUrl = readRuntimeUrl();
  if (runtimeUrl) return runtimeUrl.replace(/\/+$/, "");

  // 3. Derive from incoming request headers.
  const h = request.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") || (host.includes("localhost") || host.startsWith("127.") ? "http" : "https");
  const derivedUrl = `${proto}://${host}`;

  // If we ended up with localhost and have no saved URL, the tunnel hasn't started yet.
  if (isLocalHost(derivedUrl)) return TUNNEL_NOT_READY;

  return derivedUrl;
}

export function isLocalHost(url) {
  return /localhost|127\.0\.0\.1/.test(String(url));
}
