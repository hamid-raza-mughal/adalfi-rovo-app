"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// ---------------------------------------------------------------------------
// Client-safe models. Deliberately local (not imported from lib/db.ts): this
// file is "use client" and must never pull in a module reachable from
// better-sqlite3. These mirror only the fields this UI actually reads from
// the wire - not the full server row shape.
// ---------------------------------------------------------------------------
interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

type MessageRole = "user" | "assistant" | "system";
type MessageStatus = "pending" | "completed" | "failed";

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Lightweight local narrowing for network responses. Not a schema library:
// each check is a shallow, single-purpose guard for exactly the field this
// file touches, matching the same-origin, self-typed API this page talks to.
// ---------------------------------------------------------------------------
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "user" || value.role === "assistant" || value.role === "system") &&
    typeof value.content === "string" &&
    (value.status === "pending" || value.status === "completed" || value.status === "failed") &&
    typeof value.created_at === "string"
  );
}

function isSession(value: unknown): value is Session {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.title === "string" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function toSessionList(value: unknown): Session[] {
  return Array.isArray(value) ? value : [];
}

function toMessageList(value: unknown): Message[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Client-side lifecycle instrumentation
// Logs a structured JSON event to the browser console and forwards it to the
// server's /api/log endpoint so one unified trace appears on stdout.
// Never throws; never logs prompt/response content, secrets, or URLs.
// ---------------------------------------------------------------------------
interface ClientEventMeta {
  clientRequestId?: string | null;
  correlationId?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
  durationMs?: number;
  durationFrom?: string;
  status?: string;
  promptLength?: number;
}

interface ClientLogEntry {
  event: string;
  timestamp: string;
  source: "browser";
  clientRequestId?: string | null;
  correlationId?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
  durationMs?: number;
  durationFrom?: string;
  status?: string;
  promptLength?: number;
}

function logClientEvent(event: string, meta: ClientEventMeta = {}): void {
  try {
    const entry: ClientLogEntry = { event, timestamp: new Date().toISOString(), source: 'browser' };
    if (meta.clientRequestId !== undefined) entry.clientRequestId = meta.clientRequestId;
    if (meta.correlationId !== undefined) entry.correlationId = meta.correlationId;
    if (meta.sessionId !== undefined) entry.sessionId = meta.sessionId;
    if (meta.messageId !== undefined) entry.messageId = meta.messageId;
    if (meta.durationMs !== undefined) entry.durationMs = meta.durationMs;
    if (meta.durationFrom !== undefined) entry.durationFrom = meta.durationFrom;
    if (meta.status !== undefined) entry.status = meta.status;
    if (meta.promptLength !== undefined) entry.promptLength = meta.promptLength;

    // Browser console — always synchronous and safe.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(entry));

    // Forward to server for a unified stdout trace (fire-and-forget; never blocks the UI).
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    }).catch(() => {}); // ignore network errors — logging must not affect behaviour
  } catch {} // eslint-disable-line no-empty
}

// Assistant/system replies come from Rovo as markdown (see lib/textDecode.v2.ts); render them
// instead of showing raw "**bold**"/"# heading" syntax. User messages stay as plain text -
// nothing to render, and it keeps whatever a person literally typed from being reinterpreted.
// No rehype-raw plugin: react-markdown's default (markdown -> elements only, no raw HTML
// passthrough) is the safer choice for content arriving over the internet-facing callback route.
const MARKDOWN_COMPONENTS: Components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

