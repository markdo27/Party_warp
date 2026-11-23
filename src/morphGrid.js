/**
 * Morph grid: a grid (3 × 3 by default, up to 6 × 6) of single glyphs that hold, then melt into the next glyph of a
 * short loop. Cells run the same loop with a time lag (one step per column, a bigger one per
 * row), so a wave runs from the top-left cell to the bottom-right one. Around a glyph that is
 * changing, flat colour rings follow its outline (iso-distance bands) and swell with the
 * speed of the change. A glyph at rest is clean, except for stages that keep a ring stack
 * through their hold (the reference's u and double-arch holds).
 *
 * Everything here is pure (no DOM, no WebGL) so it can be unit-tested. The renderer lives in
 * morphGridRenderer.js.
 */

export const DEFAULT_MORPH_COLS = 3;
export const DEFAULT_MORPH_ROWS = 3;
export const MORPH_MIN_COLS = 1;
export const MORPH_MIN_ROWS = 1;
export const MORPH_MAX_COLS = 6;
export const MORPH_MAX_ROWS = 6;
export const MORPH_MAX_CELLS = MORPH_MAX_COLS * MORPH_MAX_ROWS;
export const MORPH_CELL_ASPECT = 240 / 300; // cell width / height, as in the reference grid
export const MORPH_MAX_GLYPHS = 6;
export const MORPH_MIN_GLYPHS = 2;
export const DEFAULT_MORPH_GLYPHS = 'Raum';
/** Shifts the loop so cell (0, 0) is mid-hold on its first glyph at t = 0 and melts at ≈0.83 s. */
export const MORPH_START_OFFSET_S = 0.12;
const HOLD_TAIL_S = 0.25; // the melt's rings fade out over the first part of a hold, then 0
const HOLD_TAIL_LEVEL = 0.15; // ring size left when a melt ends, as a share of the peak
const TINT_FADE_SHARE = 0.6; // a 'build' tint clears over this share of the next melt
const ARRIVE_TINT_FROM = 0.6; // an 'arrive' tint floods in from this share of the melt into it
const ARRIVE_TINT_HOLD = [0, 0.35]; // ...and clears between these shares of its hold
const HOLD_HALO_RAMP = [0.25, 0.55]; // a stage's hold rings swell in between these shares of the hold
const HOLD_HALO_END = [0.85, 1]; // ...and hand over to the melt's own rings at the end

/**
 * Colours measured from the reference video (k-means). They are kept as one named theme,
 * separate from the sticker palettes, so they can be swapped for approved tokens in one place.
 * Each stage belongs to one glyph of the loop (stage = glyph index mod stage count).
 * tintMode 'build': the cell background fills over the hold and clears in the next melt (a).
 * tintMode 'arrive': it floods in at the end of the melt into the glyph and clears early in
 * the hold (double arch). holdHalo: ring size (share of the peak) kept mid-hold.
 */
export const MORPH_THEME = Object.freeze({
  id: 'reference',
  bg: '#fefefe',
  ink: '#08020f',
  scan: '#3a3442', // the thin scanlines across the ink
  stages: Object.freeze([
    Object.freeze({ rings: ['#f6f82e', '#84cb3b', '#88d2f3', '#f6f82e'], tint: null, tintMode: 'build', holdHalo: 0 }),
    Object.freeze({ rings: ['#f6f82e', '#f29e0e', '#f193eb', '#f29e0e'], tint: '#f29e0e', tintMode: 'build', holdHalo: 0 }),
    Object.freeze({ rings: ['#f6f82e', '#84cb3b', '#88d2f3', '#625d41'], tint: null, tintMode: 'build', holdHalo: 0.55 }),
    Object.freeze({ rings: ['#8079da', '#88d2f3', '#f193eb', '#625d41'], tint: '#8079da', tintMode: 'arrive', holdHalo: 0.4 }),
  ]),
});
export const MORPH_RINGS_PER_STAGE = 4;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const mod = (x, m) => ((x % m) + m) % m;

