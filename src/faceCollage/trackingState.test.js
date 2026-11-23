import { describe, expect, it } from 'vitest';
import { ACQUIRE_FRAMES, HOLD_MS, collageAlpha, initialTracking, stepTracking } from './trackingState.js';

const run = (state, steps) => steps.reduce((s, [face, now]) => stepTracking(s, { face, now }), state);

describe('trackingState', () => {
  it('needs 3 frames to lock on', () => {
    let s = initialTracking(0);
    for (let i = 1; i < ACQUIRE_FRAMES; i += 1) s = stepTracking(s, { face: {}, now: i * 33 });
    expect(s.phase).toBe('searching');
    s = stepTracking(s, { face: {}, now: 100 });
    expect(s.phase).toBe('tracking');
  });
  it('holds for 1 s, then lost, then tracking again', () => {
    let s = run(initialTracking(0), [[{}, 0], [{}, 33], [{}, 66]]);
    s = stepTracking(s, { face: null, now: 100 });
    expect(s.phase).toBe('holding');
    expect(collageAlpha(s, 600)).toBe(1);
    s = stepTracking(s, { face: null, now: 100 + HOLD_MS });
    expect(s.phase).toBe('holding');
    s = stepTracking(s, { face: null, now: 101 + HOLD_MS });
    expect(s.phase).toBe('lost');
    expect(collageAlpha(s, 101 + HOLD_MS + 400)).toBeCloseTo(0, 5);
    s = run(s, [[{}, 2000], [{}, 2033], [{}, 2066]]);
    expect(s.phase).toBe('tracking');
  });
  it('a face during holding resumes at once', () => {
    let s = run(initialTracking(0), [[{}, 0], [{}, 1], [{}, 2], [null, 3]]);
    s = stepTracking(s, { face: {}, now: 500 });
    expect(s.phase).toBe('tracking');
    expect(collageAlpha(s, 500)).toBe(1);
  });
  it('reduced motion skips fades', () => {
    expect(collageAlpha({ phase: 'lost', streak: 0, phaseAt: 0, alphaFrom: 1 }, 10, true)).toBe(0);
    expect(collageAlpha({ phase: 'tracking', streak: 3, phaseAt: 0, alphaFrom: 0 }, 10, true)).toBe(1);
  });
  it('does not mutate the input state', () => {
    const s = Object.freeze(initialTracking(0));
    expect(() => stepTracking(s, { face: {}, now: 1 })).not.toThrow();
  });
});
