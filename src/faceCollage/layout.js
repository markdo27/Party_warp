/**
 * Collage layout: seed + counts -> list of patches placed in the face frame
 * (u right, v down, 1 = inter-ocular distance). Pure and deterministic.
 *
 * Round 5 architecture:
 *   - Organic landmark-contoured masks (`mask: 'organic-eye' | 'organic-nose' | 'organic-mouth'`)
 *     replace rectangular horizontal planks, eliminating the "venetian blind" artifact (QA R4 R6/R12)
 *     while keeping selective crisp collage cut seams (`cut`).
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
    // Row 1 (top forehead): keeps brow arch like ref!
    { u: -0.4, v: -0.74, scale: 1.06, expr: 'eyeDelay', brow: true },
    { u: 0.42, v: -0.76, scale: 1.08, expr: 'eyeWide', brow: true },
    // Row 2: tight orbital almond contours so all irises stay 100% crisp and unobstructed
    { u: -0.66, v: -0.45, scale: 1.08, expr: 'eyeDelay' },
    { u: 0.02, v: -0.46, scale: 1.12, expr: 'eyeWide' },
    { u: 0.64, v: -0.42, scale: 1.08, expr: 'eyeWide' },
    // Row 3: staggered middle eye nestled cleanly above upper noses
    { u: -0.16, v: -0.22, scale: 1.08, expr: 'eyeWide' },
    // Row 4: side-glancing left eye + closed right eye flanking the upper noses (clear of orig eyes)
    { u: -0.68, v: 0.27, scale: 1.02, flipX: true, expr: 'eyeGaze' },
    { u: 0.66, v: 0.29, scale: 1.02, flipX: false, expr: 'eyeClosed' },
  ],
  nose: [
    // Two unmistakably separated tiers: compact bridge-to-nostril crops so tier 2 never hides tier 1's nostrils!
    { u: -0.26, v: 0.28, scale: 1.04 },
    { u: 0.19, v: 0.28, scale: 1.04 },
    { u: -0.3, v: 0.64, scale: 1.1 },
    { u: 0.21, v: 0.64, scale: 1.1 },
  ],
  mouth: [
    { u: -0.42, v: 1.04, scale: 0.94, expr: 'mouthClosed' },
    { u: -0.06, v: 1.72, scale: 1.36, expr: 'mouthOpen' },
    { u: -0.72, v: 1.46, scale: 1.3, expr: 'mouthOpen' },
    { u: 0.58, v: 1.42, scale: 1.24, expr: 'mouthSmile', hardEdge: 'top' },
    { u: 0.42, v: 1.01, scale: 0.88, expr: 'mouthClosed' },
    { u: 0.44, v: 2.16, scale: 1.16, expr: 'mouthOpen' },
  ],
};

/** Zones: slots and extra copies (beyond the table) keep their centre inside. */
export const ZONES = {
  eye: { u: [-0.8, 0.8], v: [-0.85, 0.4], scale: [1.0, 1.2], rot: 6 },
  nose: { u: [-0.55, 0.55], v: [0.25, 0.85], scale: [1.0, 1.16], rot: 5 },
  mouth: { u: [-0.85, 0.85], v: [0.9, 2.3], scale: [0.88, 1.36], rot: 8 },
  cheek: { u: [-1.45, 1.45], v: [0.3, 1.7], rot: 0 },
};

const JITTER = { pos: 0.045, scale: 0.065 };
/** Upscale cap per kind after jitter (guide ceiling 1.6; 1.4 keeps lips/teeth sharp). */
const MAX_SCALE = { eye: 1.25, nose: 1.25, mouth: 1.4 };
const SALT = { eye: 11, nose: 23, mouth: 37, cheek: 53 };
const EDGES = ['top', 'right', 'bottom', 'left'];
const HARD_SKEW_DEG = [10, 24];
const HARD_SKEW_SHARE = 0.8;
const FLIP_SHARE = 0.25;
const NOSE_DEEPEN = 0.28;
/** Edge slices (ref-match guide section 5). */
const SLICE = { h: [0.09, 0.3], shift: [0.12, 0.28], src: [0.74, 0.95], v: [0.32, 1.65], len: [0.34, 0.58], outerDeg: [20, 38] };
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

/**
 * Eye organic patches: 1 selective angled collage cut chord along the outer skin rim
 * (`chord 0.80..0.93`), never cutting into the iris or forming repeating horizontal blinds.
 */
export function eyeCut(rand, i, forcedEdge = null) {
  const edge = forcedEdge ?? (i % 2 ? 'bottom' : 'top');
  const skew = rand() < HARD_SKEW_SHARE;
  const sign = rand() < 0.5 ? -1 : 1;
  const angle = skew ? range(rand, HARD_SKEW_DEG[0], HARD_SKEW_DEG[1]) : 0;
  return {
    kind: skew ? 'skew' : 'rect',
    edge,
    angle,
    signedAngle: sign * angle,
    chord: range(rand, 0.8, 0.93),
    hard: [edge],
  };
}

export function noseCut(rand) {
  const skew = rand() < 0.7;
  const sign = rand() < 0.5 ? -1 : 1;
  const angle = skew ? range(rand, 4, 14) : 0;
  return {
    kind: skew ? 'skew' : 'rect',
    edge: 'bottom',
    angle,
    signedAngle: sign * angle,
    // Crisp paper-cut seam just below the nostrils so tier 1 reads sharply above tier 2.
    chord: range(rand, 0.82, 0.92),
    hard: ['bottom'],
  };
}

