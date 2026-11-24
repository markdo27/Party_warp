import { describe, expect, it } from 'vitest';
import { INNER_LIP_RING, TEETH_MIN_PIXELS, insidePolygon, measureTeeth, meanTone, polygonBounds, teethFraction } from './teeth.js';

const SKIN = [205, 150, 120];
const CAVITY = [40, 18, 20];
const TOOTH = [236, 230, 218];
const TONGUE = [190, 70, 80];

/** Minimal 2D context stand-in over an RGBA buffer. */
function fakeCtx(W, H, paint) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const [r, g, b] = paint(x, y);
      data.set([r, g, b, 255], (y * W + x) * 4);
    }
  }
  return {
    canvas: { width: W, height: H },
    getImageData(x, y, w, h) {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let j = 0; j < h; j += 1) out.set(data.subarray(((y + j) * W + x) * 4, ((y + j) * W + x + w) * 4), j * w * 4);
      return { data: out, width: w, height: h };
    },
  };
}

/** Landmarks: inner lips as an ellipse around (cx, cy), cheeks at fixed skin spots. */
function landmarks(W, H, { cx = 100, cy = 120, rx = 30, ry = 14 } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.2 }));
  INNER_LIP_RING.forEach((id, i) => {
    const a = (i / INNER_LIP_RING.length) * Math.PI * 2;
    lm[id] = { x: (cx + rx * Math.cos(a)) / W, y: (cy + ry * Math.sin(a)) / H };
  });
  lm[50] = { x: 60 / W, y: 80 / H };
  lm[280] = { x: 140 / W, y: 80 / H };
  lm[101] = { x: 65 / W, y: 70 / H };
  lm[330] = { x: 135 / W, y: 70 / H };
  return lm;
}

const inMouth = (x, y, cx = 100, cy = 120, rx = 30, ry = 14) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

describe('teeth measurement', () => {
  it('point-in-polygon, bounds and mean tone', () => {
    const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(insidePolygon(5, 5, sq)).toBe(true);
    expect(insidePolygon(11, 5, sq)).toBe(false);
    expect(polygonBounds([[-3, 2], [8.2, 9.5]], 6, 20)).toEqual({ x: 0, y: 2, w: 6, h: 8 });
    expect(meanTone(new Uint8Array([255, 255, 255, 255])).luma).toBeCloseTo(1, 3);
  });

  it('reads a bright upper row of teeth over a dark cavity as teeth', () => {
    const ctx = fakeCtx(200, 200, (x, y) => (inMouth(x, y) ? (y < 118 ? TOOTH : CAVITY) : SKIN));
    const res = measureTeeth(ctx, landmarks(200, 200));
    expect(res).not.toBeNull();
    expect(res.frac).toBeGreaterThan(0.3);
  });

  it('does not read a dark open mouth with a red tongue as teeth', () => {
    const ctx = fakeCtx(200, 200, (x, y) => (inMouth(x, y) ? (y > 124 ? TONGUE : CAVITY) : SKIN));
    const res = measureTeeth(ctx, landmarks(200, 200));
    expect(res).not.toBeNull();
    expect(res.frac).toBeLessThan(0.05);
  });

  it('does not read skin-coloured lips as teeth', () => {
    const ctx = fakeCtx(200, 200, () => SKIN);
    expect(measureTeeth(ctx, landmarks(200, 200)).frac).toBeLessThan(0.05);
  });

  it('reads the canvas once per measurement (each getImageData is a GPU readback)', () => {
    const ctx = fakeCtx(200, 200, (x, y) => (inMouth(x, y) ? (y < 118 ? TOOTH : CAVITY) : SKIN));
    let reads = 0;
    const counted = { ...ctx, getImageData: (...a) => { reads += 1; return ctx.getImageData(...a); } };
    expect(measureTeeth(counted, landmarks(200, 200)).frac).toBeGreaterThan(0.3);
    expect(reads).toBe(1);
  });

  it('returns null (cannot judge) when the inner mouth is too small', () => {
    const ctx = fakeCtx(200, 200, () => TOOTH);
    expect(measureTeeth(ctx, landmarks(200, 200, { rx: 3, ry: 1 }))).toBeNull();
  });

  it('teethFraction counts only pixels inside the ring', () => {
    const poly = [[2, 2], [8, 2], [8, 8], [2, 8]];
    const w = 10;
    const data = new Uint8ClampedArray(w * w * 4).fill(255);
    const res = teethFraction({ data, x: 0, y: 0, w }, poly, { luma: 0.65, chroma: 0.33 });
    expect(res.pixels).toBe(36);
    expect(res.frac).toBe(1);
    expect(TEETH_MIN_PIXELS).toBeGreaterThan(0);
  });
});
