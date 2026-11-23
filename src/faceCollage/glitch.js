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

export const slotAt = (timeMs) => Math.floor(timeMs / SLOT_MS);

/**
 * @param {{ seed: number, timeMs: number, intensity: number, height: number,
 *           avoid?: Array<[number, number]>, reducedMotion?: boolean }} opts
 * `avoid` holds pixel row ranges (the kept eyes) a band may not cover by more than 30%.
 * @returns {Array<{ y: number, h: number, shift: number, split: number }>}
 */
export function glitchBands({ seed, timeMs, intensity, height, avoid = [], reducedMotion = false }) {
  const k = Math.min(1, Math.max(0, Number(intensity) || 0));
  if (k === 0 || reducedMotion || !(height > 0)) return [];
  const px = height / REF_HEIGHT;
  const rand = mulberry32(hashSeed(seed, slotAt(timeMs)));
  const count = Math.round(range(rand, BANDS[0], BANDS[0] + (BANDS[1] - BANDS[0]) * k));
  const bands = [];
  let area = 0;
  for (let i = 0; i < count; i += 1) {
    const h = Math.max(1, Math.round(range(rand, BAND_H[0], BAND_H[1]) * px));
    const y = Math.floor(rand() * Math.max(1, height - h));
    const dir = rand() < 0.5 ? -1 : 1;
    const shift = Math.round(dir * range(rand, SHIFT[0], SHIFT[1]) * k * px);
    const split = Math.max(1, Math.round(range(rand, SPLIT[0], SPLIT[1]) * px));
    const coversEye = avoid.some(([a, b]) => {
      const over = Math.max(0, Math.min(b, y + h) - Math.max(a, y));
      return over > (b - a) * EYE_COVER_LIMIT;
    });
    if (coversEye || area + h > height * MAX_AREA_SHARE) continue;
    area += h;
    bands.push({ y, h, shift, split });
  }
  return bands;
}

/** How many times the band set changes within one second starting at `fromMs` (for QA). */
export function bandChangesInSecond(fromMs) {
  return slotAt(fromMs + 999) - slotAt(fromMs);
}
