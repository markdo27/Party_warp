import { describe, expect, it } from 'vitest';
import { PRESETS, makeLayout } from './layout.js';

const seeds = [1, 7, 42, 0xabc123, 99991];

describe('layout round 4 (QA R3 visual fixes)', () => {
  it('eye patches have exactly one hard edge, alternating top / bottom among copies', () => {
    for (const seed of seeds) {
      const eyes = makeLayout({ seed, counts: PRESETS.ref.counts }).filter((p) => p.kind === 'eye' && !p.original);
      for (const e of eyes) {
        expect(e.cut.hard).toHaveLength(1);
        expect(['top', 'bottom']).toContain(e.cut.hard[0]);
      }
      const edges = new Set(eyes.map((e) => e.cut.hard[0]));
      expect(edges.size).toBe(2);
    }
  });

  it('mouth copies stay at or under 1.4x and have a single hard edge', () => {
    for (const seed of seeds) {
      for (const m of makeLayout({ seed, counts: { eye: 2, nose: 0, mouth: 8, cheek: 0 } }).filter((p) => p.kind === 'mouth')) {
        expect(m.scale).toBeLessThanOrEqual(1.4);
        expect(m.cut.hard).toHaveLength(1);
      }
    }
  });

  it('nose copies are darkened and deepened', () => {
    const noses = makeLayout({ seed: 5, counts: PRESETS.ref.counts }).filter((p) => p.kind === 'nose');
    expect(noses.length).toBe(4);
    for (const n of noses) {
      expect(n.shade).toBeLessThan(0);
      expect(n.deepen).toBeGreaterThan(0);
    }
  });
});
