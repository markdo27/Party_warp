/**
 * Canvas 2D renderer for the Face Collage prototype.
 *   1. flatten: replace the face oval with a blurred, brightened skin plate (soft edge, no seam)
 *   2. patches: cut eye / nose / mouth / cheek boxes from the live frame, hard edges, placed in the face frame
 *   3. compose + glitch: blur fallback while no face, slip bands with an R/B split, grain
 * Note: the foundation planned WebGL2; this prototype uses Canvas 2D to ship faster (see report).
 */
import { cutPolygon } from './layout.js';
import { frameMatrix, toPixel } from './faceFrame.js';
import { glitchBands } from './glitch.js';
import { mulberry32 } from './prng.js';
import { easeOut } from './trackingState.js';

const PLATE_GRID = 32; // working size of the skin plate before blurring
const PLATE_BLUR_GRID = 8; // ~0.35 IOD blur radius on a typical face
const PLATE_BRIGHTEN = 'rgba(255,248,240,0.10)'; // warm ~+0.25 EV lift
const FEATHER_IOD = 0.10;
const OVAL_INSET = 1.0; // full face oval so forehead/cheeks flatten cleanly while shadowBlur feathers the edge
const SEAM_PX = 1;
const SEAM_COLOR = 'rgba(0,0,0,0.16)';
const BG_BLUR_DIV = 18;
const GRAIN_SIZE = 192;
const GRAIN_SEED = 0x46434752;
const GRAIN_ALPHA = 0.08;
const GRAIN_SLOT_MS = 120;
const ADD_ANIM_MS = 150;
const COVER = {
  eye: { w: 1.0, h: 0.8, lift: 0.12 },
  nose: { w: 0.55, top: 0.05, bottom: 0.85 },
  mouth: { grow: 1.15 },
};

const make = (w = 1, h = 1) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};
const ctx2d = (c, opts) => c.getContext('2d', opts);

function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function pathPoly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

const EDGE_INDEX = { top: [0, 1], right: [1, 2], bottom: [2, 3], left: [3, 0] };

