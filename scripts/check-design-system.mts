// tokens:check — fails if the committed generated outputs (tokens.generated.css,
// recipes.generated.css, manifest.generated.json) differ from what the supplied Figma JSON
// would produce right now. Run in CI so nobody has to remember to run tokens:generate by hand.

import { existsSync, readFileSync } from "node:fs";
import { buildPipeline, manifestToJson, TOKENS_OUTPUT_PATH, RECIPES_OUTPUT_PATH, MANIFEST_OUTPUT_PATH } from "./design-tokens/pipeline.mts";

function diffSummary(label: string, path: URL, expected: string): boolean {
  if (!existsSync(path)) {
    console.log(`STALE: ${path.pathname} does not exist — run \`npm run tokens:generate\`.`);
    return false;
  }
  const actual = readFileSync(path, "utf-8");
  if (actual === expected) {
    console.log(`OK: ${label} is up to date.`);
    return true;
  }

  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  let firstDiff = 0;
  while (firstDiff < actualLines.length && firstDiff < expectedLines.length && actualLines[firstDiff] === expectedLines[firstDiff]) {
    firstDiff++;
  }
  console.log(`STALE: ${label} does not match what the source JSON currently produces.`);
  console.log(`  first difference at line ${firstDiff + 1}:`);
  console.log(`    committed:  ${actualLines[firstDiff] ?? "<end of file>"}`);
  console.log(`    generated:  ${expectedLines[firstDiff] ?? "<end of file>"}`);
  return false;
}

function main() {
  let pipeline: ReturnType<typeof buildPipeline>;
  try {
    pipeline = buildPipeline();
  } catch (err) {
    console.log(`FAILED: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const tokensOk = diffSummary("styles/tokens.generated.css", TOKENS_OUTPUT_PATH, pipeline.tokensCss);
  const recipesOk = diffSummary("styles/recipes.generated.css", RECIPES_OUTPUT_PATH, pipeline.recipesCss);
  const manifestOk = diffSummary("styles/manifest.generated.json", MANIFEST_OUTPUT_PATH, manifestToJson(pipeline.manifest));

  const ok = tokensOk && recipesOk && manifestOk;
  console.log(`\n${ok ? "OK" : "FAILED"}: generated outputs ${ok ? "match" : "do not match"} the supplied Figma JSON.`);
  process.exitCode = ok ? 0 : 1;
}

main();
