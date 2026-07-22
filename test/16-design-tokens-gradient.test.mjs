// test/16-design-tokens-gradient.test.mjs
// Covers: gradientTransformToAngleDeg (gradient.mts) — converting a Figma linear-gradient
// transform matrix into a CSS angle. Verified against simple, unambiguous cases plus the
// real transform from sys/dark/gradients/linear/prim_btn (Part 3 planning: dx=1, dy=0 -> 90deg).

import { test } from "node:test";
import assert from "node:assert/strict";
import { gradientTransformToAngleDeg, formatAngleDeg } from "../scripts/design-tokens/gradient.mts";

test("identity-like transform (pointing right) is 90deg", () => {
  const angle = gradientTransformToAngleDeg([[1, 0, 0], [0, 1, 0]]);
  assert.equal(Math.round(angle), 90);
});

test("direction pointing up is 0deg", () => {
  const angle = gradientTransformToAngleDeg([[0, 1, 0], [-1, 0, 0]]);
  assert.equal(Math.round(angle), 0);
});

test("direction pointing down is 180deg", () => {
  const angle = gradientTransformToAngleDeg([[0, 1, 0], [1, 0, 0]]);
  assert.equal(Math.round(angle), 180);
});

test("direction pointing left is 270deg", () => {
  const angle = gradientTransformToAngleDeg([[-1, 0, 0], [0, 1, 0]]);
  assert.equal(Math.round(angle), 270);
});

test("matches the real sys/dark/gradients/linear/prim_btn transform (~90deg, left to right)", () => {
  const angle = gradientTransformToAngleDeg([
    [1, -1.2356638230095779e-17, 3.555256683466395e-17],
    [6.956306882982082e-18, 0.11360510438680649, 0.44319742918014526],
  ]);
  assert.equal(Math.round(angle), 90);
});

test("formatAngleDeg rounds and appends the unit", () => {
  assert.equal(formatAngleDeg(90.00001), "90deg");
  assert.equal(formatAngleDeg(45.678), "45.68deg");
});
