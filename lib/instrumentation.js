// lib/instrumentation.js
// Structured lifecycle instrumentation. Outputs one JSON line per event to stdout.
// Never throws; never logs sensitive data (content, URLs, secrets, stacks).

// Whitelist: only these field names may appear in a log entry alongside event+timestamp.
const SAFE_FIELDS = new Set([
  'clientRequestId', 'correlationId', 'sessionId', 'runId', 'messageId',
  'durationMs', 'durationFrom', 'status', 'matched',
  'promptLength', 'contentLength', 'contentPresent',
  'source', 'httpStatus',
]);

/**
 * Emit a structured lifecycle event to stdout as a single JSON line.
 *
 * @param {string} event  - Stable event name (e.g. 'run_created').
 * @param {object} meta   - Safe metadata. Only fields listed in SAFE_FIELDS are written.
 *                          Pass a client-generated 'timestamp' string to override the default.
 */
export function logEvent(event, meta = {}) {
  try {
    const entry = { event, timestamp: new Date().toISOString() };

    // Allow a pre-computed ISO timestamp (e.g. forwarded from the browser).
    if (meta && typeof meta === 'object' && typeof meta.timestamp === 'string') {
      entry.timestamp = meta.timestamp;
    }

    if (meta && typeof meta === 'object') {
      for (const key of SAFE_FIELDS) {
        if (key in meta && meta[key] !== undefined) {
          entry[key] = meta[key];
        }
      }
    }

    process.stdout.write(JSON.stringify(entry) + '\n');
  } catch {
    // Logging must never crash the application.
    try { process.stderr.write('[instrumentation] log failed\n'); } catch {} // eslint-disable-line no-empty
  }
}
