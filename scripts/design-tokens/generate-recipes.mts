// Part 3: generates styles/recipes.generated.css (typography, paint/gradient, effect
// recipes) plus a structured manifest of every decision made — generated, deduplicated
// (a style that's a pure alias of a variable already in the token layer, so no recipe is
// worth duplicating), or skipped (genuinely unsupported, reported honestly rather than
// approximated). Part 9's diagnostics report is a thin serialization of this manifest, not
// a re-derivation of it.

import type { DesignSystemModel, ParsedBinding, ParsedPaintStyle, ParsedTextStyle, ParsedEffectStyle } from "./parse.mts";
import { resolveVariableValue } from "./resolve.mts";
import { buildNameRegistry } from "./generate-tokens.mts";
import { recipeClassName, recipeCustomPropertyName } from "./naming.mts";
import { colorToCss } from "./units.mts";
import { gradientTransformToAngleDeg, formatAngleDeg } from "./gradient.mts";
import type { RawColor } from "./schema.mts";

export interface RecipeManifestEntry {
  styleId: string;
  styleName: string;
  category: "paint" | "text" | "effect" | "grid";
  kind: string;
  generatedName?: string;
  boundVariables: { field: string; variableId: string; variableName: string; scopes: string[] }[];
  modeAvailability: string[];
  generated: boolean;
  deduplicated: boolean;
  skipped: boolean;
  reason?: string;
  unresolvedBindings: string[];
  namingCollision?: string;
}

function pxLiteral(n: number): string {
  return `${Math.round(n * 1000) / 1000}px`;
}
function quotedLiteral(s: string): string {
  return `"${s}"`;
}
function pctLiteral(n: number): string {
  return `${Math.round(n * 10000) / 100}%`;
}

const NAMED_WEIGHT: Record<string, number> = {
  Thin: 100,
  "Extra Light": 200,
  Light: 300,
  Regular: 400,
  Medium: 500,
  "Semi Bold": 600,
  Bold: 700,
  "Extra Bold": 800,
  Black: 900,
};

const TEXT_TRANSFORM: Record<string, string> = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize" };
const TEXT_DECORATION_CSS: Record<string, string> = { UNDERLINE: "underline", STRIKETHROUGH: "line-through" };

function computeModeAvailability(model: DesignSystemModel, boundVariableIds: string[]): string[] {
  const modes = new Set<string>();
  for (const variableId of boundVariableIds) {
    const variable = model.variablesById.get(variableId);
    if (!variable) continue;
    const collection = model.collectionsById.get(variable.collectionId);
    collection?.modes.forEach((m) => modes.add(m.name));
  }
  return [...modes];
}

// Resolves one style field to either a var() reference (binding present and its target
// exists) or a literal fallback (no binding, or binding target is missing — an unresolved
// binding, recorded by the caller rather than hidden).
function fieldValue(
  registry: Map<string, string>,
  bindings: ParsedBinding[],
  field: string,
  literal: string,
  unresolved: string[],
): string {
  const binding = bindings.find((b) => b.field === field);
  if (!binding) return literal;
  const cssName = registry.get(binding.variableId);
  if (!cssName) {
    unresolved.push(field);
    return literal;
  }
  return `var(${cssName})`;
}

function boundVariablesOf(model: DesignSystemModel, bindings: ParsedBinding[]) {
  return bindings.map((b) => ({
    field: b.field,
    variableId: b.variableId,
    variableName: model.variablesById.get(b.variableId)?.name ?? b.variableName,
    scopes: model.variablesById.get(b.variableId)?.scopes ?? [],
  }));
}

