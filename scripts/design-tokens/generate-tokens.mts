// Part 2: generates styles/tokens.generated.css from a DesignSystemModel.
//
// Gating (fail-fast, no partial/guessed output):
//  1. Every variable must resolve cleanly (no missing target, no circular alias) in every
//     mode of its own collection — reuses the exact resolver Part 1 already proved correct.
//  2. Every variable's generated CSS custom property name must be unique.
// Either failure throws with full detail rather than emitting a best-effort file.

import type { DesignSystemModel, ParsedVariable } from "./parse.mts";
import { resolveVariableValue } from "./resolve.mts";
import { COLLECTION_NAMESPACE, cssCustomPropertyName } from "./naming.mts";
import { colorToCss, floatToCss, stringToCss } from "./units.mts";
import type { RawColor } from "./schema.mts";

const GENERATED_HEADER = (model: DesignSystemModel) => `/**
 * GENERATED FILE — do not hand-edit.
 * Source: ${model.meta.figma_file_name} (schema ${model.meta.schema_version}, exported ${model.meta.exported_at})
 * Produced by scripts/generate-design-system.mts from design-tokens/adalfi-design-tokens.json
 */`;

export function buildNameRegistry(model: DesignSystemModel): Map<string, string> {
  const registry = new Map<string, string>();
  const nameToVariableId = new Map<string, string>();
  const collisions: string[] = [];

  for (const variable of model.variablesById.values()) {
    const collection = model.collectionsById.get(variable.collectionId);
    const namespace = collection ? COLLECTION_NAMESPACE[collection.name] : undefined;
    if (!namespace) {
      throw new Error(
        `No CSS namespace mapping for collection "${collection?.name ?? variable.collectionId}" (variable "${variable.name}"). ` +
          `Add it to COLLECTION_NAMESPACE in naming.mts.`,
      );
    }

    const cssName = cssCustomPropertyName(namespace, variable.name);
    const existing = nameToVariableId.get(cssName);
    if (existing && existing !== variable.id) {
      collisions.push(`"${cssName}" claimed by both ${existing} and ${variable.id} (${variable.name})`);
      continue;
    }
    nameToVariableId.set(cssName, variable.id);
    registry.set(variable.id, cssName);
  }

  if (collisions.length > 0) {
    throw new Error(`Token generation aborted — duplicate generated names:\n  ${collisions.join("\n  ")}`);
  }

  return registry;
}

function verifyAllResolve(model: DesignSystemModel): void {
  const failures: string[] = [];
  for (const variable of model.variablesById.values()) {
    const collection = model.collectionsById.get(variable.collectionId);
    const modeIds = collection ? collection.modes.map((m) => m.id) : Object.keys(variable.valuesByMode);
    for (const modeId of modeIds) {
      const result = resolveVariableValue(model, variable.id, modeId);
      if (result.unresolved) {
        failures.push(`${variable.name} (mode ${modeId})`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Token generation aborted — unresolved or circular variable alias(es):\n  ${failures.join("\n  ")}`,
    );
  }
}

// The immediate (one-hop) CSS representation of a variable's value in a given mode: a
// converted literal, or a var() reference to the alias target's generated name. Does not
// flatten multi-hop aliases — that would defeat the point of generating CSS variables.
function immediateCssValue(
  model: DesignSystemModel,
  registry: Map<string, string>,
  variable: ParsedVariable,
  modeId: string,
): string {
  let value: (typeof variable.valuesByMode)[string] | undefined = variable.valuesByMode[modeId];
  if (!value) {
    const collection = model.collectionsById.get(variable.collectionId);
    const fallbackModeId = collection?.defaultModeId;
    value = fallbackModeId ? variable.valuesByMode[fallbackModeId] : undefined;
  }
  if (!value) {
    // Unreachable: verifyAllResolve() already proved every variable/mode resolves.
    throw new Error(`Internal error: no value for ${variable.name} in mode ${modeId}`);
  }

  if (value.kind === "alias") {
    const targetName = registry.get(value.variableId);
    if (!targetName) {
      throw new Error(`Internal error: alias target ${value.variableId} has no registered name`);
    }
    return `var(${targetName})`;
  }

  switch (variable.type) {
    case "COLOR":
      return colorToCss(value.value as RawColor);
    case "FLOAT":
      return floatToCss(value.value as number, variable.scopes).css;
    case "STRING":
      return stringToCss(value.value as string, variable.scopes);
    case "BOOLEAN":
      return String(value.value);
  }
}

function declarationLine(registry: Map<string, string>, model: DesignSystemModel, variable: ParsedVariable, modeId: string): string {
  const name = registry.get(variable.id)!;
  const value = immediateCssValue(model, registry, variable, modeId);
  const comment = variable.description ? ` /* ${variable.description} */` : "";
  return `  ${name}: ${value};${comment}`;
}

export function generateTokensCss(model: DesignSystemModel): string {
  verifyAllResolve(model);
  const registry = buildNameRegistry(model);

  const singleModeBlocks: string[] = [];
  let colorsCollection: DesignSystemModel["collections"][number] | undefined;

  for (const collection of model.collections) {
    const variables = [...model.variablesById.values()].filter((v) => v.collectionId === collection.id);
    if (collection.name === "colors") {
      colorsCollection = collection;
      continue;
    }
    if (collection.modes.length !== 1) {
      throw new Error(
        `Collection "${collection.name}" has ${collection.modes.length} modes but is not handled as multi-mode — ` +
          `Part 1's diagnostics only expected "colors" to be multi-mode. Update generate-tokens.mts if this changed.`,
      );
    }
    const modeId = collection.modes[0].id;
    singleModeBlocks.push(`  /* ${collection.name} */`);
    for (const variable of variables) {
      singleModeBlocks.push(declarationLine(registry, model, variable, modeId));
    }
  }

  const sections = [GENERATED_HEADER(model), "", `:root {\n${singleModeBlocks.join("\n")}\n}`];

  if (colorsCollection) {
    const variables = [...model.variablesById.values()].filter((v) => v.collectionId === colorsCollection!.id);
    const defaultMode = colorsCollection.modes.find((m) => m.id === colorsCollection!.defaultModeId);
    const otherModes = colorsCollection.modes.filter((m) => m.id !== colorsCollection!.defaultModeId);
    if (!defaultMode) {
      throw new Error(`Collection "colors" default_mode_id ${colorsCollection.defaultModeId} matches no declared mode`);
    }

    const defaultLines = variables.map((v) => declarationLine(registry, model, v, defaultMode.id));
    sections.push(
      `\n/* colors: ${defaultMode.name} (source-declared default) */`,
      `:root,\n[data-theme="${defaultMode.name.toLowerCase()}"] {\n${defaultLines.join("\n")}\n}`,
    );

    for (const mode of otherModes) {
      const lines = variables.map((v) => declarationLine(registry, model, v, mode.id));
      sections.push(`\n/* colors: ${mode.name} */`, `[data-theme="${mode.name.toLowerCase()}"] {\n${lines.join("\n")}\n}`);
    }
  }

  return sections.join("\n") + "\n";
}
