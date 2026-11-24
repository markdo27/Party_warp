/**
 * Organic mask styling shared by the renderer and its tests (pure constants, no WebGL).
 *
 * Feather widths are in IOD outside the anatomical contour. The renderer divides them by
 * max(MIN_FEATHER_SCALE, patchScale), so the quad must be padded by at least
 * max feather / MIN_FEATHER_SCALE on every side; otherwise the feather is clipped by the quad
 * and turns into the straight horizontal "venetian blind" edge QA R4/R5 flagged (C1a, C1c).
 */
export const MIN_FEATHER_SCALE = 0.7;

export const MASK_STYLE = {
  eye: { featherTop: 0.095, featherBot: 0.09, sharpen: 0.38 },
  // Bottom stays tight so the upper tier's nostril rim reads crisply over the lower tier (C5b).
  nose: { featherTop: 0.075, featherBot: 0.03, sharpen: 0.48 },
  mouth: { featherTop: 0.055, featherBot: 0.058, sharpen: 0.36 },
};

/** Extra quad margin (IOD, before patch scale) around each feature box; also used for bank tiles. */
export const PATCH_PAD_IOD = 0.14;
