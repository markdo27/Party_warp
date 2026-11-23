import { describe, expect, it } from 'vitest';
import { MAX_AREA_SHARE, MAX_FLASHES_PER_SECOND, SLOT_MS, bandChangesInSecond, glitchBands } from './glitch.js';

const opts = { seed: 9, intensity: 1, height: 720 };

describe('glitch', () => {
  it('bands stay fixed inside a slot and change at most 3 times per second', () => {
    expect(glitchBands({ ...opts, timeMs: 10 })).toEqual(glitchBands({ ...opts, timeMs: SLOT_MS - 1 }));
    for (let t = 0; t < 5000; t += 37) expect(bandChangesInSecond(t)).toBeLessThanOrEqual(MAX_FLASHES_PER_SECOND);
  });
  it('total band height stays under 25% of the frame', () => {
    for (let t = 0; t < 20000; t += SLOT_MS) {
      const area = glitchBands({ ...opts, timeMs: t }).reduce((a, b) => a + b.h, 0);
      expect(area).toBeLessThanOrEqual(720 * MAX_AREA_SHARE);
    }
  });
  it('bands never cover more than 30% of an eye row', () => {
    const avoid = [[300, 340], [310, 350]];
    for (let t = 0; t < 20000; t += SLOT_MS) {
      for (const b of glitchBands({ ...opts, timeMs: t, avoid })) {
        for (const [a, e] of avoid) {
          expect(Math.max(0, Math.min(e, b.y + b.h) - Math.max(a, b.y))).toBeLessThanOrEqual((e - a) * 0.3);
        }
      }
    }
  });
  it('off at zero intensity or with reduced motion', () => {
    expect(glitchBands({ ...opts, timeMs: 0, intensity: 0 })).toEqual([]);
    expect(glitchBands({ ...opts, timeMs: 0, reducedMotion: true })).toEqual([]);
  });
});
