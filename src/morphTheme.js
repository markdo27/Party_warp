/*
 * The Morph grid colours, derived from the four Party Warp colour keys (fill, sil, line, bg)
 * so the grid follows the same palette chips, Shuffle and Custom colours as every layout.
 * The Reference look (MORPH_THEME) stays available as its own choice.
 */
import { MORPH_THEME } from './morphGrid.js';
import { contrastRatio, mixHex } from './color.js';

export const MORPH_MIN_INK_CONTRAST = 4.5;
export const MORPH_MIN_TINT_CONTRAST = 3;
const FALLBACK_INKS = ['#08020f', '#fefefe'];
const MIN_RING_CONTRAST = 1.5;
const TINT_STEP = 0.05;

const higherContrast = (candidates, against) =>
  candidates.reduce((best, c) => (contrastRatio(c, against) > contrastRatio(best, against) ? c : best));

/** The letter colour: fill or sil, whichever reads better on bg; a near black or white if neither reaches 4.5:1. */
export function morphInk({ fill, sil, bg }) {
  const ink = higherContrast([fill, sil], bg);
  return contrastRatio(ink, bg) >= MORPH_MIN_INK_CONTRAST ? ink : higherContrast(FALLBACK_INKS, bg);
}

/** `tint` pulled toward bg until the ink keeps MORPH_MIN_TINT_CONTRAST on it. */
function safeTint(tint, ink, bg) {
  for (let share = 0; share <= 1 + 1e-9; share += TINT_STEP) {
    const mixed = mixHex(tint, bg, share);
    if (contrastRatio(mixed, ink) >= MORPH_MIN_TINT_CONTRAST) return mixed;
  }
  return bg;
}

const cache = new Map();

/**
 * A theme with the MORPH_THEME shape from the four colour keys. Ink: see morphInk.
 * Rings: the colour not used for ink (or line mixed with ink if that one vanishes on bg), line,
 * and two tones between them, 4 stages × 4 rings. Stage 2 tints with the first ring colour,
 * stage 4 with line; stages 1 and 3 have no tint, exactly like the Reference, so the flash
 * pattern never changes. Tints are pulled toward bg until the ink keeps 3:1 on them.
 */
export function deriveMorphTheme({ fill, sil, line, bg }) {
  const key = [fill, sil, line, bg].join('|');
  const hit = cache.get(key);
  if (hit) return hit;
  const ink = morphInk({ fill, sil, bg });
  const other = ink === fill ? sil : fill;
  const r1 = contrastRatio(other, bg) >= MIN_RING_CONTRAST ? other : mixHex(line, ink, 0.5);
  const r2 = line;
  const m1 = mixHex(r1, r2, 0.5);
  const m2 = mixHex(r1, bg, 0.4);
  const ringSets = [[r1, m1, r2, r1], [r1, r2, m1, r2], [r1, m1, r2, m2], [r2, m1, r1, m2]];
  const tints = [null, safeTint(r1, ink, bg), null, safeTint(r2, ink, bg)];
  const theme = Object.freeze({
    id: 'palette',
    bg,
    ink,
    scan: mixHex(ink, bg, 0.2),
    stages: Object.freeze(MORPH_THEME.stages.map((ref, i) => Object.freeze({ ...ref, rings: ringSets[i], tint: tints[i] }))),
  });
  if (cache.size > 64) cache.clear();
  cache.set(key, theme);
  return theme;
}

/** The theme to draw: the Reference look when `reference` is on, otherwise the palette's. */
export const morphThemeFor = (params) => (params.morphReference ? MORPH_THEME : deriveMorphTheme(params));