function generateTypography(model: DesignSystemModel, registry: Map<string, string>, manifest: RecipeManifestEntry[]): string[] {
  const blocks: string[] = [];
  for (const style of model.styles.text) {
    const unresolved: string[] = [];
    const className = recipeClassName("text-style", style.name);

    const fontFamily = fieldValue(registry, style.bindings, "fontFamily", quotedLiteral(style.fontFamily), unresolved);
    const fontSize = fieldValue(registry, style.bindings, "fontSize", pxLiteral(style.fontSize), unresolved);
    const fontWeight = fieldValue(
      registry,
      style.bindings,
      "fontWeight",
      String(NAMED_WEIGHT[style.fontStyle] ?? 400),
      unresolved,
    );
    const lineHeight = fieldValue(
      registry,
      style.bindings,
      "lineHeight",
      style.lineHeight.value !== undefined ? pxLiteral(style.lineHeight.value) : "normal",
      unresolved,
    );
    const letterSpacing = fieldValue(registry, style.bindings, "letterSpacing", pxLiteral(style.letterSpacing.value), unresolved);

    const declarations = [
      `font-family: ${fontFamily};`,
      `font-size: ${fontSize};`,
      `font-weight: ${fontWeight};`,
      `line-height: ${lineHeight};`,
      `letter-spacing: ${letterSpacing};`,
    ];
    const transform = TEXT_TRANSFORM[style.textCase];
    if (transform) declarations.push(`text-transform: ${transform};`);
    const decoration = TEXT_DECORATION_CSS[style.textDecoration];
    if (decoration) declarations.push(`text-decoration: ${decoration};`);

    blocks.push(`@utility ${className} {\n  ${declarations.join("\n  ")}\n}`);

    manifest.push({
      styleId: style.id,
      styleName: style.name,
      category: "text",
      kind: "typography",
      generatedName: className,
      boundVariables: boundVariablesOf(model, style.bindings),
      modeAvailability: computeModeAvailability(model, style.bindings.map((b) => b.variableId)),
      generated: true,
      deduplicated: false,
      skipped: false,
      reason:
        unresolved.length > 0
          ? `bound variable(s) not found in export for: ${unresolved.join(", ")}; used the style's own literal value(s)`
          : undefined,
      unresolvedBindings: unresolved,
    });
  }
  return blocks;
}

// A solid paint style's *effective* rendered color: the paint's own color, alpha-composited
// with the paint layer's opacity. Figma sometimes encodes the same alpha two ways — baked
// into color.a (most bound-color styles) or applied via paint.opacity on top of an opaque
// color (e.g. the `alphas/*` family) — both need comparing on equal footing here.
function effectivePaintColor(color: RawColor, opacity: number): RawColor {
  return { r: color.r, g: color.g, b: color.b, a: (color.a ?? 1) * opacity };
}

function colorsMatch(a: RawColor, b: RawColor): boolean {
  const round = (n: number) => Math.round(n * 255);
  const roundA = (n: number) => Math.round((n ?? 1) * 1000);
  return round(a.r) === round(b.r) && round(a.g) === round(b.g) && round(a.b) === round(b.b) && roundA(a.a ?? 1) === roundA(b.a ?? 1);
}

interface Emission {
  properties: string[];
  utilities: string[];
}

