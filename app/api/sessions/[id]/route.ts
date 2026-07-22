// GET    /api/sessions/:id  -> return the session and its current messages
// PATCH  /api/sessions/:id  -> rename / update the session (title only)
// DELETE /api/sessions/:id  -> delete the session and all associated records

import { getSession, getMessages, renameSession, deleteSession } from "@/lib/db";
import { isRecord } from "@/lib/validation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  const messages = getMessages(id);
  return Response.json({ session, messages });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  // isRecord guard is a correction, not just a type-narrowing formality: a valid-JSON but
  // non-object body (e.g. a bare number or string) previously reached the bare `"title" in
  // body` check and threw an uncaught TypeError ("in" requires an object operand) instead of
  // the same 400 this line already returns for an object body missing the field. No test or
  // documented flow relied on that crash - see the "invalid JSON body shape" test below.
  if (!isRecord(body) || !("title" in body)) {
    return Response.json({ error: "No supported fields provided" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return Response.json({ error: "Title must not be empty" }, { status: 400 });
  }
  if (title.length > 120) {
    return Response.json({ error: "Title must be 120 characters or fewer" }, { status: 400 });
  }

  try {
    const updated = renameSession(id, title);
    return Response.json({ session: updated });
  } catch {
    return Response.json({ error: "Failed to update session" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });

  try {
    deleteSession(id);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Failed to delete session" }, { status: 500 });
  }
}
