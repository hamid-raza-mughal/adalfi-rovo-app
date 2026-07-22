// test/alias-loader.mjs
// Custom ESM loader hook: resolves "@/" imports to the project root, matching the
// tsconfig.json paths config used by Next.js.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL('../', import.meta.url).href; // file:///...adalfi-rovo-app/
const KNOWN_EXTENSIONS = /\.(js|mjs|cjs|json|ts|tsx)$/;
// Probed in priority order so a module already converted to TypeScript resolves
// to its .ts file instead of a stale .js file left behind mid-migration.
const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const rel = specifier.slice(2); // strip "@/"
    if (KNOWN_EXTENSIONS.test(rel)) {
      return nextResolve(ROOT + rel, context);
    }
    for (const ext of CANDIDATE_EXTENSIONS) {
      const candidate = ROOT + rel + ext;
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate, context);
      }
    }
    // Nothing found on disk; fall back to .js so the error message matches
    // today's behaviour instead of surfacing a probe-list dead end.
    return nextResolve(ROOT + rel + '.js', context);
  }
  return nextResolve(specifier, context);
}
