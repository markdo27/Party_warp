import { describe, expect, it } from 'vitest';
import { COUNT_LIMITS, PRESETS, clampCount, cutPolygon, inZone, makeLayout } from './layout.js';

const tally = (l) => l.reduce((a, p) => ({ ...a, [p.kind]: (a[p.kind] ?? 0) + 1 }), {});

describe('layout', () => {
  it('is a pure function of seed + counts', () => {
    const opts = { seed: 1234, counts: PRESETS.ref.counts };
    expect(makeLayout(opts)).toEqual(makeLayout(opts));
    expect(makeLayout({ ...opts, seed: 99 })).not.toEqual(makeLayout(opts));
  });
  it('counts include the kept originals and respect limits', () => {
    const l = makeLayout({ seed: 7, counts: { eye: 6, nose: 2, mouth: 3, cheek: 1 } });
    expect(tally(l)).toEqual({ eye: 6, nose: 2, mouth: 3, cheek: 1 });
    expect(l.filter((p) => p.original).map((p) => p.source).sort()).toEqual(['eyeA', 'eyeB', 'mouth']);
    expect(clampCount('eye', 99)).toBe(COUNT_LIMITS.eye.max);
    expect(clampCount('mouth', 0)).toBe(1);
    expect(clampCount('nose', 'x')).toBe(0);
  });
  it('raising one count keeps every other patch where it was', () => {
    const base = makeLayout({ seed: 5, counts: { eye: 4, nose: 1, mouth: 2, cheek: 0 } });
    const more = makeLayout({ seed: 5, counts: { eye: 9, nose: 4, mouth: 2, cheek: 2 } });
    for (const p of base) expect(more).toContainEqual(p);
  });
  it('copies stay inside their zones across many seeds', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const l = makeLayout({ seed, counts: { eye: 12, nose: 6, mouth: 8, cheek: 4 } });
      expect(l.every(inZone)).toBe(true);
    }
  });
  it('cut polygons: rect stays a box, skew pulls one corner in', () => {
    expect(cutPolygon(2, 1, { kind: 'rect' })).toEqual([[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]]);
    const skew = cutPolygon(2, 1, { kind: 'skew', edge: 'top', angle: 10 });
    expect(skew[1][1]).toBeGreaterThan(-0.5);
    expect(skew[0]).toEqual([-1, -0.5]);
  });
});
