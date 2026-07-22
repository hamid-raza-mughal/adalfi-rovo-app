// test/09-rovoContracts.test.mjs
// Covers: lib/rovoContracts.ts — parseRovoCallbackBody, the runtime validator that guards
// the highest-risk trust boundary in the app (the public Rovo callback body). Pure unit
// tests: no database, no network, no route involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRovoCallbackBody } from '../lib/rovoContracts.ts';

// --- valid payloads ---

test('valid callback payload with all fields parses successfully', () => {
  const result = parseRovoCallbackBody({ correlationId: 'abc-123', status: 'ok', content: 'The answer.' });
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.data, { correlationId: 'abc-123', ok: true, content: 'The answer.' });
});

test('optional fields (status, content) may be omitted and default safely', () => {
  const result = parseRovoCallbackBody({ correlationId: 'abc-123' });
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.data, { correlationId: 'abc-123', ok: true, content: '' });
});

// --- malformed JSON handling (the route passes `null` here when JSON.parse threw) ---

test('null body (malformed JSON upstream) is rejected as missing correlationId', () => {
  const result = parseRovoCallbackBody(null);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'correlationId required');
});

test('non-object JSON bodies (string, number, array) are rejected the same way', () => {
  for (const raw of ['just a string', 42, ['array'], true]) {
    const result = parseRovoCallbackBody(raw);
    assert.strictEqual(result.valid, false, `expected rejection for ${JSON.stringify(raw)}`);
    assert.strictEqual(result.reason, 'correlationId required');
  }
});

// --- missing required field ---

test('missing correlationId is rejected', () => {
  const result = parseRovoCallbackBody({ status: 'ok', content: 'hi' });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'correlationId required');
});

test('empty-string correlationId is rejected (same as missing)', () => {
  const result = parseRovoCallbackBody({ correlationId: '' });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'correlationId required');
});

// --- invalid primitive types ---

test('non-string correlationId (number) is rejected, not silently coerced', () => {
  const result = parseRovoCallbackBody({ correlationId: 12345 });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'correlationId required');
});

test('non-string correlationId (object) is rejected', () => {
  const result = parseRovoCallbackBody({ correlationId: { nested: true } });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, 'correlationId required');
});

test('non-string content defaults to empty string instead of being rejected', () => {
  const result = parseRovoCallbackBody({ correlationId: 'abc-123', content: 12345 });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.data.content, '');
});

test('arbitrary non-"ok" status value (any type) collapses to ok:false, matching pre-existing behaviour', () => {
  for (const status of ['error', 'weird-value', 123, false, {}]) {
    const result = parseRovoCallbackBody({ correlationId: 'abc-123', status });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.data.ok, false, `expected ok:false for status=${JSON.stringify(status)}`);
  }
});

test('null status is treated as absent and defaults to ok:true', () => {
  const result = parseRovoCallbackBody({ correlationId: 'abc-123', status: null });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.data.ok, true);
});
