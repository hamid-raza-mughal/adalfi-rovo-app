// test/14-design-tokens-naming-units.test.mjs
// Covers: deterministic name normalization (naming.mts) and scope-aware unit conversion
// (units.mts), including the length-scope-wins-over-flexible-scope priority rule verified
// against real multi-scope variables in Part 2 (e.g. medium_cta/size).

import { test } from "node:test";
import assert from "node:assert/strict";
import { cssCustomPropertyName, recipeClassName, recipeCustomPropertyName } from "../scripts/design-tokens/naming.mts";
import { classifyFloatUnit, colorToCss, floatToCss, stringToCss } from "../scripts/design-tokens/units.mts";

test("cssCustomPropertyName normalizes mixed naming conventions to kebab-case", () => {
  assert.equal(cssCustomPropertyName("color", "System/Accents/primary"), "--figma-color-system-accents-primary");
  assert.equal(cssCustomPropertyName("cta", "large_cta/ic_size"), "--figma-cta-large-cta-ic-size");
  assert.equal(cssCustomPropertyName("layout", "8-scale/base"), "--figma-layout-8-scale-base");
  assert.equal(cssCustomPropertyName("effect", "X & Y Values/1"), "--figma-effect-x-y-values-1");
});

test("recipeClassName / recipeCustomPropertyName follow the same normalization", () => {
  assert.equal(recipeClassName("text-style", "display/lg/bold"), "text-style-display-lg-bold");
  assert.equal(recipeCustomPropertyName("paint-style", "brand/Dark Green 1"), "--paint-style-brand-dark-green-1");
});

test("classifyFloatUnit prefers a length scope over a flexible one when both are present", () => {
  // Mirrors medium_cta/size: scopes include OPACITY and FONT_VARIATIONS alongside
  // CORNER_RADIUS/WIDTH_HEIGHT/GAP/STROKE_FLOAT — real value is 40 (a dimension), not a
  // fraction in [0,1], so length must win.
  const scopes = ["TEXT_CONTENT", "CORNER_RADIUS", "WIDTH_HEIGHT", "GAP", "STROKE_FLOAT", "OPACITY", "FONT_VARIATIONS"];
  assert.equal(classifyFloatUnit(scopes), "length");
});

test("classifyFloatUnit falls back to the flexible scope only when no length scope is present", () => {
  assert.equal(classifyFloatUnit(["OPACITY"]), "unitless-number");
  assert.equal(classifyFloatUnit(["FONT_WEIGHT"]), "unitless-int");
  assert.equal(classifyFloatUnit(["FONT_VARIATIONS"]), "unitless-number");
  assert.equal(classifyFloatUnit(["ALL_SCOPES"]), "ambiguous");
});

test("floatToCss appends px only for length-scoped values", () => {
  assert.equal(floatToCss(40, ["WIDTH_HEIGHT"]).css, "40px");
  assert.equal(floatToCss(400, ["FONT_WEIGHT"]).css, "400");
  assert.equal(floatToCss(0.5, ["OPACITY"]).css, "0.5");
});

test("colorToCss converts 0-1 floats to rgb() with percentage alpha", () => {
  assert.equal(colorToCss({ r: 1, g: 0, b: 0 }), "rgb(255 0 0 / 100%)");
  assert.equal(colorToCss({ r: 0, g: 0, b: 0, a: 0.25 }), "rgb(0 0 0 / 25%)");
});

test("stringToCss quotes the value", () => {
  assert.equal(stringToCss("Inter", ["FONT_FAMILY"]), '"Inter"');
});
