// Shared pipeline: load -> parse -> verify -> generate. Used by all three CLI entry
// points (tokens:generate / tokens:check / tokens:report) so the actual generation logic
// exists in exactly one place — the three scripts differ only in what they DO with the
// result (write files, diff against committed files, or print a summary).

import { loadRawExport, parseDesignSystem } from "./parse.mts";
import { resolveVariableValue } from "./resolve.mts";
import { generateTokensCss } from "./generate-tokens.mts";
import { generateRecipesCss } from "./generate-recipes.mts";
import type { DesignSystemModel } from "./parse.mts";
import type { RecipeManifestEntry } from "./generate-recipes.mts";
import type { RawExport } from "./schema.mts";

export const SOURCE_PATH = new URL("../../design-tokens/adalfi-design-tokens.json", import.meta.url);
export const TOKENS_OUTPUT_PATH = new URL("../../styles/tokens.generated.css", import.meta.url);
export const RECIPES_OUTPUT_PATH = new URL("../../styles/recipes.generated.css", import.meta.url);
export const MANIFEST_OUTPUT_PATH = new URL("../../styles/manifest.generated.json", import.meta.url);

export interface CountCheck {
  label: string;
  actual: number;
  expected: number | undefined;
  ok: boolean;
}

export interface ResolutionCheck {
  attempts: number;
  unresolved: number;
  failures: string[];
}

export interface Diagnostics {
  meta: RawExport["meta"];
  collections: { name: string; modeNames: string[] }[];
  counts: CountCheck[];
  bindingsTotalCheck: CountCheck;
  gradientStopBindings: number;
  variableAliasCount: number;
  variableResolution: ResolutionCheck & { maxChainDepth: number };
  bindingResolution: ResolutionCheck & { total: number };
  paintKindCounts: Record<string, number>;
  ok: boolean;
}

function countCheck(label: string, actual: number, expected: number | undefined): CountCheck {
  return { label, actual, expected, ok: expected === undefined || actual === expected };
}

function checkAllVariablesResolve(model: DesignSystemModel): ResolutionCheck & { maxChainDepth: number } {
  let attempts = 0;
  let unresolved = 0;
  let maxChainDepth = 0;
  const failures: string[] = [];

  for (const variable of model.variablesById.values()) {
    const collection = model.collectionsById.get(variable.collectionId);
    const modeIds = collection ? collection.modes.map((m) => m.id) : Object.keys(variable.valuesByMode);
    for (const modeId of modeIds) {
      attempts++;
      const result = resolveVariableValue(model, variable.id, modeId);
      maxChainDepth = Math.max(maxChainDepth, result.aliasChain.length);
      if (result.unresolved) {
        unresolved++;
        failures.push(`${variable.name} (mode ${modeId})`);
      }
    }
  }
  return { attempts, unresolved, maxChainDepth, failures };
}

function checkAllBindingsResolve(model: DesignSystemModel): ResolutionCheck & { total: number } {
  const allBindings = [
    ...model.styles.paint.flatMap((s) => s.bindings.map((b) => ({ style: s.name, b }))),
    ...model.styles.text.flatMap((s) => s.bindings.map((b) => ({ style: s.name, b }))),
    ...model.styles.effect.flatMap((s) => s.bindings.map((b) => ({ style: s.name, b }))),
    ...model.styles.grid.flatMap((s) => s.bindings.map((b) => ({ style: s.name, b }))),
  ];

  let attempts = 0;
  let unresolved = 0;
  const failures: string[] = [];

  for (const { style, b } of allBindings) {
    const variable = model.variablesById.get(b.variableId);
    if (!variable) {
      attempts++;
      unresolved++;
      failures.push(`${style} -> ${b.field} (variable ${b.variableId} not found)`);
      continue;
    }
    const collection = model.collectionsById.get(variable.collectionId);
    const modeIds = collection ? collection.modes.map((m) => m.id) : [];
    for (const modeId of modeIds) {
      attempts++;
      const result = resolveVariableValue(model, b.variableId, modeId);
      if (result.unresolved) {
        unresolved++;
        failures.push(`${style} -> ${b.field} (${variable.name}, mode ${modeId})`);
      }
    }
  }
  return { total: allBindings.length, attempts, unresolved, failures };
}

