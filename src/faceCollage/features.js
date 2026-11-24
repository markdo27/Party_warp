/**
 * Landmark indices for the 478-point MediaPipe face mesh, anatomical feature contours,
 * expression metrics (for the Expression Frame Bank), and source boxes in face-frame units.
 * "A" is always the image-left eye/cheek after selfie mirroring, "B" the image-right.
 */

export const LANDMARK_COUNT = 478;

export const EYE_A = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const EYE_B = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
export const BROW_A = [70, 63, 105, 66, 107, 46, 53, 52, 65, 55];
export const BROW_B = [300, 293, 334, 296, 336, 276, 283, 282, 295, 285];
export const EYE_LID_A = { top: 159, bottom: 145, outer: 33, inner: 133, iris: 468 };
export const EYE_LID_B = { top: 386, bottom: 374, outer: 263, inner: 362, iris: 473 };
export const IRIS_A = 468;
export const IRIS_B = 473;
export const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
export const LIPS_INNER = { top: 13, bottom: 14 };
export const MOUTH_CORNERS = [61, 291];
export const LIP_TOP = 0;
export const LIP_BOTTOM = 17;
// The mesh has no nose constant, so the bridge-to-nostril points are listed by hand.
export const NOSE_INDICES = [6, 168, 197, 195, 5, 4, 1, 2, 98, 129, 327, 358, 64, 294];
// Compact lower-bridge + tip + alar-wing contour so 2 stacked nose tiers never cover upper nostrils.
export const NOSE_CONTOUR_INDICES = [195, 5, 4, 1, 2, 98, 129, 327, 358, 64, 294, 48, 278, 94, 19];
export const NOSE_CENTER = [4, 2];
export const NOSE_TIP = 1;
export const CHEEK_A = 50;
export const CHEEK_B = 280;
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

/** Crop sizes in IOD (inter-ocular distance), tightly enclosing each organic contour + slim feather. */
export const CROP = {
  eye: { w: 0.72, h: 0.44, lift: 0.015 },
  eyeBrow: { w: 0.82, h: 0.62, lift: 0.09 },
  nose: { w: 0.58, h: 0.44 },
  mouth: { widthFactor: 1.48, minH: 0.56, heightFactor: 1.56 },
  cheek: { w: 0.78, h: 0.48 },
};

export const MAX_CONTOUR_VERTS = 16;

const mean = (pts) => {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
};

const pick = (lm, ids) => ids.map((i) => lm[i]);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 2D convex hull (Andrew's monotone chain) in CCW order. Input: Array<[number, number]>. */
export function convexHull(rawPts) {
  if (!rawPts || rawPts.length < 3) return rawPts ? rawPts.slice() : [];
  const pts = rawPts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Expands a simple polygon radially outward with asymmetric X / top / bottom margins, clamped inside the patch box. */
export function expandContour(hull, { padX = 0.06, padTop = 0.05, padBot = 0.06, halfW = 0.4, halfH = 0.3 }) {
  if (!hull.length) return [];
  let cx = 0;
  let cy = 0;
  for (const [x, y] of hull) {
    cx += x;
    cy += y;
  }
  cx /= hull.length;
  cy /= hull.length;
  return hull.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len;
    const ny = dy / len;
    const py = ny < 0 ? padTop : padBot;
    return [clamp(x + nx * padX, -halfW, halfW), clamp(y + ny * py, -halfH, halfH)];
  });
}

/** Uniformly resamples a closed polygon to at most `maxN` vertices (for fixed-size GLSL uniform arrays). */
export function resamplePolygon(pts, maxN = MAX_CONTOUR_VERTS) {
  const n = pts.length;
  if (n <= maxN) return pts;
  const lens = [0];
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    lens.push(total);
  }
  if (!(total > 1e-6)) return pts.slice(0, maxN);
  const out = [];
  let seg = 0;
  for (let k = 0; k < maxN; k += 1) {
    const target = (k / maxN) * total;
    while (seg < n - 1 && lens[seg + 1] < target) seg += 1;
    const segLen = Math.max(1e-6, lens[seg + 1] - lens[seg]);
    const t = (target - lens[seg]) / segLen;
    const a = pts[seg];
    const b = pts[(seg + 1) % n];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Fallback organic ellipse contour when a synthetic/mock mesh collapses landmarks. */
export function ellipseContour(rx, ry, n = 12) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2;
    out.push([Math.cos(a) * rx, Math.sin(a) * ry]);
  }
  return out;
}

