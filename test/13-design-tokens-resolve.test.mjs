// test/13-design-tokens-resolve.test.mjs
// Covers: variable alias resolution (resolve.mts) — literal values, single- and multi-hop
// aliases, circular-alias detection, and mode-asymmetry fallback across collections.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVariableValue } from "../scripts/design-tokens/resolve.mts";
import { makeVariable, makeCollection, makeModel, literal, alias } from "./helpers/design-system-fixtures.mjs";

test("resolves a literal value directly", () => {
  const collection = makeCollection({ id: "c1", name: "test", modes: [{ id: "m1", name: "Default" }], defaultModeId: "m1" });
  const v = makeVariable({ id: "v1", name: "a", collectionId: "c1", valuesByMode: { m1: literal(4) } });
  const model = makeModel({ collections: [collection], variables: [v] });

  const result = resolveVariableValue(model, "v1", "m1");
  assert.equal(result.unresolved, false);
  assert.equal(result.literal, 4);
  assert.deepEqual(result.aliasChain, []);
});

test("resolves a single-hop alias, preserving the chain", () => {
  const collection = makeCollection({ id: "c1", name: "test", modes: [{ id: "m1", name: "Default" }], defaultModeId: "m1" });
  const target = makeVariable({ id: "v2", name: "target", collectionId: "c1", valuesByMode: { m1: literal(8) } });
  const source = makeVariable({ id: "v1", name: "source", collectionId: "c1", valuesByMode: { m1: alias("v2") } });
  const model = makeModel({ collections: [collection], variables: [source, target] });

  const result = resolveVariableValue(model, "v1", "m1");
  assert.equal(result.unresolved, false);
  assert.equal(result.literal, 8);
  assert.equal(result.aliasChain.length, 1);
  assert.equal(result.aliasChain[0].variableId, "v2");
});

test("resolves a multi-hop alias chain (depth > 1)", () => {
  const collection = makeCollection({ id: "c1", name: "test", modes: [{ id: "m1", name: "Default" }], defaultModeId: "m1" });
  const c = makeVariable({ id: "v3", name: "c", collectionId: "c1", valuesByMode: { m1: literal(16) } });
  const b = makeVariable({ id: "v2", name: "b", collectionId: "c1", valuesByMode: { m1: alias("v3") } });
  const a = makeVariable({ id: "v1", name: "a", collectionId: "c1", valuesByMode: { m1: alias("v2") } });
  const model = makeModel({ collections: [collection], variables: [a, b, c] });

  const result = resolveVariableValue(model, "v1", "m1");
  assert.equal(result.unresolved, false);
  assert.equal(result.literal, 16);
  assert.equal(result.aliasChain.length, 2);
  assert.deepEqual(result.aliasChain.map((h) => h.variableId), ["v2", "v3"]);
});

test("detects a circular alias instead of looping forever", () => {
  const collection = makeCollection({ id: "c1", name: "test", modes: [{ id: "m1", name: "Default" }], defaultModeId: "m1" });
  const a = makeVariable({ id: "v1", name: "a", collectionId: "c1", valuesByMode: { m1: alias("v2") } });
  const b = makeVariable({ id: "v2", name: "b", collectionId: "c1", valuesByMode: { m1: alias("v1") } });
  const model = makeModel({ collections: [collection], variables: [a, b] });

  const result = resolveVariableValue(model, "v1", "m1");
  assert.equal(result.unresolved, true);
});

test("reports unresolved when the alias target doesn't exist", () => {
  const collection = makeCollection({ id: "c1", name: "test", modes: [{ id: "m1", name: "Default" }], defaultModeId: "m1" });
  const a = makeVariable({ id: "v1", name: "a", collectionId: "c1", valuesByMode: { m1: alias("does-not-exist") } });
  const model = makeModel({ collections: [collection], variables: [a] });

  const result = resolveVariableValue(model, "v1", "m1");
  assert.equal(result.unresolved, true);
  assert.equal(result.literal, undefined);
});

test("falls back to a variable's own collection default mode when the requested mode doesn't exist on it (mode asymmetry)", () => {
  // Mirrors the real export: a multi-mode "colors" variable aliases a single-mode
  // "border-scale"-style variable. Resolving in Dark/Light mode ids that don't exist on
  // the target must fall back to the target's own default mode rather than failing.
  const colors = makeCollection({
    id: "colors",
    name: "colors",
    modes: [{ id: "dark", name: "Dark" }, { id: "light", name: "Light" }],
    defaultModeId: "dark",
  });
  const scale = makeCollection({ id: "scale", name: "border-scale", modes: [{ id: "default", name: "Default" }], defaultModeId: "default" });

  const target = makeVariable({ id: "v2", name: "radius/base", collectionId: "scale", valuesByMode: { default: literal(8) } });
  const source = makeVariable({
    id: "v1",
    name: "colorish",
    collectionId: "colors",
    valuesByMode: { dark: alias("v2"), light: alias("v2") },
  });
  const model = makeModel({ collections: [colors, scale], variables: [source, target] });

  const resultDark = resolveVariableValue(model, "v1", "dark");
  const resultLight = resolveVariableValue(model, "v1", "light");
  assert.equal(resultDark.unresolved, false);
  assert.equal(resultDark.literal, 8);
  assert.equal(resultLight.unresolved, false);
  assert.equal(resultLight.literal, 8);
});
