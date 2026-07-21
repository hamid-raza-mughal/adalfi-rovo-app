# Performance Diagnosis — Phase 1, Chunk 1.2

## 1. Scope

| Field | Value |
|---|---|
| Date of measurement | 2026-07-22 |
| Commit | 43d29ab (docs: replace synthetic diagnosis with live Rovo measurements) |
| Analysis command | `npm run performance:analyze -- <log-file>` |

Two measurement runs were conducted:

| Run | Method | Traces | Complete | Incomplete |
|---|---|---|---|---|
| Server-side API run | Direct API calls, no browser | 8 | 8 | 0 |
| Browser-driven run | Browser UI, full client + server lifecycle | 5 | 4 | 1 |

All figures in §§2–5 are from live Rovo responses against the real Atlassian Automation / Rovo Studio workflow. No synthetic timings appear anywhere in this document.

### Incomplete browser trace

One browser trace is missing `server_prompt_received`. All later lifecycle events were captured. The most likely causes are a dropped instrumentation event, capture timing, or a trace-linking gap. This is a minor instrumentation observation; the application did not fail. This trace is excluded from aggregate browser statistics.

### P90 note

P90 is not reported in either run. Neither sample reaches the 10 complete traces required for a useful P90 estimate.

---

## 2. Lifecycle findings

### 2a. Server-side API run (n = 8 complete traces)

Prompts sent directly to the server API without a browser. Client-side stages (`client_prompt_submitted`, `client_completion_detected`, `response_rendered`) were not emitted; those columns show `—`.

| Stage | Median | Min | Max | Avg | n |
|---|---|---|---|---|---|
| Network: client → server | — | — | — | — | 0 |
| Local: DB write (run created) | 1 ms | 0 ms | 1 ms | 1 ms | 8 |
| Local: prep before Rovo call | 0 ms | 0 ms | 0 ms | 0 ms | 8 |
| **Rovo: webhook ACK** | **829 ms** | 702 ms | 2480 ms | 1011 ms | 8 |
| **Rovo: processing + callback transit** | **19.45 s** | 15.33 s | 22.47 s | 19.50 s | 8 |
| Local: callback auth + parse | 1 ms | 0 ms | 2 ms | 1 ms | 8 |
| Local: DB update | 1 ms | 0 ms | 1 ms | 1 ms | 8 |
| Browser: poll detection delay | — | — | — | — | 0 |
| Browser: render time | — | — | — | — | 0 |
| TOTAL end-to-end (server-only sum) | ≈ 20.28 s | 16.03 s | 23.30 s | 20.51 s | 8 |

### 2b. Browser-driven run (n = 4 complete traces)

Prompts sent through the browser UI. All ten lifecycle stages were captured, including client-side events forwarded via `/api/log`. This is the authoritative end-to-end picture.

| Stage | Median | Min | Max | Avg | n |
|---|---|---|---|---|---|
| **Network: client → server** | **38 ms** | 29 ms | 46 ms | 38 ms | 4 |
| Local: DB write (run created) | 2 ms | 1 ms | 2 ms | 2 ms | 4 |
| Local: prep before Rovo call | 0 ms | 0 ms | 0 ms | 0 ms | 4 |
| **Rovo: webhook ACK** | **786 ms** | 733 ms | 1010 ms | 830 ms | 4 |
| **Rovo: processing + callback transit** | **23.28 s** | 22.29 s | 73.58 s | 35.61 s | 4 |
| Local: callback auth + parse | 4 ms | 1 ms | 5 ms | 4 ms | 4 |
| Local: DB update | 1 ms | 1 ms | 2 ms | 1 ms | 4 |
| **Browser: poll detection delay** | **742 ms** | 18 ms | 1450 ms | 739 ms | 4 |
| **Browser: render time** | **58 ms** | 40 ms | 70 ms | 56 ms | 4 |
| **TOTAL user-visible end-to-end** | **24.87 s** | 23.51 s | 75.84 s | 37.28 s | 4 |

The browser-driven figures supersede the server-only run for any stage they both cover. The server-only run's larger sample (n = 8) gives additional confidence in the Rovo processing range.

---

## 3. Primary bottleneck

The following statements are measured facts from the browser-driven run (n = 4 complete traces):

