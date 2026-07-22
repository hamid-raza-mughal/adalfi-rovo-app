// test/19-design-tokens-check.test.mjs
// Covers: stale-output detection (scripts/check-design-system.mts, the `tokens:check`
// script) — passes when committed outputs match the source JSON, fails when they don't.
// Runs the real CLI script as a subprocess since that's the actual artifact this behavior
// needs to be true of; the committed file is tampered and always restored in `finally`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const REPO_ROOT = new URL("../", import.meta.url);
const TOKENS_PATH = new URL("styles/tokens.generated.css", REPO_ROOT);
const CHECK_SCRIPT = new URL("scripts/check-design-system.mts", REPO_ROOT).pathname;

function runCheck() {
  try {
    const output = execFileSync(process.execPath, [CHECK_SCRIPT], { encoding: "utf-8", cwd: new URL(".", REPO_ROOT).pathname });
    return { exitCode: 0, output };
  } catch (err) {
    return { exitCode: err.status, output: err.stdout };
  }
}

test("passes when committed outputs match what the source JSON currently produces", () => {
  const result = runCheck();
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /OK: generated outputs match/);
});

test("fails when a committed generated file has been tampered with (stale)", () => {
  const original = readFileSync(TOKENS_PATH, "utf-8");
  try {
    writeFileSync(TOKENS_PATH, original + "\n/* tampered by test */\n", "utf-8");
    const result = runCheck();
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /STALE: styles\/tokens\.generated\.css/);
    assert.match(result.output, /FAILED: generated outputs do not match/);
  } finally {
    writeFileSync(TOKENS_PATH, original, "utf-8");
  }
});
