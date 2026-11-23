/**
 * Face tracking phases (foundation 6.2, visual spec B7):
 * searching -> tracking (3 frames in a row) -> holding (face lost, last frame kept 1 s)
 * -> lost (collage fades out 300 ms). Face back while holding: straight to tracking.
 * Face back after lost: collage fades in 200 ms with the same seed.
 */

export const ACQUIRE_FRAMES = 3;
export const HOLD_MS = 1000;
export const FADE_OUT_MS = 300;
export const FADE_IN_MS = 200;

/** CSS cubic-bezier(x1, y1, x2, y2) as a function of t in [0, 1]. */
export function cubicBezier(x1, y1, x2, y2) {
  const bez = (t, a, b) => 3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i += 1) {
      const mid = (lo + hi) / 2;
      if (bez(mid, x1, x2) < x) lo = mid;
      else hi = mid;
    }
    return bez((lo + hi) / 2, y1, y2);
  };
}

export const easeOut = cubicBezier(0, 0, 0.2, 1);

export const initialTracking = (now = 0) => ({
  phase: 'searching',
  streak: 0,
  phaseAt: now,
  alphaFrom: 0,
});

/** Collage opacity for a state at time `now`. */
export function collageAlpha(state, now, reducedMotion = false) {
  const dt = now - state.phaseAt;
  if (state.phase === 'holding') return 1;
  if (state.phase === 'tracking') {
    if (reducedMotion) return 1;
    return state.alphaFrom + (1 - state.alphaFrom) * easeOut(dt / FADE_IN_MS);
  }
  if (state.phase === 'lost') {
    if (reducedMotion) return 0;
    return state.alphaFrom * (1 - easeOut(dt / FADE_OUT_MS));
  }
  return 0;
}

/** Pure step: returns a new state for one detection result. */
export function stepTracking(state, { face, now }) {
  if (face) {
    const streak = state.streak + 1;
    if (state.phase === 'tracking') return { ...state, streak };
    if (state.phase === 'holding') return { phase: 'tracking', streak, phaseAt: now, alphaFrom: 1 };
    if (streak >= ACQUIRE_FRAMES) {
      return { phase: 'tracking', streak, phaseAt: now, alphaFrom: collageAlpha(state, now) };
    }
    return { ...state, streak };
  }
  if (state.phase === 'tracking') return { phase: 'holding', streak: 0, phaseAt: now, alphaFrom: 1 };
  if (state.phase === 'holding' && now - state.phaseAt > HOLD_MS) {
    return { phase: 'lost', streak: 0, phaseAt: now, alphaFrom: 1 };
  }
  return state.streak === 0 ? state : { ...state, streak: 0 };
}