/** A whole number of columns or rows in [min, max]; anything else falls back to `fallback`. */
export function gridCount(value, min, max, fallback) {
  const n = Number(value);
  if (value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(n)) return fallback;
  return clamp(Math.round(n), min, max);
}

/** Columns and rows to draw, clamped to the supported range (3 × 3 when missing). */
export const gridDims = (cols, rows) => ({
  cols: gridCount(cols, MORPH_MIN_COLS, MORPH_MAX_COLS, DEFAULT_MORPH_COLS),
  rows: gridCount(rows, MORPH_MIN_ROWS, MORPH_MAX_ROWS, DEFAULT_MORPH_ROWS),
});

/**
 * The glyphs of the loop from free text: visible graphemes only (spaces dropped), at most
 * MORPH_MAX_GLYPHS. Falls back to the default set when fewer than two are left.
 */
export function morphGlyphList(raw, split = (s) => Array.from(s)) {
  const glyphs = split(String(raw ?? '')).filter((g) => g.trim() !== '').slice(0, MORPH_MAX_GLYPHS);
  return glyphs.length >= MORPH_MIN_GLYPHS ? glyphs : Array.from(DEFAULT_MORPH_GLYPHS);
}

/**
 * CSS-style cubic-bezier(x1, y1, x2, y2) easing for t in [0, 1]. Newton steps with a
 * bisection fallback, so steep curves stay monotonic.
 */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s) => (3 * ax * s + 2 * bx) * s + cx;
  const solve = (x) => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - x;
      if (Math.abs(err) < 1e-6) return s;
      const d = slopeX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 40; i++) {
      const v = sampleX(s);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solve(t));
  };
}

/** The reference's "fast change, long hold" curve. */
export const morphEase = cubicBezier(0.7, 0, 0.3, 1);

/** Ring size (0–1) across a melt: grows in fast, peaks past the middle, leaves a tail. */
export function meltEnvelope(progress) {
  const p = clamp(progress, 0, 1);
  return smoothstep(0, 0.45, p) * (1 - (1 - HOLD_TAIL_LEVEL) * smoothstep(0.55, 1, p));
}

/** Ring size (0–1) early in a hold: the melt's tail fading out. */
export const holdTail = (inHold) => HOLD_TAIL_LEVEL * (1 - smoothstep(0, HOLD_TAIL_S, Math.max(0, inHold)));

/** Seconds one cell lags behind cell (0, 0). */
export const cellDelay = (col, row, colDelay, rowDelay) => col * colDelay + row * rowDelay;

/** One loop of `count` glyphs, each held for `hold` then melted over `melt` seconds. */
export const morphCycle = (count, hold, melt) => count * (hold + melt);

const stageOf = (glyph, stages) => stages[glyph % stages.length];
const hasTint = (stage, mode) => Boolean(stage.tint) && stage.tintMode === mode;

/** Ring size (0-1) a stage keeps through its own hold, on top of the melt's tail. */
export function holdHalo(stage, inHold, hold) {
  const level = stage.holdHalo ?? 0;
  if (!level) return 0;
  return level * smoothstep(HOLD_HALO_RAMP[0] * hold, HOLD_HALO_RAMP[1] * hold, inHold)
    * (1 - smoothstep(HOLD_HALO_END[0] * hold, HOLD_HALO_END[1] * hold, inHold));
}

function holdState(slot, next, inHold, hold, stages) {
  const stage = stageOf(slot, stages);
  const halo = Math.max(holdTail(inHold), holdHalo(stage, inHold, hold));
  const tint = stage.tintMode === 'arrive'
    ? 1 - smoothstep(ARRIVE_TINT_HOLD[0] * hold, ARRIVE_TINT_HOLD[1] * hold, inHold)
    : smoothstep(0.1 * hold, 0.9 * hold, inHold);
  return { from: slot, to: next, mix: 0, progress: 0, halo, tint, tintStage: slot, melting: false };
}

