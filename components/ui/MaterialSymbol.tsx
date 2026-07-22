import type { CSSProperties } from "react";

// Material Symbols Rounded — see app/globals.css for the @font-face (font-display: block,
// self-hosted via the `material-symbols` package) and the `.material-symbols-rounded` base
// class this component relies on for font-family, line-height, font-feature-settings ("liga",
// which turns the name below into a glyph), and text-rendering.

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface MaterialSymbolProps {
  /** Ligature name of the icon, e.g. "home", "search", "close". */
  name: string;
  /** Rendered size in pixels. Also the default for `opticalSize`. */
  size?: number;
  /** FILL axis: outline (false) or filled (true). */
  fill?: boolean;
  /** wght axis, 100-700. */
  weight?: number;
  /** GRAD axis, -25 to 200. */
  grade?: number;
  /** opsz axis, 20-48. Defaults to `size`. */
  opticalSize?: number;
  className?: string;
}

// Always decorative/presentational (aria-hidden): an icon glyph must never carry its own
// accessible name. Put the name on the interactive parent instead, e.g.
// <button aria-label="Close"><MaterialSymbol name="close" /></button> — otherwise a screen
// reader would announce the ligature text a second time, redundantly and out of context.
export function MaterialSymbol({ name, size = 24, fill = false, weight = 400, grade = 0, opticalSize, className }: MaterialSymbolProps) {
  const axes = {
    FILL: fill ? 1 : 0,
    wght: clamp(weight, 100, 700),
    GRAD: clamp(grade, -25, 200),
    opsz: clamp(opticalSize ?? size, 20, 48),
  };

  const style: CSSProperties = {
    fontSize: size,
    fontVariationSettings: `'FILL' ${axes.FILL}, 'wght' ${axes.wght}, 'GRAD' ${axes.GRAD}, 'opsz' ${axes.opsz}`,
  };

  return (
    <span
      aria-hidden="true"
      className={["material-symbols-rounded", className].filter(Boolean).join(" ")}
      style={style}
    >
      {name}
    </span>
  );
}
