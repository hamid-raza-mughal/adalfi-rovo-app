// test/helpers/tsx-loader.mjs
// Node's native TypeScript support strips *types* but does not transform JSX (JSX has
// real runtime semantics, not just erasable annotations), so a .tsx component can't be
// imported directly the way the plain .mts generator modules are. This transpiles JSX to
// react/jsx-runtime calls at test time using the TypeScript compiler API — already a
// project devDependency, so this adds no new tooling (no Babel/esbuild/Storybook) — then
// imports the result from a temp file.

import ts from "typescript";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Written inside the project root (not the OS tmpdir) so plain bare-specifier imports in
// the transpiled output (e.g. "react/jsx-runtime") resolve via the project's own
// node_modules — Node's resolution walk only finds node_modules directories that are
// actual ancestors of the importing file.
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export async function importTsx(sourcePath) {
  const source = readFileSync(sourcePath, "utf-8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });

  const dir = mkdtempSync(join(PROJECT_ROOT, ".tmp-tsx-test-"));
  const outPath = join(dir, "module.mjs");
  writeFileSync(outPath, outputText, "utf-8");
  try {
    return await import(`file://${outPath}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
