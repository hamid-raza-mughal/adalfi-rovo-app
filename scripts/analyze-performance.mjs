#!/usr/bin/env node
// scripts/analyze-performance.mjs
// Analyzes structured lifecycle JSON logs produced by lib/instrumentation.js and the
// browser-side logClientEvent function in app/page.js.
//
// Usage:
//   npm run performance:analyze -- <log-file>
//
// Output: per-request duration table, aggregate statistics, and anomaly report.
// Never prints prompt text, response content, secrets, tokens, or environment values.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// All known lifecycle event names in expected temporal order.
const ORDERED_EVENTS = [
  'client_prompt_submitted',
  'server_prompt_received',
  'run_created',
  'rovo_request_started',
  'rovo_request_acknowledged',
  'callback_received',
  'callback_validated',
  'database_update_completed',
  'client_completion_detected',
  'response_rendered',
];

// Stages to compute between event pairs. Both events must be present for the
// duration to be included.  { from, to, label }
const STAGES = [
  { from: 'client_prompt_submitted',    to: 'server_prompt_received',      label: 'Network: client → server' },
  { from: 'server_prompt_received',     to: 'run_created',                 label: 'Local: DB write (run created)' },
  { from: 'run_created',               to: 'rovo_request_started',         label: 'Local: prep before Rovo call' },
  { from: 'rovo_request_started',      to: 'rovo_request_acknowledged',    label: 'Rovo: webhook ACK' },
  { from: 'rovo_request_acknowledged', to: 'callback_received',            label: 'Rovo: processing + callback transit' },
  { from: 'callback_received',         to: 'callback_validated',           label: 'Local: callback auth + parse' },
  { from: 'callback_validated',        to: 'database_update_completed',    label: 'Local: DB update' },
  { from: 'database_update_completed', to: 'client_completion_detected',   label: 'Browser: poll detection delay' },
  { from: 'client_completion_detected', to: 'response_rendered',           label: 'Browser: render time' },
  { from: 'client_prompt_submitted',   to: 'response_rendered',            label: 'TOTAL end-to-end' },
];

// Events that signal a complete, successful end-to-end trace.
const COMPLETION_EVENTS = new Set(['database_update_completed', 'response_rendered']);

// Events required for a trace to be counted as "complete" for aggregate stats.
const REQUIRED_FOR_COMPLETE = [
  'server_prompt_received',
  'run_created',
  'rovo_request_started',
  'rovo_request_acknowledged',
  'callback_validated',
  'database_update_completed',
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

async function parseLogFile(filePath) {
  const lines = [];
  const parseErrors = [];

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let lineNum = 0;
  for await (const raw of rl) {
    lineNum++;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // Lines that don't start with '{' are plainly non-JSON (Next.js build output,
    // cloudflared startup messages, etc.). Skip them silently — they are expected
    // when capturing from `npm run dev` and are not parse errors.
    if (!trimmed.startsWith('{')) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (!entry || typeof entry !== 'object' || typeof entry.event !== 'string' || !entry.timestamp) {
        parseErrors.push({ lineNum, reason: 'missing event or timestamp' });
        continue;
      }
      lines.push(entry);
    } catch {
      parseErrors.push({ lineNum, reason: 'invalid JSON' });
    }
  }

  return { events: lines, parseErrors };
}

// ---------------------------------------------------------------------------
// Trace grouping
// ---------------------------------------------------------------------------

/**
 * Group parsed log events into per-request traces keyed by correlationId.
 *
 * Events that lack a correlationId are linked via clientRequestId:
 *   - server_prompt_received (has clientRequestId, no correlationId)
 *   - client_prompt_submitted (has clientRequestId, no correlationId)
 *
 * callback_received (has neither ID) is linked to the trace whose
 * callback_validated is closest in time immediately after it.
 *
 * Returns Map<correlationId, TraceData>
 */