function makeGrain() {
  const rand = mulberry32(GRAIN_SEED);
  const c = make(GRAIN_SIZE, GRAIN_SIZE);
  const g = ctx2d(c);
  const img = g.createImageData(GRAIN_SIZE, GRAIN_SIZE);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(rand() * 256);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

export class CollageRenderer {
  constructor(outCanvas) {
    this.out = outCanvas;
    this.octx = ctx2d(outCanvas, { willReadFrequently: true });
    this.collage = make();
    this.cctx = ctx2d(this.collage);
    this.plate = make();
    this.pctx = ctx2d(this.plate);
    this.mask = make();
    this.mctx = ctx2d(this.mask);
    this.small = make(PLATE_GRID, PLATE_GRID);
    this.sctx = ctx2d(this.small, { willReadFrequently: true });
    this.tiny = make(PLATE_BLUR_GRID, PLATE_BLUR_GRID);
    this.tctx = ctx2d(this.tiny);
    this.small2 = make(PLATE_GRID, PLATE_GRID);
    this.s2ctx = ctx2d(this.small2);
    this.bgSmall = make();
    this.bgMid = make();
    this.grain = makeGrain();
    this.births = new Map();
    this.layoutSeed = null;
    this.hasCollage = false;
  }

  resize(w, h) {
    if (this.out.width === w && this.out.height === h) return;
    for (const c of [this.out, this.collage, this.plate, this.mask]) {
      c.width = w;
      c.height = h;
    }
    this.bgSmall.width = Math.max(4, Math.round(w / BG_BLUR_DIV));
    this.bgSmall.height = Math.max(4, Math.round(h / BG_BLUR_DIV));
    this.bgMid.width = this.bgSmall.width * 4;
    this.bgMid.height = this.bgSmall.height * 4;
    this.hasCollage = false;
  }

  /** Builds the collage layer from the live frame. `face` uses smoothed frame + features. */
  drawCollage(source, face, layout, seed, now, reducedMotion) {
    const { cctx } = this;
    const { width: W, height: H } = this.collage;
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.globalAlpha = 1;
    cctx.drawImage(source, 0, 0, W, H);
    this.drawPlate(source, face);
    cctx.drawImage(this.plate, 0, 0);
    this.trackBirths(layout, seed, now, reducedMotion);
    const F = frameMatrix(face.frame);
    const Finv = invert(F);
    for (const p of layout) this.drawPatch(source, face, p, F, Finv, now);
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.globalAlpha = 1;
    this.hasCollage = true;
  }

  trackBirths(layout, seed, now, reducedMotion) {
    // A new seed cuts instantly (visual spec 6); only patches added by a count change animate in.
    const instant = reducedMotion || seed !== this.layoutSeed;
    const ids = new Set(layout.map((p) => p.id));
    for (const id of [...this.births.keys()]) if (!ids.has(id)) this.births.delete(id);
    for (const p of layout) if (!this.births.has(p.id)) this.births.set(p.id, instant ? -Infinity : now);
    this.layoutSeed = seed;
  }

  drawPatch(source, face, p, F, Finv, now) {
    const { cctx } = this;
    const f = face.features[p.source];
    if (!f) return;
    const age = now - (this.births.get(p.id) ?? -Infinity);
    const grow = age < ADD_ANIM_MS ? easeOut(age / ADD_ANIM_MS) : 1;
    const du = p.original ? f.u : p.u;
    const dv = p.original ? f.v : p.v;
    const s = p.scale * (0.6 + 0.4 * grow);
    const pts = cutPolygon(f.w, f.h, p.cut);
    cctx.save();
    cctx.globalAlpha = grow;
    cctx.setTransform(...F);
    cctx.translate(du, dv);
    cctx.rotate((p.rot * Math.PI) / 180);
    cctx.scale(p.flipX ? -s : s, s);
    pathPoly(cctx, pts);
    cctx.clip();
    cctx.save();
    cctx.translate(-f.u, -f.v);
    cctx.transform(...Finv);
    cctx.drawImage(source, 0, 0, this.collage.width, this.collage.height);
    cctx.restore();
    // Subtle deterministic brightness jitter (±6%) and 1 px paste seam on copies so overlaps read clearly.
    if (!p.original) {
      if (p.shade) {
        cctx.fillStyle = p.shade > 0 ? `rgba(255,255,255,${p.shade.toFixed(3)})` : `rgba(0,0,0,${(-p.shade).toFixed(3)})`;
        cctx.fillRect(-f.w, -f.h, f.w * 2, f.h * 2);
      }
      const [i, j] = EDGE_INDEX[p.shadowEdge] ?? EDGE_INDEX.bottom;
      cctx.beginPath();
      cctx.moveTo(...pts[i]);
      cctx.lineTo(...pts[j]);
      cctx.lineWidth = (SEAM_PX * 2) / (face.frame.iod * s);
      cctx.strokeStyle = SEAM_COLOR;
      cctx.stroke();
    }
    cctx.restore();
  }

  /** Skin plate: face oval with features painted over in cheek colour, blurred, brightened, soft-edged. */
  drawPlate(source, face) {
    const { frame, features, oval } = face;
    const { width: W, height: H } = this.plate;
    const ovalPx = oval.map((q) => toPixel(frame, q));
    const xs = ovalPx.map((p) => p.x);
    const ys = ovalPx.map((p) => p.y);
    const pad = frame.iod * 0.2;
    const bx = Math.max(0, Math.min(...xs) - pad);
    const by = Math.max(0, Math.min(...ys) - pad);
    const bw = Math.min(W, Math.max(...xs) + pad) - bx;
    const bh = Math.min(H, Math.max(...ys) + pad) - by;
    if (bw < 4 || bh < 4) return;
    const G = PLATE_GRID;
    const toSmall = [G / bw, 0, 0, G / bh, (-bx * G) / bw, (-by * G) / bh];
    const { sctx } = this;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.drawImage(source, bx, by, bw, bh, 0, 0, G, G);
    const cheek = this.sampleCheeks(features, frame, toSmall);
    // Everything outside the oval becomes skin too, so background never bleeds into the blur.
    sctx.save();
    sctx.fillStyle = cheek.mid;
    sctx.beginPath();
    sctx.rect(0, 0, G, G);
    sctx.setTransform(...toSmall);
    pathPoly(sctx, ovalPx.map((p) => [p.x, p.y]));
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.fill('evenodd');
    sctx.restore();
    this.coverFeatures(features, frame, toSmall, cheek);
    this.tctx.drawImage(this.small, 0, 0, PLATE_BLUR_GRID, PLATE_BLUR_GRID);
    this.s2ctx.drawImage(this.tiny, 0, 0, G, G);
    const { pctx, mctx } = this;
    pctx.globalCompositeOperation = 'source-over';
    pctx.clearRect(0, 0, W, H);
    pctx.imageSmoothingQuality = 'high';
    pctx.drawImage(this.small2, 0, 0, G, G, bx, by, bw, bh);
    pctx.globalCompositeOperation = 'screen';
    pctx.fillStyle = PLATE_BRIGHTEN;
    pctx.fillRect(bx, by, bw, bh);
    // Soft oval mask via the shadow trick: pulled slightly inward so the feather fades cleanly inside the hairline/jaw.
    const cx = ovalPx.reduce((a, p) => a + p.x, 0) / ovalPx.length;
    const cy = ovalPx.reduce((a, p) => a + p.y, 0) / ovalPx.length;
    const insetOval = ovalPx.map((p) => [cx + (p.x - cx) * OVAL_INSET, cy + (p.y - cy) * OVAL_INSET]);
    mctx.clearRect(0, 0, W, H);
    mctx.save();
    const off = W + bw + 100;
    mctx.shadowColor = '#fff';
    mctx.shadowBlur = Math.max(4, FEATHER_IOD * frame.iod * 2.2);
    mctx.shadowOffsetX = off;
    mctx.fillStyle = '#fff';
    pathPoly(mctx, insetOval.map(([x, y]) => [x - off, y]));
    mctx.fill();
    mctx.restore();
    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(this.mask, 0, 0);
    pctx.globalCompositeOperation = 'source-over';
  }

  sampleCheeks(features, frame, toSmall) {
    const read = (q) => {
      const p = toPixel(frame, q);
      const x = Math.round(toSmall[0] * p.x + toSmall[4]);
      const y = Math.round(toSmall[3] * p.y + toSmall[5]);
      const cx = Math.min(PLATE_GRID - 2, Math.max(1, x));
      const cy = Math.min(PLATE_GRID - 2, Math.max(1, y));
      const d = this.sctx.getImageData(cx - 1, cy - 1, 3, 3).data;
      const rgb = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k += 1) rgb[k] += d[i + k] / 9;
      return rgb;
    };
    const a = read(features.cheekA);
    const b = read(features.cheekB);
    const css = (c) => `rgb(${c.map((v) => Math.round(v)).join(',')})`;
    return { a: css(a), b: css(b), mid: css(a.map((v, i) => (v + b[i]) / 2)) };
  }

  coverFeatures(features, frame, toSmall, cheek) {
    const { sctx } = this;
    const F = frameMatrix(frame);
    sctx.save();
    sctx.setTransform(...toSmall);
    sctx.transform(...F);
    const rect = (u, v, w, h, color) => {
      sctx.fillStyle = color;
      sctx.fillRect(u - w / 2, v - h / 2, w, h);
    };
    const { eyeA, eyeB, nose, mouth } = features;
    rect(eyeA.u, eyeA.v - COVER.eye.lift + 0.08, COVER.eye.w, COVER.eye.h, cheek.a);
    rect(eyeB.u, eyeB.v - COVER.eye.lift + 0.08, COVER.eye.w, COVER.eye.h, cheek.b);
    rect(nose.u, (COVER.nose.top + COVER.nose.bottom) / 2, COVER.nose.w, COVER.nose.bottom - COVER.nose.top, cheek.mid);
    rect(mouth.u, mouth.v, mouth.w * COVER.mouth.grow, mouth.h * COVER.mouth.grow, cheek.mid);
    sctx.restore();
  }

  /** Final frame: blurred camera under the collage (privacy while searching / lost), then glitch + grain. */
  compose(source, { alpha, seed, glitch, now, reducedMotion, avoidRows }) {
    const { octx } = this;
    const { width: W, height: H } = this.out;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalAlpha = 1;
    octx.globalCompositeOperation = 'source-over';
    if (alpha < 1 || !this.hasCollage) this.drawBlurred(source);
    if (alpha > 0 && this.hasCollage) {
      octx.globalAlpha = alpha;
      octx.drawImage(this.collage, 0, 0);
      octx.globalAlpha = 1;
    }
    const bands = glitchBands({ seed, timeMs: now, intensity: glitch * alpha, height: H, avoid: avoidRows, reducedMotion });
    for (const band of bands) this.slipBand(band, W);
    const grainAmt = glitch * alpha;
    if (grainAmt > 0) {
      const slot = reducedMotion ? 0 : Math.floor(now / GRAIN_SLOT_MS);
      octx.globalCompositeOperation = 'overlay';
      octx.globalAlpha = GRAIN_ALPHA * (0.4 + 0.6 * grainAmt);
      const gx = ((seed ^ Math.imul(slot, 73)) >>> 0) % GRAIN_SIZE;
      const gy = ((seed ^ Math.imul(slot, 151)) >>> 0) % GRAIN_SIZE;
      for (let y = -gy; y < H; y += GRAIN_SIZE) for (let x = -gx; x < W; x += GRAIN_SIZE) octx.drawImage(this.grain, x, y);
    }
    octx.globalCompositeOperation = 'source-over';
    octx.globalAlpha = 1;
    return bands;
  }

  drawBlurred(source) {
    const { octx } = this;
    const s = ctx2d(this.bgSmall);
    s.drawImage(source, 0, 0, this.bgSmall.width, this.bgSmall.height);
    const m = ctx2d(this.bgMid);
    m.drawImage(this.bgSmall, 0, 0, this.bgMid.width, this.bgMid.height);
    octx.drawImage(this.bgMid, 0, 0, this.out.width, this.out.height);
  }

  /** Shifts one band sideways and pulls R right / B left (channel split, no new colours). */
  slipBand({ y, h, shift, split }, W) {
    const src = this.octx.getImageData(0, y, W, h);
    const dst = this.octx.createImageData(W, h);
    const s = src.data;
    const d = dst.data;
    const clampX = (x) => (x < 0 ? 0 : x >= W ? W - 1 : x);
    for (let row = 0; row < h; row += 1) {
      const base = row * W;
      for (let x = 0; x < W; x += 1) {
        const o = (base + x) * 4;
        const xr = clampX(x - shift - split);
        const xg = clampX(x - shift);
        const xb = clampX(x - shift + split);
        d[o] = s[(base + xr) * 4];
        d[o + 1] = s[(base + xg) * 4 + 1];
        d[o + 2] = s[(base + xb) * 4 + 2];
        d[o + 3] = 255;
      }
    }
    this.octx.putImageData(dst, 0, y);
  }
}
