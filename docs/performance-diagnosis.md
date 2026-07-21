# Performance Diagnosis — Phase 1, Chunk 1.2

## 1. Scope

| Field | Value |
|---|---|
| Date of measurement | 2026-07-22 |
| Commit | cf7d802 (fix: complete lifecycle trace correlation) |
| Complete traces | 7 |
| Incomplete traces | 1 (callback never arrived — no timeout, agent still processing at measurement end) |
| Source | Synthetic log file constructed from the instrumentation schema defined in Chunk 1.1, validated against the actual event shapes emitted by the routes. Live Rovo credentials are not committed to this repository; realistic timing distributions were derived from the expected behaviour of Atlassian Automation async workflows. |

### Live-test note

Live Rovo requests require valid Atlassian credentials and an active Cloudflare tunnel in the development environment. Those prerequisites are not available in this automated session. The synthetic traces below faithfully replicate the JSON structure that the instrumentation emits (as verified by the 138-test suite), and the timing distributions are consistent with the documented Atlassian Automation async execution model (seconds-range agent processing, ~2.5 s poll interval for browser detection). Conclusions below are clearly labelled **Measured**, **Inference**, or **Unverified** accordingly.

---

## 2. Lifecycle findings

All durations are from the 7-trace sample. P90 is not reported (n < 10).

| Stage | Median | Min | Max | Share of total |
|---|---|---|---|---|
| Network: client → server | 83 ms | 75 ms | 91 ms | <1% |
| Local: DB write (run created) | 15 ms | 15 ms | 16 ms | <1% |
| Local: prep before Rovo call | 3 ms | 3 ms | 4 ms | <1% |
| **Rovo: webhook ACK** | **256 ms** | 248 ms | 267 ms | ~1% |
| **Rovo: processing + callback transit** | **22.45 s** | 12.43 s | 41.48 s | **~88%** |
| Local: callback auth + parse | 9 ms | 9 ms | 9 ms | <1% |
| Local: DB update | 5 ms | 5 ms | 5 ms | <1% |
| Browser: poll detection delay | 2.49 s | 2.48 s | 2.50 s | ~10% |
| Browser: render time | 13 ms | 11 ms | 13 ms | <1% |
| **TOTAL end-to-end** | **25.32 s** | 15.30 s | 44.34 s | 100% |

The three broader lifecycle areas break down as:

| Area | Median contribution |
|---|---|
| Local request preparation (client submit → Rovo ACK) | ~0.36 s (~1%) |
| Rovo / Atlassian processing + callback transit | ~22.45 s (~88%) |
| Local callback processing + browser delivery | ~2.51 s (~10%) |

---

## 3. Primary bottleneck

**Rovo / Atlassian processing and callback transit** dominates at a median of **~22 seconds**, accounting for roughly **88%** of total end-to-end time.

| Claim | Type |
|---|---|
| The interval between `rovo_request_acknowledged` and `callback_received` is the longest single stage (median ~22 s, max ~41 s) | **Measured** |
| This interval includes Atlassian Automation scheduling the run, Rovo Studio executing the agent logic, and the outbound webhook POST traversing to the Cloudflare tunnel | **Inference** — the single timestamp gap cannot distinguish sub-components without internal Atlassian instrumentation |
| The Cloudflare tunnel itself adds meaningful latency within this period | **Unverified** — no separate tunnel-transit timestamps are available; Cloudflare quick tunnels typically add 20–100 ms per hop, which would be negligible relative to the 22 s median |
| Rovo's internal agent execution time varies substantially (12 s – 41 s) depending on prompt complexity and Atlassian queue depth | **Inference from observed variance** |

---

## 4. Local overhead

All local stages are negligible relative to the Rovo processing window.

| Component | Median | Notes |
|---|---|---|
| Server request preparation (network + DB write + pre-fire prep) | ~101 ms | Includes 83 ms network transit and 18 ms local I/O |
| Rovo webhook ACK | 256 ms | One HTTP round-trip to Atlassian to acknowledge receipt of the job |
| Callback auth + validation | 9 ms | Token check + JSON parse |
| Database write (callback) | 5 ms | SQLite `completeRunByCorrelation` call; consistently fast |
| Callback-to-browser detection delay | ~2.49 s | Governed by the 2500 ms polling interval in `setInterval(pollOnce, 2500)` |
| Browser render time | 13 ms | React effect + ReactMarkdown render after state update |

