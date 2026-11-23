/* Colour helpers shared by the sticker and the Morph grid (pure). */

export const HEX_RE = /^#[0-9a-f]{6}$/i;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** '#rrggbb' to [r, g, b] in 0-1; anything else is black. */
export function hexToRgb01(hex) {
  if (!HEX_RE.test(hex ?? '')) return [0, 0, 0];
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const toHex = (rgb) => `#${rgb.map((c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, '0')).join('')}`;

/** WCAG relative luminance of a '#rrggbb' colour. */
export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb01(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two '#rrggbb' colours (1-21). */
export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` mixed with `share` (0-1) of `b`, in sRGB. */
export function mixHex(a, b, share) {
  const x = hexToRgb01(a);
  const y = hexToRgb01(b);
  const t = clamp01(share);
  return toHex(x.map((c, i) => c + (y[i] - c) * t));
}