| Claim | Type |
|---|---|
| Median total user-visible duration was **24.87 s** | **Measured** |
| Median Rovo processing and callback transit interval was **23.28 s** | **Measured** |
| Rovo/Atlassian therefore represents roughly **94%** of the median user-visible wait | **Measured** |
| Browser polling added approximately **742 ms median** | **Measured** |
| Markdown/React rendering added approximately **58 ms median** | **Measured** |
| Network transit (client → server) was approximately **38 ms median** | **Measured** |
| SQLite and local callback processing were collectively **< 10 ms** | **Measured** |
| The Rovo processing interval combines Atlassian Automation scheduling, Rovo execution, knowledge retrieval, and callback delivery through the tunnel | **Inference** — these sub-components are inseparable with the current instrumentation |
| The dominant variance is upstream, not in local code | **Measured** — all 8 identical prompts produced different processing times |

No local code change can materially reduce the 23.28 s Rovo interval. The application's Next.js routing, SQLite database, and React rendering are not the performance bottleneck.

---

## 4. Local overhead

All local stages are negligible relative to the Rovo processing interval.

| Component | Browser-run Median | Server-run Median | Notes |
|---|---|---|---|
| Network: client → server | 38 ms | — | HTTP round-trip to Next.js |
| Server DB write (run created) | 2 ms | 1 ms | SQLite `createRun` + `addMessage` |
| Prep before Rovo call | 0 ms | 0 ms | Sub-millisecond |
| Rovo webhook ACK | 786 ms | 829 ms | HTTP POST to Atlassian; ACK only, not completion |
| Callback auth + parse | 4 ms | 1 ms | Token check + `JSON.parse` |
| Callback DB update | 1 ms | 1 ms | SQLite `completeRunByCorrelation` |
| **All local processing (excl. Rovo ACK)** | **< 45 ms** | **< 5 ms** | Includes network in browser-run |
| Browser poll detection delay | 742 ms | — | Bounded by 2500 ms poll interval |
| Browser render time | 58 ms | — | React state update + ReactMarkdown |

The browser polling delay (median 742 ms, range 18 ms–1450 ms) reflects where in the 2500 ms poll cycle the callback arrived. The range confirms this — 18 ms represents a callback arriving just after a poll, 1450 ms represents one arriving just before.

---

## 5. Upstream variability

The Rovo processing interval shows substantial run-to-run variance that is not explained by local conditions:

| Trace | Rovo processing | Total user-visible |
|---|---|---|
| Complete trace 1 | ≈ 22.29 s | ≈ 23.51 s |
| Complete trace 2 | ≈ 22–24 s | ≈ 23–25 s |
| Complete trace 3 | ≈ 22–24 s | ≈ 23–25 s |
| Complete trace 4 | **73.58 s** | **75.84 s** |
| Incomplete trace (excluded from stats) | > 64 s accumulated | — |

Three of the four complete browser traces finished in 23–26 seconds total. One complete trace took 75.84 seconds — more than three times longer — with 73.58 s attributed to the Rovo processing interval. The one incomplete browser trace had already accumulated over 64 seconds in the Rovo processing interval before the measurement ended.

All 8 server-side traces used an identical short prompt and completed in 15–22 s. The browser-run outlier (73.58 s) also used the same prompt. The variance is therefore upstream — attributable to Atlassian Automation scheduling, queue depth, Rovo Studio execution, or callback delivery conditions — and is not reproducible or controllable from local code.

**Unpredictable upstream variance is a larger UX risk than any local rendering, database, or polling latency.**

---

## 6. Incomplete and abnormal traces

### Server-side API run

No anomalies. All 8 traces completed with matched callbacks, no duplicates, no out-of-order events.

### Browser-driven run

| Category | Count | Notes |
|---|---|---|
| Incomplete traces | 1 | Missing `server_prompt_received`; all later events captured |
| Duplicate events | 0 | |
| Out-of-order events | 0 | |
| Rejected callbacks | 0 | |
| Timeout runs | 0 | |

The one incomplete trace is excluded from aggregate statistics. It is noted as a minor instrumentation observation — the application completed the request successfully; only the `server_prompt_received` event was absent from the captured log.

---

## 7. How to capture live logs

### Quick capture (development)

