import { describe, expect, it } from 'vitest';
import { glitchBands } from './glitch.js';

const face = { cx: 480, iod: 100 };
const base = { seed: 3, intensity: 1, height: 720, width: 960, face };

describe('glitch round 3 (face-sized bands)', () => {
  it('bands are sized by the face and side bands stay off the centre', () => {
    let sides = 0;
    for (let t = 0; t < 20000; t += 400) {
      for (const b of glitchBands({ ...base, timeMs: t })) {
        expect(b.h).toBeLessThanOrEqual(Math.ceil(0.18 * face.iod) + 1);
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

  it('round 4: bands cover about 3-6% of the frame at glitch 0.6 (QA R3 R11 was 0.2-1.4%)', () => {
    const shares = [];
    for (let t = 0; t < 30000; t += 500) {
      const bands = glitchBands({ ...base, intensity: 0.6, timeMs: t });
      shares.push(bands.reduce((a, b) => a + b.h * (b.x1 - b.x0), 0) / (base.width * base.height));
    }
    const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
    expect(mean).toBeGreaterThan(0.025);
    expect(mean).toBeLessThan(0.08);
  });

  it('same seed and time give the same bands', () => {
    expect(glitchBands({ ...base, timeMs: 1234 })).toEqual(glitchBands({ ...base, timeMs: 1234 }));
  });
});
