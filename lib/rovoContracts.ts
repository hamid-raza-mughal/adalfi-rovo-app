// lib/rovoContracts.ts
// Shared compile-time contracts and runtime validation for the Rovo request/callback
// lifecycle. The callback body is the highest-risk trust boundary in this app: it arrives
// over the public internet via the Cloudflare tunnel, authenticated only by a shared-secret
// header, before any of this runs. It is therefore never typed via a bare assertion — it
// stays `unknown` until parseRovoCallbackBody narrows it.

import { isRecord } from "@/lib/validation";

/** Body this app sends TO Rovo's Incoming webhook (see lib/rovo.ts -> fireRovo). */
export interface FireRovoPayload {
  sessionId: string;
  correlationId: string;
  prompt: string;
  callbackUrl: string;
}

/** Validated, narrowed shape of an inbound Rovo callback body, produced only by
 *  parseRovoCallbackBody below - never constructed directly from a raw request body. */
export interface ParsedRovoCallback {
  correlationId: string;
  /** Derived from the raw `status` field: `(status ?? "ok") === "ok"`. Any other value,
   *  of any type, yields false - this mirrors the route's pre-existing behaviour exactly. */
  ok: boolean;
  /** Defaults to "" when the raw `content` field is absent or not a string. */
  content: string;
}

/** Shared result convention for every runtime validator introduced in this migration.
 *  A `false` result carries a `reason` suitable for direct use as an API error message -
 *  it is never a thrown exception, since malformed external input is an expected case,
 *  not a programmer error. */
export type ParseResult<T> = { valid: true; data: T } | { valid: false; reason: string };

/**
 * Validates a raw, untrusted Rovo callback body - already JSON.parse'd by the route, or
 * `null` if parsing failed. `correlationId` is the only field whose absence or wrong type
 * changes the route's response (400 "correlationId required"); `status` and `content` are
 * optional on the wire and degrade to the same defaults the route already applied inline
 * before this validator existed, so a successful callback behaves identically to before.
 *
 * Correction (documented, not silent): a `correlationId` that is present but not a
 * non-empty string is now rejected the same way a missing one always was. Previously this
 * field was only checked for truthiness (`!body?.correlationId`), so a present-but-wrong-type
 * value (e.g. a JSON number) would fall through to the database lookup and depend on
 * SQLite's TEXT-affinity coercion rather than the UUID string this app has always generated
 * and sent as `correlationId` in the first place. No existing test or documented flow relies
 * on a non-string correlationId being accepted, so this closes a latent gap rather than
 * changing any exercised behaviour.
 */
export function parseRovoCallbackBody(raw: unknown): ParseResult<ParsedRovoCallback> {
  const body = isRecord(raw) ? raw : {};

  const correlationId = body.correlationId;
  if (typeof correlationId !== "string" || correlationId.length === 0) {
    return { valid: false, reason: "correlationId required" };
  }

  // Neither field is type-checked beyond this: an arbitrary `status` (any type, any value
  // other than the exact string "ok") must still collapse to ok:false, and a non-string
  // `content` must still default to "" rather than being rejected - both preserved exactly.
  const ok = (body.status ?? "ok") === "ok";
  const content = typeof body.content === "string" ? body.content : "";

  return { valid: true, data: { correlationId, ok, content } };
}