function generateSolidPaint(
  model: DesignSystemModel,
  registry: Map<string, string>,
  style: ParsedPaintStyle,
  manifest: RecipeManifestEntry[],
): Emission {
  const paint = style.paints[0];
  const binding = style.bindings.find((b) => b.field === "0.color");
  const boundVariables = boundVariablesOf(model, style.bindings);
  const modeAvailability = computeModeAvailability(model, style.bindings.map((b) => b.variableId));

  const literalCss = paint.color ? colorToCss(effectivePaintColor(paint.color, paint.opacity)) : undefined;

  if (!binding) {
    // No variable at all — this style IS the source of truth, generate from its literal.
    const className = recipeClassName("paint-style", style.name);
    const propName = recipeCustomPropertyName("paint-style", style.name);
    manifest.push({
      styleId: style.id,
      styleName: style.name,
      category: "paint",
      kind: "solid",
      generatedName: className,
      boundVariables,
      modeAvailability,
      generated: true,
      deduplicated: false,
      skipped: false,
      reason: "no bound variable; literal color is the source of truth",
      unresolvedBindings: [],
    });
    return { properties: [`${propName}: ${literalCss};`], utilities: [`@utility ${className} {\n  background-color: var(${propName});\n}`] };
  }

  const targetVariable = model.variablesById.get(binding.variableId);
  if (!targetVariable) {
    // Dangling reference (target no longer exists in the export) — fall back to the
    // style's own literal so a real recipe still comes out, and report the gap honestly.
    const className = recipeClassName("paint-style", style.name);
    const propName = recipeCustomPropertyName("paint-style", style.name);
    manifest.push({
      styleId: style.id,
      styleName: style.name,
      category: "paint",
      kind: "solid",
      generatedName: className,
      boundVariables,
      modeAvailability,
      generated: true,
      deduplicated: false,
      skipped: false,
      reason: "bound variable not found in export; used the style's own literal value",
      unresolvedBindings: ["0.color"],
    });
    return { properties: [`${propName}: ${literalCss};`], utilities: [`@utility ${className} {\n  background-color: var(${propName});\n}`] };
  }

  const collection = model.collectionsById.get(targetVariable.collectionId);
  const resolved = resolveVariableValue(model, targetVariable.id, collection?.defaultModeId ?? "");
  const variableColor = resolved.literal as RawColor | undefined;
  const isPureAlias =
    style.paints.length === 1 &&
    paint.blendMode === "NORMAL" &&
    style.bindings.length === 1 &&
    variableColor !== undefined &&
    literalCss !== undefined &&
    colorsMatch(effectivePaintColor(paint.color!, paint.opacity), variableColor);

  if (isPureAlias) {
    manifest.push({
      styleId: style.id,
      styleName: style.name,
      category: "paint",
      kind: "solid",
      boundVariables,
      modeAvailability,
      generated: false,
      deduplicated: true,
      skipped: false,
      reason: `identical to bound variable "${targetVariable.name}"; no separate recipe generated`,
      unresolvedBindings: [],
    });
    return { properties: [], utilities: [] };
  }

  // Bound, but the style's compositing (opacity/blend) changes the rendered result versus
  // the variable alone (e.g. sys/dark/Scrim: opacity applied on top of an already-alpha'd
  // variable). Use the style's own literal for fidelity; the variable is still recorded
  // above for traceability, just not used as the emitted value.
  const className = recipeClassName("paint-style", style.name);
  const propName = recipeCustomPropertyName("paint-style", style.name);
  manifest.push({
    styleId: style.id,
    styleName: style.name,
    category: "paint",
    kind: "solid",
    generatedName: className,
    boundVariables,
    modeAvailability,
    generated: true,
    deduplicated: false,
    skipped: false,
    reason: `bound variable "${targetVariable.name}" exists but style compositing (opacity/blend) yields a different color; used literal composited value for fidelity`,
    unresolvedBindings: [],
  });
  return { properties: [`${propName}: ${literalCss};`], utilities: [`@utility ${className} {\n  background-color: var(${propName});\n}`] };
}

function generateGradientStop(
  model: DesignSystemModel,
  registry: Map<string, string>,
  stop: { color: RawColor; position: number; binding?: ParsedBinding },
  unresolved: string[],
): string {
  let colorCss: string;
  if (stop.binding) {
    const cssName = registry.get(stop.binding.variableId);
    if (cssName) {
      colorCss = `var(${cssName})`;
    } else {
      unresolved.push(stop.binding.field);
      colorCss = colorToCss(stop.color);
    }
  } else {
    colorCss = colorToCss(stop.color);
  }
  return `${colorCss} ${pctLiteral(stop.position)}`;
}

function generateGradientPaint(
  model: DesignSystemModel,
  registry: Map<string, string>,
  style: ParsedPaintStyle,
  manifest: RecipeManifestEntry[],
): Emission {
  const paint = style.paints[0];
  const unresolved: string[] = [];
  const angle = formatAngleDeg(gradientTransformToAngleDeg(paint.gradientTransform ?? [[1, 0, 0], [0, 1, 0]]));
  const stops = (paint.gradientStops ?? []).map((s) => generateGradientStop(model, registry, s, unresolved));
  const value = `linear-gradient(${angle}, ${stops.join(", ")})`;

  const className = recipeClassName("paint-style", style.name);
  const propName = recipeCustomPropertyName("paint-style", style.name);

  manifest.push({
    styleId: style.id,
    styleName: style.name,
    category: "paint",
    kind: "gradient",
    generatedName: className,
    boundVariables: boundVariablesOf(model, style.bindings),
    modeAvailability: computeModeAvailability(model, style.bindings.map((b) => b.variableId)),
    generated: true,
    deduplicated: false,
    skipped: false,
    reason: `${stops.length}-stop linear gradient, angle derived from gradientTransform`,
    unresolvedBindings: unresolved,
  });

  return { properties: [`${propName}: ${value};`], utilities: [`@utility ${className} {\n  background-image: var(${propName});\n}`] };
}

