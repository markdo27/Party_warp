import { describe, expect, it } from 'vitest';
import { COUNT_LIMITS, PRESETS, makeLayout } from './layout.js';

describe('layout round 3 (ref match)', () => {
  const ref = makeLayout({ seed: 77, counts: PRESETS.ref.counts });

  it('ref preset gives 6 edge slices, drawn last, mostly on one side', () => {
    const slices = ref.filter((p) => p.kind === 'cheek');
    expect(COUNT_LIMITS.cheek.max).toBe(6);
    expect(slices).toHaveLength(6);
    expect(ref.slice(-6).every((p) => p.kind === 'cheek')).toBe(true);
    const heavy = slices.filter((s) => s.side === slices[0].side).length;
    expect(heavy).toBe(4);
    for (const s of slices) {
      expect(Math.abs(s.srcU)).toBeGreaterThanOrEqual(0.72);
      expect(Math.sign(s.shift)).toBe(s.side);
      expect(s.u).toBeCloseTo(s.srcU + s.shift);
    }
  });

  it('eye patches never cut top or bottom (R5 C1a: no horizontal blinds), only their outward side', () => {
    for (const p of ref.filter((x) => x.kind === 'eye')) {
      for (const e of p.cut.hard) expect(['left', 'right']).toContain(e);
    }
  });

  it('the layout does not depend on time, only on seed + counts', () => {
    expect(makeLayout({ seed: 77, counts: PRESETS.ref.counts })).toEqual(ref);
  });
});
