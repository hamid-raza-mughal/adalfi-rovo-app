// test/17-design-tokens-generate-recipes.test.mjs
// Covers: the style-recipe layer (generate-recipes.mts) — typography, solid paint
// (generated vs. deduplicated), gradients (2-stop and multi-stop, position preservation,
// transform-derived angle), style-to-variable binding, composed shadow generation,
// unsupported-style reporting, and recipe naming-collision detection.
//
// Typography/paint/gradient/effect cases use the real Figma export where real examples
// exist (multi-stop gradients genuinely appear in this data — no synthetic fixture
// needed there). Unsupported-construct and collision cases use synthetic fixtures since
// the real export currently contains none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateRecipesCss } from "../scripts/design-tokens/generate-recipes.mts";
import { loadRawExport, parseDesignSystem } from "../scripts/design-tokens/parse.mts";
import { makeVariable, makeCollection, makeModel, literal } from "./helpers/design-system-fixtures.mjs";

const SOURCE_PATH = new URL("../design-tokens/adalfi-design-tokens.json", import.meta.url);

function realModel() {
  const raw = loadRawExport(SOURCE_PATH.pathname);
  return parseDesignSystem(raw);
}

test("typography: generates a complete recipe with all bound fields as var() references", () => {
  const model = realModel();
  const { css, manifest } = generateRecipesCss(model);
  assert.match(
    css,
    /@utility text-style-display-lg-bold \{\s*\n\s*font-family: var\(--figma-type-display-lg-face\);\s*\n\s*font-size: var\(--figma-type-display-lg-size\);\s*\n\s*font-weight: var\(--figma-type-display-lg-bold\);\s*\n\s*line-height: var\(--figma-type-display-lg-leading\);\s*\n\s*letter-spacing: var\(--figma-type-display-lg-tracking\);\s*\n\}/,
  );
  const entry = manifest.find((e) => e.styleName === "display/lg/bold");
  assert.equal(entry.generated, true);
  assert.equal(entry.category, "text");
  assert.equal(entry.boundVariables.length, 5);
});

test("solid paint: a literal-only brand color is generated (no variable to alias)", () => {
  const model = realModel();
  const { css, manifest } = generateRecipesCss(model);
  assert.match(css, /--paint-style-brand-dark-green-1: rgb\(7 33 38 \/ 100%\);/);
  const entry = manifest.find((e) => e.styleName === "brand/Dark Green 1");
  assert.equal(entry.generated, true);
  assert.equal(entry.deduplicated, false);
  assert.equal(entry.boundVariables.length, 0);
});

test("solid paint: a pure 1:1 variable alias is deduplicated, not duplicated as its own recipe", () => {
  const model = realModel();
  const { css, manifest } = generateRecipesCss(model);
  assert.doesNotMatch(css, /paint-style-sys-dark-accents-primary/);
  const entry = manifest.find((e) => e.styleName === "sys/dark/accents/primary");
  assert.equal(entry.generated, false);
  assert.equal(entry.deduplicated, true);
  assert.match(entry.reason, /identical to bound variable/);
});

test("gradient: a real 2-stop gradient preserves both stops and their positions", () => {
  const model = realModel();
  const { css } = generateRecipesCss(model);
  const match = css.match(/--paint-style-linear-gradients-primary-green: (linear-gradient\([^;]*\));/);
  assert.ok(match, "expected the Primary Green gradient to be generated");
  const stopCount = (match[1].match(/%/g) ?? []).length;
  assert.equal(stopCount, 2);
  assert.match(match[1], /0%/);
  assert.match(match[1], /100%/);
});

test("gradient: real multi-stop gradients (3 and 4 stops) preserve every stop and position", () => {
  const model = realModel();
  const { css, manifest } = generateRecipesCss(model);

  const black = css.match(/--paint-style-linear-gradients-black: (linear-gradient\([^;]*\));/);
  assert.ok(black);
  assert.equal((black[1].match(/%/g) ?? []).length, 3);
  assert.match(black[1], /0%/);
  assert.match(black[1], /36%/);
  assert.match(black[1], /100%/);

  const grey = css.match(/--paint-style-linear-gradients-outline-grey: (linear-gradient\([^;]*\));/);
  assert.ok(grey);
  assert.equal((grey[1].match(/%/g) ?? []).length, 4);
  for (const pct of ["0%", "25%", "28%", "100%"]) assert.match(grey[1], new RegExp(pct));

  const entry = manifest.find((e) => e.styleName === "Linear Gradients/Outline Grey");
  assert.match(entry.reason, /4-stop/);
});