function buildContour(lm, ids, toFace, center, pad, boxW, boxH, fallbackRx, fallbackRy) {
  const local = ids.map((i) => {
    const q = toFace(lm[i]);
    return [q.u - center.u, q.v - center.v];
  });
  const hull = convexHull(local);
  if (hull.length < 3) return ellipseContour(fallbackRx, fallbackRy);
  const expanded = expandContour(hull, {
    ...pad,
    halfW: boxW * 0.46,
    halfH: boxH * 0.46,
  });
  return resamplePolygon(expanded, MAX_CONTOUR_VERTS);
}

/**
 * Feature centres and crop sizes in face-frame units (u right, v down, 1 = IOD).
 * `toFace` maps a pixel point into the face frame. Eye A is always the image-left eye.
 */
export function measureFeatures(lm, toFace, iod) {
  let eyeA = toFace(mean(pick(lm, EYE_A)));
  let eyeB = toFace(mean(pick(lm, EYE_B)));
  if (eyeA.u > eyeB.u) [eyeA, eyeB] = [eyeB, eyeA];
  let cheekA = toFace(lm[CHEEK_A]);
  let cheekB = toFace(lm[CHEEK_B]);
  if (cheekA.u > cheekB.u) [cheekA, cheekB] = [cheekB, cheekA];
  const nose = toFace(mean(pick(lm, NOSE_CENTER)));
  const mouth = toFace(mean(pick(lm, LIPS_OUTER)));
  const mouthW = dist(lm[MOUTH_CORNERS[0]], lm[MOUTH_CORNERS[1]]) / iod;
  const mouthH = dist(lm[LIP_TOP], lm[LIP_BOTTOM]) / iod;
  return {
    eyeA: { u: eyeA.u, v: eyeA.v - CROP.eye.lift, w: CROP.eye.w, h: CROP.eye.h },
    eyeB: { u: eyeB.u, v: eyeB.v - CROP.eye.lift, w: CROP.eye.w, h: CROP.eye.h },
    eyeBrowA: { u: eyeA.u, v: eyeA.v - CROP.eyeBrow.lift, w: CROP.eyeBrow.w, h: CROP.eyeBrow.h },
    eyeBrowB: { u: eyeB.u, v: eyeB.v - CROP.eyeBrow.lift, w: CROP.eyeBrow.w, h: CROP.eyeBrow.h },
    nose: { ...nose, w: CROP.nose.w, h: CROP.nose.h },
    mouth: {
      ...mouth,
      w: Math.max(0.56, mouthW * CROP.mouth.widthFactor),
      h: Math.max(CROP.mouth.minH, mouthH * CROP.mouth.heightFactor),
    },
    cheekA: { ...cheekA, w: CROP.cheek.w, h: CROP.cheek.h },
    cheekB: { ...cheekB, w: CROP.cheek.w, h: CROP.cheek.h },
  };
}

/**
 * Anatomical contour polygons in feature-local face units (centred at each feature's (u, v)).
 * - `eyeA`/`eyeB`: tight almond orbital contours (lids + lashes, NO eyebrow) so densely stacked
 *   eyes never occlude the irises above them and Minimal preset wipes eyebrows cleanly (Q1).
 * - `eyeBrowA`/`eyeBrowB`: full eye + brow arch used only on the top forehead row (matching ref).
 * - `nose`: compact bridge-to-nostril silhouette so 2 stacked tiers both stay sharp & readable.
 * - `mouth`: expanded outer-lip hull so lips, teeth & cavity remain 100% opaque with zero ghosting.
 */
export function measureContours(lm, toFace, features) {
  const rawEyeA = toFace(mean(pick(lm, EYE_A)));
  const rawEyeB = toFace(mean(pick(lm, EYE_B)));
  const swapped = rawEyeA.u > rawEyeB.u;
  const orbitalA = swapped ? EYE_B : EYE_A;
  const orbitalB = swapped ? EYE_A : EYE_B;
  const browA = swapped ? [...EYE_B, ...BROW_B] : [...EYE_A, ...BROW_A];
  const browB = swapped ? [...EYE_A, ...BROW_A] : [...EYE_B, ...BROW_B];
  return {
    eyeA: buildContour(lm, orbitalA, toFace, features.eyeA, { padX: 0.085, padTop: 0.08, padBot: 0.065 }, features.eyeA.w, features.eyeA.h, 0.26, 0.14),
    eyeB: buildContour(lm, orbitalB, toFace, features.eyeB, { padX: 0.085, padTop: 0.08, padBot: 0.065 }, features.eyeB.w, features.eyeB.h, 0.26, 0.14),
    eyeBrowA: buildContour(lm, browA, toFace, features.eyeBrowA, { padX: 0.065, padTop: 0.035, padBot: 0.065 }, features.eyeBrowA.w, features.eyeBrowA.h, 0.28, 0.2),
    eyeBrowB: buildContour(lm, browB, toFace, features.eyeBrowB, { padX: 0.065, padTop: 0.035, padBot: 0.065 }, features.eyeBrowB.w, features.eyeBrowB.h, 0.28, 0.2),
    nose: buildContour(lm, NOSE_CONTOUR_INDICES, toFace, features.nose, { padX: 0.055, padTop: 0.04, padBot: 0.035 }, features.nose.w, features.nose.h, 0.2, 0.16),
    mouth: buildContour(lm, LIPS_OUTER, toFace, features.mouth, { padX: 0.065, padTop: 0.055, padBot: 0.07 }, features.mouth.w, features.mouth.h, 0.34, 0.18),
  };
}

