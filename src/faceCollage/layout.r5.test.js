import { describe, expect, it } from 'vitest';
import { BROW_A, BROW_B, LANDMARK_COUNT, NOSE_CONTOUR_INDICES, convexHull, resamplePolygon } from './features.js';
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

  it('Ref preset uses organic masks, enables frame bank, keeps originals live, and spans v >= 2.1', () => {
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
    expect(Math.max(...mouths.map((m) => m.v))).toBeGreaterThanOrEqual(2.1);
    for (const p of [...eyes, ...noses, ...mouths]) {
      const plane = cutHalfPlane(0.8, 0.6, p.cut);
      if (p.cut.hard.length === 0) expect(plane).toBeNull();
      else expect(Math.hypot(plane[0], plane[1])).toBeCloseTo(1, 5);
    }
  });
});
