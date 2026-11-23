/**
 * Collage layout: seed + counts -> list of patches placed in the face frame
 * (u right, v down, 1 = inter-ocular distance). Pure and deterministic.
 *
 * Counts include the kept originals (2 eyes, 1 mouth), as in the visual spec B5.
 * Every patch draws from its own PRNG stream and only checks overlap against
 * patches earlier in its list, so raising or lowering a count keeps the others still.
 */
import { hashSeed, mulberry32, range } from './prng.js';

export const COUNT_LIMITS = {
  eye: { min: 2, max: 12 },
  nose: { min: 0, max: 6 },
  mouth: { min: 1, max: 8 },
  cheek: { min: 0, max: 4 },
};

export const PRESETS = {
  default: { label: 'Default', counts: { eye: 6, nose: 0, mouth: 3, cheek: 0 }, glitch: 0.3 },
  ref: { label: 'Ref', counts: { eye: 10, nose: 4, mouth: 6, cheek: 3 }, glitch: 0.6 },
  minimal: { label: 'Minimal', counts: { eye: 2, nose: 0, mouth: 1, cheek: 0 }, glitch: 0 },
};

/** Placement zones (visual spec B4). Copies' centres must stay inside. */
export const ZONES = {
  eye: { u: [-1.15, 1.15], v: [-0.95, 0.45], scale: [0.85, 1.25], rot: 12, overlap: 0.35 },
  nose: { u: [-0.55, 0.55], v: [0.3, 0.95], scale: [0.9, 1.15], rot: 6, overlap: 0.5, rows: [0.45, 0.8] },
  mouth: { u: [-1.25, 1.25], v: [0.9, 1.95], scale: [0.9, 1.4], rot: 10, overlap: 0.45 },
  cheek: { u: [-1.45, 1.45], v: [0.5, 1.3], scale: [0.9, 1.1], rot: 8, overlap: 1 },
};

/** Nominal sizes in IOD, only used to judge overlap while placing. */
const NOMINAL = {
  eye: { w: 0.8, h: 0.55 },
  nose: { w: 0.6, h: 0.55 },
  mouth: { w: 1.2, h: 0.5 },
  cheek: { w: 0.55, h: 0.7 },
};

/** Where the kept originals sit on an average face, for overlap checks only. */
const ORIGINALS = [
  { kind: 'eye', source: 'eyeA', u: -0.5, v: -0.08 },
  { kind: 'eye', source: 'eyeB', u: 0.5, v: -0.08 },
  { kind: 'mouth', source: 'mouth', u: 0, v: 1.05 },
];

const SALT = { eye: 11, nose: 23, mouth: 37, cheek: 53 };
const MAX_TRIES = 30;
const SKEW_SHARE = 0.4;
const SKEW_DEG = [8, 20];
const EDGES = ['top', 'right', 'bottom', 'left'];
const MOUTH_WAVE = { amp: 0.12, period: 1.6, rows: [1.0, 1.82] };
const CHEEK_OUT = [0.1, 0.3];
const CHEEK_BASE_U = 0.95;

export const clampCount = (kind, n) => {
  const { min, max } = COUNT_LIMITS[kind];
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
};

/** Overlap as a share of the smaller box (axis-aligned approximation). */
function overlapShare(a, b) {
  const ix = Math.max(0, Math.min(a.u + a.w / 2, b.u + b.w / 2) - Math.max(a.u - a.w / 2, b.u - b.w / 2));
  const iy = Math.max(0, Math.min(a.v + a.h / 2, b.v + b.h / 2) - Math.max(a.v - a.h / 2, b.v - b.h / 2));
  return (ix * iy) / Math.min(a.w * a.h, b.w * b.h);
}

const box = (kind, u, v, scale) => ({ u, v, w: NOMINAL[kind].w * scale, h: NOMINAL[kind].h * scale });

function proposePosition(kind, i, rand) {
  const z = ZONES[kind];
  if (kind === 'nose') {
    return { u: range(rand, z.u[0], z.u[1]), v: z.rows[i % z.rows.length] + range(rand, -0.06, 0.06) };
  }
  if (kind === 'mouth') {
    const u = range(rand, -1.1, 1.1);
    const row = range(rand, MOUTH_WAVE.rows[0], MOUTH_WAVE.rows[1]);
    const v = row + MOUTH_WAVE.amp * Math.sin((2 * Math.PI * u) / MOUTH_WAVE.period);
    return { u, v: Math.min(z.v[1], Math.max(z.v[0], v)) };
  }
  if (kind === 'cheek') {
    const side = i % 2 === 0 ? -1 : 1;
    return { u: side * (CHEEK_BASE_U + range(rand, CHEEK_OUT[0], CHEEK_OUT[1])), v: range(rand, z.v[0], z.v[1]) };
  }
  return { u: range(rand, z.u[0], z.u[1]), v: range(rand, z.v[0], z.v[1]) };
}

