// Scope-aware conversion of a resolved literal variable value into a CSS value string.
//
// Priority order below is evidence-based, not guessed: several variables carry multiple
// scopes at once (e.g. `medium_cta/size` has scopes
// [TEXT_CONTENT, CORNER_RADIUS, WIDTH_HEIGHT, GAP, STROKE_FLOAT, OPACITY, FONT_VARIATIONS]
// with a literal value of 40) because Figma's `scopes` array lists every property panel a
// variable is *allowed* to be bound to, not a claim that its meaning is ambiguous. Checking
// the real values confirms these are dimensions (32, 40, ...) — never fractions in [0,1] —
// so any length-compatible scope must outrank OPACITY/FONT_VARIATIONS/TEXT_CONTENT, which
// only apply when no length scope is present.
import type { RawColor } from "./schema.mts";

const LENGTH_SCOPES = new Set([
  "CORNER_RADIUS",
  "WIDTH_HEIGHT",
  "GAP",
  "STROKE_FLOAT",
  "EFFECT_FLOAT",
  "FONT_SIZE",
  "LETTER_SPACING",
  "LINE_HEIGHT",
]);

export type UnitKind = "length" | "unitless-int" | "unitless-number" | "ambiguous";

export function classifyFloatUnit(scopes: string[]): UnitKind {
  if (scopes.some((s) => LENGTH_SCOPES.has(s))) return "length";
  if (scopes.includes("FONT_WEIGHT")) return "unitless-int";
  if (scopes.includes("OPACITY")) return "unitless-number";
  if (scopes.includes("FONT_VARIATIONS")) return "unitless-number";
  return "ambiguous";
}

function formatNumber(n: number, maxDecimals: number): string {
  const rounded = Number(n.toFixed(maxDecimals));
  return String(rounded);
}

export function colorToCss(color: RawColor): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = color.a ?? 1;
  const alphaPct = formatNumber(a * 100, 2);
  return `rgb(${r} ${g} ${b} / ${alphaPct}%)`;
}

export interface FloatConversion {
  css: string;
  unit: UnitKind;
}

export function floatToCss(value: number, scopes: string[]): FloatConversion {
  const unit = classifyFloatUnit(scopes);
  switch (unit) {
    case "length":
      return { css: `${formatNumber(value, 3)}px`, unit };
    case "unitless-int":
      return { css: formatNumber(value, 0), unit };
    case "unitless-number":
    case "ambiguous":
      return { css: formatNumber(value, 4), unit };
  }
}

export function stringToCss(value: string, scopes: string[]): string {
  if (scopes.includes("FONT_FAMILY")) return `"${value}"`;
  return `"${value}"`;
}
