/**
 * Canvas 2D renderer for the Face Collage prototype.
 *   1. flatten: replace the face oval with a blurred, brightened skin plate (soft edge, no seam)
 *   2. patches: eye / nose / mouth boxes from the live frame on the ref slot table; 1-2 hard cut edges,
 *      the rest feathered into the layer below (ref-match guide section 4)
 *   3. edge slices: strips of the finished collage at the face edge pushed outwards (guide section 5)
 *   4. tone grade: lift + warm curve inside the face ellipse (guide section 2)
 *   5. compose + glitch: blur fallback while no face, slip bands at the face edges with an R/B split, grain
 * Note: the foundation planned WebGL2; this prototype uses Canvas 2D to ship faster (see report).
 */
import { cutPolygon, softEdges } from './layout.js';
import { frameMatrix, toPixel } from './faceFrame.js';
import { glitchBands } from './glitch.js';
import { mulberry32 } from './prng.js';
import { easeOut } from './trackingState.js';

const PLATE_GRID = 32; // working size of the skin plate before blurring
const PLATE_BLUR_GRID = 8; // ~0.35 IOD blur radius on a typical face
const PLATE_BRIGHTEN = 'rgba(255,248,240,0.10)'; // warm ~+0.25 EV lift
const FEATHER_IOD = 0.10;
const PATCH_FEATHER_IOD = 0.12; // soft patch edges; guide says ~0.05 IOD, 0.12 hides the box sides at phone sizes
const MAX_SCRATCH_PX = 1024;
/** Tone grade: lift curve y = (1 - e^(-kx)) / (1 - e^(-k)) per channel, then a contrast stretch around `mid`. */
const GRADE = { k: [1.6, 1.55, 1.0], mid: 150, contrast: 1.45, u0: 0, v0: 0.65, ru: 1.2, rv: 1.7, feather: 0.18, outside: 0.25 };
const EDGE_INDEX = { top: [0, 1], right: [1, 2], bottom: [2, 3], left: [3, 0] };
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
    for (const p of layout) {
      if (p.kind === 'cheek') this.drawSlice(face, p, F, Finv, now);
      else this.drawPatch(source, face, p, F, Finv, now);
    }
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    this.grade(face);
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
    // Patch is built in a face-aligned scratch canvas, then pasted with move / rotate / flip.
    const { x, sw, sh, kx } = this.scratchFor(f.w, f.h, face.frame.iod * s);
    x.save();
    pathPoly(x, pts);
    x.clip();
    x.save();
    x.translate(-f.u, -f.v);
    x.transform(...Finv);
    x.drawImage(source, 0, 0, this.collage.width, this.collage.height);
    x.restore();
    this.shadeScratch(x, f.w, f.h, p.shade);
    x.restore();
    this.finishEdges(x, f.w, f.h, pts, p.cut, PATCH_FEATHER_IOD / s, (SEAM_PX * 2) / kx);
    cctx.save();
    cctx.globalAlpha = grow;
    cctx.setTransform(...F);
    cctx.translate(du, dv);
    cctx.rotate((p.rot * Math.PI) / 180);
    cctx.scale(p.flipX ? -s : s, s);
    cctx.drawImage(this.scratch, 0, 0, sw, sh, -f.w / 2, -f.h / 2, f.w, f.h);
    cctx.restore();
  }

  /** Edge slice: copies a strip of the finished collage at srcU and pastes it `shift` further out. */
  drawSlice(face, p, F, Finv, now) {
    const { cctx } = this;
    const age = now - (this.births.get(p.id) ?? -Infinity);
    const grow = age < ADD_ANIM_MS ? easeOut(age / ADD_ANIM_MS) : 1;
    const w = p.len;
    const h = p.h;
    const pts = cutPolygon(w, h, p.cut);
    const { x, sw, sh, kx } = this.scratchFor(w, h, face.frame.iod);
    x.save();
    x.translate(-p.srcU, -p.v);
    x.transform(...Finv);
    x.drawImage(this.collage, 0, 0);
    x.restore();
    this.shadeScratch(x, w, h, p.shade);
    this.finishEdges(x, w, h, pts, p.cut, PATCH_FEATHER_IOD, (SEAM_PX * 2) / kx);
    cctx.save();
    cctx.globalAlpha = grow;
    cctx.setTransform(...F);
    cctx.translate(p.srcU + p.shift * grow, p.v);
    cctx.drawImage(this.scratch, 0, 0, sw, sh, -w / 2, -h / 2, w, h);
    cctx.restore();
  }

  /** Patch-local scratch canvas at `k` px per face unit, local origin at its centre. */
  scratchFor(w, h, k) {
    if (!this.scratch) {
      this.scratch = make();
      this.xctx = ctx2d(this.scratch);
    }
    const sw = Math.max(2, Math.min(MAX_SCRATCH_PX, Math.ceil(w * k)));
    const sh = Math.max(2, Math.min(MAX_SCRATCH_PX, Math.ceil(h * k)));
    this.scratch.width = sw; // resizing also clears
    this.scratch.height = sh;
    const kx = sw / w;
    this.xctx.setTransform(kx, 0, 0, sh / h, sw / 2, sh / 2);
    return { x: this.xctx, sw, sh, kx };
  }

  /** Deterministic brightness jitter (about ±5%) so stacked copies read as separate pieces. */
  shadeScratch(x, w, h, shade) {
    if (!shade) return;
    x.save();
    x.globalCompositeOperation = 'source-atop';
    x.fillStyle = shade > 0 ? `rgba(255,255,255,${shade.toFixed(3)})` : `rgba(0,0,0,${(-shade).toFixed(3)})`;
    x.fillRect(-w, -h, w * 2, h * 2);
    x.restore();
  }

  /** Feathers soft edges with destination-out ramps and draws a 1 px seam along the hard (cut) edges. */
  finishEdges(x, w, h, pts, cut, feather, seamW) {
    x.save();
    x.globalCompositeOperation = 'destination-out';
    for (const e of softEdges(cut)) {
      const vert = e === 'top' || e === 'bottom';
      const half = (vert ? h : w) / 2;
      const sign = e === 'top' || e === 'left' ? -1 : 1;
      const outer = sign * half;
      const inner = outer - sign * feather;
      const g = vert ? x.createLinearGradient(0, outer, 0, inner) : x.createLinearGradient(outer, 0, inner, 0);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g;
      const a = Math.min(outer, inner);
      if (vert) x.fillRect(-w, a, w * 2, feather);
      else x.fillRect(a, -h, feather, h * 2);
    }
    x.globalCompositeOperation = 'source-atop';
    x.strokeStyle = SEAM_COLOR;
    x.lineWidth = seamW;
    for (const e of cut.hard ?? []) {
      const [i, j] = EDGE_INDEX[e];
      x.beginPath();
      x.moveTo(...pts[i]);
      x.lineTo(...pts[j]);
      x.stroke();
    }
    x.restore();
  }

  /** Lift + warm tone curve inside a feathered face ellipse (guide section 2); mild lift outside it. */
  grade(face) {
    if (!this.lut) {
      this.lut = GRADE.k.map((kk) => {
        const t = new Uint8ClampedArray(256);
        for (let i = 0; i < 256; i += 1) t[i] = Math.round((255 * (1 - Math.exp((-kk * i) / 255))) / (1 - Math.exp(-kk)));
        return t;
      });
      // Contrast is stretched on luma only (same offset on R, G, B) so it does not push the chroma.
      this.lumaDelta = new Float32Array(256);
      for (let i = 0; i < 256; i += 1) this.lumaDelta[i] = (i - GRADE.mid) * (GRADE.contrast - 1);
    }
    const ld = this.lumaDelta;
    const { frame } = face;
    const { width: W, height: H } = this.collage;
    const c = toPixel(frame, { u: GRADE.u0, v: GRADE.v0 });
    const r = Math.max(GRADE.ru, GRADE.rv) * (1 + GRADE.feather) * frame.iod;
    const x0 = Math.max(0, Math.floor(c.x - r));
    const y0 = Math.max(0, Math.floor(c.y - r));
    const x1 = Math.min(W, Math.ceil(c.x + r));
    const y1 = Math.min(H, Math.ceil(c.y + r));
    if (x1 - x0 < 2 || y1 - y0 < 2) return;
    const img = this.cctx.getImageData(x0, y0, x1 - x0, y1 - y0);
    const d = img.data;
    const [lr, lg, lb] = this.lut;
    const iw = x1 - x0;
    const inv = 1 / frame.iod;
    for (let yy = y0; yy < y1; yy += 1) {
      const py = yy + 0.5 - frame.oy;
      for (let xx = x0; xx < x1; xx += 1) {
        const px = xx + 0.5 - frame.ox;
        const du = ((px * frame.ax + py * frame.ay) * inv - GRADE.u0) / GRADE.ru;
        const dv = ((-px * frame.ay + py * frame.ax) * inv - GRADE.v0) / GRADE.rv;
        const q = Math.sqrt(du * du + dv * dv);
        const inside = q <= 1 ? 1 : q >= 1 + GRADE.feather ? 0 : 1 - (q - 1) / GRADE.feather;
        const m = GRADE.outside + (1 - GRADE.outside) * inside;
        const o = ((yy - y0) * iw + (xx - x0)) * 4;
        const r0 = lr[d[o]];
        const g0 = lg[d[o + 1]];
        const b0 = lb[d[o + 2]];
        const lift = ld[(0.299 * r0 + 0.587 * g0 + 0.114 * b0) | 0];
        d[o] += (r0 + lift - d[o]) * m;
        d[o + 1] += (g0 + lift - d[o + 1]) * m;
        d[o + 2] += (b0 + lift - d[o + 2]) * m;
      }
    }
    this.cctx.putImageData(img, x0, y0);
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
  compose(source, { alpha, seed, glitch, now, reducedMotion, avoidRows, face = null }) {
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
    const bands = glitchBands({ seed, timeMs: now, intensity: glitch * alpha, height: H, width: W, face, avoid: avoidRows, reducedMotion });
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
  slipBand({ y, h, shift, split, x0 = 0, x1 = W }, W) {
    const bx = Math.max(0, x0);
    const bw = Math.min(W, x1) - bx;
    if (bw < 1) return;
    const src = this.octx.getImageData(0, y, W, h);
    const dst = this.octx.createImageData(bw, h);
    const s = src.data;
    const d = dst.data;
    const clampX = (x) => (x < 0 ? 0 : x >= W ? W - 1 : x);
    for (let row = 0; row < h; row += 1) {
      const base = row * W;
      for (let x = bx; x < bx + bw; x += 1) {
        const o = (row * bw + x - bx) * 4;
        const xr = clampX(x - shift - split);
        const xg = clampX(x - shift);
        const xb = clampX(x - shift + split);
        d[o] = s[(base + xr) * 4];
        d[o + 1] = s[(base + xg) * 4 + 1];
        d[o + 2] = s[(base + xb) * 4 + 2];
        d[o + 3] = 255;
      }
    }
    this.octx.putImageData(dst, bx, y);
  }
}