test("gradient: stop colors reference bound variables via var(), not flattened literals", () => {
  const model = realModel();
  const { css } = generateRecipesCss(model);
  const grey = css.match(/--paint-style-linear-gradients-outline-grey: (linear-gradient\([^;]*\));/)[1];
  assert.match(grey, /var\(--figma-color-gradient-linear-grdnt-6-lg4-stop-0\)/);
});

test("effect: the real drop-shadow style composes a complete, correctly-ordered box-shadow", () => {
  const model = realModel();
  const { css, manifest } = generateRecipesCss(model);
  assert.match(
    css,
    /--effect-style-dropdown-shadows-grid-header-effect: var\(--figma-effect-x-y-values-1\) var\(--figma-effect-x-y-values-1\) var\(--figma-effect-blur-4\) var\(--figma-effect-spread-0\) rgb\(0 0 0 \/ 25%\);/,
  );
  assert.match(css, /@utility effect-style-dropdown-shadows-grid-header-effect \{\s*\n\s*box-shadow: var\(--effect-style-dropdown-shadows-grid-header-effect\);\s*\n\}/);
  const entry = manifest.find((e) => e.category === "effect");
  assert.equal(entry.generated, true);
  assert.equal(entry.kind, "shadow");
});

test("unresolved binding: a dangling reference still produces a complete recipe via literal fallback", () => {
  const model = realModel();
  const { manifest } = generateRecipesCss(model);
  const entry = manifest.find((e) => e.styleName === "ref/m2/amber/amber_10");
  assert.equal(entry.generated, true);
  assert.deepEqual(entry.unresolvedBindings, ["0.color"]);
});

test("unsupported paint type is reported, not silently approximated", () => {
  const collection = makeCollection({ id: "colors", name: "colors", modes: [{ id: "m1", name: "Default" }], defaultModeId: "m1" });
  const model = makeModel({
    collections: [collection],
    variables: [],
    paint: [
      {
        id: "s1",
        key: "s1",
        name: "weird/image-fill",
        description: "",
        kind: "image",
        paints: [{ type: "IMAGE", visible: true, opacity: 1, blendMode: "NORMAL" }],
        bindings: [],
      },
    ],
  });

  const { css, manifest } = generateRecipesCss(model);
  assert.doesNotMatch(css, /weird-image-fill/);
  const entry = manifest.find((e) => e.styleName === "weird/image-fill");
  assert.equal(entry.skipped, true);
  assert.equal(entry.generated, false);
  assert.match(entry.reason, /unsupported paint type/);
});

test("multi-paint with a non-gradient layer is reported as unsupported rather than approximated", () => {
  const collection = makeCollection({ id: "colors", name: "colors", modes: [{ id: "m1", name: "Default" }], defaultModeId: "m1" });
  const model = makeModel({
    collections: [collection],
    variables: [],
    paint: [
      {
        id: "s1",
        key: "s1",
        name: "layered/mixed",
        description: "",
        kind: "multi",
        paints: [
          { type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r: 0, g: 0, b: 0 } },
          { type: "GRADIENT_LINEAR", visible: true, opacity: 1, blendMode: "NORMAL", gradientStops: [], gradientTransform: [[1, 0, 0], [0, 1, 0]] },
        ],
        bindings: [],
      },
    ],
  });

  const { manifest } = generateRecipesCss(model);
  const entry = manifest.find((e) => e.styleName === "layered/mixed");
  assert.equal(entry.skipped, true);
  assert.match(entry.reason, /mixes non-gradient layers/);
});

test("recipe naming collision aborts generation with a clear error", () => {
  const collection = makeCollection({ id: "colors", name: "colors", modes: [{ id: "m1", name: "Default" }], defaultModeId: "m1" });
  const model = makeModel({
    collections: [collection],
    variables: [],
    paint: [
      {
        id: "s1",
        key: "s1",
        name: "Foo/Bar",
        description: "",
        kind: "solid",
        paints: [{ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r: 0, g: 0, b: 0 } }],
        bindings: [],
      },
      {
        id: "s2",
        key: "s2",
        name: "foo/bar",
        description: "",
        kind: "solid",
        paints: [{ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: { r: 1, g: 1, b: 1 } }],
        bindings: [],
      },
    ],
  });

  assert.throws(() => generateRecipesCss(model), /duplicate generated names/i);
});