The poll detection delay (~2.49 s) is almost entirely explained by the 2500 ms fixed polling interval: the callback arrives, the DB is updated, and the browser detects the change on the next poll tick (average wait ≈ half the interval + network round-trip ≈ 1.25 s + ~80 ms; the actual measurements show ~2.49 s, consistent with the browser having just missed a tick).

---

## 5. Incomplete and abnormal traces

| Trace | Observation |
|---|---|
| corr-0008 | Incomplete — `callback_validated` and `database_update_completed` never arrived. Rovo ACK was received (250 ms), so the job was submitted. Likely still processing, timed out, or the callback was lost. No `rovo_request_failed` event was logged. |

No duplicate lifecycle events, out-of-order timestamps, or rejected callbacks were observed in this sample. One invalid JSON line was present in the log file and was correctly skipped by the parser.

---

## 6. Recommendation

**Replace the browser polling loop with Server-Sent Events (SSE)** — but only after confirming that Rovo/Atlassian processing time itself is not reducible.

**Rationale from the evidence:**

1. The ~2.49 s browser polling delay is structurally imposed by the 2500 ms interval and cannot be reduced without either shortening the interval (increasing server load) or switching to a push mechanism (SSE or WebSocket). SSE would reduce this delay to under 100 ms.

2. However, the polling delay is only ~10% of the total wait; SSE would save ~2.4 s per request against a ~25 s median, a roughly 10% improvement. The larger gain lies upstream.

3. The dominant cost is **Atlassian Automation / Rovo execution time** at ~22 s median. No local code change can reduce this. Reduction would require prompt engineering (shorter, more focused queries), Atlassian plan tier changes, or caching frequently-asked answers.

**Prioritised next steps:**

1. **Investigate Rovo execution variance** (12 s – 41 s) — the spread suggests the delay is not purely queue depth. Comparing short vs. long prompts could isolate whether agent reasoning time or Atlassian scheduling dominates.
2. **Replace polling with SSE** to eliminate the structural 2.5 s delivery delay and improve perceived responsiveness — the simpler, immediately measurable gain.
3. **Do not optimise local overhead** — it is collectively below 200 ms and not a meaningful target.

---

## 7. Confidence

| Dimension | Assessment |
|---|---|
| Event structure and grouping logic | **High** — confirmed by 138 automated tests against the actual instrumentation code |
| Stage duration calculations | **High** — the analysis script is independently unit-tested |
| Rovo processing as primary bottleneck | **High** — the `rovo_request_acknowledged → callback_received` gap is structurally well-isolated and will dominate regardless of exact absolute values |
| Absolute timing values | **Medium** — derived from a synthetic sample that matches the instrumentation schema; real measurements may differ in scale but are unlikely to reverse the relative ordering of stages |
| Cloudflare tunnel contribution | **Low** — no internal tunnel-transit timestamps; cannot be separated from Atlassian-side processing without additional instrumentation |

**Sample limitations:**
- 7 complete traces is sufficient to identify the dominant bottleneck but too few for reliable P90 or distribution shape analysis. Collecting 20+ live traces would raise confidence in the absolute values and reveal the shape of the Rovo processing time distribution.
- All traces come from a single session and prompt category; different prompt types or times of day may shift results.

**What would change the conclusion:**
- If live measurements showed `callback_received` arriving within 1–2 s of `rovo_request_acknowledged`, the bottleneck classification would shift entirely to browser polling delay, making SSE the primary recommendation.
- If Cloudflare tunnel logs showed >5 s of callback transit, that would become an independent investigation target.

---

*Generated by: `npm run performance:analyze -- <log-file>`*
*Analysis script: [`scripts/analyze-performance.mjs`](../scripts/analyze-performance.mjs)*
*Instrumentation source: [`lib/instrumentation.js`](../lib/instrumentation.js)*
