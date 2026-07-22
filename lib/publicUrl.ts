// lib/publicUrl.ts
// Resolve the app's public base URL for Rovo callbacks, and validate the other small
// pieces of runtime configuration this app reads directly from the environment.
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
import { isRecord } from "@/lib/validation";

export const TUNNEL_NOT_READY = Symbol("TUNNEL_NOT_READY");

/** Well-formed check only - scheme and syntax, never a specific host. This is not an
 *  allowlist: any http/https host passes. Applied to the env-var and runtime-file tiers,
 *  both of which are developer/operator-set (not the untrusted request-header tier). */
function isWellFormedHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function readRuntimeUrl(): string | null {
  // RUNTIME_DIR env var allows tests to point at a temp directory instead of .runtime/.
  const runtimeDir = process.env.RUNTIME_DIR ?? path.join(process.cwd(), ".runtime");
  const publicUrlFile = path.join(runtimeDir, "public-url.json");
  try {
    const raw = readFileSync(publicUrlFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const url = isRecord(parsed) && typeof parsed.url === "string" ? parsed.url.trim() : "";
    return url && isWellFormedHttpUrl(url) ? url : null;
  } catch {
    return null;
  }
}

export function getPublicBaseUrl(request: Request): string | typeof TUNNEL_NOT_READY {
  // 1. Explicit override always wins.
  const envUrl = process.env.PUBLIC_BASE_URL?.trim();
  if (envUrl && isWellFormedHttpUrl(envUrl)) return envUrl.replace(/\/+$/, "");

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

export function isLocalHost(url: unknown): boolean {
  return /localhost|127\.0\.0\.1/.test(String(url));
}

const DEFAULT_PHASE_TIMEOUT_SECONDS = 180;

/**
 * Parses PHASE_TIMEOUT_SECONDS from its raw env-var string. Only a finite, non-negative
 * number is valid; anything else (missing, empty, non-numeric, NaN, +/-Infinity, negative)
 * falls back to the same 180-second default this app has always used.
 *
 * Correction (documented, not silent): the previous inline expression,
 * `Number(process.env.PHASE_TIMEOUT_SECONDS || 180)`, only treated a *falsy* raw value
 * (missing or "") as "use the default" - a non-numeric string (e.g. "abc") produced NaN,
 * and the literal string "Infinity" produced an actual Infinity, both of which flowed
 * straight into failStaleRuns's SQL modifier and silently broke the watchdog (SQLite's
 * datetime() cannot parse a NaN or Infinity offset, so it would match zero rows rather
 * than error). Zero is preserved as valid, matching how failStaleRuns(0) is already used
 * in tests to mean "everything currently pending is stale" - no test or documented flow
 * ever relied on a non-numeric or negative value doing anything in particular, so this
 * closes a latent gap rather than changing exercised behaviour.
 */
export function parsePhaseTimeoutSeconds(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PHASE_TIMEOUT_SECONDS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PHASE_TIMEOUT_SECONDS;
}