export default function Home() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  // `ReturnType<Window['setInterval']>` rather than `ReturnType<typeof window.setInterval>`:
  // in this project's type environment `window` is typed as `Window & typeof globalThis`, and
  // @types/node's ambient `declare global { function setInterval(...): NodeJS.Timeout }`
  // pollutes a bare `typeof window.setInterval` lookup even through the `window.` qualifier
  // (verified: `ReturnType<typeof window.setInterval>` resolves to `Timeout`, but the actual
  // call `window.setInterval(fn, ms)` below still returns `number` - the two disagree, and
  // assigning the real return value to a `Timeout`-typed ref fails to compile). Indexing the
  // `Window` interface directly (`Window['setInterval']`) reads the DOM lib's own method
  // signature without going through that ambient-global intersection, giving the correct
  // browser `number` handle type this ref actually holds.
  const pollRef = useRef<ReturnType<Window['setInterval']> | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Instrumentation refs — tracking state across renders and interval callbacks.
  const promptSubmittedAtRef = useRef<number | null>(null);   // Date.now() when the user hit Send
  const clientRequestIdRef = useRef<string | null>(null);     // UUID generated in the browser before each submission
  const lastCorrelationIdRef = useRef<string | null>(null);   // assistantMessage.id returned by the server
  const pendingDetectedRef = useRef<boolean>(false);          // true while we're polling for a response
  const renderedMessageIds = useRef<Set<string>>(new Set());  // guards against duplicate response_rendered events

  // load the session list once on mount
  useEffect(() => {
    refreshSessions();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // load messages whenever the active session changes
  useEffect(() => {
    stopPolling();
    if (!activeId) {
      setMessages([]);
      return;
    }
    loadMessages(activeId);
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // keep the newest message in view
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Emit response_rendered once when the in-flight assistant message transitions to completed.
  // renderedMessageIds guards against duplicate events from normal React re-renders: once the
  // correlationId is in the Set, no further fires occur even if the component re-renders.
  useEffect(() => {
    const cid = lastCorrelationIdRef.current;
    if (!cid) return;
    if (renderedMessageIds.current.has(cid)) return;
    const msg = messages.find((m) => m.id === cid && m.role === 'assistant' && m.status === 'completed');
    if (!msg) return;
    renderedMessageIds.current.add(cid);
    logClientEvent('response_rendered', {
      clientRequestId: clientRequestIdRef.current,
      correlationId: cid,
      sessionId: activeId,
      messageId: cid,
      durationMs: promptSubmittedAtRef.current != null ? Date.now() - promptSubmittedAtRef.current : undefined,
      durationFrom: 'client_prompt_submitted',
      status: 'success',
    });
  }, [messages, activeId]);

  async function refreshSessions(): Promise<void> {
    const res = await fetch("/api/sessions");
    const data: unknown = await res.json();
    const body = isRecord(data) ? data : {};
    const sessionList = toSessionList(body.sessions);
    setSessions(sessionList);
    setActiveId((cur) => cur || sessionList[0]?.id || null);
  }

  async function newChat(): Promise<void> {
    const res = await fetch("/api/sessions", { method: "POST" });
    const data: unknown = await res.json().catch(() => null);
    const body = isRecord(data) ? data : {};
    const session = body.session;
    if (!res.ok || !isSession(session)) {
      logClientEvent('new_chat_failed', { status: 'failed' });
      return;
    }
    setSessions((s) => [session, ...s]);
    setActiveId(session.id);
    setMessages([]);
  }

  async function loadMessages(id: string): Promise<void> {
    const res = await fetch(`/api/sessions/${id}/messages`);
    const data: unknown = await res.json();
    const body = isRecord(data) ? data : {};
    const list = toMessageList(body.messages);
    setMessages(list);
    if (hasPending(list)) startPolling();
  }

  function hasPending(list: Message[]): boolean {
    return list.some((m) => m.role === "assistant" && m.status === "pending");
  }

  function startPolling(): void {
    pendingDetectedRef.current = true;
    if (pollRef.current) return; // already polling
    pollRef.current = window.setInterval(pollOnce, 2500);
  }

  function stopPolling(): void {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function pollOnce(): Promise<void> {
    const id = activeIdRef.current;
    if (!id) return;
    try {
      const res = await fetch(`/api/sessions/${id}/messages`);
      const data: unknown = await res.json();
      const body = isRecord(data) ? data : {};
      const list = toMessageList(body.messages);
      setMessages(list);
      if (!hasPending(list)) {
        // Detect transition: we were waiting and the response is now present.
        if (pendingDetectedRef.current) {
          pendingDetectedRef.current = false;
          logClientEvent('client_completion_detected', {
            clientRequestId: clientRequestIdRef.current,
            correlationId: lastCorrelationIdRef.current,
            sessionId: id,
            durationMs: promptSubmittedAtRef.current != null ? Date.now() - promptSubmittedAtRef.current : undefined,
            durationFrom: 'client_prompt_submitted',
            status: 'success',
          });
        }
        stopPolling();
      }
    } catch {
      logClientEvent('client_poll_failed', {
        clientRequestId: clientRequestIdRef.current,
        sessionId: id,
        status: 'failed',
      });
    }
  }

  // keep a ref of the active id so the interval callback always sees the current value
  const activeIdRef = useRef<string | null>(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || !activeId || busy || hasPending(messages)) return;

    // Generate a browser-side request ID before anything else so that client_prompt_submitted
    // and server_prompt_received can be linked even before the server creates a correlationId.
    const clientRequestId = crypto.randomUUID();
    clientRequestIdRef.current = clientRequestId;
    promptSubmittedAtRef.current = Date.now();

    logClientEvent('client_prompt_submitted', {
      clientRequestId,
      sessionId: activeId,
      promptLength: text.length,
      status: 'success',
    });

    setBusy(true);
    setInput("");
    try {
      const res = await fetch(`/api/sessions/${activeId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // clientRequestId is forwarded to the server for trace linking; it is safe metadata
        // and is never passed to Rovo or stored in the database.
        body: JSON.stringify({ content: text, clientRequestId }),
      });
      const data: unknown = await res.json();
      const body = isRecord(data) ? data : {};

      // Capture the correlationId (assistantMessage.id) for subsequent lifecycle events.
      if (isMessage(body.assistantMessage)) {
        lastCorrelationIdRef.current = body.assistantMessage.id;
      }

      const newMessages = [body.userMessage, body.assistantMessage].filter(isMessage);
      setMessages((m) => [...m, ...newMessages]);
      startPolling();
      refreshSessions();
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const pending = hasPending(messages);

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="newbtn" onClick={newChat}>
          + New Chat
        </button>
        <div className="sessions">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`session ${s.id === activeId ? "active" : ""}`}
              onClick={() => setActiveId(s.id)}
              title={s.title}
            >
              {s.title || "Untitled"}
            </button>
          ))}
          {sessions.length === 0 && <p className="muted">No conversations yet.</p>}
        </div>
      </aside>

      <main className="main">
        {!activeId ? (
          <div className="empty">
            <p>Start a new chat to begin.</p>
            <button onClick={newChat}>+ New Chat</button>
          </div>
        ) : (
          <>
            <div className="messages">
              {messages.map((m) => (
                <div key={m.id} className={`row ${m.role}`}>
                  <div className={`bubble ${m.role} ${m.status} ${m.role === "user" ? "" : "markdown"}`}>
                    {m.role === "assistant" && m.status === "pending" ? (
                      <span className="thinking">thinking...</span>
                    ) : m.role === "user" ? (
                      m.content
                    ) : (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                        {m.content || ""}
                      </ReactMarkdown>
                    )}
                  </div>
                </div>
              ))}
              {messages.length === 0 && <p className="muted center">Send a message to get started.</p>}
              <div ref={endRef} />
            </div>

            <div className="composer">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKey}
                placeholder={pending ? "Waiting for the agent to reply..." : "Type a message..."}
                disabled={pending}
                rows={1}
              />
              <button onClick={send} disabled={pending || !input.trim()}>
                Send
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