function meltState(slot, next, progress, stages) {
  const base = { from: slot, to: next, mix: morphEase(progress), progress, halo: meltEnvelope(progress), melting: true };
  if (hasTint(stageOf(next, stages), 'arrive')) {
    return { ...base, tint: smoothstep(ARRIVE_TINT_FROM, 1, progress), tintStage: next };
  }
  const fading = stageOf(slot, stages).tintMode === 'build';
  return { ...base, tint: fading ? 1 - smoothstep(0, TINT_FADE_SHARE, progress) : 0, tintStage: slot };
}

/**
 * One cell's state at loop time `seconds` (already delayed for the cell).
 * from / to: glyph indices; mix: eased 0-1 between them; halo: ring size 0-1;
 * tint: 0-1 share of the tinted cell background of stage `tintStage`; melting: in a melt or not.
 */
export function morphCellState(seconds, count, hold, melt, stages = MORPH_THEME.stages) {
  const slotLength = hold + melt;
  const t = mod(seconds, count * slotLength);
  const slot = Math.min(count - 1, Math.floor(t / slotLength));
  const inSlot = t - slot * slotLength;
  const next = (slot + 1) % count;
  if (inSlot < hold) return holdState(slot, next, inSlot, hold, stages);
  return meltState(slot, next, clamp((inSlot - hold) / melt, 0, 1), stages);
}

/**
 * All `cols × rows` cells (3 × 3 when missing) at global time `time` (seconds), row-major
 * from the top-left cell. `still` (reduced motion) drops the rings and the tint and keeps
 * every glyph whole.
 */
export function morphGridFrame(time, { cols, rows, count, hold, melt, colDelay, rowDelay, still = false }) {
  const dims = gridDims(cols, rows);
  const cells = [];
  for (let row = 0; row < dims.rows; row++) {
    for (let col = 0; col < dims.cols; col++) {
      const local = time + MORPH_START_OFFSET_S - cellDelay(col, row, colDelay, rowDelay);
      const state = morphCellState(local, count, hold, melt);
      cells.push(still
        ? { ...state, to: state.from, mix: 0, halo: 0, tint: 0, melting: false, col, row }
        : { ...state, col, row });
    }
  }
  return cells;
}

/**
 * The largest `cols × rows` grid of MORPH_CELL_ASPECT (4:5) cells that fits `rect` (any
 * units), with a `margin` share kept clear on each side, centred. Returns { x, y, width, height }.
 */
export function morphGridRect(rect, margin = 0, cols = DEFAULT_MORPH_COLS, rows = DEFAULT_MORPH_ROWS) {
  const dims = gridDims(cols, rows);
  const gridAspect = (dims.cols * MORPH_CELL_ASPECT) / dims.rows;
  const availW = Math.max(1, rect.width * (1 - 2 * margin));
  const availH = Math.max(1, rect.height * (1 - 2 * margin));
  const width = Math.min(availW, availH * gridAspect);
  const height = width / gridAspect;
  return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
}

/**
 * The most switches between a plain and a tinted background that one cell makes within any
 * one second of the loop. Used to check the flash limit (WCAG 2.3.1: at most 3 per second).
 */
export function tintSwitchesPerSecond(count, hold, melt, sampleHz = 120) {
  const cycle = morphCycle(count, hold, melt);
  const steps = Math.ceil(cycle * sampleHz);
  const times = [];
  let last = null;
  for (let i = 0; i <= steps; i++) {
    const s = morphCellState(i / sampleHz, count, hold, melt);
    const tinted = Boolean(MORPH_THEME.stages[s.tintStage % MORPH_THEME.stages.length].tint) && s.tint > 0.5;
    if (last !== null && tinted !== last) times.push(i / sampleHz);
    last = tinted;
  }
  return times.reduce((most, t0) => Math.max(most, times.filter((t) => t >= t0 && t < t0 + 1).length), 0);
}
