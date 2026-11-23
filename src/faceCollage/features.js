/**
 * Landmark indices for the 478-point MediaPipe face mesh and the source boxes
 * (in face-frame units) that every collage patch is cut from.
 * "A" is the eye/cheek on the image left after the selfie mirror, "B" the image right;
 * which mesh index ends up on which side does not matter because patches are cut by box.
 */

export const LANDMARK_COUNT = 478;

export const EYE_A = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const EYE_B = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
export const IRIS_A = 468;
export const IRIS_B = 473;
export const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
export const MOUTH_CORNERS = [61, 291];
export const LIP_TOP = 0;
export const LIP_BOTTOM = 17;
// The mesh has no nose constant, so the bridge-to-nostril points are listed by hand.
export const NOSE_INDICES = [6, 168, 197, 195, 5, 4, 1, 2, 98, 129, 327, 358, 64, 294];
export const NOSE_CENTER = [195, 2];
export const CHEEK_A = 50;
export const CHEEK_B = 280;
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

/** Crop sizes in IOD (inter-ocular distance), from the visual spec B3. */
export const CROP = {
  eye: { w: 0.8, h: 0.55, lift: 0.08 },
  nose: { w: 0.6, h: 0.55 },
  mouth: { widthFactor: 1.35, minH: 0.5, heightFactor: 1.4 },
  cheek: { w: 0.78, h: 0.48 },
};

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
    nose: { ...nose, w: CROP.nose.w, h: CROP.nose.h },
    mouth: {
      ...mouth,
      w: mouthW * CROP.mouth.widthFactor,
      h: Math.max(CROP.mouth.minH, mouthH * CROP.mouth.heightFactor),
    },
    cheekA: { ...cheekA, w: CROP.cheek.w, h: CROP.cheek.h },
    cheekB: { ...cheekB, w: CROP.cheek.w, h: CROP.cheek.h },
  };
}

/** Flat numeric view of the features, so one filter can smooth them all. */
export const FEATURE_KEYS = ['eyeA', 'eyeB', 'nose', 'mouth', 'cheekA', 'cheekB'];
const FIELDS = ['u', 'v', 'w', 'h'];

export const featuresToArray = (f) => FEATURE_KEYS.flatMap((k) => FIELDS.map((p) => f[k][p]));

export function arrayToFeatures(arr) {
  return Object.fromEntries(
    FEATURE_KEYS.map((k, i) => [k, Object.fromEntries(FIELDS.map((p, j) => [p, arr[i * FIELDS.length + j]]))]),
  );
}
