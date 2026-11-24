/**
 * Collage layout: seed + counts -> list of patches placed in the face frame
 * (u right, v down, 1 = inter-ocular distance). Pure and deterministic.
 *
 * Round 5 architecture:
 *   - Organic landmark-contoured masks (`mask: 'organic-eye' | 'organic-nose' | 'organic-mouth'`)
 *     replace rectangular horizontal planks, eliminating the "venetian blind" artifact (QA R4 R6/R12)
 *     The core (|u| < 0.7) is soft like the ref; only outer copies get one outward hard cut (`cut`),
 *     and the cheek/jaw edge slices keep their hard top/bottom/angled cuts.
 *   - Only the top forehead eye row (`brow: true`) carries the eyebrow arch (matching `image.png`);
 *     lower stacked eyes use tight orbital almond contours so every iris remains unobstructed!
 *   - Semantic expression roles (`expr`) map copies to the Expression Frame Bank (R10) while kept
 *     originals (eyeA, eyeB, mouth) stay 100% live and the original nose remains hidden.
 */
import { hashSeed, mulberry32, range } from './prng.js';

export const COUNT_LIMITS = {
  eye: { min: 2, max: 12 },
  nose: { min: 0, max: 6 },
  mouth: { min: 1, max: 8 },
  cheek: { min: 0, max: 6 },
};

export const PRESETS = {
  default: { label: 'Default', counts: { eye: 6, nose: 0, mouth: 3, cheek: 0 }, glitch: 0.3, bank: false },
  ref: { label: 'Ref', counts: { eye: 10, nose: 4, mouth: 7, cheek: 6 }, glitch: 0.6, bank: true },
  minimal: { label: 'Minimal', counts: { eye: 2, nose: 0, mouth: 1, cheek: 0 }, glitch: 0, bank: false },
};

/** Slot table calibrated to `image.png` (`ref-measure.json`), in the order copies are added. */
export const SLOTS = {
  eye: [
    // Row 1 (top forehead): keeps organic curved brow arch like ref, staggered vertically.
    { u: -0.34, v: -0.78, scale: 1.24, expr: 'eyeDelay', brow: true },
    { u: 0.44, v: -0.7, scale: 1.28, expr: 'eyeWide', brow: true },
    // Row 2: large sculpted eyes tightly packed & deliberately staggered so max same-row <= 2 (C1a).
    { u: -0.66, v: -0.44, scale: 1.26, expr: 'eyeDelay' },
    { u: 0.08, v: -0.56, scale: 1.32, expr: 'eyeWide' },
    { u: 0.68, v: -0.33, scale: 1.26, expr: 'eyeWide' },
    // Row 3: staggered middle eye nestled cleanly above upper noses.
    { u: -0.2, v: -0.22, scale: 1.28, expr: 'eyeWide' },
    // Row 4: side-glancing left eye + closed right eye flanking the upper noses (non-mirrored v).
    { u: -0.7, v: 0.24, scale: 1.2, flipX: true, expr: 'eyeGaze' },
    { u: 0.64, v: 0.31, scale: 1.22, flipX: false, expr: 'eyeClosed' },
  ],
  nose: [
    // Two unmistakably separated tiers: compact bridge-to-nostril crops so tier 2 never hides tier 1's nostrils!
    { u: -0.26, v: 0.27, scale: 1.1 },
    { u: 0.2, v: 0.29, scale: 1.1 },
    { u: -0.29, v: 0.63, scale: 1.18 },
    { u: 0.22, v: 0.65, scale: 1.18 },
  ],
  mouth: [
    // Upper tier: closed/parted lips tucked right under lower noses.
    { u: -0.44, v: 0.98, scale: 1.02, rot: -5, expr: 'mouthClosed' },
    // Lower-center chin mouth: bold open mouth anchoring the lower face.
    { u: -0.04, v: 1.58, scale: 1.38, rot: -2, expr: 'mouthOpen' },
    // Big open left jaw mouth tilted outward like ref.
    { u: -0.66, v: 1.34, scale: 1.36, rot: 11, expr: 'mouthOpen' },
    // Wide toothy right grin.
    { u: 0.56, v: 1.3, scale: 1.32, rot: -6, expr: 'mouthTeeth' },
    // Upper-right closed lip.
    { u: 0.44, v: 0.95, scale: 0.96, rot: 6, expr: 'mouthClosed' },
    // Single peeking mouth tucked tight behind/under bottom-right jaw (like ref y=890 behind chin).
    { u: 0.4, v: 1.84, scale: 1.14, rot: -11, expr: 'mouthOpen', drawKey: 1.44 },
  ],
};

