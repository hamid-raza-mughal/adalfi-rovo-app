// GET  /api/sessions        -> list sessions for the sidebar
// POST /api/sessions        -> create a new session
import { listSessions, createSession } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ sessions: listSessions() });
}

export async function POST(request) {
  let title = "New chat";
  try {
    const body = await request.json();
    if (body?.title) title = String(body.title).slice(0, 120);
  } catch {
    // no body is fine - default title
  }
  return Response.json({ session: createSession(title) }, { status: 201 });
}
