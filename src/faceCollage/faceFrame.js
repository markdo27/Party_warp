/**
 * Face frame: origin between the irises, x along the eye line, y towards the chin,
 * unit = inter-ocular distance (IOD). Every patch is placed in this frame so the
 * collage follows the head (move, roll, zoom) without re-randomising.
 */
import { FACE_OVAL, IRIS_A, IRIS_B, LANDMARK_COUNT, measureFeatures } from './features.js';

/** Landmarks (normalised 0..1) -> pixel points, mirrored for the selfie view when asked. */
export function toPixels(landmarks, width, height, mirror) {
  return landmarks.map((p) => ({ x: (mirror ? 1 - p.x : p.x) * width, y: p.y * height }));
}

/** Builds the frame from pixel landmarks. Returns null when the mesh is incomplete or degenerate. */
export function frameFromLandmarks(lm) {
  if (!lm || lm.length < LANDMARK_COUNT) return null;
  let a = lm[IRIS_A];
  let b = lm[IRIS_B];
  if (a.x > b.x) [a, b] = [b, a]; // x axis always points to the image right
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const iod = Math.hypot(dx, dy);
  if (!(iod > 1)) return null;
  return { ox: (a.x + b.x) / 2, oy: (a.y + b.y) / 2, ax: dx / iod, ay: dy / iod, iod };
}

/** Pixel point -> face units. */
export function toFace(frame, p) {
  const px = p.x - frame.ox;
  const py = p.y - frame.oy;
  return {
    u: (px * frame.ax + py * frame.ay) / frame.iod,
    v: (-px * frame.ay + py * frame.ax) / frame.iod,
  };
}

/** Face units -> pixel point. */
export function toPixel(frame, q) {
  return {
    x: frame.ox + (q.u * frame.ax - q.v * frame.ay) * frame.iod,
    y: frame.oy + (q.u * frame.ay + q.v * frame.ax) * frame.iod,
  };
}

/** Canvas transform [a, b, c, d, e, f] that draws face units into pixels. */
export const frameMatrix = (f) => [f.ax * f.iod, f.ay * f.iod, -f.ay * f.iod, f.ax * f.iod, f.ox, f.oy];

/** Frame + features in one step, or null when there is no usable face. */
export function measureFace(lm) {
  const frame = frameFromLandmarks(lm);
  if (!frame) return null;
  return {
    frame,
    features: measureFeatures(lm, (p) => toFace(frame, p), frame.iod),
    oval: FACE_OVAL.map((i) => toFace(frame, lm[i])),
  };
}

/** Frame as numbers for filtering; the axis is stored as an angle so it stays unit length. */
export const frameToArray = (f) => [f.ox, f.oy, Math.atan2(f.ay, f.ax), f.iod];
export function arrayToFrame([ox, oy, angle, iod]) {
  return { ox, oy, ax: Math.cos(angle), ay: Math.sin(angle), iod };
}

/** Linear blend of two frames (used for the 150 ms catch-up when the face comes back). */
export function lerpFrame(a, b, t) {
  const A = frameToArray(a);
  const B = frameToArray(b);
  return arrayToFrame(A.map((v, i) => v + (B[i] - v) * t));
}

/** One Euro filter (Casiez et al. 2012) over a vector of numbers. */
export class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.prev = null;
    this.dPrev = null;
    this.tPrev = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** `t` in seconds. Returns a new array; the input is not changed. */
  filter(values, t) {
    if (this.prev === null || this.prev.length !== values.length || t <= this.tPrev) {
      this.prev = values.slice();
      this.dPrev = values.map(() => 0);
      this.tPrev = t;
      return values.slice();
    }
    const dt = t - this.tPrev;
    const ad = OneEuro.alpha(this.dCutoff, dt);
    const dNext = values.map((v, i) => ad * ((v - this.prev[i]) / dt) + (1 - ad) * this.dPrev[i]);
    const next = values.map((v, i) => {
      const a = OneEuro.alpha(this.minCutoff + this.beta * Math.abs(dNext[i]), dt);
      return a * v + (1 - a) * this.prev[i];
    });
    this.prev = next;
    this.dPrev = dNext;
    this.tPrev = t;
    return next.slice();
  }
}