/** Zones: slots and extra copies (beyond the table) keep their centre inside. */
export const ZONES = {
  eye: { u: [-0.82, 0.82], v: [-0.86, 0.42], scale: [1.08, 1.34], rot: 7 },
  nose: { u: [-0.55, 0.55], v: [0.23, 0.85], scale: [1.04, 1.22], rot: 5 },
  mouth: { u: [-0.85, 0.85], v: [0.88, 2.05], scale: [0.92, 1.38], rot: 14 },
  cheek: { u: [-1.45, 1.45], v: [0.3, 1.7], rot: 0 },
};

/**
 * Soft core vs hard rim (QA-R5 C1, read from `image.png`): inside |u| < `soft` features blend
 * into each other with no straight seam; only copies centred at |u| >= `cutFrom` get one hard
 * cut, on their outward side, so the cut line itself lands at |u| >= `soft`.
 */
export const CORE_U = { cutFrom: 0.55, soft: 0.7 };
/** Draw key for noses: all tiers sit between the upper eyes and the mouths, upper tier on top. */
// Above every eye band (v <= 0.42) and below every mouth (v >= 0.88): low eyes never cover a nose tier.
const NOSE_DRAW_KEY = 0.6;
const NOSE_DRAW_SPREAD = 0.01;

const JITTER = { u: 0.055, v: { eye: 0.028, nose: 0.032, mouth: 0.045 }, scale: 0.065 };
/** Upscale cap per kind after jitter (guide ceiling 1.6; 1.4 keeps lips/teeth sharp). */
const MAX_SCALE = { eye: 1.45, nose: 1.28, mouth: 1.4 };
const SALT = { eye: 11, nose: 23, mouth: 37, cheek: 53 };
const EDGES = ['top', 'right', 'bottom', 'left'];
const HARD_SKEW_DEG = [10, 24];
const HARD_SKEW_SHARE = 0.8;
const FLIP_SHARE = { eye: 0.28, mouth: 0.45 };
const NOSE_DEEPEN = 0.28;
/** Stratified cheek/jaw slices (R5-V1): sit cleanly below lower eyes (v 0.56..1.04) + 1 far-outer jaw tab, never cutting core mouths. */
const SLICE_SLOTS = [
  { v: 0.56, h: [0.16, 0.23], len: [0.42, 0.54], src: [0.74, 0.8], shift: [0.18, 0.28] },
  { v: 0.79, h: [0.17, 0.25], len: [0.44, 0.56], src: [0.74, 0.82], shift: [0.2, 0.3] },
  { v: 0.62, h: [0.16, 0.23], len: [0.4, 0.52], src: [0.74, 0.8], shift: [0.16, 0.26] },
  { v: 1.03, h: [0.17, 0.25], len: [0.4, 0.52], src: [0.76, 0.84], shift: [0.2, 0.3] },
  { v: 0.9, h: [0.16, 0.23], len: [0.4, 0.5], src: [0.74, 0.82], shift: [0.16, 0.26] },
  { v: 1.38, h: [0.14, 0.2], len: [0.3, 0.38], src: [0.88, 0.96], shift: [0.2, 0.28] },
];
const SLICE_OUTER_DEG = [20, 38];
/** Heavy side gets 2/3 of slices: H H L H L H (4 vs 2 in Ref preset). */
const SLICE_SIDES = [1, 1, 0, 1, 0, 1];

