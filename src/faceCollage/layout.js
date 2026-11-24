/**
 * Collage layout: seed + counts -> list of patches placed in the face frame
 * (u right, v down, 1 = inter-ocular distance). Pure and deterministic.
 *
 * Round 3 (ref match): copies sit on a fixed slot table measured from the reference
 * (ref-match guide, section 3) with a small seeded jitter, instead of free scatter.
 * Counts include the kept originals (2 eyes, 1 mouth). Each patch has its own PRNG stream,
 * so raising or lowering a count never moves the others.
 * `cheek` patches are edge slices: horizontal strips of the face edge pushed outwards.
 */
import { hashSeed, mulberry32, range } from './prng.js';

export const COUNT_LIMITS = {
  eye: { min: 2, max: 12 },
  nose: { min: 0, max: 6 },
  mouth: { min: 1, max: 8 },
  cheek: { min: 0, max: 6 },
};

export const PRESETS = {
  default: { label: 'Default', counts: { eye: 6, nose: 0, mouth: 3, cheek: 0 }, glitch: 0.3 },
  ref: { label: 'Ref', counts: { eye: 10, nose: 4, mouth: 7, cheek: 6 }, glitch: 0.6 },
  minimal: { label: 'Minimal', counts: { eye: 2, nose: 0, mouth: 1, cheek: 0 }, glitch: 0 },
};

/** Slot table from the reference, in the order copies are added (removed in reverse). */
export const SLOTS = {
  eye: [
    { u: -0.43, v: -0.72, scale: 1.12 },
    { u: 0.41, v: -0.74, scale: 1.12 },
    { u: -0.69, v: -0.47, scale: 1.18 },
    { u: 0.01, v: -0.49, scale: 1.24 },
    { u: 0.65, v: -0.42, scale: 1.18 },
    { u: -0.02, v: -0.2, scale: 1.18 },
    { u: -0.71, v: 0.21, scale: 1.12, flipX: true },
    { u: 0.67, v: 0.27, scale: 1.12, flipX: true },
  ],
  nose: [
    { u: -0.35, v: 0.36, scale: 1.15 },
    { u: 0.15, v: 0.36, scale: 1.15 },
    { u: -0.38, v: 0.66, scale: 1.2 },
    { u: 0.2, v: 0.66, scale: 1.2 },
  ],
  mouth: [
    { u: -0.45, v: 1.09, scale: 0.95 },
    { u: -0.07, v: 1.74, scale: 1.35 },
    { u: -0.8, v: 1.46, scale: 1.3 },
    { u: 0.62, v: 1.46, scale: 1.2 },
    { u: 0.43, v: 1.03, scale: 0.9 },
    { u: 0.47, v: 2.17, scale: 1.15 },
  ],
};

/** Zones: slots and extra copies (beyond the table) keep their centre inside. */
export const ZONES = {
  eye: { u: [-0.85, 0.85], v: [-0.9, 0.45], scale: [1.1, 1.25], rot: 6 },
  nose: { u: [-0.55, 0.55], v: [0.25, 0.85], scale: [1.05, 1.2], rot: 6 },
  mouth: { u: [-0.9, 0.9], v: [0.9, 2.3], scale: [0.9, 1.3], rot: 8 },
  cheek: { u: [-1.45, 1.45], v: [0.3, 1.7], rot: 0 },
};

const JITTER = { pos: 0.06, scale: 0.08 };
/** Upscale cap per kind after jitter: a 1.6x+ mouth from a small source went blurry (QA R3, guide max 1.6). */
const MAX_SCALE = { eye: 1.3, nose: 1.3, mouth: 1.4 };
const SALT = { eye: 11, nose: 23, mouth: 37, cheek: 53 };
const EDGES = ['top', 'right', 'bottom', 'left'];
const HARD_SKEW_DEG = [5, 20];
const HARD_SKEW_SHARE = 0.45;
const FLIP_SHARE = 0.25;
const NOSE_DEEPEN = 0.25;
/** Edge slices (guide section 5). */
const SLICE = { h: [0.08, 0.35], shift: [0.1, 0.3], src: [0.72, 0.95], v: [0.3, 1.7], len: [0.35, 0.6] };
/** Heavy side gets about 2/3 of the slices: H H L H L H. */
const SLICE_SIDES = [1, 1, 0, 1, 0, 1];

/** Where the kept originals sit on an average face (QA overlays only). */
const ORIGINALS = [
  { kind: 'eye', source: 'eyeA', u: -0.5, v: -0.08 },
  { kind: 'eye', source: 'eyeB', u: 0.5, v: -0.08 },
  { kind: 'mouth', source: 'mouth', u: 0, v: 1.05 },
];

