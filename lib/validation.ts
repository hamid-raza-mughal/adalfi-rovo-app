// lib/validation.ts
// Generic runtime-validation helpers shared across modules that narrow `unknown`
// values (request bodies, parsed JSON files, environment-derived data) before use.

/** General-purpose guard: narrows an `unknown` value to a plain object so its properties
 *  can be safely accessed. Not specific to any one module's domain - shared across route
 *  request-body parsing and config-file parsing to avoid every caller redefining it. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
