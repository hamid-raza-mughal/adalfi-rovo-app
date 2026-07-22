// lib/sessionEvents.ts
// Process-local, session-scoped Server-Sent Events transport foundation.
//
// Phase 3.1 scope: this module is the pub/sub mechanism only. Nothing in this codebase
// calls `publish` yet - the callback route (app/api/webhook/callback/route.ts) still only
// writes to SQLite, and the browser still polls (app/page.tsx). Phase 3.2 wires those
// together; this module exists so that wiring has a typed, tested contract to call into.
//
// Deliberately minimal: no database access, and no general-purpose event-bus abstraction
// (no wildcard subscriptions, no event history/replay, no cross-session broadcast) - just
// enough for one session's SSE route to notify that session's own subscribers.

/**
 * The only events this transport carries. No message content, role, or id travels over
 * the wire - SQLite remains the authoritative source of message content (see lib/db.ts).
 * `connected` confirms the transport is live; `message` signals "this session's messages
 * changed, go re-fetch" without saying what changed.
 */
export type SessionEvent = { type: "connected" } | { type: "message" };

type Subscriber = (event: SessionEvent) => void;

// Next.js dev-mode hot-reload re-imports modules, which would otherwise reset this Map on
// every save (any subscriber connected before the reload would be orphaned in a registry no
// route could reach anymore). Caching on globalThis survives that reload, exactly as
// lib/db.ts's __adalfiDb singleton already does for the database connection.
declare global {
  // eslint-disable-next-line no-var
  var __adalfiSessionSubscribers: Map<string, Set<Subscriber>> | undefined;
}

const registry: Map<string, Set<Subscriber>> =
  globalThis.__adalfiSessionSubscribers ?? (globalThis.__adalfiSessionSubscribers = new Map());

/**
 * Registers `subscriber` for `sessionId`'s events and returns a matching unsubscribe
 * function. Returning the unsubscribe function - rather than requiring callers to hold onto
 * `subscriber` and call `unsubscribe` separately - means a route's cleanup path can never
 * accidentally unsubscribe the wrong callback.
 */
export function subscribe(sessionId: string, subscriber: Subscriber): () => void {
  let set = registry.get(sessionId);
  if (!set) {
    set = new Set();
    registry.set(sessionId, set);
  }
  set.add(subscriber);
  return () => unsubscribe(sessionId, subscriber);
}

/**
 * Removes `subscriber` from `sessionId`'s set. Idempotent: an unknown session, an unknown
 * subscriber, or a second call for one already removed are all safe no-ops - a route's
 * abort listener and its stream-cancel path can both call this without coordinating which
 * one runs first.
 */
export function unsubscribe(sessionId: string, subscriber: Subscriber): void {
  const set = registry.get(sessionId);
  if (!set) return;
  set.delete(subscriber);
  if (set.size === 0) registry.delete(sessionId);
}

/**
 * Delivers `event` to every current subscriber of `sessionId`. Sessions are fully
 * isolated: subscribers of any other session never see it. A no-op if `sessionId` has no
 * open connections (nothing has subscribed, or all of them already disconnected).
 */
export function publish(sessionId: string, event: SessionEvent): void {
  const set = registry.get(sessionId);
  if (!set) return;
  for (const subscriber of set) subscriber(event);
}

/**
 * Test-only inspection helper: the number of live subscribers for `sessionId`. Not used by
 * any route - exists so tests can assert that cleanup actually ran (subscriber count back
 * to 0) without reaching into this module's private registry.
 */
export function subscriberCount(sessionId: string): number {
  return registry.get(sessionId)?.size ?? 0;
}
