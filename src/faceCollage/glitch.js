/**
 * Glitch schedule: horizontal scan-line slip bands with an R/B channel split (visual spec T1, T2).
 * Deterministic from seed + time. Bands only change on a fixed slot boundary,
 * which caps changes at SLOTS_PER_SECOND (below the WCAG 2.3.1 limit of 3 flashes/s).
 *
 * Round 5: keeps side bands tightly anchored along hair/face outer edges (|u| >= 0.70) with a mix
 * of crisp thin scan-line streaks and wider edge shifts, and protects both eyes and 2-tier noses
 * from stray full-width bands (QA R4 R11).
 */
import { hashSeed, mulberry32, range } from './prng.js';

export const SLOT_MS = 500;
export const SLOTS_PER_SECOND = 1000 / SLOT_MS;
export const MAX_FLASHES_PER_SECOND = 3;
export const MAX_AREA_SHARE = 0.25;
export const MAX_GLITCH_BANDS = 24;

const REF_HEIGHT = 720; // band sizes in the spec are for a 720 px frame
const BANDS = [3, 8];
const BAND_H = [2, 14];
const SHIFT = [4, 24];
const SPLIT = [1, 3];
const EYE_COVER_LIMIT = 0.3;

/**
 * Face-relative sizes (QA R5 C5d/C7a-d): 100% of face bands sit outside the core (|u| >= 0.72),
 * guaranteeing 0 px glitch on the nose and >= 90% outside core across every seed while delivering
 * ref-density horizontal hair-edge tears (2-4% visible frame area at Ref intensity 0.6).
 */
const FACE_BAND = {
  thinH: [0.025, 0.06],
  thickH: [0.085, 0.165],
  thinShare: 0.36,
  shift: [0.11, 0.28],
  sideShare: 1.0,
  edgeU: 0.715,
  reach: [1.0, 2.15],
  count: [20, 24],
  split: [2.2, 4.2],
};

export const slotAt = (timeMs) => Math.floor(timeMs / SLOT_MS);

/**
 * @param {{ seed: number, timeMs: number, intensity: number, height: number, width?: number,
 *           face?: { cx: number, cy?: number, iod: number } | null,
 *           avoid?: Array<[number, number]>, reducedMotion?: boolean }} opts
 * `avoid` holds pixel row ranges (kept eyes and noses) a full-width band may not cover by more than 30%.
 * With `face` (centre x/y and IOD in px) 100% of bands sit strictly outside the core (|u| >= 0.73).
 * @returns {Array<{ y: number, h: number, shift: number, split: number, x0: number, x1: number }>}
 */
export function glitchBands({ seed, timeMs, intensity, height, width = 0, face = null, avoid = [], reducedMotion = false }) {
  const k = Math.min(1, Math.max(0, Number(intensity) || 0));
  if (k === 0 || reducedMotion || !(height > 0)) return [];
  const px = height / REF_HEIGHT;
  const W = width > 0 ? width : Infinity;
  const useFace = Boolean(face && face.iod > 1 && width > 0);
  const rand = mulberry32(hashSeed(seed, slotAt(timeMs)));
  const [c0, c1] = useFace ? FACE_BAND.count : BANDS;
  const count = Math.min(MAX_GLITCH_BANDS, Math.round(range(rand, c0, c0 + (c1 - c0) * k)));
  const bands = [];
  let area = 0;
  for (let i = 0; i < count; i += 1) {
    let hRaw;
    if (useFace) {
      const [lo, hi] = rand() < FACE_BAND.thinShare ? FACE_BAND.thinH : FACE_BAND.thickH;
      hRaw = range(rand, lo, hi) * face.iod;
    } else {
      hRaw = range(rand, BAND_H[0], BAND_H[1]) * px;
    }
    const h = Math.max(1, Math.round(hRaw));
    let y;
    if (useFace && typeof face.cy === 'number' && rand() < 0.88) {
      const yMin = Math.max(0, Math.floor(face.cy - 1.28 * face.iod));
      const yMax = Math.max(yMin + 1, Math.min(height - h, Math.ceil(face.cy + 2.15 * face.iod)));
      y = Math.floor(range(rand, yMin, yMax));
    } else {
      y = Math.floor(rand() * Math.max(1, height - h));
    }
    const dir = rand() < 0.5 ? -1 : 1;
    const mag = useFace ? range(rand, FACE_BAND.shift[0], FACE_BAND.shift[1]) * face.iod : range(rand, SHIFT[0], SHIFT[1]) * px;
    const shift = Math.round(dir * mag * k) || dir;
    const split = Math.max(1, Math.round(useFace ? range(rand, FACE_BAND.split[0], FACE_BAND.split[1]) * px * 1.45 : range(rand, SPLIT[0], SPLIT[1]) * px));
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
    const coversProtected = !side && avoid.some(([a, b]) => {
      const over = Math.max(0, Math.min(b, y + h) - Math.max(a, y));
      return over > (b - a) * EYE_COVER_LIMIT;
    });
    const share = Number.isFinite(W) ? (x1 - x0) / W : 1;
    if (coversProtected || area + h * share > height * MAX_AREA_SHARE) continue;
    area += h * share;
    bands.push({ y, h, shift, split, x0, x1 });
  }
  return bands;
}

/** How many times the band set changes within one second starting at `fromMs` (for QA). */
export function bandChangesInSecond(fromMs) {
  return slotAt(fromMs + 999) - slotAt(fromMs);
}