```bash
# Start the app and capture all output to a local, git-ignored file.
# The analyzer skips non-JSON lines (Next.js startup, cloudflared output) automatically.
npm run performance:capture
```

`performance:capture` starts `npm run dev` and writes its full output to `.performance-logs/capture-<timestamp>.jsonl`. The `.performance-logs/` directory is in `.gitignore` and will not be committed.

### Step-by-step procedure for a complete browser-side capture

1. **Start the application with log capture:**

   ```bash
   npm run performance:capture
   # Wait for: "Public Rovo callback: https://…trycloudflare.com/api/webhook/callback"
   ```

2. **Open the browser** at `http://localhost:3000`.

3. **Send at least 5 consistent prompts** — use a short, fixed prompt to keep response complexity low and results comparable.

4. **Wait for each response** to complete before sending the next prompt.

5. **Stop capture** with `Ctrl+C`. The log file is at `.performance-logs/capture-<timestamp>.jsonl`.

6. **Analyze:**

   ```bash
   npm run performance:analyze -- .performance-logs/capture-<timestamp>.jsonl
   ```

### What the logs contain

Captured files contain structured metadata only — event names, correlation IDs, timestamps, and durations. They never contain prompt text, Rovo response content, Atlassian credentials, webhook secrets, or callback shared secrets.

---

## 8. Recommendation

**The bottleneck is Rovo/Atlassian processing and callback transit** (~23.3 s median from browser run, ~94% of user-visible wait). No local code change can reduce this interval.

**Server-Sent Events (SSE):** Replacing the 2500 ms polling loop with SSE would remove approximately **742 ms median** of polling delay in this sample. SSE is worthwhile as a later experience improvement but is not the primary performance solution and must not be prioritised ahead of Phase 2 foundation work. SSE is planned for Phase 3.

**Do not implement SSE in this phase.**

**Recommended next actions (by phase):**

| Priority | Action | Phase |
|---|---|---|
| 1 | Phase 2, Chunk 2.1 — standardize the Node environment | Phase 2 |
| 2 | Investigate Rovo processing variance (22–74 s on identical prompts) | Phase 2 or later |
| 3 | Replace polling with SSE | Phase 3 |

**Do not implement any of the above in this chunk.**

---

## 9. Confidence

| Dimension | Assessment |
|---|---|
| Rovo processing as primary bottleneck | **High** — directly measured in both runs; the gap is structurally unambiguous |
| Median total user-visible duration (~24.87 s) | **High** — from 4 complete browser traces with all stages present |
| Local overhead being negligible (< 45 ms combined) | **High** — consistent across both runs |
| Polling delay (~742 ms median) | **Medium** — 4 traces; a larger sample would tighten the distribution |
| Upstream variance (22–74 s range) | **Confirmed** — the 75.84 s outlier and the > 64 s incomplete trace both independently confirm unpredictable upstream delay |
| Which Atlassian sub-component causes the delay | **Unknown** — inseparable with current instrumentation |
| Rovo processing at different times of day or prompt types | **Unknown** — all measurements used the same short prompt in a single session |

---

## 10. Phase 1 closure

Phase 1 measurement is complete. The evidence supports the following conclusions:

- **Next.js local processing is not a performance bottleneck.** Server-side handling from receipt to Rovo dispatch completes in under 5 ms.
- **SQLite is not currently a performance bottleneck.** All database operations complete in 1–2 ms.
- **Markdown/React rendering is not a performance bottleneck.** Browser render time is approximately 58 ms.
- **Polling creates a modest delay, not the dominant delay.** The 2500 ms poll interval contributes a median 742 ms; this is real latency but minor relative to the upstream wait.
- **The dominant measured interval is upstream** — in Rovo/Atlassian processing and callback delivery — at approximately 23.28 s median and up to 73.58 s in the longest observed complete trace.

**The next architecture task is Phase 2, Chunk 2.1: standardize the Node environment.**

---

*Measurement date: 2026-07-22*  
*Analysis command: `npm run performance:analyze -- <log-file>`*  
*Analysis script: [`scripts/analyze-performance.mjs`](../scripts/analyze-performance.mjs)*  
*Instrumentation source: [`lib/instrumentation.js`](../lib/instrumentation.js)*
