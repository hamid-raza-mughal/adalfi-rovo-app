// GET /api/sessions/:id/events — Server-Sent Events transport for a single session.
//
// Phase 3.1 scope: transport foundation only. Nothing publishes a real application event
// yet - the callback route (app/api/webhook/callback/route.ts) and the browser polling
// client (app/page.tsx) are both untouched. This route exists so the transport itself -
// headers, the initial handshake, heartbeats, and subscriber cleanup - can be built and
// verified in isolation before Phase 3.2 wires a real event through it.
import { getSession } from "@/lib/db";
import { subscribe, type SessionEvent } from "@/lib/sessionEvents";

export const runtime = "nodejs";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;

// SSE_HEARTBEAT_MS env var lets tests use a short interval instead of waiting 15s for a
// real one to fire - the same testability pattern as SQLITE_DB_PATH (lib/db.ts) and
// RUNTIME_DIR (lib/publicUrl.ts). Read per-connection (not cached at module load) so a
// test can change it between requests without needing to re-import the route module.
function heartbeatIntervalMs(): number {
  const raw = Number(process.env.SSE_HEARTBEAT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HEARTBEAT_INTERVAL_MS;
}

function formatEvent(event: SessionEvent): string {
  return `event: ${event.type}\ndata: {}\n\n`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });

  const encoder = new TextEncoder();
  let cleanup: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Consumer already gone; cleanup() below finishes tearing this connection down.
        }
      };

      // Handshake: proves the transport is live before any application event can arrive.
      send(formatEvent({ type: "connected" }));

      // SSE comment (a line starting with ":") - ignored by EventSource, never dispatched
      // as an event. Keeps idle connections (and the Cloudflare tunnel in front of them)
      // from timing out, without ever creating an application-level message event.
      const heartbeatTimer = setInterval(() => send(": heartbeat\n\n"), heartbeatIntervalMs());

      const unsubscribeSession = subscribe(id, (event) => send(formatEvent(event)));

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeatTimer);
        unsubscribeSession();
        try {
          controller.close();
        } catch {
          // Already closed by the consumer side (request aborted / reader cancelled).
        }
      };

      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      // Consumer closed the stream (e.g. the browser navigated away) without the request
      // necessarily firing an "abort" event - route both paths through the same cleanup.
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
