// Deterministic Figma-name -> CSS-custom-property-name conversion.
//
// Figma variable names mix several conventions in this export: PascalCase segments
// ("System/Accents/primary"), snake_case ("large_cta/ic_size"), already-kebab segments
// ("8-scale/base"), and segments with spaces/punctuation ("X & Y Values/1"). This produces
// one consistent kebab-case identifier regardless of the source convention.

// Maps a variable collection's Figma name to the CSS custom property namespace it lives
// under. Collection names are stable and readable (unlike collection ids), so they're the
// right key here.
export const COLLECTION_NAMESPACE: Record<string, string> = {
  "font-theme": "font",
  colors: "color",
  "border-scale": "border",
  "layout-scale": "layout",
  effects: "effect",
  "cta-scale": "cta",
  "type-scale": "type",
};

function slugSegment(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2") // camelCase boundary
    .replace(/[^a-zA-Z0-9]+/g, "-") // any run of non-alphanumerics -> single hyphen
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

// variableName is the raw Figma name, e.g. "System/Accents/primary" or "X & Y Values/1".
export function cssCustomPropertyName(namespace: string, variableName: string): string {
  const segments = variableName.split("/").map(slugSegment).filter(Boolean);
  return `--figma-${namespace}-${segments.join("-")}`;
}

export function recipeClassName(prefix: string, styleName: string): string {
  const segments = styleName.split("/").map(slugSegment).filter(Boolean);
  return `${prefix}-${segments.join("-")}`;
}

export function recipeCustomPropertyName(prefix: string, styleName: string): string {
  return `--${recipeClassName(prefix, styleName)}`;
}
