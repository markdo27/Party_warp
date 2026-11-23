import { describe, expect, it } from 'vitest';
import { OneEuro, frameFromLandmarks, measureFace, toFace, toPixel } from './faceFrame.js';
import { IRIS_A, IRIS_B, LANDMARK_COUNT, NOSE_INDICES } from './features.js';

/** A fake mesh: every landmark at a fixed face-unit spot, then moved, rolled and scaled. */
function mesh({ dx = 0, dy = 0, angle = 0, scale = 1 }) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const place = (u, v) => ({ x: 300 + dx + scale * 60 * (u * c - v * s), y: 200 + dy + scale * 60 * (u * s + v * c) });
  return Array.from({ length: LANDMARK_COUNT }, (_, i) => {
    if (i === IRIS_A) return place(-0.5, 0);
    if (i === IRIS_B) return place(0.5, 0);
    return place(Math.sin(i) * 1.2, Math.cos(i * 1.7) * 1.5);
  });
}

describe('faceFrame', () => {
  it('face-unit coordinates do not change when the head moves, rolls or zooms', () => {
    const ref = measureFace(mesh({}));
    const moved = measureFace(mesh({ dx: 80, dy: -40, angle: 0.26, scale: 1.4 }));
    expect(moved.frame.iod).toBeCloseTo(60 * 1.4, 6);
    for (const k of Object.keys(ref.features)) {
      for (const field of Object.keys(ref.features[k])) {
        expect(moved.features[k][field]).toBeCloseTo(ref.features[k][field], 6);
      }
    }
  });
  it('toPixel inverts toFace', () => {
    const f = frameFromLandmarks(mesh({ angle: -0.3, scale: 0.8 }));
    const p = { x: 123.4, y: 321 };
    const back = toPixel(f, toFace(f, p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });
  it('rejects incomplete or degenerate meshes', () => {
    expect(frameFromLandmarks(mesh({}).slice(0, 400))).toBeNull();
    const flat = mesh({});
    flat[IRIS_B] = { ...flat[IRIS_A] };
    expect(frameFromLandmarks(flat)).toBeNull();
  });
  it('nose indices exist in the 478-point mesh', () => {
    expect(NOSE_INDICES.every((i) => i >= 0 && i < LANDMARK_COUNT)).toBe(true);
  });
  it('OneEuro smooths jitter and settles near the steady value', () => {
    const f = new OneEuro({ minCutoff: 1, beta: 0 });
    let out;
    for (let i = 0; i < 120; i += 1) out = f.filter([10 + (i % 2 ? 1 : -1)], i / 30);
    expect(Math.abs(out[0] - 10)).toBeLessThan(0.5);
    f.reset();
    expect(f.filter([50], 0)).toEqual([50]);
  });
});
