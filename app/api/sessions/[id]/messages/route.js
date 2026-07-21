// GET  /api/sessions/:id/messages  -> messages for this session (the UI polls this). Runs the watchdog first.
// POST /api/sessions/:id/messages  -> save the user message + a pending assistant message, then fire Rovo.
//                                     Returns immediately; the answer arrives later via /api/webhook/callback.
import {
  getSession,
  getMessages,
  addMessage,
  createRun,
  touchSession,
  failStaleRuns,
  completeRunByCorrelation,
} from "@/lib/db";
import { fireRovo } from "@/lib/rovo";
import { getPublicBaseUrl, isLocalHost, TUNNEL_NOT_READY } from "@/lib/publicUrl";
import { decodeAgentText } from "@/lib/textDecode.v2";

export const runtime = "nodejs";

const TIMEOUT = Number(process.env.PHASE_TIMEOUT_SECONDS || 180);

export async function GET(request, { params }) {
  failStaleRuns(TIMEOUT); // mark any pending run that never got a callback as failed
  const session = getSession(params.id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  // The callback route already decodes on the way in; this decode (same dispatcher - handles
  // urlEncode and htmlEncode/xmlEncode) is what makes any row stored before that fix, or by
  // some other future path, render clean too - no migration needed.
  const messages = getMessages(params.id).map((m) => ({ ...m, content: decodeAgentText(m.content) }));
  return Response.json({ messages });
}

export async function POST(request, { params }) {
  const session = getSession(params.id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const content = (body?.content || "").trim();
  if (!content) return Response.json({ error: "content required" }, { status: 400 });

  // 1) save the user message (done) and a pending assistant placeholder
  const userMessage = addMessage({ sessionId: params.id, role: "user", content, status: "completed" });
  const assistantMessage = addMessage({ sessionId: params.id, role: "assistant", content: "", status: "pending" });

  // 2) correlation id = the pending assistant message id (what the callback matches on)
  const correlationId = assistantMessage.id;
  // Resolve the public callback URL (env override → runtime file → request headers).
  const baseUrl = getPublicBaseUrl(request);
  if (baseUrl === TUNNEL_NOT_READY) {
    return Response.json(
      { error: "The public callback tunnel is still starting. Please try again in a moment." },
      { status: 503 }
    );
  }
  if (isLocalHost(baseUrl)) {
    console.warn(
      "[orchestrator] Callback URL resolved to localhost - Rovo cannot reach it. " +
        "Open the app via your tunnel URL (not localhost), or set PUBLIC_BASE_URL in .env.local."
    );
  }
  const callbackUrl = `${baseUrl}/api/webhook/callback`;
  const payload = { sessionId: params.id, correlationId, prompt: content, callbackUrl };

  createRun({
    sessionId: params.id,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    correlationId,
    webhookUrl: process.env.ROVO_WEBHOOK_URL || "",
    requestPayload: JSON.stringify(payload),
  });
  touchSession(params.id);

  // 3) fire the webhook. A 200 is only an ACK - do NOT wait for the answer here.
  try {
    await fireRovo(payload);
  } catch (err) {
    // Could not even reach Rovo -> fail this turn now so the UI shows an error instead of spinning.
    completeRunByCorrelation({
      correlationId,
      ok: false,
      content: `Could not reach the agent: ${err.message}`,
      rawPayload: String(err),
    });
    const messages = getMessages(params.id);
    return Response.json(
      { userMessage, assistantMessage: messages.find((m) => m.id === assistantMessage.id), error: err.message },
      { status: 200 }
    );
  }

  return Response.json({ userMessage, assistantMessage });
}