/** Where the kept originals sit on an average face (QA overlays only; renderer uses live landmarks). */
const ORIGINALS = [
  { kind: 'eye', source: 'eyeA', u: -0.5, v: -0.02 },
  { kind: 'eye', source: 'eyeB', u: 0.5, v: -0.02 },
  { kind: 'mouth', source: 'mouth', u: 0, v: 1.05 },
];

const MASK_FOR = { eye: 'organic-eye', nose: 'organic-nose', mouth: 'organic-mouth', cheek: 'slice' };

export const clampCount = (kind, n) => {
  const { min, max } = COUNT_LIMITS[kind];
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
};

const clamp = (x, [lo, hi]) => Math.min(hi, Math.max(lo, x));

/** No hard cut: the patch only has its organic feathered contour. */
const NO_CUT = Object.freeze({ kind: 'none', edge: null, angle: 0, signedAngle: 0, chord: 1, hard: Object.freeze([]) });

/**
 * One hard collage cut on the outward side of an outer copy (left for u < 0, right for u > 0),
 * a near-vertical chord tilted up to 24 deg, so the seam reads like the ref's cheek/jaw cuts
 * and never as a horizontal plank. Core copies (|u| < CORE_U.cutFrom) stay fully organic.
 */
export function rimCut(rand, u) {
  if (Math.abs(u) < CORE_U.cutFrom) return NO_CUT;
  const skew = rand() < HARD_SKEW_SHARE;
  const sign = rand() < 0.5 ? -1 : 1;
  const angle = skew ? range(rand, HARD_SKEW_DEG[0], HARD_SKEW_DEG[1]) : 0;
  const edge = u < 0 ? 'left' : 'right';
  return { kind: skew ? 'skew' : 'rect', edge, angle, signedAngle: sign * angle, chord: range(rand, 0.8, 0.92), hard: [edge] };
}

const cutFor = (kind, rand, u) => (kind === 'cheek' ? makeCut(rand, EDGES) : rimCut(rand, u));

export function makeCut(rand, allowed = EDGES) {
  const sides = allowed.filter((e) => e === 'left' || e === 'right');
  const vertical = rand() < 0.7 || sides.length === 0;
  const first = vertical ? (rand() < 0.5 ? 'top' : 'bottom') : sides[rand() < 0.5 ? 0 : sides.length - 1];
  const hard = [first];
  if (rand() < 0.5) {
    const others = allowed.filter((e) => e !== first);
    hard.push(others[Math.floor(rand() * others.length)]);
  }
  const skew = rand() < HARD_SKEW_SHARE;
  const angle = skew ? range(rand, HARD_SKEW_DEG[0], HARD_SKEW_DEG[1]) : 0;
  return { kind: skew ? 'skew' : 'rect', edge: first, angle, signedAngle: angle, chord: 0.86, hard };
}

function slotOrExtra(kind, i, rand, chirality) {
  const slot = SLOTS[kind]?.[i];
  const z = ZONES[kind];
  if (!slot) {
    const extraExpr = kind === 'eye' ? 'eyeDelay' : kind === 'mouth' ? 'mouthDelay' : 'live';
    return {
      u: range(rand, z.u[0], z.u[1]),
      v: range(rand, z.v[0], z.v[1]),
      scale: range(rand, z.scale[0], z.scale[1]),
      rot: null,
      flipX: null,
      expr: extraExpr,
      brow: false,
      drawOrder: null,
    };
  }
  const jv = JITTER.v[kind] ?? 0.035;
  return {
    u: clamp(slot.u * chirality + range(rand, -JITTER.u, JITTER.u), z.u),
    v: clamp(slot.v + range(rand, -jv, jv), z.v),
    scale: Math.min(MAX_SCALE[kind] ?? Infinity, slot.scale * (1 + range(rand, -JITTER.scale, JITTER.scale))),
    rot: slot.rot !== undefined ? slot.rot * chirality : null,
    flipX: slot.flipX !== undefined ? (chirality < 0 ? !slot.flipX : slot.flipX) : null,
    expr: slot.expr ?? 'live',
    brow: Boolean(slot.brow),
    drawOrder: slot.drawKey ?? null,
  };
}

