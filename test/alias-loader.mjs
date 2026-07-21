// test/alias-loader.mjs
// Custom ESM loader hook: resolves "@/" imports to the project root, matching the
// jsconfig.json paths config used by Next.js.

const ROOT = new URL('../', import.meta.url).href; // file:///...adalfi-rovo-app/

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    let rel = specifier.slice(2); // strip "@/"
    // Append .js when no extension is present (Next.js allows omitting it).
    if (!rel.endsWith('.js') && !rel.endsWith('.mjs') && !rel.endsWith('.cjs') && !rel.endsWith('.json')) {
      rel += '.js';
    }
    return nextResolve(ROOT + rel, context);
  }
  return nextResolve(specifier, context);
}
