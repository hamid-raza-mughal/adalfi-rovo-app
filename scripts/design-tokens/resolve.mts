// Alias resolution over a parsed DesignSystemModel.
//
// A variable's value in a given mode can alias another variable. That other variable may
// belong to a different collection with an entirely different set of mode ids (e.g. a
// `colors` Dark/Light value pointing at a single-mode `border-scale` variable) — mode
// asymmetry across collections, not just within one. When the requested modeId doesn't
// exist on the target variable, we fall back to that variable's own collection default
// mode rather than assuming every collection shares the same mode namespace.

import type { RawColor } from "./schema.mts";
import type { DesignSystemModel } from "./parse.mts";

export interface ResolvedValue {
  literal: number | string | boolean | RawColor | undefined;
  // Every variable hopped through to reach the literal, in order (excludes the starting variable).
  aliasChain: Array<{ variableId: string; variableName: string }>;
  // True if resolution stopped early (missing variable, missing mode value, or a cycle).
  unresolved: boolean;
}

export function resolveVariableValue(
  model: DesignSystemModel,
  variableId: string,
  modeId: string,
  seen: Set<string> = new Set(),
): ResolvedValue {
  const aliasChain: ResolvedValue["aliasChain"] = [];

  let currentId = variableId;
  let currentModeId = modeId;

  while (true) {
    if (seen.has(currentId)) {
      return { literal: undefined, aliasChain, unresolved: true };
    }
    seen.add(currentId);

    const variable = model.variablesById.get(currentId);
    if (!variable) {
      return { literal: undefined, aliasChain, unresolved: true };
    }

    let value: (typeof variable.valuesByMode)[string] | undefined = variable.valuesByMode[currentModeId];
    if (!value) {
      // Mode asymmetry: this variable doesn't define a value for the requested mode
      // (e.g. it belongs to a single-mode collection). Fall back to its own collection's
      // default mode.
      const collection = model.collectionsById.get(variable.collectionId);
      const fallbackModeId = collection?.defaultModeId;
      value = fallbackModeId ? variable.valuesByMode[fallbackModeId] : undefined;
    }

    if (!value) {
      return { literal: undefined, aliasChain, unresolved: true };
    }

    if (value.kind === "literal") {
      return { literal: value.value, aliasChain, unresolved: false };
    }

    // value.kind === "alias" — hop to the aliased variable and keep the same requested
    // mode id; the asymmetry fallback above applies again on the next iteration if needed.
    const targetVariable = model.variablesById.get(value.variableId);
    aliasChain.push({
      variableId: value.variableId,
      variableName: targetVariable?.name ?? value.aliasName ?? value.variableId,
    });
    currentId = value.variableId;
    currentModeId = modeId;
  }
}