export function runDiagnostics(raw: RawExport, model: DesignSystemModel): Diagnostics {
  const counts = raw.diagnostics.counts;
  const countChecks = [
    countCheck("variable collections", model.collections.length, counts.variable_collections),
    countCheck("variables", model.variablesById.size, counts.variables),
    countCheck("paint styles", model.styles.paint.length, counts.paint_styles),
    countCheck("text styles", model.styles.text.length, counts.text_styles),
    countCheck("effect styles", model.styles.effect.length, counts.effect_styles),
    countCheck("grid styles", model.styles.grid.length, counts.grid_styles),
  ];

  const paintBindingCount = model.styles.paint.reduce((n, s) => n + s.bindings.length, 0);
  const textBindingCount = model.styles.text.reduce((n, s) => n + s.bindings.length, 0);
  const effectBindingCount = model.styles.effect.reduce((n, s) => n + s.bindings.length, 0);
  const gridBindingCount = model.styles.grid.reduce((n, s) => n + s.bindings.length, 0);
  const totalStyleBindings = paintBindingCount + textBindingCount + effectBindingCount + gridBindingCount;

  const gradientStopBindings = model.styles.paint.reduce(
    (n, s) => n + s.paints.reduce((m, p) => m + (p.gradientStops?.filter((g) => g.binding).length ?? 0), 0),
    0,
  );

  const bindingsTotalCheck = countCheck(
    "style-field bindings (excl. gradient stops)",
    totalStyleBindings - gradientStopBindings,
    counts.bindings_total,
  );

  const variableAliasCount = [...model.variablesById.values()].reduce(
    (n, v) => n + Object.values(v.valuesByMode).filter((val) => val.kind === "alias").length,
    0,
  );

  const variableResolution = checkAllVariablesResolve(model);
  const bindingResolution = checkAllBindingsResolve(model);

  const paintKindCounts: Record<string, number> = {};
  for (const s of model.styles.paint) paintKindCounts[s.kind] = (paintKindCounts[s.kind] ?? 0) + 1;

  const ok = countChecks.every((c) => c.ok) && bindingsTotalCheck.ok && variableResolution.unresolved === 0;

  return {
    meta: raw.meta,
    collections: model.collections.map((c) => ({ name: c.name, modeNames: c.modes.map((m) => m.name) })),
    counts: countChecks,
    bindingsTotalCheck,
    gradientStopBindings,
    variableAliasCount,
    variableResolution,
    bindingResolution,
    paintKindCounts,
    ok,
  };
}

export interface Pipeline {
  raw: RawExport;
  model: DesignSystemModel;
  diagnostics: Diagnostics;
  tokensCss: string;
  recipesCss: string;
  manifest: RecipeManifestEntry[];
}

// Throws if parse-level diagnostics fail (mismatched counts, unresolved/circular variable
// aliases) or if token/recipe generation itself fails (naming collisions, unresolved
// *required* aliases) — callers decide how to report the failure.
export function buildPipeline(): Pipeline {
  const raw = loadRawExport(SOURCE_PATH.pathname);
  const model = parseDesignSystem(raw);
  const diagnostics = runDiagnostics(raw, model);
  if (!diagnostics.ok) {
    throw new Error("parse-level diagnostics failed");
  }
  const tokensCss = generateTokensCss(model);
  const { css: recipesCss, manifest } = generateRecipesCss(model);
  return { raw, model, diagnostics, tokensCss, recipesCss, manifest };
}

export function printDiagnostics(d: Diagnostics): void {
  console.log(`Design tokens: ${d.meta.figma_file_name} (schema ${d.meta.schema_version}, exported ${d.meta.exported_at})\n`);

  console.log("Collections:");
  for (const c of d.collections) console.log(`  - ${c.name}: ${c.modeNames.length} mode(s) [${c.modeNames.join(", ")}]`);

  console.log("\nCounts vs. source diagnostics:");
  for (const c of d.counts) {
    console.log(`  [${c.ok ? "OK" : "MISMATCH"}] ${c.label}: parsed=${c.actual}${c.expected !== undefined ? ` expected=${c.expected}` : ""}`);
  }
  console.log(
    `  [${d.bindingsTotalCheck.ok ? "OK" : "MISMATCH"}] ${d.bindingsTotalCheck.label}: ` +
      `parsed=${d.bindingsTotalCheck.actual} expected=${d.bindingsTotalCheck.expected}`,
  );
  console.log(`  [NOTE] + ${d.gradientStopBindings} additional gradient-stop bindings not counted in bindings_total`);
  console.log(`  [NOTE] + ${d.variableAliasCount} variable-to-variable aliases (also not counted in bindings_total)`);

  console.log("\nAlias resolution (every variable x every mode of its own collection):");
  console.log(
    `  ${d.variableResolution.attempts} resolution attempts, ${d.variableResolution.unresolved} unresolved, ` +
      `max alias chain depth = ${d.variableResolution.maxChainDepth}`,
  );
  for (const f of d.variableResolution.failures.slice(0, 10)) console.log(`  [UNRESOLVED] ${f}`);

  console.log(
    "\nBinding resolution (every style-field binding x every mode of its target variable's collection)" +
      " — informational, does not gate token generation:",
  );
  console.log(`  ${d.bindingResolution.total} bindings, ${d.bindingResolution.attempts} resolution attempts, ${d.bindingResolution.unresolved} unresolved`);
  for (const f of d.bindingResolution.failures.slice(0, 10)) console.log(`  [UNRESOLVED] ${f}`);

  console.log("\nPaint style kinds:");
  for (const [kind, n] of Object.entries(d.paintKindCounts)) console.log(`  - ${kind}: ${n}`);

  console.log(`\n${d.ok ? "OK" : "FAILED"}: parse-and-preserve verification ${d.ok ? "passed" : "found issues above"}.`);
}

export function manifestToJson(manifest: RecipeManifestEntry[]): string {
  // Deterministic ordering: manifest entries are already produced in source array order
  // (text, then paint, then effect) by generateRecipesCss, which is itself stable across
  // runs — JSON.stringify preserves that order and key order as written.
  return JSON.stringify(manifest, null, 2) + "\n";
}
