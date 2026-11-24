/**
 * Performance ladder (foundation spec, line 152): when fps stays under 24 for 2 s, step down one
 * level at a time: (1) detect every other frame, (2) detect image 480 -> 320 px, (3) smaller
 * output canvas. Patch count is never reduced, the user's layout stays as chosen.
 * Pure state machine; the engine feeds it one fps reading per 1 s window.
 */

export const DEGRADE_MIN_FPS = 24;
/** Consecutive slow 1 s fps windows before stepping down (2 windows = 2 s). */
export const DEGRADE_SLOW_WINDOWS = 2;

export const DEGRADE_LEVELS = Object.freeze([
  Object.freeze({ detectEvery: 1, detectWidth: 480, outSide: 960 }),
  Object.freeze({ detectEvery: 2, detectWidth: 480, outSide: 960 }),
  Object.freeze({ detectEvery: 2, detectWidth: 320, outSide: 960 }),
  Object.freeze({ detectEvery: 2, detectWidth: 320, outSide: 720 }),
]);

/** @returns {{ level: number, slowWindows: number, steps: Array<{ level: number, t: number, fps: number }> }} */
export const initialDegrade = () => ({ level: 0, slowWindows: 0, steps: [] });

export const degradeSettings = (state) => DEGRADE_LEVELS[Math.min(state.level, DEGRADE_LEVELS.length - 1)];

/**
 * @param {ReturnType<typeof initialDegrade>} state
 * @param {{ fps: number, t: number, holdOutput?: boolean }} reading one finished fps window.
 *   `holdOutput` blocks the step that would resize the output (a clip is being recorded).
 * @returns {ReturnType<typeof initialDegrade>} new state (the input is never changed)
 */
export function stepDegrade(state, { fps, t, holdOutput = false }) {
  if (!Number.isFinite(fps)) return state;
  if (fps >= DEGRADE_MIN_FPS) return state.slowWindows === 0 ? state : { ...state, slowWindows: 0 };
  const slowWindows = state.slowWindows + 1;
  const last = state.level >= DEGRADE_LEVELS.length - 1;
  if (slowWindows < DEGRADE_SLOW_WINDOWS || last) return { ...state, slowWindows };
  const next = DEGRADE_LEVELS[state.level + 1];
  if (holdOutput && next.outSide !== DEGRADE_LEVELS[state.level].outSide) return { ...state, slowWindows };
  const level = state.level + 1;
  return { level, slowWindows: 0, steps: [...state.steps, { level, t: Math.round(t), fps: Math.round(fps * 10) / 10 }] };
}
