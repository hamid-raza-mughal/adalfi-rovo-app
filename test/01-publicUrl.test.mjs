// test/01-publicUrl.test.mjs
// Covers: public callback URL resolution logic (lib/publicUrl.js).
// RUNTIME_DIR is set per-test; no real .runtime/ directory is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// publicUrl.js reads RUNTIME_DIR at call time, so static import is fine.
import { getPublicBaseUrl, isLocalHost, TUNNEL_NOT_READY } from '../lib/publicUrl.js';

// --- helpers ---

const tempBase = join(tmpdir(), `rovo-publicurl-${randomUUID()}`);
mkdirSync(tempBase, { recursive: true });
process.on('exit', () => rmSync(tempBase, { recursive: true, force: true }));

function makeRequest(host = 'localhost:3000', extra = {}) {
  return new Request('http://localhost:3000/', {
    headers: { 'x-forwarded-host': host, ...extra },
  });
}

function withEnv(key, value, fn) {
  const saved = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

function withRuntimeFile(content) {
  const dir = join(tempBase, randomUUID());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'public-url.json'), content, 'utf8');
  return dir;
}

function withEmptyRuntime() {
  const dir = join(tempBase, randomUUID());
  mkdirSync(dir, { recursive: true });
  // no file written
  return dir;
}

// --- tests ---

test('PUBLIC_BASE_URL has highest priority over runtime file', () => {
  const runtimeDir = withRuntimeFile(JSON.stringify({ url: 'https://file-url.trycloudflare.com' }));
  const result = withEnv('RUNTIME_DIR', runtimeDir, () =>
    withEnv('PUBLIC_BASE_URL', 'https://override.example.com', () =>
      getPublicBaseUrl(makeRequest('my-tunnel.example.com'))
    )
  );
  assert.strictEqual(result, 'https://override.example.com');
});

test('PUBLIC_BASE_URL trailing slash is removed', () => {
  const result = withEnv('PUBLIC_BASE_URL', 'https://override.example.com/', () =>
    withEnv('RUNTIME_DIR', withEmptyRuntime(), () =>
      getPublicBaseUrl(makeRequest('localhost:3000'))
    )
  );
  assert.strictEqual(result, 'https://override.example.com');
});

test('PUBLIC_BASE_URL multiple trailing slashes removed', () => {
  const result = withEnv('PUBLIC_BASE_URL', 'https://override.example.com///', () =>
    withEnv('RUNTIME_DIR', withEmptyRuntime(), () =>
      getPublicBaseUrl(makeRequest('localhost:3000'))
    )
  );
  assert.strictEqual(result, 'https://override.example.com');
});

test('runtime file URL is used when no PUBLIC_BASE_URL', () => {
  const runtimeDir = withRuntimeFile(JSON.stringify({ url: 'https://abc123.trycloudflare.com' }));
  const result = withEnv('PUBLIC_BASE_URL', undefined, () =>
    withEnv('RUNTIME_DIR', runtimeDir, () =>
      getPublicBaseUrl(makeRequest('localhost:3000'))
    )
  );
  assert.strictEqual(result, 'https://abc123.trycloudflare.com');
});

test('runtime file URL trailing slash is removed', () => {
  const runtimeDir = withRuntimeFile(JSON.stringify({ url: 'https://abc123.trycloudflare.com/' }));
  const result = withEnv('PUBLIC_BASE_URL', undefined, () =>
    withEnv('RUNTIME_DIR', runtimeDir, () =>
      getPublicBaseUrl(makeRequest('localhost:3000'))
    )
  );
  assert.strictEqual(result, 'https://abc123.trycloudflare.com');
});

test('request x-forwarded-host fallback used when no file and no env', () => {
  const result = withEnv('PUBLIC_BASE_URL', undefined, () =>
    withEnv('RUNTIME_DIR', withEmptyRuntime(), () =>
      getPublicBaseUrl(makeRequest('real-tunnel.example.com'))
    )
  );
  assert.strictEqual(result, 'https://real-tunnel.example.com');
});

test('request x-forwarded-proto is honoured', () => {
  const result = withEnv('PUBLIC_BASE_URL', undefined, () =>
    withEnv('RUNTIME_DIR', withEmptyRuntime(), () =>
      getPublicBaseUrl(new Request('http://localhost:3000/', {
        headers: { 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'https' },
      }))
    )
  );
  assert.strictEqual(result, 'https://example.com');
});

test('localhost request without runtime file returns TUNNEL_NOT_READY', () => {
  const result = withEnv('PUBLIC_BASE_URL', undefined, () =>
    withEnv('RUNTIME_DIR', withEmptyRuntime(), () =>
      getPublicBaseUrl(new Request('http://localhost:3000/', { headers: { host: 'localhost:3000' } }))
    )
  );
  assert.strictEqual(result, TUNNEL_NOT_READY);
});

test('malformed runtime JSON does not crash and falls through', () => {
  const dir = join(tempBase, randomUUID());
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'public-url.json'), '{ NOT VALID JSON !!!', 'utf8');
  const result = withEnv('PUBLIC_BASE_URL', undefined, () =>
    withEnv('RUNTIME_DIR', dir, () =>
      getPublicBaseUrl(makeRequest('real-host.example.com'))
    )
  );
  // Fell through to request headers — real host → valid HTTPS URL
  assert.strictEqual(result, 'https://real-host.example.com');
});

test('empty url field in runtime JSON falls through', () => {
  const runtimeDir = withRuntimeFile(JSON.stringify({ url: '' }));
  const result = withEnv('PUBLIC_BASE_URL', undefined, () =>
    withEnv('RUNTIME_DIR', runtimeDir, () =>
      getPublicBaseUrl(makeRequest('my-host.example.com'))
    )
  );
  assert.strictEqual(result, 'https://my-host.example.com');
});

test('missing runtime file falls through to request headers', () => {
  const result = withEnv('PUBLIC_BASE_URL', undefined, () =>
    withEnv('RUNTIME_DIR', withEmptyRuntime(), () =>
      getPublicBaseUrl(makeRequest('fallback-host.example.com'))
    )
  );
  assert.strictEqual(result, 'https://fallback-host.example.com');
});

test('isLocalHost returns true for localhost', () => {
  assert.ok(isLocalHost('http://localhost:3000'));
});

test('isLocalHost returns true for 127.0.0.1', () => {
  assert.ok(isLocalHost('http://127.0.0.1:3000'));
});

test('isLocalHost returns false for public domain', () => {
  assert.ok(!isLocalHost('https://abc.trycloudflare.com'));
});

test('localhost-only request with 127.0.0.1 returns TUNNEL_NOT_READY', () => {
  const result = withEnv('PUBLIC_BASE_URL', undefined, () =>
    withEnv('RUNTIME_DIR', withEmptyRuntime(), () =>
      getPublicBaseUrl(new Request('http://127.0.0.1:3000/', { headers: { host: '127.0.0.1:3000' } }))
    )
  );
  assert.strictEqual(result, TUNNEL_NOT_READY);
});
