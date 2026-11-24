import { describe, expect, it } from 'vitest';
import { BROW_A, BROW_B, LANDMARK_COUNT, NOSE_CONTOUR_INDICES, convexHull, resamplePolygon } from './features.js';
import { glitchBands } from './glitch.js';
import { PRESETS, cutHalfPlane, makeLayout } from './layout.js';

describe('Round 5 architecture (organic masks, selective cuts, frame bank roles)', () => {
  it('all new anatomical landmark indices stay inside the 478-point mesh', () => {
    for (const list of [BROW_A, BROW_B, NOSE_CONTOUR_INDICES]) {
      expect(list.every((i) => i >= 0 && i < LANDMARK_COUNT)).toBe(true);
    }
  });

  it('convexHull and resamplePolygon produce clean bounded contours', () => {
    const pts = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5], [0.2, 0.8]];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(4);
    const res = resamplePolygon(hull, 16);
    expect(res.length).toBeLessThanOrEqual(16);
    const dense = Array.from({ length: 40 }, (_, i) => [Math.cos((i / 40) * Math.PI * 2), Math.sin((i / 40) * Math.PI * 2)]);
    expect(resamplePolygon(dense, 16)).toHaveLength(16);
  });

  it('Ref preset uses organic masks, enables frame bank, keeps originals live, and packs mouths inside the widened jaw', () => {
    expect(PRESETS.ref.bank).toBe(true);
    expect(PRESETS.default.bank).toBe(false);
    expect(PRESETS.minimal.bank).toBe(false);
    const ref = makeLayout({ seed: 0xabc123, counts: PRESETS.ref.counts });
    const originals = ref.filter((p) => p.original);
    expect(originals.every((p) => p.expr === 'live')).toBe(true);
    const eyes = ref.filter((p) => p.kind === 'eye' && !p.original);
    const mouths = ref.filter((p) => p.kind === 'mouth' && !p.original);
    const noses = ref.filter((p) => p.kind === 'nose');
    expect(eyes.every((p) => p.mask === 'organic-eye')).toBe(true);
    expect(noses.every((p) => p.mask === 'organic-nose')).toBe(true);
    expect(mouths.every((p) => p.mask === 'organic-mouth')).toBe(true);
    expect(eyes.some((p) => p.expr === 'eyeClosed')).toBe(true);
    expect(mouths.some((p) => p.expr === 'mouthOpen')).toBe(true);
    expect(mouths.some((p) => p.expr === 'mouthTeeth')).toBe(true);
    const maxMouthV = Math.max(...mouths.map((m) => m.v));
    expect(maxMouthV).toBeGreaterThanOrEqual(1.8);
    expect(maxMouthV).toBeLessThanOrEqual(2.05);
    for (const p of [...eyes, ...noses, ...mouths]) {
      const plane = cutHalfPlane(0.8, 0.6, p.cut);
      if (p.cut.hard.length === 0) expect(plane).toBeNull();
      else expect(Math.hypot(plane[0], plane[1])).toBeCloseTo(1, 5);
    }
  });

  it('R5-1 visual guards: <= 2 eyes per row (C1a), cheek slices stay clear of core mouths (C1c), and face glitch never enters core/nose (C5d/C7c)', () => {
    const qaSeeds = ['abc123', 'k7m2p9', 'q4w8e1', 'z0x5c3', 'r9t1y6', 'h2j8n4'].map((s) => parseInt(s, 36));
    for (const seed of qaSeeds) {
      const ref = makeLayout({ seed, counts: PRESETS.ref.counts });
      const eyes = ref.filter((p) => p.kind === 'eye');
      const maxSameRow = Math.max(...eyes.map((e) => eyes.filter((q) => Math.abs(q.v - e.v) <= 0.05).length));
      expect(maxSameRow).toBeLessThanOrEqual(2);
      const cheeks = ref.filter((p) => p.kind === 'cheek');
      for (const s of cheeks) {
        const innerU = Math.abs(s.u) - s.len / 2;
        if (s.v > 1.15) expect(innerU).toBeGreaterThanOrEqual(0.85);
        else expect(innerU).toBeGreaterThanOrEqual(0.6);
      }
      const face = { cx: 320, cy: 190, iod: 92 };
      const coreLeft = face.cx - 0.7 * face.iod;
      const coreRight = face.cx + 0.7 * face.iod;
      for (let t = 0; t < 5000; t += 500) {
        for (const b of glitchBands({ seed, timeMs: t, intensity: 0.6, width: 640, height: 480, face })) {
          expect(b.x1 <= coreLeft + 1 || b.x0 >= coreRight - 1).toBe(true);
        }
      }
    }
  });
});
