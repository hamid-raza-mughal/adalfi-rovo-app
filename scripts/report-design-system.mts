// tokens:report — a concise, human-readable summary of the current generation state:
// variables by category, styles by category, recipes generated, bindings resolved,
// duplicate aliases, unsupported constructs, mode asymmetry, warnings and errors.

import { buildPipeline, printDiagnostics } from "./design-tokens/pipeline.mts";

function main() {
  let pipeline: ReturnType<typeof buildPipeline>;
  try {
    pipeline = buildPipeline();
  } catch (err) {
    console.log(`FAILED: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  printDiagnostics(pipeline.diagnostics);

  const variablesByType = new Map<string, number>();
  for (const v of pipeline.model.variablesById.values()) variablesByType.set(v.type, (variablesByType.get(v.type) ?? 0) + 1);
  console.log("\nVariables by type:");
  for (const [type, n] of variablesByType) console.log(`  - ${type}: ${n}`);

  const singleModeCollections = pipeline.model.collections.filter((c) => c.modes.length === 1).map((c) => c.name);
  const multiModeCollections = pipeline.model.collections.filter((c) => c.modes.length > 1).map((c) => c.name);
  console.log("\nMode asymmetry:");
  console.log(`  - multi-mode: ${multiModeCollections.join(", ") || "(none)"}`);
  console.log(`  - single-mode: ${singleModeCollections.join(", ") || "(none)"}`);

  console.log("\nRecipes by category:");
  const byCategory = new Map<string, { generated: number; deduplicated: number; skipped: number }>();
  for (const entry of pipeline.manifest) {
    const bucket = byCategory.get(entry.category) ?? { generated: 0, deduplicated: 0, skipped: 0 };
    if (entry.generated) bucket.generated++;
    if (entry.deduplicated) bucket.deduplicated++;
    if (entry.skipped) bucket.skipped++;
    byCategory.set(entry.category, bucket);
  }
  for (const [category, counts] of byCategory) {
    console.log(`  - ${category}: ${counts.generated} generated, ${counts.deduplicated} deduplicated, ${counts.skipped} skipped`);
  }

  const unresolved = pipeline.manifest.filter((e) => e.unresolvedBindings.length > 0);
  console.log(`\nUnresolved bindings: ${unresolved.length} style(s)`);
  for (const e of unresolved) console.log(`  - ${e.styleName}: ${e.unresolvedBindings.join(", ")} (${e.reason ?? ""})`);

  const skipped = pipeline.manifest.filter((e) => e.skipped);
  console.log(`\nUnsupported/skipped constructs: ${skipped.length}`);
  for (const e of skipped) console.log(`  - ${e.styleName} (${e.category}/${e.kind}): ${e.reason ?? ""}`);

  const collisions = pipeline.manifest.filter((e) => e.namingCollision);
  console.log(`\nNaming collisions: ${collisions.length}`);
  for (const e of collisions) console.log(`  - ${e.styleName}: ${e.namingCollision}`);

  console.log(`\n${pipeline.diagnostics.ok && skipped.length === 0 ? "OK" : pipeline.diagnostics.ok ? "OK (with reported gaps above)" : "FAILED"}`);
  process.exitCode = pipeline.diagnostics.ok ? 0 : 1;
}

main();
