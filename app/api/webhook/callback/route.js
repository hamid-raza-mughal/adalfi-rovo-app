// POST /api/webhook/callback
// Rovo's "Send web request" step calls this when the agent has produced an answer.
// Body: { correlationId, status, content }
//
// `content` must be built in the Rovo flow as:  {{agentText.jsonEncode}}
// where `agentText` is a "Create variable" step holding {{agentResponse.asString}}.
// Two Rovo/Jira Automation quirks make this the only reliable path:
//   1. Chaining any function directly onto {{agentResponse}} (not a variable) silently
//      returns empty - a known Atlassian bug (AUTO-1897 / AUTO-1873). Save it to a
//      variable first, then operate on the variable.
//   2. The raw markdown often contains quotes/newlines that break a JSON string if
//      embedded unescaped. `jsonEncode` (a real, documented Automation smart-value
//      function) escapes exactly what JSON needs, so JSON.parse below already returns
//      plain, readable text on the intended path - no decode step needed for it.
// `base64Encode` is NOT a real smart-value function in Jira/Rovo Automation's text-field
// set - it silently resolves to empty rather than erroring. Don't use it.
//
// Fallback: if a flow edit ever sends `content` through urlEncode, htmlEncode, or xmlEncode
// instead, it arrives encoded rather than plain - "%3D%3D%3D+P0+COLD..." for urlEncode, or
// "&amp;"-style entities for htmlEncode/xmlEncode. decodeAgentText (lib/textDecode.v2.js)
// inspects the content and picks whichever decoder matches; it's a no-op on the intended
// jsonEncode path, where none of those signatures appear.
import { completeRunByCorrelation, getRunByCorrelation } from "@/lib/db";
import { decodeAgentText } from "@/lib/textDecode.v2";
import { logEvent } from "@/lib/instrumentation";

export const runtime = "nodejs";

export async function POST(request) {
  const callbackReceivedAt = Date.now();

  // Emit callback_received immediately — this is the reference timestamp for all
  // subsequent callback-side durations. No correlationId is available yet because
  // the body has not been parsed.
  logEvent('callback_received', {});

  // 1) authenticate the caller with the shared secret (this endpoint is internet-facing)
  const token = request.headers.get("x-callback-token");
  if (!token || token !== process.env.CALLBACK_SHARED_SECRET) {
    logEvent('callback_rejected', {
      durationMs: Date.now() - callbackReceivedAt,
      durationFrom: 'callback_received',
      status: 'failed',
      httpStatus: 401,
    });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // 2) parse
  const body = await request.json().catch(() => null);
  if (!body?.correlationId) {
    return Response.json({ error: "correlationId required" }, { status: 400 });
  }

  // Look up the run to surface sessionId, runId, and messageId in subsequent log entries.
  // correlationId = assistantMessage.id, so messageId is the same value — named separately
  // for log readability. The run may not exist for unknown/duplicate correlationIds.
  const run = getRunByCorrelation(body.correlationId);
  const sessionId = run?.session_id;
  const runId = run?.id;
  const messageId = run?.assistant_message_id;

  const validatedAt = Date.now();
  logEvent('callback_validated', {
    correlationId: body.correlationId,
    sessionId,
    runId,
    messageId,
    durationMs: validatedAt - callbackReceivedAt,
    durationFrom: 'callback_received',
    status: 'success',
    contentPresent: typeof body.content === 'string' && body.content.length > 0,
    contentLength: typeof body.content === 'string' ? body.content.length : 0,
  });

  // 3) the answer. jsonEncode on the Rovo side means this is normally already plain,
  // readable text - JSON.parse() above has already unescaped the quotes/newlines jsonEncode
  // added. decodeAgentText is the fallback for the urlEncode/htmlEncode/xmlEncode case above.
  const rawContent = typeof body.content === "string" ? body.content : "";
  const content = decodeAgentText(rawContent);
  const ok = (body.status ?? "ok") === "ok";

  // 4) fill the pending reply (idempotent: unknown/duplicate correlationId -> matched:false, harmless)
  const matched = completeRunByCorrelation({
    correlationId: body.correlationId,
    ok,
    content,
    rawPayload: JSON.stringify(body).slice(0, 5000),
  });

  logEvent('database_update_completed', {
    correlationId: body.correlationId,
    sessionId,
    runId,
    messageId,
    durationMs: Date.now() - validatedAt,
    durationFrom: 'callback_validated',
    status: 'success',
    matched,
  });

  return Response.json({ ok: true, matched });
}