function groupIntoTraces(events) {
  // Build an ordered list for time-proximity matching.
  const sorted = [...events].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Map: correlationId → { events: [], clientRequestIds: Set }
  const traces = new Map();
  // Map: clientRequestId → correlationId  (populated once we see run_created)
  const cridToCorrelation = new Map();
  // Unmatched events that need secondary linkage
  const orphansByCrid = new Map(); // clientRequestId → [events]
  const callbackReceived = []; // events with no IDs

  // First pass: events with a correlationId get grouped directly.
  for (const ev of sorted) {
    if (ev.correlationId) {
      if (!traces.has(ev.correlationId)) {
        traces.set(ev.correlationId, { events: [], clientRequestIds: new Set() });
      }
      traces.get(ev.correlationId).events.push(ev);
      if (ev.clientRequestId) {
        traces.get(ev.correlationId).clientRequestIds.add(ev.clientRequestId);
        cridToCorrelation.set(ev.clientRequestId, ev.correlationId);
      }
    } else if (ev.event === 'callback_received') {
      callbackReceived.push(ev);
    } else if (ev.clientRequestId) {
      if (!orphansByCrid.has(ev.clientRequestId)) {
        orphansByCrid.set(ev.clientRequestId, []);
      }
      orphansByCrid.get(ev.clientRequestId).push(ev);
    }
    // Events with neither correlationId nor clientRequestId are ungroupable; ignored.
  }

  // Second pass: link orphan events (server_prompt_received, client_prompt_submitted)
  // using clientRequestId → correlationId mapping.
  for (const [crid, evList] of orphansByCrid) {
    const corr = cridToCorrelation.get(crid);
    if (corr && traces.has(corr)) {
      traces.get(corr).events.push(...evList);
    }
    // If no matching trace yet, these remain ungrouped (incomplete trace).
  }

  // Third pass: link callback_received to the trace whose callback_validated is
  // nearest in time after it.
  const usedCallbackReceived = new Set();
  for (const [corr, trace] of traces) {
    const validated = trace.events.find((e) => e.event === 'callback_validated');
    if (!validated) continue;
    const validatedTime = new Date(validated.timestamp).getTime();
    // Find the closest callback_received that precedes validated and hasn't been used.
    let best = null;
    let bestDiff = Infinity;
    for (const cr of callbackReceived) {
      if (usedCallbackReceived.has(cr)) continue;
      const t = new Date(cr.timestamp).getTime();
      if (t <= validatedTime) {
        const diff = validatedTime - t;
        if (diff < bestDiff) {
          bestDiff = diff;
          best = cr;
        }
      }
    }
    if (best) {
      trace.events.push(best);
      usedCallbackReceived.add(best);
    }
  }

  // Normalise each trace: sort events by timestamp.
  for (const trace of traces.values()) {
    trace.events.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  return traces;
}

// ---------------------------------------------------------------------------
// Per-trace analysis
// ---------------------------------------------------------------------------

function analyzeTrace(correlationId, trace) {
  const { events } = trace;
  const byEvent = new Map(); // event name → [timestamps]

  for (const ev of events) {
    if (!byEvent.has(ev.event)) byEvent.set(ev.event, []);
    byEvent.get(ev.event).push(new Date(ev.timestamp).getTime());
  }

  // Detect anomalies.
  const anomalies = [];
  const duplicates = [];
  for (const [name, times] of byEvent) {
    if (times.length > 1) {
      duplicates.push(name);
      anomalies.push(`duplicate: ${name} (×${times.length})`);
    }
  }

  // Check expected ordering.
  const presentOrdered = ORDERED_EVENTS.filter((e) => byEvent.has(e));
  const outOfOrder = [];
  for (let i = 1; i < presentOrdered.length; i++) {
    const prev = presentOrdered[i - 1];
    const curr = presentOrdered[i];
    const prevT = byEvent.get(prev)?.[0];
    const currT = byEvent.get(curr)?.[0];
    if (prevT !== undefined && currT !== undefined && currT < prevT) {
      outOfOrder.push(`${prev} → ${curr}`);
    }
  }
  if (outOfOrder.length > 0) {
    anomalies.push(`out-of-order: ${outOfOrder.join(', ')}`);
  }

  // Missing events.
  const missing = REQUIRED_FOR_COMPLETE.filter((e) => !byEvent.has(e));

  // Stage durations.
  const stageDurations = {};
  for (const stage of STAGES) {
    const fromTimes = byEvent.get(stage.from);
    const toTimes   = byEvent.get(stage.to);
    if (!fromTimes || !toTimes) continue;
    const diff = toTimes[0] - fromTimes[0];
    stageDurations[`${stage.from}→${stage.to}`] = diff;
  }

  // Completeness check.
  const isComplete = missing.length === 0;

  return {
    correlationId,
    events: events.map((e) => e.event),
    byEvent,
    stageDurations,
    isComplete,
    missing,
    anomalies,
    duplicates,
    outOfOrder,
  };
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function stats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted.length >= 10
    ? sorted[Math.ceil(sorted.length * 0.9) - 1]
    : null;
  return { min, max, avg, median, p90, n: values.length };
}

function fmt(ms) {
  if (ms === null || ms === undefined) return '—';
  if (typeof ms !== 'number' || isNaN(ms)) return '?';
  if (ms < 0) return `${ms.toFixed(0)}ms (negative)`;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printTable(rows, headers) {
  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i], String(cell).length);
    });
  }
  const sep = widths.map((w) => '─'.repeat(w + 2)).join('┼');
  const headerRow = headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join('│');
  const divider = `├${sep}┤`;
  console.log(`┌${widths.map((w) => '─'.repeat(w + 2)).join('┬')}┐`);
  console.log(`│${headerRow}│`);
  console.log(divider);
  for (const row of rows) {
    const line = row.map((cell, i) => ` ${String(cell).padEnd(widths[i])} `).join('│');
    console.log(`│${line}│`);
  }
  console.log(`└${widths.map((w) => '─'.repeat(w + 2)).join('┴')}┘`);
}

