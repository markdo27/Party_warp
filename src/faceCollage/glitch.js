/**
 * Glitch schedule: horizontal slip bands with an R/B channel split (visual spec T1, T2).
 * Deterministic from seed + time. Bands only change on a fixed slot boundary,
 * which caps changes at SLOTS_PER_SECOND (below the WCAG 2.3.1 limit of 3 flashes/s).
 */
import { hashSeed, mulberry32, range } from './prng.js';

export const SLOT_MS = 500;
export const SLOTS_PER_SECOND = 1000 / SLOT_MS;
export const MAX_FLASHES_PER_SECOND = 3;
export const MAX_AREA_SHARE = 0.25;
const REF_HEIGHT = 720; // band sizes in the spec are for a 720 px frame
const BANDS = [3, 8];
const BAND_H = [2, 14];
const SHIFT = [4, 24];
const SPLIT = [1, 3];
const EYE_COVER_LIMIT = 0.3;
/** Face-relative sizes (ref-match guide section 6), used when the face is known. */
const FACE_BAND = { h: [0.02, 0.08], shift: [0.07, 0.25], sideShare: 0.75, edgeU: 0.7, reach: [0.5, 1.6] };

export const slotAt = (timeMs) => Math.floor(timeMs / SLOT_MS);

/**
 * @param {{ seed: number, timeMs: number, intensity: number, height: number, width?: number,
 *           face?: { cx: number, iod: number } | null,
 *           avoid?: Array<[number, number]>, reducedMotion?: boolean }} opts
 * `avoid` holds pixel row ranges (the kept eyes) a full-width band may not cover by more than 30%.
 * With `face` (centre x and IOD in px) most bands sit at the face edges (|u| >= 0.7) and only
 * span [x0, x1]; sizes follow the IOD instead of the frame height.
 * @returns {Array<{ y: number, h: number, shift: number, split: number, x0: number, x1: number }>}
 */
export function glitchBands({ seed, timeMs, intensity, height, width = 0, face = null, avoid = [], reducedMotion = false }) {
  const k = Math.min(1, Math.max(0, Number(intensity) || 0));
  if (k === 0 || reducedMotion || !(height > 0)) return [];
  const px = height / REF_HEIGHT;
  const W = width > 0 ? width : Infinity;
  const useFace = Boolean(face && face.iod > 1 && width > 0);
  const rand = mulberry32(hashSeed(seed, slotAt(timeMs)));
  const count = Math.round(range(rand, BANDS[0], BANDS[0] + (BANDS[1] - BANDS[0]) * k));
  const bands = [];
  let area = 0;
  for (let i = 0; i < count; i += 1) {
    const hRaw = useFace ? range(rand, FACE_BAND.h[0], FACE_BAND.h[1]) * face.iod : range(rand, BAND_H[0], BAND_H[1]) * px;
    const h = Math.max(1, Math.round(hRaw));
    const y = Math.floor(rand() * Math.max(1, height - h));
    const dir = rand() < 0.5 ? -1 : 1;
    const mag = useFace ? range(rand, FACE_BAND.shift[0], FACE_BAND.shift[1]) * face.iod : range(rand, SHIFT[0], SHIFT[1]) * px;
    const shift = Math.round(dir * mag * k) || dir;
    const split = Math.max(1, Math.round(range(rand, SPLIT[0], SPLIT[1]) * px));
    let x0 = 0;
    let x1 = W;
    const side = useFace && rand() < FACE_BAND.sideShare;
    if (side) {
      const left = rand() < 0.5;
      const edge = FACE_BAND.edgeU * face.iod;
      const reach = range(rand, FACE_BAND.reach[0], FACE_BAND.reach[1]) * face.iod;
      x0 = Math.max(0, Math.round(left ? face.cx - edge - reach : face.cx + edge));
      x1 = Math.min(width, Math.round(left ? face.cx - edge : face.cx + edge + reach));
      if (x1 - x0 < 2) continue;
    }
    const coversEye = !side && avoid.some(([a, b]) => {
      const over = Math.max(0, Math.min(b, y + h) - Math.max(a, y));
      return over > (b - a) * EYE_COVER_LIMIT;
    });
    // Area is counted as band height x covered width share, so short edge bands cost less.
    const share = Number.isFinite(W) ? (x1 - x0) / W : 1;
    if (coversEye || area + h * share > height * MAX_AREA_SHARE) continue;
    area += h * share;
    bands.push({ y, h, shift, split, x0, x1 });
  }
  return bands;
}

/** How many times the band set changes within one second starting at `fromMs` (for QA). */
export function bandChangesInSecond(fromMs) {
  return slotAt(fromMs + 999) - slotAt(fromMs);
}