function placeCopies(kind, seed, total) {
  // Per-seed left/right chirality gives distinct layouts across seeds while keeping count-stability.
  const chirality = mulberry32(hashSeed(seed, 9191))() < 0.5 ? 1 : -1;
  const out = [];
  for (let i = 0; i < total; i += 1) {
    const pos = slotOrExtra(kind, i, mulberry32(hashSeed(seed, SALT[kind] * 1000 + i)), chirality);
    const attr = mulberry32(hashSeed(seed, SALT[kind] * 7919 + i));
    const source = kind === 'eye' ? (attr() < 0.5 ? 'eyeA' : 'eyeB') : kind;
    const flipShare = FLIP_SHARE[kind] ?? 0;
    const flipX = flipShare > 0 && (pos.flipX ?? attr() < flipShare);
    const baseRot = pos.rot !== null ? clamp(pos.rot + range(attr, -4.5, 4.5), [-ZONES[kind].rot, ZONES[kind].rot]) : range(attr, -ZONES[kind].rot, ZONES[kind].rot);
    out.push({
      id: `${kind}-${i}`,
      kind,
      mask: MASK_FOR[kind],
      expr: pos.expr,
      brow: pos.brow,
      original: false,
      source,
      u: pos.u,
      v: pos.v,
      scale: pos.scale,
      rot: baseRot,
      flipX,
      cut: cutFor(kind, attr, pos.u),
      shade: kind === 'nose' ? range(attr, -0.045, -0.005) : range(attr, -0.04, 0.04),
      deepen: kind === 'nose' ? NOSE_DEEPEN : 0,
      ...(pos.drawOrder !== null && { drawOrder: pos.drawOrder }),
    });
  }
  return out;
}

/**
 * Back-to-front key: lower centre drawn later, except noses (drawn upper-over-lower right after
 * upper eyes) and the bottom peeking mouth (`drawOrder`), which tucks behind the chin mouth as in `image.png`.
 */
const drawKey = (p) => (p.kind === 'nose' ? NOSE_DRAW_KEY - p.v * NOSE_DRAW_SPREAD : p.drawOrder ?? p.v);

/** Edge slices: a hard-cut angled strip of the finished collage at the face edge pushed outwards. */
function placeSlices(seed, total) {
  const heavy = mulberry32(hashSeed(seed, 4242))() < 0.5 ? -1 : 1;
  const out = [];
  for (let i = 0; i < total; i += 1) {
    const rand = mulberry32(hashSeed(seed, SALT.cheek * 1000 + i));
    const spec = SLICE_SLOTS[i % SLICE_SLOTS.length];
    const side = SLICE_SIDES[i % SLICE_SIDES.length] ? heavy : -heavy;
    const srcU = side * range(rand, spec.src[0], spec.src[1]);
    const shift = side * range(rand, spec.shift[0], spec.shift[1]);
    const outerAngle = range(rand, SLICE_OUTER_DEG[0], SLICE_OUTER_DEG[1]) * (rand() < 0.5 ? 1 : -1);
    const v = clamp(spec.v + range(rand, -0.055, 0.055), ZONES.cheek.v);
    out.push({
      id: `cheek-${i}`,
      kind: 'cheek',
      mask: MASK_FOR.cheek,
      expr: 'live',
      brow: false,
      original: false,
      source: 'slice',
      side,
      srcU,
      shift,
      u: srcU + shift,
      v,
      h: range(rand, spec.h[0], spec.h[1]),
      len: range(rand, spec.len[0], spec.len[1]),
      scale: 1,
      rot: 0,
      flipX: false,
      cut: {
        kind: 'skew',
        edge: side > 0 ? 'right' : 'left',
        angle: Math.abs(outerAngle),
        signedAngle: outerAngle,
        hard: ['top', 'bottom'],
      },
      shade: range(rand, -0.025, 0.055),
    });
  }
  return out;
}

/**
 * @param {{ seed: number, counts: { eye: number, nose: number, mouth: number, cheek?: number } }} opts
 * @returns {Array<object>} patches back-to-front (lower centre drawn later, as in the reference);
 *   edge slices come last because they copy the finished collage.
 */