function report(analyses, parseErrors) {
  const complete   = analyses.filter((a) => a.isComplete);
  const incomplete = analyses.filter((a) => !a.isComplete);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Lifecycle Performance Analysis');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`Traces found:     ${analyses.length}`);
  console.log(`  Complete:       ${complete.length}`);
  console.log(`  Incomplete:     ${incomplete.length}`);
  if (parseErrors.length > 0) {
    console.log(`  Parse errors:   ${parseErrors.length} lines skipped`);
  }

  // ── Per-request duration table ──────────────────────────────────────────
  if (analyses.length > 0) {
    console.log('\n── Per-request stage durations (ms) ──────────────────────────\n');
    const stageKeys = STAGES.map((s) => `${s.from}→${s.to}`);
    const headers = ['#', 'Corr-ID (truncated)', ...STAGES.map((s) => s.label), 'Complete'];
    const rows = analyses.map((a, i) => {
      const id = a.correlationId.length > 16
        ? `…${a.correlationId.slice(-14)}`
        : a.correlationId;
      const stageCells = stageKeys.map((k) =>
        k in a.stageDurations ? fmt(a.stageDurations[k]) : '—'
      );
      return [String(i + 1), id, ...stageCells, a.isComplete ? 'yes' : 'no'];
    });
    printTable(rows, headers);
  }

  // ── Aggregate statistics (complete traces only) ──────────────────────────
  if (complete.length > 0) {
    console.log('\n── Aggregate statistics (complete traces only) ────────────────\n');
    const stageKeys = STAGES.map((s) => `${s.from}→${s.to}`);
    const rows = STAGES.map((stage) => {
      const key = `${stage.from}→${stage.to}`;
      const vals = complete
        .map((a) => a.stageDurations[key])
        .filter((v) => typeof v === 'number' && !isNaN(v));
      if (vals.length === 0) return [stage.label, '—', '—', '—', '—', '—', '0'];
      const s = stats(vals);
      const totalKey = 'client_prompt_submitted→response_rendered';
      const shareStr = key === totalKey
        ? '100%'
        : complete.map((a) => {
            const total = a.stageDurations[totalKey];
            const part  = a.stageDurations[key];
            return (total && part !== undefined) ? part / total : null;
          }).filter(Boolean).reduce((sum, r, _, arr) => sum + r / arr.length, 0) > 0
          ? (complete.map((a) => {
              const total = a.stageDurations[totalKey];
              const part  = a.stageDurations[key];
              return (total && part !== undefined) ? part / total : null;
            }).filter(Boolean).reduce((sum, r, _, arr) => sum + r / arr.length, 0) * 100).toFixed(0) + '%'
          : '—';
      return [
        stage.label,
        fmt(s.median),
        fmt(s.min),
        fmt(s.max),
        fmt(s.avg),
        s.p90 !== null ? fmt(s.p90) : '(n<10)',
        String(vals.length),
      ];
    });
    printTable(rows, ['Stage', 'Median', 'Min', 'Max', 'Avg', 'P90', 'n']);
  } else {
    console.log('\n(No complete traces — aggregate statistics not available)');
  }

  // ── Incomplete and abnormal traces ──────────────────────────────────────
  if (incomplete.length > 0) {
    console.log('\n── Incomplete traces ──────────────────────────────────────────\n');
    for (const a of incomplete) {
      const id = a.correlationId.length > 32
        ? `…${a.correlationId.slice(-30)}`
        : a.correlationId;
      console.log(`  ${id}`);
      if (a.missing.length > 0) {
        console.log(`    Missing:     ${a.missing.join(', ')}`);
      }
      if (a.anomalies.length > 0) {
        for (const note of a.anomalies) {
          console.log(`    Anomaly:     ${note}`);
        }
      }
    }
  }

  // ── All anomalies ────────────────────────────────────────────────────────
  const allAnomalies = analyses.filter((a) => a.anomalies.length > 0);
  if (allAnomalies.length > 0) {
    console.log('\n── Anomalies in all traces ────────────────────────────────────\n');
    for (const a of allAnomalies) {
      const id = a.correlationId.length > 32
        ? `…${a.correlationId.slice(-30)}`
        : a.correlationId;
      for (const note of a.anomalies) {
        console.log(`  ${id}: ${note}`);
      }
    }
  }

  // ── Parse errors ─────────────────────────────────────────────────────────
  if (parseErrors.length > 0) {
    console.log('\n── Parse errors ───────────────────────────────────────────────\n');
    for (const e of parseErrors) {
      console.log(`  Line ${e.lineNum}: ${e.reason}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: npm run performance:analyze -- <log-file>');
    process.exit(1);
  }

  const { events, parseErrors } = await parseLogFile(filePath).catch((err) => {
    console.error(`Cannot read log file: ${err.message}`);
    process.exit(1);
  });

  const traces = groupIntoTraces(events);
  const analyses = Array.from(traces.entries()).map(([corr, trace]) =>
    analyzeTrace(corr, trace)
  );

  report(analyses, parseErrors);
}

// Run main only when executed directly (not when imported by tests).
const isMain = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/\\/g, '/').split('/').pop()
);
if (isMain) main();

// Export internals for tests.
export {
  parseLogFile,
  groupIntoTraces,
  analyzeTrace,
  stats,
  STAGES,
  ORDERED_EVENTS,
  REQUIRED_FOR_COMPLETE,
};
