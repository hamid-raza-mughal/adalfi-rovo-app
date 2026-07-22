// tokens:generate — regenerates tokens.generated.css, recipes.generated.css, and
// manifest.generated.json deterministically from design-tokens/adalfi-design-tokens.json.
// See scripts/design-tokens/pipeline.mts for the actual generation logic.

import { mkdirSync, writeFileSync } from "node:fs";
import {
  buildPipeline,
  manifestToJson,
  printDiagnostics,
  TOKENS_OUTPUT_PATH,
  RECIPES_OUTPUT_PATH,
  MANIFEST_OUTPUT_PATH,
} from "./design-tokens/pipeline.mts";

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

  mkdirSync(new URL(".", TOKENS_OUTPUT_PATH), { recursive: true });
  writeFileSync(TOKENS_OUTPUT_PATH, pipeline.tokensCss, "utf-8");
  const propertyCount = (pipeline.tokensCss.match(/^\s*--figma-/gm) ?? []).length;
  console.log(`\nOK: wrote ${TOKENS_OUTPUT_PATH.pathname} (${propertyCount} custom properties, ${pipeline.tokensCss.length} bytes)`);

  writeFileSync(RECIPES_OUTPUT_PATH, pipeline.recipesCss, "utf-8");
  console.log(`OK: wrote ${RECIPES_OUTPUT_PATH.pathname} (${pipeline.recipesCss.length} bytes)`);

  const manifestJson = manifestToJson(pipeline.manifest);
  writeFileSync(MANIFEST_OUTPUT_PATH, manifestJson, "utf-8");
  console.log(`OK: wrote ${MANIFEST_OUTPUT_PATH.pathname} (${pipeline.manifest.length} entries, ${manifestJson.length} bytes)`);

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
  const totalUnresolved = pipeline.manifest.reduce((n, e) => n + e.unresolvedBindings.length, 0);
  console.log(`  ${totalUnresolved} unresolved binding(s) across all recipes (fell back to literal values)`);

  process.exitCode = 0;
}

main();