function generateMultiPaint(
  model: DesignSystemModel,
  registry: Map<string, string>,
  style: ParsedPaintStyle,
  manifest: RecipeManifestEntry[],
): Emission {
  const allGradients = style.paints.every((p) => p.type.startsWith("GRADIENT"));
  if (!allGradients) {
    manifest.push({
      styleId: style.id,
      styleName: style.name,
      category: "paint",
      kind: "multi",
      boundVariables: boundVariablesOf(model, style.bindings),
      modeAvailability: [],
      generated: false,
      deduplicated: false,
      skipped: true,
      reason: "multi-paint style mixes non-gradient layers; layered CSS compositing for this combination is not supported — reporting rather than approximating",
      unresolvedBindings: [],
    });
    return { properties: [], utilities: [] };
  }

  const unresolved: string[] = [];
  // CSS background-image lists render first-listed on top; Figma's paints array stacks
  // later entries on top, so the list is reversed. (No real instance exists to verify
  // this against — see the manifest reason and the corresponding test fixture.)
  const layers = [...style.paints].reverse().map((paint) => {
    const angle = formatAngleDeg(gradientTransformToAngleDeg(paint.gradientTransform ?? [[1, 0, 0], [0, 1, 0]]));
    const stops = (paint.gradientStops ?? []).map((s) => generateGradientStop(model, registry, s, unresolved));
    return `linear-gradient(${angle}, ${stops.join(", ")})`;
  });

  const className = recipeClassName("paint-style", style.name);
  const propName = recipeCustomPropertyName("paint-style", style.name);
  manifest.push({
    styleId: style.id,
    styleName: style.name,
    category: "paint",
    kind: "multi",
    generatedName: className,
    boundVariables: boundVariablesOf(model, style.bindings),
    modeAvailability: computeModeAvailability(model, style.bindings.map((b) => b.variableId)),
    generated: true,
    deduplicated: false,
    skipped: false,
    reason: `${layers.length}-layer multi-paint (all gradient layers), stacking order assumed from Figma's paints array — unverified against a real example`,
    unresolvedBindings: unresolved,
  });
  return { properties: [`${propName}: ${layers.join(", ")};`], utilities: [`@utility ${className} {\n  background-image: var(${propName});\n}`] };
}

function generatePaint(model: DesignSystemModel, registry: Map<string, string>, manifest: RecipeManifestEntry[]): Emission {
  const properties: string[] = [];
  const utilities: string[] = [];
  const merge = (e: Emission) => {
    properties.push(...e.properties);
    utilities.push(...e.utilities);
  };

  for (const style of model.styles.paint) {
    if (style.kind === "multi") {
      merge(generateMultiPaint(model, registry, style, manifest));
    } else if (style.kind === "gradient") {
      merge(generateGradientPaint(model, registry, style, manifest));
    } else if (style.kind === "solid") {
      merge(generateSolidPaint(model, registry, style, manifest));
    } else {
      manifest.push({
        styleId: style.id,
        styleName: style.name,
        category: "paint",
        kind: style.kind,
        boundVariables: boundVariablesOf(model, style.bindings),
        modeAvailability: [],
        generated: false,
        deduplicated: false,
        skipped: true,
        reason: `unsupported paint type: ${style.paints[0]?.type ?? "unknown"}`,
        unresolvedBindings: [],
      });
    }
  }
  return { properties, utilities };
}

