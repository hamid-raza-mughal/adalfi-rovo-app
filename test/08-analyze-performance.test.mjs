// test/08-analyze-performance.test.mjs
// Unit tests for scripts/analyze-performance.mjs
// Covers: complete traces, missing events, duplicates, out-of-order events,
// multiple correlation IDs, invalid JSON lines, no completed traces,
// correct median/duration calculations, and sensitive-data exclusion.
// Uses only in-memory fixture data and temp files — no real DB, Rovo, or Cloudflare.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const {
  parseLogFile,
  groupIntoTraces,
  analyzeTrace,
  stats,
  STAGES,
  REQUIRED_FOR_COMPLETE,
} = await import('../scripts/analyze-performance.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDir = join(tmpdir(), `perf-test-${randomUUID()}`);
mkdirSync(tempDir, { recursive: true });

process.on('exit', () => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function writeTempLog(lines) {
  const path = join(tempDir, `log-${randomUUID()}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

function makeEvent(event, extra = {}) {
  return JSON.stringify({ event, timestamp: new Date().toISOString(), ...extra });
}

/**
 * Build a complete trace fixture with realistic timestamps spread across ~3 seconds.
 * Offsets are in milliseconds from a base time.
 */
function makeCompleteTrace(correlationId, clientRequestId, baseMs = Date.now()) {
  const t = (offsetMs) => new Date(baseMs + offsetMs).toISOString();
  return [
    { event: 'client_prompt_submitted', timestamp: t(0),    clientRequestId, sessionId: 's-1' },
    { event: 'server_prompt_received',  timestamp: t(80),   clientRequestId, sessionId: 's-1' },
    { event: 'run_created',             timestamp: t(95),   correlationId, clientRequestId, sessionId: 's-1', runId: 'r-1', messageId: correlationId },
    { event: 'rovo_request_started',    timestamp: t(100),  correlationId, clientRequestId, sessionId: 's-1', runId: 'r-1', messageId: correlationId },
    { event: 'rovo_request_acknowledged', timestamp: t(350), correlationId, clientRequestId, sessionId: 's-1', runId: 'r-1', messageId: correlationId },
    { event: 'callback_received',       timestamp: t(2800) },
    { event: 'callback_validated',      timestamp: t(2810), correlationId, sessionId: 's-1', runId: 'r-1', messageId: correlationId },
    { event: 'database_update_completed', timestamp: t(2820), correlationId, sessionId: 's-1', runId: 'r-1', messageId: correlationId },
    { event: 'client_completion_detected', timestamp: t(5200), correlationId, clientRequestId, sessionId: 's-1' },
    { event: 'response_rendered',       timestamp: t(5250), correlationId, clientRequestId, sessionId: 's-1' },
  ];
}

// ---------------------------------------------------------------------------
// 1. parseLogFile — file reading and JSON parsing
// ---------------------------------------------------------------------------

test('parseLogFile reads a valid JSONL file and returns all events', async () => {
  const crid = randomUUID();
  const corr = randomUUID();
  const lines = makeCompleteTrace(corr, crid).map((e) => JSON.stringify(e));
  const path = writeTempLog(lines);
  const { events, parseErrors } = await parseLogFile(path);
  assert.strictEqual(events.length, 10);
  assert.strictEqual(parseErrors.length, 0);
});

test('parseLogFile silently skips non-JSON lines (server startup output) and records errors only for {-prefixed failures', async () => {
  const lines = [
    makeEvent('server_prompt_received', { clientRequestId: 'c-1' }),
    'this is plaintext server log output',   // silently skipped (no { prefix)
    '{ broken json {{{',                     // starts with {, fails to parse → parse error
    makeEvent('run_created', { correlationId: 'corr-1', clientRequestId: 'c-1' }),
    '   ',  // blank line — silently ignored
    '▲ Next.js 16.2.11 (Turbopack)',         // silently skipped
  ];
  const path = writeTempLog(lines);
  const { events, parseErrors } = await parseLogFile(path);
  assert.strictEqual(events.length, 2, 'must parse both valid JSON events');
  assert.strictEqual(parseErrors.length, 1, 'only the {-prefixed broken JSON is a parse error');
  assert.ok(parseErrors[0].reason.includes('JSON'));
});

test('parseLogFile skips entries missing required event field', async () => {
  const lines = [
    JSON.stringify({ timestamp: new Date().toISOString() }), // no event
    makeEvent('run_created', { correlationId: 'c-1' }),
  ];
  const path = writeTempLog(lines);
  const { events, parseErrors } = await parseLogFile(path);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(parseErrors.length, 1);
});

test('parseLogFile returns empty results for an empty file', async () => {
  const path = writeTempLog([]);
  const { events, parseErrors } = await parseLogFile(path);
  assert.strictEqual(events.length, 0);
  assert.strictEqual(parseErrors.length, 0);
});

// ---------------------------------------------------------------------------
// 2. groupIntoTraces — correlation and linkage logic
// ---------------------------------------------------------------------------

test('groupIntoTraces groups a complete trace by correlationId', () => {
  const corr = randomUUID();
  const crid = randomUUID();
  const events = makeCompleteTrace(corr, crid);
  const traces = groupIntoTraces(events);
  assert.ok(traces.has(corr), 'must have a trace for the correlationId');
  const trace = traces.get(corr);
  assert.ok(trace.events.some((e) => e.event === 'client_prompt_submitted'));
  assert.ok(trace.events.some((e) => e.event === 'server_prompt_received'));
  assert.ok(trace.events.some((e) => e.event === 'callback_received'));
  assert.ok(trace.events.some((e) => e.event === 'response_rendered'));
});

test('groupIntoTraces handles multiple distinct correlationIds', () => {
  const base = Date.now();
  const corr1 = randomUUID();
  const crid1 = randomUUID();
  const corr2 = randomUUID();
  const crid2 = randomUUID();
  // Place trace 2 well after trace 1 to avoid callback_received proximity conflicts.
  const events = [
    ...makeCompleteTrace(corr1, crid1, base),
    ...makeCompleteTrace(corr2, crid2, base + 20000),
  ];
  const traces = groupIntoTraces(events);
  assert.strictEqual(traces.size, 2);
  assert.ok(traces.has(corr1));
  assert.ok(traces.has(corr2));
  // Ensure callback_received events are not cross-assigned.
  const t1 = traces.get(corr1);
  const t2 = traces.get(corr2);
  const crInTrace1 = t1.events.filter((e) => e.event === 'callback_received');
  const crInTrace2 = t2.events.filter((e) => e.event === 'callback_received');
  assert.strictEqual(crInTrace1.length, 1, 'trace 1 must have exactly one callback_received');
  assert.strictEqual(crInTrace2.length, 1, 'trace 2 must have exactly one callback_received');
});

test('groupIntoTraces links server_prompt_received via clientRequestId', () => {
  const corr = randomUUID();
  const crid = randomUUID();
  const events = [
    { event: 'server_prompt_received', timestamp: new Date().toISOString(), clientRequestId: crid },
    { event: 'run_created', timestamp: new Date().toISOString(), correlationId: corr, clientRequestId: crid },
  ];
  const traces = groupIntoTraces(events);
  const trace = traces.get(corr);
  assert.ok(trace, 'trace must exist');
  assert.ok(trace.events.some((e) => e.event === 'server_prompt_received'));
});

test('groupIntoTraces links client_prompt_submitted via clientRequestId', () => {
  const corr = randomUUID();
  const crid = randomUUID();
  const events = [
    { event: 'client_prompt_submitted', timestamp: new Date().toISOString(), clientRequestId: crid },
    { event: 'run_created', timestamp: new Date().toISOString(), correlationId: corr, clientRequestId: crid },
  ];
  const traces = groupIntoTraces(events);
  const trace = traces.get(corr);
  assert.ok(trace, 'trace must exist');
  assert.ok(trace.events.some((e) => e.event === 'client_prompt_submitted'));
});

test('groupIntoTraces links callback_received to nearest preceding callback_validated', () => {
  const base = Date.now();
  const corr = randomUUID();
  const crid = randomUUID();
  const events = makeCompleteTrace(corr, crid, base);
  const traces = groupIntoTraces(events);
  const trace = traces.get(corr);
  assert.ok(trace.events.some((e) => e.event === 'callback_received'),
    'callback_received must be linked to the trace');
});

// ---------------------------------------------------------------------------
// 3. analyzeTrace — completeness, missing events, and stage durations
// ---------------------------------------------------------------------------

test('analyzeTrace marks a complete trace as isComplete:true', () => {
  const corr = randomUUID();
  const crid = randomUUID();
  const events = makeCompleteTrace(corr, crid);
  const traces = groupIntoTraces(events);
  const result = analyzeTrace(corr, traces.get(corr));
  assert.strictEqual(result.isComplete, true);
  assert.strictEqual(result.missing.length, 0);
});

test('analyzeTrace marks a trace missing callback_validated as isComplete:false', () => {
  const corr = randomUUID();
  const crid = randomUUID();
  const events = makeCompleteTrace(corr, crid).filter(
    (e) => e.event !== 'callback_validated' && e.event !== 'database_update_completed'
  );
  const traces = groupIntoTraces(events);
  const result = analyzeTrace(corr, traces.get(corr));
  assert.strictEqual(result.isComplete, false);
  assert.ok(result.missing.includes('callback_validated'));
});

test('analyzeTrace reports duplicate events', () => {
  const corr = randomUUID();
  const crid = randomUUID();
  const base = makeCompleteTrace(corr, crid);
  // Insert a duplicate run_created.
  const dup = { ...base.find((e) => e.event === 'run_created'), timestamp: new Date().toISOString() };
  const events = [...base, dup];
  const traces = groupIntoTraces(events);
  const result = analyzeTrace(corr, traces.get(corr));
  assert.ok(result.duplicates.includes('run_created'),
    'duplicate run_created must be reported');
  assert.ok(result.anomalies.some((a) => a.includes('duplicate') && a.includes('run_created')));
});

test('analyzeTrace reports out-of-order events', () => {
  const corr = randomUUID();
  const crid = randomUUID();
  const baseMs = Date.now();
  // rovo_request_acknowledged placed before rovo_request_started in time.
  const events = [
    { event: 'server_prompt_received',      timestamp: new Date(baseMs).toISOString(),       clientRequestId: crid },
    { event: 'run_created',                 timestamp: new Date(baseMs + 10).toISOString(),   correlationId: corr, clientRequestId: crid },
    { event: 'rovo_request_acknowledged',   timestamp: new Date(baseMs + 20).toISOString(),   correlationId: corr, clientRequestId: crid }, // before started!
    { event: 'rovo_request_started',        timestamp: new Date(baseMs + 30).toISOString(),   correlationId: corr, clientRequestId: crid },
    { event: 'callback_validated',          timestamp: new Date(baseMs + 100).toISOString(),  correlationId: corr },
    { event: 'database_update_completed',   timestamp: new Date(baseMs + 110).toISOString(),  correlationId: corr },
  ];
  const traces = groupIntoTraces(events);
  const result = analyzeTrace(corr, traces.get(corr));
  assert.ok(result.outOfOrder.length > 0, 'out-of-order must be detected');
  assert.ok(result.anomalies.some((a) => a.includes('out-of-order')));
});

test('analyzeTrace calculates correct stage durations', () => {
  const corr = randomUUID();
  const crid = randomUUID();
  const baseMs = Date.now();
  const events = makeCompleteTrace(corr, crid, baseMs);
  const traces = groupIntoTraces(events);
  const result = analyzeTrace(corr, traces.get(corr));

  // client_prompt_submitted → server_prompt_received should be ~80ms
  const key = 'client_prompt_submitted→server_prompt_received';
  assert.ok(key in result.stageDurations, `${key} must be present`);
  const dur = result.stageDurations[key];
  assert.ok(dur >= 75 && dur <= 85, `expected ~80ms, got ${dur}ms`);

  // TOTAL should be ~5250ms
  const total = result.stageDurations['client_prompt_submitted→response_rendered'];
  assert.ok(total !== undefined, 'total must be present');
  assert.ok(total >= 5240 && total <= 5260, `expected ~5250ms, got ${total}ms`);
});

test('analyzeTrace does not invent a duration when a required event is missing', () => {
  const corr = randomUUID();
  const crid = randomUUID();
  const events = makeCompleteTrace(corr, crid).filter(
    (e) => e.event !== 'rovo_request_acknowledged'
  );
  const traces = groupIntoTraces(events);
  const result = analyzeTrace(corr, traces.get(corr));
  // Stages that need rovo_request_acknowledged must be absent.
  assert.ok(!('rovo_request_started→rovo_request_acknowledged' in result.stageDurations));
  assert.ok(!('rovo_request_acknowledged→callback_received' in result.stageDurations));
});

// ---------------------------------------------------------------------------
// 4. stats — statistical calculations
// ---------------------------------------------------------------------------

test('stats returns correct min, max, avg, median for odd-length array', () => {
  const s = stats([100, 200, 300]);
  assert.strictEqual(s.min, 100);
  assert.strictEqual(s.max, 300);
  assert.ok(Math.abs(s.avg - 200) < 0.01);
  assert.strictEqual(s.median, 200);
  assert.strictEqual(s.p90, null); // n < 10
});

test('stats returns correct median for even-length array', () => {
  const s = stats([100, 200, 300, 400]);
  // median of [100,200,300,400] = (200+300)/2 = 250
  assert.strictEqual(s.median, 250);
});

test('stats returns p90 only when n >= 10', () => {
  const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const s = stats(vals);
  assert.ok(s.p90 !== null, 'p90 must be present for n=10');
  // p90 of sorted [10..100] → index ceil(10*0.9)-1 = 8 → value 90
  assert.strictEqual(s.p90, 90);
});

test('stats returns null for empty array', () => {
  const s = stats([]);
  assert.strictEqual(s, null);
});

test('stats handles a single value', () => {
  const s = stats([42]);
  assert.strictEqual(s.min, 42);
  assert.strictEqual(s.max, 42);
  assert.strictEqual(s.median, 42);
  assert.strictEqual(s.avg, 42);
  assert.strictEqual(s.p90, null);
});

// ---------------------------------------------------------------------------
// 5. No completed traces — incomplete-only sample
// ---------------------------------------------------------------------------

test('analyzeTrace handles a trace with no completed events correctly', () => {
  const corr = randomUUID();
  const crid = randomUUID();
  // Only the very first two events — nothing completes.
  const events = [
    { event: 'client_prompt_submitted', timestamp: new Date().toISOString(), clientRequestId: crid },
    { event: 'run_created', timestamp: new Date().toISOString(), correlationId: corr, clientRequestId: crid },
  ];
  const traces = groupIntoTraces(events);
  const result = analyzeTrace(corr, traces.get(corr));
  assert.strictEqual(result.isComplete, false);
  const required = result.missing;
  assert.ok(required.includes('server_prompt_received'));
  assert.ok(required.includes('callback_validated'));
});

// ---------------------------------------------------------------------------
// 6. Sensitive content must not appear in structured output
// ---------------------------------------------------------------------------

test('analyzeTrace result contains no raw prompt text or response content', () => {
  // Simulate a log where prompt/content slipped through somehow.
  const corr = randomUUID();
  const crid = randomUUID();
  const events = makeCompleteTrace(corr, crid).map((e) => ({
    ...e,
    // These fields are NOT in SAFE_FIELDS and must not be present in real logs,
    // but even if they somehow appear, analyzeTrace must not copy them forward.
    prompt: 'What is the Q3 budget?',
    content: 'The Q3 budget is $1.2M',
    token: 'secret-token',
  }));
  const traces = groupIntoTraces(events);
  const result = analyzeTrace(corr, traces.get(corr));

  // The result object carries only metadata IDs and numbers, never text.
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes('Q3 budget'), 'prompt text must not be in analyzeTrace output');
  assert.ok(!serialised.includes('$1.2M'), 'response content must not be in analyzeTrace output');
  assert.ok(!serialised.includes('secret-token'), 'tokens must not be in analyzeTrace output');
});

test('parseLogFile does not evaluate or execute content in log lines', async () => {
  const lines = [
    // Deliberately crafted injected lines that look like commands.
    '{"event":"server_prompt_received","timestamp":"2026-07-22T00:00:00.000Z","clientRequestId":"c-1","__proto__":{"polluted":true}}',
    makeEvent('run_created', { correlationId: 'corr-1', clientRequestId: 'c-1' }),
  ];
  const path = writeTempLog(lines);
  // Must not throw, must return parseable events.
  const { events } = await parseLogFile(path);
  assert.ok(events.length >= 1);
  // Prototype pollution must not have occurred.
  assert.strictEqual(({}).polluted, undefined);
});

// ---------------------------------------------------------------------------
// 7. groupIntoTraces with invalid / edge-case events
// ---------------------------------------------------------------------------

test('groupIntoTraces ignores events with no correlationId and no clientRequestId', () => {
  const events = [
    { event: 'server_prompt_received', timestamp: new Date().toISOString() }, // no IDs
    { event: 'run_created', timestamp: new Date().toISOString(), correlationId: 'corr-1', clientRequestId: 'crid-1' },
  ];
  const traces = groupIntoTraces(events);
  // server_prompt_received with no clientRequestId cannot be linked.
  const trace = traces.get('corr-1');
  const found = trace.events.find((e) => e.event === 'server_prompt_received');
  assert.ok(!found, 'orphan event with no clientRequestId must not be linked');
});

test('groupIntoTraces handles an empty event list', () => {
  const traces = groupIntoTraces([]);
  assert.strictEqual(traces.size, 0);
});

// ---------------------------------------------------------------------------
// 8. Correct exclusion of incomplete traces from aggregate completeness check
// ---------------------------------------------------------------------------

test('REQUIRED_FOR_COMPLETE list covers all critical server-side events', () => {
  for (const name of ['server_prompt_received', 'run_created', 'rovo_request_started',
    'rovo_request_acknowledged', 'callback_validated', 'database_update_completed']) {
    assert.ok(REQUIRED_FOR_COMPLETE.includes(name), `${name} must be in REQUIRED_FOR_COMPLETE`);
  }
});

test('a trace missing only client-side events is still marked complete if all server events are present', () => {
  // The spec's REQUIRED_FOR_COMPLETE deliberately excludes client-side events so that
  // server-only log captures (no browser) still yield useful aggregate statistics.
  const corr = randomUUID();
  const crid = randomUUID();
  // Remove client-side events only.
  const events = makeCompleteTrace(corr, crid).filter(
    (e) => !['client_prompt_submitted', 'client_completion_detected', 'response_rendered'].includes(e.event)
  );
  const traces = groupIntoTraces(events);
  const result = analyzeTrace(corr, traces.get(corr));
  assert.strictEqual(result.isComplete, true,
    'trace must be complete when all server-side required events are present');
});
