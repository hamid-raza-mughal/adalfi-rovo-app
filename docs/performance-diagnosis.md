# Performance Diagnosis — Phase 1, Chunk 1.2

## 1. Scope

| Field | Value |
|---|---|
| Date of measurement | 2026-07-22 |
| Commit | d287996 (docs: add performance diagnosis and analysis tooling) |
| Measurement method | 8 live Rovo requests sent to the running application via the documented API |
| Complete traces | 8 |
| Incomplete traces | 0 |
| Source | Live Rovo responses — real Atlassian Automation / Rovo Studio workflow |

### Coverage note

The test prompts were sent directly to the server API (not through a browser), so client-side events (`client_prompt_submitted`, `client_completion_detected`, `response_rendered`) were not emitted. The stages that require those events — network transit to the server, browser polling delay, and browser render time — show `—` in the tables below.

The raw log was captured using the procedure in [Capturing live logs](#6-how-to-capture-live-logs) and analyzed with:

```bash
npm run performance:analyze -- <log-file>
```

---

## 2. Lifecycle findings

The table below shows only stages for which timestamps were available in both events. Stages marked `—` require browser-side events that were not present in this capture run.

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
| **TOTAL end-to-end (server only)** | **≈ 20.28 s** | 16.03 s | 23.30 s | 20.51 s | 8 |

> **TOTAL end-to-end (server only)** is the sum of all measured server-side stages per trace. Browser stages are not included because client events were not captured in this run. The real end-to-end time as seen by a browser user is longer by the browser polling detection delay (up to 2.5 s per poll cycle) and network transit from the client.

P90 is not reported for this sample (n = 8 < 10).

### Broader lifecycle areas (server-measured stages only)

| Area | Sum of measured stages |
|---|---|
| Local request preparation (server received → Rovo ACK) | **median 830 ms** |
| Rovo / Atlassian processing + callback transit | **median 19.45 s** |
| Local callback processing | **median 2 ms** |

---

## 3. Primary bottleneck

**Rovo / Atlassian processing and callback transit** is the dominant cost: a median of **19.45 s** per request, accounting for **96%** of the measurable server-side wait time.

| Claim | Type |
|---|---|
| The interval between `rovo_request_acknowledged` and `callback_received` is the longest single stage (median 19.45 s, range 15.33 s–22.47 s) | **Measured — from 8 live Rovo traces** |
| This interval includes Atlassian Automation scheduling, Rovo Studio agent execution, and the outbound webhook POST arriving at the Cloudflare tunnel | **Inference** — a single timestamp gap; cannot isolate sub-components without Atlassian-internal instrumentation |
| Rovo processing time varies substantially run-to-run (15–22 s with a consistent short prompt) | **Measured** — all 8 prompts were identical; the variance is upstream, not in local code |
| All local overhead (DB writes, auth, parsing) is collectively below 5 ms | **Measured — from 8 live traces** |

The Rovo webhook ACK (median 829 ms, one outlier at 2.48 s on trace 8) reflects the HTTP round-trip from this server to Atlassian's Automation endpoint. This is expected behaviour — Rovo Automation returns 200 only to acknowledge receipt of the job, not completion.

---

## 4. Local overhead

All local stages are negligible in isolation and collectively.

| Component | Median | Notes |
|---|---|---|
| Server DB write (run created) | 1 ms | SQLite `createRun` + `addMessage` |
| Prep before Rovo call | 0 ms | Sub-millisecond; within measurement noise |
| Rovo webhook ACK (HTTP round-trip) | 829 ms | One HTTP POST to Atlassian; one outlier at 2.48 s |
| Callback auth + parse | 1 ms | Token check + `JSON.parse` |
| Callback DB update | 1 ms | SQLite `completeRunByCorrelation` |
| **Total local processing** | **< 5 ms** | Excluding the Rovo HTTP round-trip |

**Browser stages not measured in this run.** The browser polling delay is structurally bounded by the 2500 ms `setInterval` in [app/page.js](../app/page.js:137) — in the typical case the delay is between 0 ms and 2500 ms (uniform distribution → expected ~1.25 s). To measure it, capture logs with a browser session open (see §6).

---

## 5. Incomplete or abnormal traces

None. All 8 traces completed successfully with matched callbacks.

| Category | Count |
|---|---|
| Duplicate lifecycle events | 0 |
| Out-of-order events | 0 |
| Rejected callbacks | 0 |
| Timeout runs | 0 |
| Missing callbacks | 0 |

---

## 6. How to capture live logs

### Quick capture (development)

```bash
# Start the app and capture all output to a local, git-ignored file.
# The analyzer skips non-JSON lines automatically.
npm run performance:capture
```

`performance:capture` starts `npm run dev` and writes its full output (including Next.js build logs and cloudflare startup messages) to `.performance-logs/capture-<timestamp>.jsonl`. Non-JSON lines are silently ignored during analysis.

The `.performance-logs/` directory is listed in `.gitignore` and will not be committed.

### Step-by-step procedure for a complete browser-side capture

To capture all lifecycle stages including client-side events:

1. **Start the application with log capture:**

   ```bash
   npm run performance:capture
   # Wait for: "Public Rovo callback: https://…trycloudflare.com/api/webhook/callback"
   ```

2. **Open the browser** at `http://localhost:3000`.

3. **Open browser DevTools → Console** — client-side lifecycle events appear as JSON lines in the console alongside server-forwarded events.

4. **Send at least 5 consistent prompts** — use a short, fixed prompt (e.g., "Hello, please reply briefly.") to keep response complexity low and results comparable.

5. **Wait for each response** to complete before sending the next prompt.

6. **Stop capture** with `Ctrl+C`. The log file is at `.performance-logs/capture-<timestamp>.jsonl`.

7. **Analyze:**

   ```bash
   npm run performance:analyze -- .performance-logs/capture-<timestamp>.jsonl
   ```

8. **Regenerate this document** from the analysis output.

### What the logs contain

The captured `.jsonl` file contains structured metadata only — event names, correlation IDs, timestamps, and durations. It never contains:
- Prompt text or Rovo response content
- Atlassian credentials or webhook secrets
- Callback shared secrets
- Internal Rovo configuration

---

## 7. Recommendation

Based on the measured evidence:

**The bottleneck is Rovo / Atlassian processing and callback transit** (~19.5 s median, ~96% of server-side wait time). No local code change can reduce this.

**Recommended next steps (in priority order):**

1. **Capture browser-side traces** to quantify the polling delivery delay and confirm the total end-to-end user-visible duration. This is the immediate gap in the current measurement.

2. **Replace browser polling with Server-Sent Events (SSE)** if the polling delay (expected ~1.25 s average, up to 2.5 s per cycle) is unacceptable after the end-to-end time is confirmed. This would have no effect on Rovo processing time but would reduce the browser-visible wait.

3. **Investigate Rovo processing variance** (15 s – 22 s on identical prompts). The spread suggests queue depth or Atlassian scheduling is a factor, not prompt complexity. Understanding this could inform caching or warm-up strategies.

Do not implement any of the above in this chunk.

---

## 8. Confidence

| Dimension | Assessment |
|---|---|
| Rovo processing as primary bottleneck | **High** — directly measured from 8 live traces; the gap is structurally clear |
| Local overhead being negligible | **High** — consistently below 5 ms across all traces |
| Rovo ACK median (~829 ms) | **High** — all 8 traces measured; one outlier at 2.48 s |
| Rovo processing variance (15–22 s) | **Medium** — 8 traces is a small sample; a longer session could shift the distribution |
| Browser polling delay | **Not measured** — requires a browser session to capture client events |
| Network client-to-server transit | **Not measured** — requires browser-side `client_prompt_submitted` events |
| Total end-to-end user-visible duration | **Not measured** — sum of server-measured + browser stages |

**Remaining uncertainty:**
- Browser stages are unquantified. Total user-visible time is server-measured time plus polling delay (0–2.5 s) plus network round-trip.
- 8 traces may not represent the variance across different times of day, Atlassian queue load, or prompt types.
- Trace 8 had a 2.48 s Rovo ACK (vs. 702–852 ms for others) — possible initial connection latency or rate-limit backoff; one occurrence is insufficient to draw conclusions.

**What would change the conclusion:**
- If browser traces showed the polling delay exceeding ~5 s, it would become a co-primary concern alongside Rovo processing.
- If longer sampling (20+ traces) showed Rovo processing below 5 s for a significant fraction of requests, caching or warm-up strategies would become more attractive.

---

*Measurement date: 2026-07-22*  
*Analysis command: `npm run performance:analyze -- <log-file>`*  
*Analysis script: [`scripts/analyze-performance.mjs`](../scripts/analyze-performance.mjs)*  
*Instrumentation source: [`lib/instrumentation.js`](../lib/instrumentation.js)*
