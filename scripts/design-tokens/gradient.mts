// Converts a Figma linear-gradient transform (a 2x3 affine matrix mapping the gradient's
// own [0,1]x[0,1] handle space onto the shape) into a CSS `linear-gradient()` angle.
//
// The transform's first column (m[0][0], m[1][0]) is the direction the gradient's own
// left-to-right axis maps to in screen space (x right, y down — same convention CSS and the
// DOM use). CSS angles are measured clockwise from "up" (0deg = to top, 90deg = to right),
// which in screen coordinates is `atan2(dx, -dy)`.
export function gradientTransformToAngleDeg(transform: number[][]): number {
  const dx = transform[0][0];
  const dy = transform[1][0];
  const radians = Math.atan2(dx, -dy);
  const degrees = (radians * 180) / Math.PI;
  return (degrees + 360) % 360;
}

export function formatAngleDeg(deg: number): string {
  const rounded = Math.round(deg * 100) / 100;
  return `${rounded}deg`;
}
