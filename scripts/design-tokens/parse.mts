// Parses the raw Figma export (schema.ts) into a normalized, fully-preserved intermediate model.
// This step does NOT flatten aliases into literals and does NOT emit CSS — later generation
// stages consume DesignSystemModel to produce tokens.generated.css / recipes.generated.css.

import { readFileSync } from "node:fs";
import type {
  RawColor,
  RawEffect,
  RawEffectStyle,
  RawExport,
  RawFieldBinding,
  RawGridStyle,
  RawPaint,
  RawPaintStyle,
  RawTextStyle,
  RawVariableType,
} from "./schema.mts";

export function loadRawExport(path: string): RawExport {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as RawExport;
}

export interface ParsedMode {
  id: string;
  name: string;
}

export interface ParsedCollection {
  id: string;
  key: string;
  name: string;
  modes: ParsedMode[];
  defaultModeId: string;
  remote: boolean;
}

// A variable's value in a given mode is either a literal or an alias to another variable.
// Kept unresolved here on purpose — resolve.ts walks this on demand.
export type ParsedValue =
  | { kind: "literal"; value: number | string | boolean | RawColor }
  | { kind: "alias"; variableId: string; aliasName?: string };

export interface ParsedVariable {
  id: string;
  key: string;
  name: string;
  collectionId: string;
  type: RawVariableType;
  valuesByMode: Record<string, ParsedValue>;
  scopes: string[];
  description: string;
  codeSyntax: Record<string, string>;
  remote: boolean;
}

// One normalized "field X is bound to variable Y" fact, regardless of which of the export's
// several raw shapes (paint bound_variables, text bound_variables, gradient stop boundVariables,
// effect bound_variables) it came from.
export interface ParsedBinding {
  field: string;
  variableId: string;
  variableName: string;
}

export interface ParsedGradientStop {
  color: RawColor;
  position: number;
  binding?: ParsedBinding;
}

export interface ParsedPaintLayer {
  type: string;
  visible: boolean;
  opacity: number;
  blendMode: string;
  color?: RawColor;
  gradientStops?: ParsedGradientStop[];
  gradientTransform?: number[][];
}

export type PaintStyleKind = "solid" | "gradient" | "multi" | "image" | "other";

export interface ParsedPaintStyle {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: PaintStyleKind;
  paints: ParsedPaintLayer[];
  bindings: ParsedBinding[];
}

export interface ParsedTextStyle {
  id: string;
  key: string;
  name: string;
  description: string;
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  letterSpacing: { unit: string; value: number };
  lineHeight: { unit: string; value?: number };
  paragraphSpacing: number;
  paragraphIndent: number;
  listSpacing: number;
  leadingTrim: string;
  hangingPunctuation: boolean;
  hangingList: boolean;
  textCase: string;
  textDecoration: string;
  textDecorationStyle: string | null;
  textDecorationSkipInk: boolean | null;
  textDecorationColor: RawColor | null;
  fontVariations: Record<string, number> | null;
  bindings: ParsedBinding[];
}

export interface ParsedEffect {
  type: string;
  visible: boolean;
  radius: number;
  color?: RawColor;
  offset?: { x: number; y: number };
  spread?: number;
  blendMode?: string;
  showShadowBehindNode?: boolean;
}

export interface ParsedEffectStyle {
  id: string;
  key: string;
  name: string;
  description: string;
  effects: ParsedEffect[];
  bindings: ParsedBinding[];
}

export interface ParsedGridStyle {
  id: string;
  key: string;
  name: string;
  description: string;
  layoutGrids: unknown[];
  bindings: ParsedBinding[];
}

export interface DesignSystemModel {
  meta: RawExport["meta"];
  collections: ParsedCollection[];
  collectionsById: Map<string, ParsedCollection>;
  variablesById: Map<string, ParsedVariable>;
  styles: {
    paint: ParsedPaintStyle[];
    text: ParsedTextStyle[];
    effect: ParsedEffectStyle[];
    grid: ParsedGridStyle[];
  };
}

function isLiteralValue(v: unknown): v is number | string | boolean | RawColor {
  if (v === null) return false;
  if (typeof v !== "object") return true;
  return (v as { type?: string }).type !== "VARIABLE_ALIAS";
}

function parseVariables(raw: RawExport): {
  variablesById: Map<string, ParsedVariable>;
} {
  const variablesById = new Map<string, ParsedVariable>();

  for (const item of raw.variables.items) {
    const valuesByMode: Record<string, ParsedValue> = {};
    for (const [modeId, rawValue] of Object.entries(item.values_by_mode)) {
      valuesByMode[modeId] = isLiteralValue(rawValue)
        ? { kind: "literal", value: rawValue }
        : { kind: "alias", variableId: rawValue.id, aliasName: rawValue.alias_name };
    }

    variablesById.set(item.id, {
      id: item.id,
      key: item.key,
      name: item.name,
      collectionId: item.collection_id,
      type: item.type,
      valuesByMode,
      scopes: item.scopes,
      description: item.description,
      codeSyntax: item.code_syntax,
      remote: item.remote,
    });
  }

  return { variablesById };
}

// Looks up a variable's display name for bindings that only carry a variable id
// (gradient stop bindings never carry alias_name — unlike paint/text/effect bindings).
function variableName(variablesById: Map<string, ParsedVariable>, variableId: string, fallback?: string): string {
  return variablesById.get(variableId)?.name ?? fallback ?? variableId;
}