export function makeLayout({ seed, counts }) {
  const n = {
    eye: clampCount('eye', counts.eye),
    nose: clampCount('nose', counts.nose),
    mouth: clampCount('mouth', counts.mouth),
    cheek: clampCount('cheek', counts.cheek ?? 0),
  };
  const originals = ORIGINALS.map((o) => ({
    ...o,
    id: `orig-${o.source}`,
    mask: MASK_FOR[o.kind],
    expr: 'live',
    brow: false,
    original: true,
    scale: 1,
    rot: 0,
    flipX: false,
    // Kept originals follow the live face and are never cut.
    cut: NO_CUT,
    shade: 0,
    deepen: 0,
  }));
  const eyes = placeCopies('eye', seed, COUNT_LIMITS.eye.max - 2).slice(0, n.eye - 2);
  const noses = placeCopies('nose', seed, COUNT_LIMITS.nose.max).slice(0, n.nose);
  const mouths = placeCopies('mouth', seed, COUNT_LIMITS.mouth.max - 1).slice(0, n.mouth - 1);
  const slices = placeSlices(seed, COUNT_LIMITS.cheek.max).slice(0, n.cheek);
  const body = [...originals, ...eyes, ...noses, ...mouths].sort((a, b) => drawKey(a) - drawKey(b) || a.id.localeCompare(b.id));
  return [...body, ...slices];
}

/** True when a copy's centre lies inside its zone (QA Q5). Originals follow the real face. */
export function inZone(p) {
  if (p.original) return true;
  const z = ZONES[p.kind];
  return p.u >= z.u[0] && p.u <= z.u[1] && p.v >= z.v[0] && p.v <= z.v[1];
}

/** Clip polygon in patch-local units for a w x h patch centred on 0,0. Only the first hard edge is slanted. */
export function cutPolygon(w, h, cut) {
  const x = w / 2;
  const y = h / 2;
  const pts = [
    [-x, -y],
    [x, -y],
    [x, y],
    [-x, y],
  ];
  if (cut.kind !== 'skew' || !cut.angle) return pts;
  const t = Math.tan((cut.angle * Math.PI) / 180);
  if (cut.edge === 'top') pts[1] = [x, -y + Math.min(h * 0.6, w * t)];
  if (cut.edge === 'bottom') pts[3] = [-x, y - Math.min(h * 0.6, w * t)];
  if (cut.edge === 'left') pts[0] = [-x + Math.min(w * 0.6, h * t), -y];
  if (cut.edge === 'right') pts[2] = [x - Math.min(w * 0.6, h * t), y];
  return pts;
}

/** Edges that are not cut hard get feathered. */
export const softEdges = (cut) => EDGES.filter((e) => !(cut.hard ?? EDGES).includes(e));

/**
 * Converts a patch's selective hard cut specification into a normalized 2D half-plane
 * `[nx, ny, dist]` in patch-local face units (`dot(p, n) > dist` is sliced away with <= 1.5 px AA).
 */
export function cutHalfPlane(w, h, cut) {
  if (!cut?.hard?.length) return null;
  const edge = cut.edge ?? cut.hard[0];
  const rad = ((cut.signedAngle ?? cut.angle ?? 0) * Math.PI) / 180;
  const chord = cut.chord ?? 0.85;
  let nx = 0;
  let ny = 0;
  let baseDist = 0;
  if (edge === 'top') {
    nx = Math.sin(rad);
    ny = -Math.cos(rad);
    baseDist = (h * 0.5) * chord;
  } else if (edge === 'bottom') {
    nx = Math.sin(rad);
    ny = Math.cos(rad);
    baseDist = (h * 0.5) * chord;
  } else if (edge === 'left') {
    nx = -Math.cos(rad);
    ny = Math.sin(rad);
    baseDist = (w * 0.5) * chord;
  } else {
    nx = Math.cos(rad);
    ny = Math.sin(rad);
    baseDist = (w * 0.5) * chord;
  }
  return [nx, ny, baseDist];
}
