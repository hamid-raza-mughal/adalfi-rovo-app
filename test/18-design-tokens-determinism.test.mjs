// test/18-design-tokens-determinism.test.mjs
// Covers: generation is deterministic — running the same source through the pipeline
// twice produces byte-identical tokens.generated.css, recipes.generated.css, and manifest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRawExport, parseDesignSystem } from "../scripts/design-tokens/parse.mts";
import { generateTokensCss } from "../scripts/design-tokens/generate-tokens.mts";
import { generateRecipesCss } from "../scripts/design-tokens/generate-recipes.mts";
import { manifestToJson } from "../scripts/design-tokens/pipeline.mts";

const SOURCE_PATH = new URL("../design-tokens/adalfi-design-tokens.json", import.meta.url);

test("tokens.generated.css is byte-identical across independent runs", () => {
  const raw = loadRawExport(SOURCE_PATH.pathname);
  const cssA = generateTokensCss(parseDesignSystem(raw));
  const cssB = generateTokensCss(parseDesignSystem(raw));
  assert.equal(cssA, cssB);
});

test("recipes.generated.css and its manifest are byte-identical across independent runs", () => {
  const raw = loadRawExport(SOURCE_PATH.pathname);
  const a = generateRecipesCss(parseDesignSystem(raw));
  const b = generateRecipesCss(parseDesignSystem(raw));
  assert.equal(a.css, b.css);
  assert.equal(manifestToJson(a.manifest), manifestToJson(b.manifest));
});
