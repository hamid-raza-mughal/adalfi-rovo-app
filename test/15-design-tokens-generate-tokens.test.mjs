// test/15-design-tokens-generate-tokens.test.mjs
// Covers: variable name-collision detection and Dark/Light mode token generation
// (generate-tokens.mts), the latter against the real Figma export since the point is
// proving the actual :root/[data-theme] structure and real per-mode values.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNameRegistry, generateTokensCss } from "../scripts/design-tokens/generate-tokens.mts";
import { loadRawExport, parseDesignSystem } from "../scripts/design-tokens/parse.mts";
import { makeVariable, makeCollection, makeModel, literal } from "./helpers/design-system-fixtures.mjs";

const SOURCE_PATH = new URL("../design-tokens/adalfi-design-tokens.json", import.meta.url);

test("buildNameRegistry throws on a genuine naming collision", () => {
  const collection = makeCollection({ id: "c1", name: "colors", modes: [{ id: "m1", name: "Default" }], defaultModeId: "m1" });
  // "Foo/Bar" and "foo/bar" normalize to the identical CSS custom property name.
  const a = makeVariable({ id: "v1", name: "Foo/Bar", collectionId: "c1", type: "COLOR", valuesByMode: { m1: literal({ r: 0, g: 0, b: 0 }) } });
  const b = makeVariable({ id: "v2", name: "foo/bar", collectionId: "c1", type: "COLOR", valuesByMode: { m1: literal({ r: 1, g: 1, b: 1 }) } });
  const model = makeModel({ collections: [collection], variables: [a, b] });

  assert.throws(() => buildNameRegistry(model), /duplicate generated names/i);
});

test("does not collide on distinct names", () => {
  const collection = makeCollection({ id: "c1", name: "colors", modes: [{ id: "m1", name: "Default" }], defaultModeId: "m1" });
  const a = makeVariable({ id: "v1", name: "a", collectionId: "c1", type: "COLOR", valuesByMode: { m1: literal({ r: 0, g: 0, b: 0 }) } });
  const b = makeVariable({ id: "v2", name: "b", collectionId: "c1", type: "COLOR", valuesByMode: { m1: literal({ r: 1, g: 1, b: 1 }) } });
  const model = makeModel({ collections: [collection], variables: [a, b] });

  const registry = buildNameRegistry(model);
  assert.equal(registry.size, 2);
});

test("generates a :root, [data-theme=dark] block and a [data-theme=light] block with the real export's per-mode values", () => {
  const raw = loadRawExport(SOURCE_PATH.pathname);
  const model = parseDesignSystem(raw);
  const css = generateTokensCss(model);

  assert.match(css, /:root,\s*\n\[data-theme="dark"\] \{/);
  assert.match(css, /\[data-theme="light"\] \{/);

  // System/Accents/primary: verified Dark=rgb(30 215 152 / 100%), Light=rgb(15 168 122 / 100%).
  const darkBlock = css.slice(css.indexOf('[data-theme="dark"]'), css.indexOf('[data-theme="light"]'));
  const lightBlock = css.slice(css.indexOf('[data-theme="light"]'));
  assert.match(darkBlock, /--figma-color-system-accents-primary: rgb\(30 215 152 \/ 100%\);/);
  assert.match(lightBlock, /--figma-color-system-accents-primary: rgb\(15 168 122 \/ 100%\);/);
});

test("single-mode collections are not wrapped in a [data-theme] selector", () => {
  const raw = loadRawExport(SOURCE_PATH.pathname);
  const model = parseDesignSystem(raw);
  const css = generateTokensCss(model);
  const flatRootBlock = css.slice(0, css.indexOf('[data-theme="dark"]'));
  assert.match(flatRootBlock, /--figma-border-radius-global-lg: 18px;/);
});

test("an aliased variable emits a var() reference, not a flattened literal", () => {
  const raw = loadRawExport(SOURCE_PATH.pathname);
  const model = parseDesignSystem(raw);
  const css = generateTokensCss(model);
  assert.match(css, /--figma-cta-large-cta-round: var\(--figma-border-radius-cta-base\);/);
});
