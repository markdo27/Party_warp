/** Small deterministic PRNG helpers shared by layout and glitch. */

/** mulberry32: 32-bit seed -> function returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes two 32-bit numbers into one, so each stream (eyes, glitch slot...) gets its own seed. */
export function hashSeed(a, b) {
  let h = (a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export const range = (rand, lo, hi) => lo + rand() * (hi - lo);

const SEED_CHARS = 6;
const SEED_SPACE = 36 ** SEED_CHARS; // 6 base36 chars, fits in 32 bits

/** Seed shown on screen: 6 base36 characters, easy to copy. */
export const seedToText = (seed) => (seed % SEED_SPACE).toString(36).padStart(SEED_CHARS, '0');

/** Parses user input back into a seed, or null when it is not 1-6 base36 characters. */
export function textToSeed(text) {
  const clean = String(text ?? '').trim().toLowerCase();
  if (!/^[0-9a-z]{1,6}$/.test(clean)) return null;
  return parseInt(clean, 36);
}

export const randomSeed = (rand = Math.random) => Math.floor(rand() * SEED_SPACE);
