import { describe, expect, it } from 'vitest';
import { glitchBands } from './glitch.js';

const face = { cx: 480, iod: 100 };
const base = { seed: 3, intensity: 1, height: 720, width: 960, face };

describe('glitch round 3 (face-sized bands)', () => {
  it('bands are sized by the face and side bands stay off the centre', () => {
    let sides = 0;
    for (let t = 0; t < 20000; t += 400) {
      for (const b of glitchBands({ ...base, timeMs: t })) {
        expect(b.h).toBeLessThanOrEqual(Math.ceil(0.08 * face.iod) + 1);
        expect(b.x0).toBeGreaterThanOrEqual(0);
        expect(b.x1).toBeLessThanOrEqual(base.width);
        const full = b.x0 === 0 && b.x1 === base.width;
        if (!full) {
          sides += 1;
          const left = b.x1 <= face.cx - 0.7 * face.iod + 1;
          const right = b.x0 >= face.cx + 0.7 * face.iod - 1;
          expect(left || right).toBe(true);
        }
      }
    }
    expect(sides).toBeGreaterThan(0);
  });

  it('same seed and time give the same bands', () => {
    expect(glitchBands({ ...base, timeMs: 1234 })).toEqual(glitchBands({ ...base, timeMs: 1234 }));
  });
});
