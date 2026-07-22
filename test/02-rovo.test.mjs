// test/02-rovo.test.mjs
// Covers: Rovo outgoing request payload construction (lib/rovo.js).
// fetch is replaced per-test; no real HTTP calls are made.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fireRovo } from '../lib/rovo.ts';

// --- helpers ---

function withEnv(key, value, fn) {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

function withFetchMock(mockFn, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn;
  try {
    return fn();
  } finally {
    globalThis.fetch = original;
  }
}

const DUMMY_URL = 'https://rovo.example.com/webhook/123';
const DUMMY_SECRET = 'test-webhook-secret';

// --- tests ---

test('missing ROVO_WEBHOOK_URL throws before any network call', async () => {
  let fetchCalled = false;
  await withEnv('ROVO_WEBHOOK_URL', undefined, () =>
    withEnv('ROVO_WEBHOOK_SECRET', DUMMY_SECRET, () =>
      withFetchMock(async () => { fetchCalled = true; return new Response('', { status: 200 }); }, () =>
        assert.rejects(
          () => fireRovo({ sessionId: 's1', correlationId: 'c1', prompt: 'hi', callbackUrl: 'https://cb.example.com/api/webhook/callback' }),
          /ROVO_WEBHOOK_URL/
        )
      )
    )
  );
  assert.ok(!fetchCalled, 'fetch must not be called when URL is missing');
});

test('missing ROVO_WEBHOOK_SECRET throws before any network call', async () => {
  let fetchCalled = false;
  await withEnv('ROVO_WEBHOOK_URL', DUMMY_URL, () =>
    withEnv('ROVO_WEBHOOK_SECRET', undefined, () =>
      withFetchMock(async () => { fetchCalled = true; return new Response('', { status: 200 }); }, () =>
        assert.rejects(
          () => fireRovo({ sessionId: 's1', correlationId: 'c1', prompt: 'hi', callbackUrl: 'https://cb.example.com/api/webhook/callback' }),
          /ROVO_WEBHOOK_SECRET/
        )
      )
    )
  );
  assert.ok(!fetchCalled);
});

test('fireRovo sends the correct payload fields', async () => {
  let capturedBody;
  const payload = {
    sessionId: 'session-abc',
    correlationId: 'corr-xyz',
    prompt: 'What is the policy?',
    callbackUrl: 'https://my-tunnel.trycloudflare.com/api/webhook/callback',
  };

  await withEnv('ROVO_WEBHOOK_URL', DUMMY_URL, () =>
    withEnv('ROVO_WEBHOOK_SECRET', DUMMY_SECRET, () =>
      withFetchMock(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return new Response('{}', { status: 200 });
      }, () => fireRovo(payload))
    )
  );

  assert.strictEqual(capturedBody.sessionId, 'session-abc');
  assert.strictEqual(capturedBody.correlationId, 'corr-xyz');
  assert.strictEqual(capturedBody.prompt, 'What is the policy?');
  assert.strictEqual(capturedBody.callbackUrl, 'https://my-tunnel.trycloudflare.com/api/webhook/callback');
});

test('callbackUrl in payload ends with /api/webhook/callback', async () => {
  let capturedBody;
  const cbUrl = 'https://abc.trycloudflare.com/api/webhook/callback';

  await withEnv('ROVO_WEBHOOK_URL', DUMMY_URL, () =>
    withEnv('ROVO_WEBHOOK_SECRET', DUMMY_SECRET, () =>
      withFetchMock(async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return new Response('{}', { status: 200 });
      }, () => fireRovo({ sessionId: 's', correlationId: 'c', prompt: 'q', callbackUrl: cbUrl }))
    )
  );

  assert.ok(capturedBody.callbackUrl.endsWith('/api/webhook/callback'));
});

test('webhook secret is sent as X-Automation-Webhook-Token header', async () => {
  let capturedHeaders;

  await withEnv('ROVO_WEBHOOK_URL', DUMMY_URL, () =>
    withEnv('ROVO_WEBHOOK_SECRET', DUMMY_SECRET, () =>
      withFetchMock(async (_url, options) => {
        capturedHeaders = options.headers;
        return new Response('{}', { status: 200 });
      }, () => fireRovo({ sessionId: 's', correlationId: 'c', prompt: 'q', callbackUrl: 'https://cb.example.com/api/webhook/callback' }))
    )
  );

  assert.strictEqual(capturedHeaders['X-Automation-Webhook-Token'], DUMMY_SECRET);
});

test('non-200 response throws with status code in message', async () => {
  await withEnv('ROVO_WEBHOOK_URL', DUMMY_URL, () =>
    withEnv('ROVO_WEBHOOK_SECRET', DUMMY_SECRET, () =>
      withFetchMock(async () => new Response('Bad gateway', { status: 502 }), () =>
        assert.rejects(
          () => fireRovo({ sessionId: 's', correlationId: 'c', prompt: 'q', callbackUrl: 'https://cb.example.com/api/webhook/callback' }),
          /502/
        )
      )
    )
  );
});

test('successful 200 response returns true', async () => {
  const result = await withEnv('ROVO_WEBHOOK_URL', DUMMY_URL, () =>
    withEnv('ROVO_WEBHOOK_SECRET', DUMMY_SECRET, () =>
      withFetchMock(async () => new Response('{}', { status: 200 }), () =>
        fireRovo({ sessionId: 's', correlationId: 'c', prompt: 'q', callbackUrl: 'https://cb.example.com/api/webhook/callback' })
      )
    )
  );
  assert.strictEqual(result, true);
});
