"use client";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ---------------------------------------------------------------------------
// Client-side lifecycle instrumentation
// Logs a structured JSON event to the browser console and forwards it to the
// server's /api/log endpoint so one unified trace appears on stdout.
// Never throws; never logs prompt/response content, secrets, or URLs.
// ---------------------------------------------------------------------------
function logClientEvent(event, meta = {}) {
  try {
    const entry = { event, timestamp: new Date().toISOString(), source: 'browser' };
    if (meta.correlationId !== undefined) entry.correlationId = meta.correlationId;
    if (meta.sessionId !== undefined) entry.sessionId = meta.sessionId;
    if (meta.messageId !== undefined) entry.messageId = meta.messageId;
    if (meta.durationMs !== undefined) entry.durationMs = meta.durationMs;
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

// Assistant/system replies come from Rovo as markdown (see lib/textDecode.v2.js); render them
// instead of showing raw "**bold**"/"# heading" syntax. User messages stay as plain text -
// nothing to render, and it keeps whatever a person literally typed from being reinterpreted.
// No rehype-raw plugin: react-markdown's default (markdown -> elements only, no raw HTML
// passthrough) is the safer choice for content arriving over the internet-facing callback route.
const MARKDOWN_COMPONENTS = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

export default function Home() {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);
  const endRef = useRef(null);

  // Instrumentation refs — tracking state across renders and interval callbacks.
  const promptSubmittedAtRef = useRef(null);   // Date.now() when the user hit Send
  const lastCorrelationIdRef = useRef(null);   // assistantMessage.id for the in-flight request
  const pendingDetectedRef = useRef(false);    // true while we're polling for a response
  const renderedMessageIds = useRef(new Set()); // guards against duplicate response_rendered events

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
  // The renderedMessageIds Set prevents duplicate events from normal React re-renders.
  useEffect(() => {
    const cid = lastCorrelationIdRef.current;
    if (!cid) return;
    if (renderedMessageIds.current.has(cid)) return;
    const msg = messages.find((m) => m.id === cid && m.role === 'assistant' && m.status === 'completed');
    if (!msg) return;
    renderedMessageIds.current.add(cid);
    logClientEvent('response_rendered', {
      correlationId: cid,
      sessionId: activeId,
      messageId: cid,
      durationMs: promptSubmittedAtRef.current != null ? Date.now() - promptSubmittedAtRef.current : undefined,
      status: 'success',
    });
  }, [messages, activeId]);

  async function refreshSessions() {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    setSessions(data.sessions || []);
    setActiveId((cur) => cur || data.sessions?.[0]?.id || null);
  }

  async function newChat() {
    const res = await fetch("/api/sessions", { method: "POST" });
    const data = await res.json();
    setSessions((s) => [data.session, ...s]);
    setActiveId(data.session.id);
    setMessages([]);
  }

  async function loadMessages(id) {
    const res = await fetch(`/api/sessions/${id}/messages`);
    const data = await res.json();
    const list = data.messages || [];
    setMessages(list);
    if (hasPending(list)) startPolling();
  }

  function hasPending(list) {
    return list.some((m) => m.role === "assistant" && m.status === "pending");
  }

  function startPolling() {
    pendingDetectedRef.current = true;
    if (pollRef.current) return; // already polling
    pollRef.current = setInterval(pollOnce, 2500);
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function pollOnce() {
    const id = activeIdRef.current;
    if (!id) return;
    try {
      const res = await fetch(`/api/sessions/${id}/messages`);
      const data = await res.json();
      const list = data.messages || [];
      setMessages(list);
      if (!hasPending(list)) {
        // Detect transition: we were waiting and the response is now present.
        if (pendingDetectedRef.current) {
          pendingDetectedRef.current = false;
          logClientEvent('client_completion_detected', {
            correlationId: lastCorrelationIdRef.current,
            sessionId: id,
            durationMs: promptSubmittedAtRef.current != null ? Date.now() - promptSubmittedAtRef.current : undefined,
            status: 'success',
          });
        }
        stopPolling();
      }
    } catch {
      logClientEvent('client_poll_failed', {
        sessionId: id,
        status: 'failed',
      });
    }
  }

  // keep a ref of the active id so the interval callback always sees the current value
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  async function send() {
    const text = input.trim();
    if (!text || !activeId || busy || hasPending(messages)) return;

    promptSubmittedAtRef.current = Date.now();
    logClientEvent('client_prompt_submitted', {
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
        body: JSON.stringify({ content: text }),
      });
      const data = await res.json();

      // Capture the correlationId (assistantMessage.id) for subsequent lifecycle events.
      if (data.assistantMessage?.id) {
        lastCorrelationIdRef.current = data.assistantMessage.id;
      }

      setMessages((m) => [...m, data.userMessage, data.assistantMessage].filter(Boolean));
      startPolling();
      refreshSessions();
    } finally {
      setBusy(false);
    }
  }

  function onKey(e) {
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
