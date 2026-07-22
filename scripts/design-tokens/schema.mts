// Types mirroring the raw Figma design-tokens export exactly (design-tokens/adalfi-design-tokens.json).
// Field names intentionally match the JSON's snake_case/camelCase as exported — no renaming here.
// That normalization happens in parse.ts, which turns this raw shape into DesignSystemModel.

export interface RawMeta {
  schema_version: string;
  exported_at: string;
  figma_file_name: string;
  figma_file_key: string | null;
  plugin_version: string;
}

export interface RawDiagnostics {
  counts: Record<string, number>;
  warnings: Array<{ type: string; message: string }>;
}

export interface RawMode {
  modeId: string;
  name: string;
}

export interface RawCollection {
  id: string;
  key: string;
  name: string;
  modes: RawMode[];
  default_mode_id: string;
  remote: boolean;
}

export type RawVariableType = "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";

export interface RawColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

// Shape used inside variables.items[].values_by_mode when a mode's value is an alias
// to another variable, rather than a literal.
export interface RawVariableAlias {
  type: "VARIABLE_ALIAS";
  id: string;
  alias_name?: string;
}

export type RawVariableValue = number | string | boolean | RawColor | RawVariableAlias;

export interface RawVariable {
  id: string;
  key: string;
  name: string;
  collection_id: string;
  type: RawVariableType;
  values_by_mode: Record<string, RawVariableValue>;
  scopes: string[];
  code_syntax: Record<string, string>;
  description: string;
  remote: boolean;
}

// Shape used for bound_variables arrays attached to paint styles and effect styles.
// (Distinct from the alias shape above and from the text-style / gradient-stop shapes below —
// the export uses at least three different shapes for "this field is bound to a variable".)
export interface RawFieldBinding {
  paint_index?: number;
  effect_index?: number;
  field: string;
  variable_id: string;
  alias_name: string;
}

export interface RawGradientStopBinding {
  // Only ever seen keyed by "color" in this export, but keep it open — a future export
  // could bind other gradient stop fields.
  [field: string]: { type: "VARIABLE_ALIAS"; id: string } | undefined;
}

export interface RawGradientStop {
  color: RawColor;
  position: number;
  boundVariables?: RawGradientStopBinding;
}

export interface RawPaint {
  type: string; // "SOLID" | "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND" | "IMAGE" | ...
  visible: boolean;
  opacity: number;
  blendMode: string;
  color?: RawColor;
  gradientStops?: RawGradientStop[];
  gradientTransform?: number[][];
}

export interface RawPaintStyle {
  id: string;
  key: string;
  name: string;
  description: string;
  paints: RawPaint[];
  bound_variables: RawFieldBinding[];
}

export interface RawTextStyle {
  id: string;
  key: string;
  name: string;
  description: string;
  font_name: { family: string; style: string };
  font_size: number;
  letter_spacing: { unit: string; value: number };
  line_height: { unit: string; value?: number };
  paragraph_spacing: number;
  paragraph_indent: number;
  list_spacing: number;
  leading_trim: string;
  hanging_punctuation: boolean;
  hanging_list: boolean;
  text_case: string;
  text_decoration: string;
  text_decoration_style: string | null;
  text_decoration_offset: unknown;
  text_decoration_skip_ink: boolean | null;
  text_decoration_thickness: unknown;
  text_decoration_color: RawColor | null;
  font_variations: Record<string, number> | null;
  // Keyed by camelCase field name (fontSize, fontFamily, lineHeight, letterSpacing, fontWeight, ...) —
  // a third, distinct shape from RawFieldBinding and RawGradientStopBinding.
  bound_variables: Record<string, { variable_id: string; alias_name: string }>;
}

export interface RawEffect {
  type: string; // "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" | "BACKGROUND_BLUR"
  visible: boolean;
  radius: number;
  color?: RawColor;
  offset?: { x: number; y: number };
  spread?: number;
  blendMode?: string;
  showShadowBehindNode?: boolean;
}

export interface RawEffectStyle {
  id: string;
  key: string;
  name: string;
  description: string;
  effects: RawEffect[];
  bound_variables: RawFieldBinding[];
}

export interface RawGridStyle {
  id: string;
  key: string;
  name: string;
  description: string;
  layoutGrids?: unknown[];
  bound_variables?: RawFieldBinding[];
}

export interface RawExport {
  diagnostics: RawDiagnostics;
  meta: RawMeta;
  variables: {
    collections: RawCollection[];
    items: RawVariable[];
  };
  styles: {
    paint: RawPaintStyle[];
    text: RawTextStyle[];
    effect: RawEffectStyle[];
    grid: RawGridStyle[];
  };
}