export const clampCount = (kind, n) => {
  const { min, max } = COUNT_LIMITS[kind];
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
};

const clamp = (x, [lo, hi]) => Math.min(hi, Math.max(lo, x));

/**
 * 1 or 2 hard (cut) edges per patch; the rest are feathered into the layer below (guide section 4).
 * 70% of first hard edges are top/bottom; the first hard edge may be slanted.
 * Eye copies only cut top/bottom so their sides melt into the copies next to them.
 */
/**
 * Eye copies: exactly one hard edge, alternating top / bottom by index, so stacked eyes do not
 * read as repeated horizontal stripes (QA R3 R6). Mouths: one hard edge, mostly a slanted side
 * cut, so neighbouring mouths blend into a wave instead of slats.
 */
export function eyeCut(rand, i) {
  const edge = i % 2 ? 'bottom' : 'top';
  const skew = rand() < HARD_SKEW_SHARE;
  return { kind: skew ? 'skew' : 'rect', edge, angle: skew ? range(rand, HARD_SKEW_DEG[0], HARD_SKEW_DEG[1]) : 0, hard: [edge] };
}

export function mouthCut(rand) {
  const r = rand();
  const edge = r < 0.35 ? 'left' : r < 0.7 ? 'right' : r < 0.85 ? 'top' : 'bottom';
  const skew = rand() < 0.6;
  return { kind: skew ? 'skew' : 'rect', edge, angle: skew ? range(rand, HARD_SKEW_DEG[0], HARD_SKEW_DEG[1]) : 0, hard: [edge] };
}

// Noses: one slanted top/bottom cut so the two tiers read as stacked noses, not boxes.
const cutFor = (kind, rand, i) => (kind === 'eye' || kind === 'nose' ? eyeCut(rand, i) : kind === 'mouth' ? mouthCut(rand) : makeCut(rand, EDGES));

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
  return { kind: skew ? 'skew' : 'rect', edge: first, angle: skew ? range(rand, HARD_SKEW_DEG[0], HARD_SKEW_DEG[1]) : 0, hard };
}

function slotOrExtra(kind, i, rand) {
  const slot = SLOTS[kind]?.[i];
  const z = ZONES[kind];
  if (!slot) {
    return { u: range(rand, z.u[0], z.u[1]), v: range(rand, z.v[0], z.v[1]), scale: range(rand, z.scale[0], z.scale[1]), flipX: null };
  }
  return {
    u: clamp(slot.u + range(rand, -JITTER.pos, JITTER.pos), z.u),
    v: clamp(slot.v + range(rand, -JITTER.pos, JITTER.pos), z.v),
    scale: Math.min(MAX_SCALE[kind] ?? Infinity, slot.scale * (1 + range(rand, -JITTER.scale, JITTER.scale))),
    flipX: slot.flipX ?? null,
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
      original: false,
      source,
      u: pos.u,
      v: pos.v,
      scale: pos.scale,
      rot: range(attr, -ZONES[kind].rot, ZONES[kind].rot),
      flipX,
      cut: cutFor(kind, attr, i),
      shade: kind === 'nose' ? range(attr, -0.04, 0) : range(attr, -0.05, 0.05),
      // Noses read too pale against the lifted skin (QA R3): deepen nostrils and tip shadow.
      deepen: kind === 'nose' ? NOSE_DEEPEN : 0,
    });
  }
  return out;
}

/** Edge slices: a strip of the finished collage at the face edge (srcU), pushed outwards by `shift`. */
function placeSlices(seed, total) {
  const heavy = mulberry32(hashSeed(seed, 4242))() < 0.5 ? -1 : 1;
  const out = [];
  for (let i = 0; i < total; i += 1) {
    const rand = mulberry32(hashSeed(seed, SALT.cheek * 1000 + i));
    const side = SLICE_SIDES[i % SLICE_SIDES.length] ? heavy : -heavy;
    const srcU = side * range(rand, SLICE.src[0], SLICE.src[1]);
    const shift = side * range(rand, SLICE.shift[0], SLICE.shift[1]);
    out.push({
      id: `cheek-${i}`,
      kind: 'cheek',
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
      cut: { kind: 'rect', edge: 'top', angle: 0, hard: ['top', 'bottom'] },
      shade: range(rand, -0.04, 0.04),
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
    original: true,
    scale: 1,
    rot: 0,
    flipX: false,
    cut: cutFor(o.kind, mulberry32(hashSeed(seed, 9001 + i)), i),
    shade: 0,
  }));
  // Full max-length lists sliced to the count, so changing a count never moves the others.
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