function scaleFor(kind, v, rand) {
  const [lo, hi] = ZONES[kind].scale;
  if (kind !== 'mouth') return range(rand, lo, hi);
  // Lower mouths are bigger, like the reference.
  const depth = (v - ZONES.mouth.v[0]) / (ZONES.mouth.v[1] - ZONES.mouth.v[0]);
  return Math.min(hi, Math.max(lo, lo + (hi - lo) * depth + range(rand, -0.08, 0.08)));
}

function sourceFor(kind, i, rand, u) {
  if (kind === 'eye') return rand() < 0.5 ? 'eyeA' : 'eyeB';
  if (kind === 'cheek') return u < 0 ? 'cheekA' : 'cheekB';
  return kind;
}

function makeCut(rand, kind) {
  const skew = kind === 'cheek' || rand() < SKEW_SHARE;
  return skew
    ? { kind: 'skew', edge: EDGES[Math.floor(rand() * 4)], angle: range(rand, SKEW_DEG[0], SKEW_DEG[1]) }
    : { kind: 'rect' };
}

function placeCopies(kind, seed, total, placed) {
  const out = [];
  const zone = ZONES[kind];
  for (let i = 0; i < total; i += 1) {
    const rand = mulberry32(hashSeed(seed, SALT[kind] * 1000 + i));
    const sameKind = placed.filter((p) => p.kind === kind).concat(out);
    let best = null;
    for (let t = 0; t < MAX_TRIES; t += 1) {
      const pos = proposePosition(kind, i, rand);
      const scale = scaleFor(kind, pos.v, rand);
      const b = box(kind, pos.u, pos.v, scale);
      const worst = sameKind.reduce((m, p) => Math.max(m, overlapShare(b, box(kind, p.u, p.v, p.scale ?? 1))), 0);
      if (!best || worst < best.worst) best = { ...pos, scale, worst };
      if (worst <= zone.overlap) break;
    }
    const attr = mulberry32(hashSeed(seed, SALT[kind] * 7919 + i));
    out.push({
      id: `${kind}-${i}`,
      kind,
      original: false,
      source: sourceFor(kind, i, attr, best.u),
      u: best.u,
      v: best.v,
      scale: best.scale,
      rot: range(attr, -zone.rot, zone.rot),
      flipX: kind === 'eye' && attr() < 0.25,
      cut: makeCut(attr, kind),
      shadowEdge: EDGES[Math.floor(attr() * 4)],
    });
  }
  return out;
}

/**
 * @param {{ seed: number, counts: { eye: number, nose: number, mouth: number, cheek?: number } }} opts
 * @returns {Array<object>} patches sorted back-to-front (lower centre drawn later, as in the reference)
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
    original: true,
    scale: 1,
    rot: 0,
    flipX: false,
    cut: { kind: 'rect' },
    shadowEdge: 'bottom',
  }));
  // Full max-length lists sliced to the count, so changing a count never moves the others.
  const eyes = placeCopies('eye', seed, COUNT_LIMITS.eye.max - 2, originals).slice(0, n.eye - 2);
  const noses = placeCopies('nose', seed, COUNT_LIMITS.nose.max, originals).slice(0, n.nose);
  const mouths = placeCopies('mouth', seed, COUNT_LIMITS.mouth.max - 1, originals).slice(0, n.mouth - 1);
  const cheeks = placeCopies('cheek', seed, COUNT_LIMITS.cheek.max, originals).slice(0, n.cheek);
  return [...originals, ...eyes, ...noses, ...mouths, ...cheeks].sort((a, b) => a.v - b.v || a.id.localeCompare(b.id));
}

/** True when a copy's centre lies inside its zone (QA Q5). Originals follow the real face. */
export function inZone(p) {
  if (p.original) return true;
  const z = ZONES[p.kind];
  return p.u >= z.u[0] && p.u <= z.u[1] && p.v >= z.v[0] && p.v <= z.v[1];
}

/** Clip polygon in patch-local units for a w x h patch centred on 0,0. */
export function cutPolygon(w, h, cut) {
  const x = w / 2;
  const y = h / 2;
  const pts = [
    [-x, -y],
    [x, -y],
    [x, y],
    [-x, y],
  ];
  if (cut.kind !== 'skew') return pts;
  const t = Math.tan((cut.angle * Math.PI) / 180);
  // Tilt one edge by pulling one of its corners inwards.
  if (cut.edge === 'top') pts[1] = [x, -y + Math.min(h * 0.6, w * t)];
  if (cut.edge === 'bottom') pts[3] = [-x, y - Math.min(h * 0.6, w * t)];
  if (cut.edge === 'left') pts[0] = [-x + Math.min(w * 0.6, h * t), -y];
  if (cut.edge === 'right') pts[2] = [x - Math.min(w * 0.6, h * t), y];
  return pts;
}