function parseFieldBindings(
  bindings: RawFieldBinding[] | undefined,
  variablesById: Map<string, ParsedVariable>,
): ParsedBinding[] {
  if (!bindings) return [];
  return bindings.map((b) => {
    const index = b.paint_index ?? b.effect_index;
    const field = index !== undefined ? `${index}.${b.field}` : b.field;
    return {
      field,
      variableId: b.variable_id,
      variableName: variableName(variablesById, b.variable_id, b.alias_name),
    };
  });
}

function parsePaintStyle(style: RawPaintStyle, variablesById: Map<string, ParsedVariable>): ParsedPaintStyle {
  const bindings = parseFieldBindings(style.bound_variables, variablesById);

  const paints: ParsedPaintLayer[] = style.paints.map((paint: RawPaint, paintIndex) => {
    const gradientStops = paint.gradientStops?.map((stop, stopIndex) => {
      const boundColor = stop.boundVariables?.color;
      if (boundColor) {
        const binding: ParsedBinding = {
          field: `${paintIndex}.gradientStops[${stopIndex}].color`,
          variableId: boundColor.id,
          variableName: variableName(variablesById, boundColor.id),
        };
        bindings.push(binding);
        return { color: stop.color, position: stop.position, binding };
      }
      return { color: stop.color, position: stop.position };
    });

    return {
      type: paint.type,
      visible: paint.visible,
      opacity: paint.opacity,
      blendMode: paint.blendMode,
      color: paint.color,
      gradientStops,
      gradientTransform: paint.gradientTransform,
    };
  });

  let kind: PaintStyleKind = "other";
  if (paints.length > 1) kind = "multi";
  else if (paints[0]?.type === "SOLID") kind = "solid";
  else if (paints[0]?.type?.startsWith("GRADIENT")) kind = "gradient";
  else if (paints[0]?.type === "IMAGE") kind = "image";

  return {
    id: style.id,
    key: style.key,
    name: style.name,
    description: style.description,
    kind,
    paints,
    bindings,
  };
}

function parseTextStyle(style: RawTextStyle, variablesById: Map<string, ParsedVariable>): ParsedTextStyle {
  const bindings: ParsedBinding[] = Object.entries(style.bound_variables).map(([field, ref]) => ({
    field,
    variableId: ref.variable_id,
    variableName: variableName(variablesById, ref.variable_id, ref.alias_name),
  }));

  return {
    id: style.id,
    key: style.key,
    name: style.name,
    description: style.description,
    fontFamily: style.font_name.family,
    fontStyle: style.font_name.style,
    fontSize: style.font_size,
    letterSpacing: style.letter_spacing,
    lineHeight: style.line_height,
    paragraphSpacing: style.paragraph_spacing,
    paragraphIndent: style.paragraph_indent,
    listSpacing: style.list_spacing,
    leadingTrim: style.leading_trim,
    hangingPunctuation: style.hanging_punctuation,
    hangingList: style.hanging_list,
    textCase: style.text_case,
    textDecoration: style.text_decoration,
    textDecorationStyle: style.text_decoration_style,
    textDecorationSkipInk: style.text_decoration_skip_ink,
    textDecorationColor: style.text_decoration_color,
    fontVariations: style.font_variations,
    bindings,
  };
}

function parseEffectStyle(style: RawEffectStyle, variablesById: Map<string, ParsedVariable>): ParsedEffectStyle {
  const bindings = parseFieldBindings(style.bound_variables, variablesById);

  const effects: ParsedEffect[] = style.effects.map((effect: RawEffect) => ({
    type: effect.type,
    visible: effect.visible,
    radius: effect.radius,
    color: effect.color,
    offset: effect.offset,
    spread: effect.spread,
    blendMode: effect.blendMode,
    showShadowBehindNode: effect.showShadowBehindNode,
  }));

  return {
    id: style.id,
    key: style.key,
    name: style.name,
    description: style.description,
    effects,
    bindings,
  };
}

function parseGridStyle(style: RawGridStyle, variablesById: Map<string, ParsedVariable>): ParsedGridStyle {
  return {
    id: style.id,
    key: style.key,
    name: style.name,
    description: style.description,
    layoutGrids: style.layoutGrids ?? [],
    bindings: parseFieldBindings(style.bound_variables, variablesById),
  };
}

export function parseDesignSystem(raw: RawExport): DesignSystemModel {
  const { variablesById } = parseVariables(raw);

  const collections: ParsedCollection[] = raw.variables.collections.map((c) => ({
    id: c.id,
    key: c.key,
    name: c.name,
    modes: c.modes.map((m) => ({ id: m.modeId, name: m.name })),
    defaultModeId: c.default_mode_id,
    remote: c.remote,
  }));
  const collectionsById = new Map(collections.map((c) => [c.id, c]));

  return {
    meta: raw.meta,
    collections,
    collectionsById,
    variablesById,
    styles: {
      paint: raw.styles.paint.map((s) => parsePaintStyle(s, variablesById)),
      text: raw.styles.text.map((s) => parseTextStyle(s, variablesById)),
      effect: raw.styles.effect.map((s) => parseEffectStyle(s, variablesById)),
      grid: raw.styles.grid.map((s) => parseGridStyle(s, variablesById)),
    },
  };
}