/** Expression measurements in face-frame units for the Expression Frame Bank (R10). */
export function measureExpressions(lm, toFace, iod) {
  const rawEyeA = toFace(mean(pick(lm, EYE_A)));
  const rawEyeB = toFace(mean(pick(lm, EYE_B)));
  const swapped = rawEyeA.u > rawEyeB.u;
  const lidA = swapped ? EYE_LID_B : EYE_LID_A;
  const lidB = swapped ? EYE_LID_A : EYE_LID_B;

  const eyeMetrics = (lid) => {
    const pOut = toFace(lm[lid.outer]);
    const pIn = toFace(lm[lid.inner]);
    const pTop = toFace(lm[lid.top]);
    const pBot = toFace(lm[lid.bottom]);
    const pIris = toFace(lm[lid.iris]);
    const w = Math.max(1e-4, Math.hypot(pIn.u - pOut.u, pIn.v - pOut.v));
    const h = Math.hypot(pBot.u - pTop.u, pBot.v - pTop.v);
    const midU = (pOut.u + pIn.u) * 0.5;
    return {
      open: h / w,
      gaze: clamp((pIris.u - midU) / (w * 0.5), -1, 1),
      width: w,
    };
  };

  const eA = eyeMetrics(lidA);
  const eB = eyeMetrics(lidB);
  const mouthOpen = dist(lm[LIPS_INNER.top], lm[LIPS_INNER.bottom]) / iod;
  const mouthOuterH = dist(lm[LIP_TOP], lm[LIP_BOTTOM]) / iod;
  const mouthWidth = dist(lm[MOUTH_CORNERS[0]], lm[MOUTH_CORNERS[1]]) / iod;
  const c0 = toFace(lm[MOUTH_CORNERS[0]]);
  const c1 = toFace(lm[MOUTH_CORNERS[1]]);
  const topLip = toFace(lm[LIP_TOP]);
  const botLip = toFace(lm[LIP_BOTTOM]);
  const lipMidV = (topLip.v + botLip.v) * 0.5;
  const cornerV = (c0.v + c1.v) * 0.5;
  const cornerLift = lipMidV - cornerV;
  const mouthSmile = mouthWidth + cornerLift * 1.6;
  // Head-turn proxies: nose tip offset from the outer-eye-corner midpoint (IOD units) and the
  // ratio of the two eye widths. Large turns foreshorten one eye and fake a blink or a gaze.
  const outerA = toFace(lm[EYE_LID_A.outer]);
  const outerB = toFace(lm[EYE_LID_B.outer]);
  const noseTip = toFace(lm[NOSE_TIP]);
  const yaw = noseTip.u - (outerA.u + outerB.u) * 0.5;
  const eyeWidthRatio = Math.min(eA.width, eB.width) / Math.max(1e-4, Math.max(eA.width, eB.width));

  return {
    eyeOpenA: eA.open,
    eyeOpenB: eB.open,
    gazeA: eA.gaze,
    gazeB: eB.gaze,
    mouthOpen,
    mouthOuterH,
    mouthWidth,
    cornerLift,
    mouthSmile,
    yaw,
    eyeWidthRatio,
  };
}

/** Flat numeric view of the features, so one filter can smooth them all. */
export const FEATURE_KEYS = ['eyeA', 'eyeB', 'eyeBrowA', 'eyeBrowB', 'nose', 'mouth', 'cheekA', 'cheekB'];
const FIELDS = ['u', 'v', 'w', 'h'];

export const featuresToArray = (f) => FEATURE_KEYS.flatMap((k) => FIELDS.map((p) => f[k][p]));

export function arrayToFeatures(arr) {
  return Object.fromEntries(
    FEATURE_KEYS.map((k, i) => [k, Object.fromEntries(FIELDS.map((p, j) => [p, arr[i * FIELDS.length + j]]))]),
  );
}