function generateEffects(model: DesignSystemModel, registry: Map<string, string>, manifest: RecipeManifestEntry[]): Emission {
  const properties: string[] = [];
  const utilities: string[] = [];
  for (const style of model.styles.effect) {
    const unresolved: string[] = [];
    const shadowParts: string[] = [];
    const layerBlurs: string[] = [];
    const backgroundBlurs: string[] = [];

    style.effects.forEach((effect, i) => {
      const f = (field: string, literal: string) => fieldValue(registry, style.bindings, `${i}.${field}`, literal, unresolved);
      if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
        const x = f("offsetX", pxLiteral(effect.offset?.x ?? 0));
        const y = f("offsetY", pxLiteral(effect.offset?.y ?? 0));
        const blur = f("radius", pxLiteral(effect.radius));
        const spread = f("spread", pxLiteral(effect.spread ?? 0));
        const color = effect.color ? colorToCss(effect.color) : "rgb(0 0 0 / 100%)";
        const inset = effect.type === "INNER_SHADOW" ? " inset" : "";
        shadowParts.push(`${x} ${y} ${blur} ${spread} ${color}${inset}`);
      } else if (effect.type === "LAYER_BLUR") {
        layerBlurs.push(`blur(${f("radius", pxLiteral(effect.radius))})`);
      } else if (effect.type === "BACKGROUND_BLUR") {
        backgroundBlurs.push(`blur(${f("radius", pxLiteral(effect.radius))})`);
      }
    });

    if (shadowParts.length === 0 && layerBlurs.length === 0 && backgroundBlurs.length === 0) {
      manifest.push({
        styleId: style.id,
        styleName: style.name,
        category: "effect",
        kind: "unsupported",
        boundVariables: boundVariablesOf(model, style.bindings),
        modeAvailability: [],
        generated: false,
        deduplicated: false,
        skipped: true,
        reason: "no supported effect types found (expected DROP_SHADOW/INNER_SHADOW/LAYER_BLUR/BACKGROUND_BLUR)",
        unresolvedBindings: [],
      });
      continue;
    }

    const className = recipeClassName("effect-style", style.name);
    const declarations: string[] = [];
    if (shadowParts.length > 0) {
      const propName = recipeCustomPropertyName("effect-style", style.name);
      properties.push(`${propName}: ${shadowParts.join(", ")};`);
      declarations.push(`box-shadow: var(${propName});`);
    }
    if (layerBlurs.length > 0) declarations.push(`filter: ${layerBlurs.join(" ")};`);
    if (backgroundBlurs.length > 0) declarations.push(`backdrop-filter: ${backgroundBlurs.join(" ")};`);

    utilities.push(`@utility ${className} {\n  ${declarations.join("\n  ")}\n}`);

    manifest.push({
      styleId: style.id,
      styleName: style.name,
      category: "effect",
      kind: shadowParts.length > 0 ? "shadow" : "blur",
      generatedName: className,
      boundVariables: boundVariablesOf(model, style.bindings),
      modeAvailability: computeModeAvailability(model, style.bindings.map((b) => b.variableId)),
      generated: true,
      deduplicated: false,
      skipped: false,
      unresolvedBindings: unresolved,
    });
  }
  return { properties, utilities };
}

const HEADER = (model: DesignSystemModel) => `/**
 * GENERATED FILE — do not hand-edit.
 * Source: ${model.meta.figma_file_name} (schema ${model.meta.schema_version}, exported ${model.meta.exported_at})
 * Produced by scripts/generate-design-system.mts from design-tokens/adalfi-design-tokens.json
 */`;

// Two different styles normalizing to the same generated class name would silently shadow
// one another in the cascade (last-declared wins) — detected and reported per style, and
// generation is aborted rather than shipping a silently-broken duplicate.
function detectNamingCollisions(manifest: RecipeManifestEntry[]): string[] {
  const byName = new Map<string, string[]>();
  for (const entry of manifest) {
    if (!entry.generatedName) continue;
    const ids = byName.get(entry.generatedName) ?? [];
    ids.push(entry.styleId);
    byName.set(entry.generatedName, ids);
  }

  const collisions: string[] = [];
  for (const [name, ids] of byName) {
    if (ids.length > 1) {
      collisions.push(`"${name}" claimed by styles ${ids.join(", ")}`);
      for (const entry of manifest) {
        if (entry.generatedName === name) entry.namingCollision = name;
      }
    }
  }
  return collisions;
}

export function generateRecipesCss(model: DesignSystemModel): { css: string; manifest: RecipeManifestEntry[] } {
  const registry = buildNameRegistry(model);
  const manifest: RecipeManifestEntry[] = [];

  const typography = generateTypography(model, registry, manifest);
  const paint = generatePaint(model, registry, manifest);
  const effects = generateEffects(model, registry, manifest);

  if (model.styles.grid.length === 0) {
    // Explicitly not silently ignored: there is nothing to generate because the source
    // export carries zero grid styles (diagnostics confirm this in Part 1/9's report).
  }

  const collisions = detectNamingCollisions(manifest);
  if (collisions.length > 0) {
    throw new Error(`Recipe generation aborted — duplicate generated names:\n  ${collisions.join("\n  ")}`);
  }

  const allProperties = [...paint.properties, ...effects.properties];
  const rootBlock = allProperties.length > 0 ? `:root {\n  ${allProperties.join("\n  ")}\n}` : "";
  const allUtilities = [...typography, ...paint.utilities, ...effects.utilities];

  const css = [HEADER(model), "", rootBlock, "", ...allUtilities, ""].join("\n");
  return { css, manifest };
}
