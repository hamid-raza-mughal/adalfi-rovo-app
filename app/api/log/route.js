// POST /api/log — receives browser-side lifecycle events and writes them to server stdout.
// Only accepts a fixed allowlist of event names; all field filtering is done by logEvent.
// This endpoint is local-only; no auth token is required because it writes no data and
// carries no side effects — a rejected or ignored call is harmless.
import { logEvent } from "@/lib/instrumentation";

export const runtime = "nodejs";

const VALID_CLIENT_EVENTS = new Set([
  'client_prompt_submitted',
  'client_completion_detected',
  'response_rendered',
  'client_poll_failed',
]);

export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || !VALID_CLIENT_EVENTS.has(body.event)) {
      return Response.json({ ok: false }, { status: 400 });
    }
    logEvent(body.event, {
      clientRequestId: body.clientRequestId,
      correlationId: body.correlationId,
      sessionId: body.sessionId,
      messageId: body.messageId,
      durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
      durationFrom: typeof body.durationFrom === 'string' ? body.durationFrom : undefined,
      status: body.status,
      source: 'browser',
      promptLength: typeof body.promptLength === 'number' ? body.promptLength : undefined,
      // Preserve the browser-generated timestamp so the server log reflects when the
      // event actually occurred, not when this HTTP request arrived.
      timestamp: typeof body.timestamp === 'string' ? body.timestamp : undefined,
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