export function mouthCut(rand, forcedEdge = null) {
  const r = rand();
  const edge = forcedEdge ?? (r < 0.36 ? 'left' : r < 0.72 ? 'right' : r < 0.86 ? 'top' : 'bottom');
  const skew = forcedEdge === 'top' ? rand() < 0.3 : rand() < 0.75;
  const sign = rand() < 0.5 ? -1 : 1;
  const angle = skew ? range(rand, HARD_SKEW_DEG[0], HARD_SKEW_DEG[1]) : 0;
  return {
    kind: skew ? 'skew' : 'rect',
    edge,
    angle,
    signedAngle: sign * angle,
    // Stays in the skin rim outside the vermilion lip (including M5's signature ref upper-cheek cut).
    chord: forcedEdge === 'top' ? range(rand, 0.82, 0.9) : range(rand, 0.85, 0.94),
    hard: [edge],
  };
}

const cutFor = (kind, rand, i, forcedEdge = null) =>
  kind === 'eye' ? eyeCut(rand, i, forcedEdge) : kind === 'nose' ? noseCut(rand) : kind === 'mouth' ? mouthCut(rand, forcedEdge) : makeCut(rand, EDGES);

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

function slotOrExtra(kind, i, rand) {
  const slot = SLOTS[kind]?.[i];
  const z = ZONES[kind];
  if (!slot) {
    const extraExpr = kind === 'eye' ? 'eyeDelay' : kind === 'mouth' ? 'mouthDelay' : 'live';
    return {
      u: range(rand, z.u[0], z.u[1]),
      v: range(rand, z.v[0], z.v[1]),
      scale: range(rand, z.scale[0], z.scale[1]),
      flipX: null,
      expr: extraExpr,
      brow: false,
      hardEdge: null,
    };
  }
  return {
    u: clamp(slot.u + range(rand, -JITTER.pos, JITTER.pos), z.u),
    v: clamp(slot.v + range(rand, -JITTER.pos, JITTER.pos), z.v),
    scale: Math.min(MAX_SCALE[kind] ?? Infinity, slot.scale * (1 + range(rand, -JITTER.scale, JITTER.scale))),
    flipX: slot.flipX ?? null,
    expr: slot.expr ?? 'live',
    brow: Boolean(slot.brow),
    hardEdge: slot.hardEdge ?? null,
  };
}

function placeCopies(kind, seed, total) {
  const out = [];
  for (let i = 0; i < total; i += 1) {
    const pos = slotOrExtra(kind, i, mulberry32(hashSeed(seed, SALT[kind] * 1000 + i)));
    const attr = mulberry32(hashSeed(seed, SALT[kind] * 7919 + i));
    const source = kind === 'eye' ? (attr() < 0.5 ? 'eyeA' : 'eyeB') : kind;
    const flipX = kind === 'eye' && (pos.flipX ?? attr() < FLIP_SHARE);
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
      rot: range(attr, -ZONES[kind].rot, ZONES[kind].rot),
      flipX,
      cut: cutFor(kind, attr, i, pos.hardEdge),
      shade: kind === 'nose' ? range(attr, -0.045, -0.005) : range(attr, -0.04, 0.04),
      deepen: kind === 'nose' ? NOSE_DEEPEN : 0,
    });
  }
  return out;
}

/** Edge slices: a hard-cut angled strip of the finished collage at the face edge pushed outwards. */
function placeSlices(seed, total) {
  const heavy = mulberry32(hashSeed(seed, 4242))() < 0.5 ? -1 : 1;
  const out = [];
  for (let i = 0; i < total; i += 1) {
    const rand = mulberry32(hashSeed(seed, SALT.cheek * 1000 + i));
    const side = SLICE_SIDES[i % SLICE_SIDES.length] ? heavy : -heavy;
    const srcU = side * range(rand, SLICE.src[0], SLICE.src[1]);
    const shift = side * range(rand, SLICE.shift[0], SLICE.shift[1]);
    const outerAngle = range(rand, SLICE.outerDeg[0], SLICE.outerDeg[1]) * (rand() < 0.5 ? 1 : -1);
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
      v: range(rand, SLICE.v[0], SLICE.v[1]),
      h: range(rand, SLICE.h[0], SLICE.h[1]),
      len: range(rand, SLICE.len[0], SLICE.len[1]),
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
      shade: range(rand, -0.03, 0.045),
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
  const originals = ORIGINALS.map((o, i) => ({
    ...o,
    id: `orig-${o.source}`,
    mask: MASK_FOR[o.kind],
    expr: 'live',
    brow: false,
    original: true,
    scale: 1,
    rot: 0,
    flipX: false,
    cut: cutFor(o.kind, mulberry32(hashSeed(seed, 9001 + i)), i),
    shade: 0,
    deepen: 0,
  }));
  const eyes = placeCopies('eye', seed, COUNT_LIMITS.eye.max - 2).slice(0, n.eye - 2);
  const noses = placeCopies('nose', seed, COUNT_LIMITS.nose.max).slice(0, n.nose);
  const mouths = placeCopies('mouth', seed, COUNT_LIMITS.mouth.max - 1).slice(0, n.mouth - 1);
  const slices = placeSlices(seed, COUNT_LIMITS.cheek.max).slice(0, n.cheek);
  const body = [...originals, ...eyes, ...noses, ...mouths].sort((a, b) => a.v - b.v || a.id.localeCompare(b.id));
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
