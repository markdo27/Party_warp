/**
 * Frame loop: camera (or photo) -> landmarks on a small detect canvas -> smoothed face frame
 * -> tracking state + Expression Frame Bank -> WebGL2 GPU collage renderer.
 * Owns no camera stream itself; the UI opens and stops the stream so the camera light always
 * follows the Stop button.
 */
import { ExpressionBank } from './frameBank.js';
import { CollageRenderer } from './renderer.js';
import { OneEuro, arrayToFrame, frameToArray, measureFace, toPixel, toPixels } from './faceFrame.js';
import { arrayToFeatures, featuresToArray } from './features.js';
import { makeLayout } from './layout.js';
import { collageAlpha, initialTracking, stepTracking } from './trackingState.js';

const MAX_OUT_SIDE = 960; // output canvas long side (perf on mid phones)
const DETECT_WIDTH = 480;
const SLOW_DETECT_MS = 20; // above this, detect every other frame
const EYE_BAND_IOD = 0.3;
const NOSE_BAND_V = [0.22, 0.85];
const FPS_WINDOW_MS = 1000;
const TIMELINE_MAX = 400;

const now = () => performance.now();

function fitSize(w, h) {
  const k = Math.min(1, MAX_OUT_SIDE / Math.max(w, h));
  return { width: Math.max(2, Math.round((w * k) / 2) * 2), height: Math.max(2, Math.round((h * k) / 2) * 2) };
}

const sourceSize = (src) =>
  src instanceof HTMLVideoElement ? { w: src.videoWidth, h: src.videoHeight } : { w: src.naturalWidth || src.width, h: src.naturalHeight || src.height };

export class CollageEngine {
  /** @param {{ canvas: HTMLCanvasElement, tracker: { detect: Function, delegate: string }, reducedMotion?: boolean, onPhase?: (phase: string) => void }} opts */
  constructor({ canvas, tracker, reducedMotion = false, onPhase }) {
    this.canvas = canvas;
    this.tracker = tracker;
    this.reducedMotion = reducedMotion;
    this.onPhase = onPhase;
    this.renderer = new CollageRenderer(canvas);
    this.bank = new ExpressionBank();
    // Small detect canvas only (480px); WebGL2 samples source directly with shader mirroring.
    this.detectCanvas = document.createElement('canvas');
    this.dctx = this.detectCanvas.getContext('2d', { willReadFrequently: false });
    this.frameFilter = new OneEuro({ minCutoff: 1.2, beta: 0.03 });
    this.featureFilter = new OneEuro({ minCutoff: 1.0, beta: 0.02 });
    this.params = { seed: 1, counts: { eye: 6, nose: 0, mouth: 3, cheek: 0 }, glitch: 0.3, bank: false };
    this.layout = makeLayout(this.params);
    this.source = null;
    this.isStill = false;
    this.stillFace = null;
    this.mirror = false;
    this.outWidth = 2;
    this.outHeight = 2;
    this.raf = 0;
    this.running = false;
    this.face = null;
    this.tracking = initialTracking(now());
    this.stats = { fps: 0, detectMs: 0, renderMs: 0, frames: 0, fpsFrames: 0, fpsAt: now(), skipNext: false };
    this.timeline = [];
    this.bands = [];
  }

  bankOpts() {
    return { enabled: Boolean(this.params.bank), isStill: this.isStill, reducedMotion: this.reducedMotion };
  }

  /** High-key magazine-scan grade runs on Default/Ref/Custom, off on Minimal (pure flatten test Q1/Q2). */
  gradeAmount() {
    const { counts, glitch } = this.params;
    const isMinimal = counts.eye === 2 && counts.nose === 0 && counts.mouth === 1 && (counts.cheek ?? 0) === 0 && glitch === 0;
    return isMinimal ? 0 : 1;
  }

  setParams({ seed, counts, glitch, bank }) {
    const next = {
      ...this.params,
      ...(seed !== undefined && { seed }),
      ...(counts && { counts: { ...counts } }),
      ...(glitch !== undefined && { glitch }),
      ...(bank !== undefined && { bank: Boolean(bank) }),
    };
    const layoutChanged = next.seed !== this.params.seed || JSON.stringify(next.counts) !== JSON.stringify(this.params.counts);
    const bankToggled = next.bank !== this.params.bank;
    this.params = next;
    if (bankToggled && !next.bank) {
      this.bank.clear();
      this.renderer.clearBank();
    }
    if (layoutChanged) {
      this.layout = makeLayout(next);
      // While holding, the frozen collage must still show the new layout.
      if (this.face && this.tracking.phase === 'holding' && this.source) {
        this.renderer.drawCollage(this.source, this.face, this.layout, next.seed, now(), this.reducedMotion, {
          mirror: this.mirror,
          bank: this.bank,
          bankUpdates: [],
          bankOpts: this.bankOpts(),
        });
      }
    }
  }

  /** @param {HTMLVideoElement|HTMLImageElement} source */
  start(source, { mirror }) {
    this.stop();
    this.source = source;
    this.isStill = typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement;
    this.stillFace = null;
    this.mirror = Boolean(mirror);
    const { w, h } = sourceSize(source);
    const out = fitSize(w, h);
    this.outWidth = out.width;
    this.outHeight = out.height;
    this.detectCanvas.width = DETECT_WIDTH;
    this.detectCanvas.height = Math.max(2, Math.round((DETECT_WIDTH * out.height) / out.width));
    this.renderer.resize(out.width, out.height);
    this.bank.clear();
    this.renderer.clearBank();
    this.frameFilter.reset();
    this.featureFilter.reset();
    this.face = null;
    this.tracking = initialTracking(now());
    this.timeline = [];
    this.setPhase(this.tracking.phase);
    this.running = true;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.source = null;
    this.bank.clear();
    this.renderer.clearBank();
  }

  dispose() {
    this.stop();
    this.renderer.dispose();
  }

  /** `t` is the frame time the state machine used, so logged gaps match HOLD_MS exactly. */
  setPhase(phase, t = now()) {
    this.timeline.push({ phase, t: Math.round(t) });
    if (this.timeline.length > TIMELINE_MAX) this.timeline = this.timeline.slice(-TIMELINE_MAX);
    this.onPhase?.(phase);
  }

  tick = () => {
    if (!this.running) return;
    try {
      this.step(now());
    } catch (err) {
      console.error('[face-collage] frame failed', err);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  drawDetectFrame() {
    const { dctx, detectCanvas: c } = this;
    dctx.setTransform(this.mirror ? -1 : 1, 0, 0, 1, this.mirror ? c.width : 0, 0);
    dctx.drawImage(this.source, 0, 0, c.width, c.height);
    dctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  detect(t) {
    if (this.isStill && this.stillFace) return this.stillFace;
    const s = this.stats;
    if (s.skipNext) {
      s.skipNext = false;
      return undefined; // no new result this frame
    }
    this.drawDetectFrame();
    const t0 = now();
    const lm = this.tracker.detect(this.detectCanvas, t);
    s.detectMs = now() - t0;
    s.skipNext = s.detectMs > SLOW_DETECT_MS;
    if (!lm) return null;
    // The detect canvas is already mirrored, so landmarks map straight onto output pixels.
    const measured = measureFace(toPixels(lm, this.outWidth, this.outHeight, false));
    if (this.isStill && measured) this.stillFace = measured;
    return measured;
  }

  smooth(raw, t) {
    if (this.isStill) return raw;
    const sec = t / 1000;
    const frame = arrayToFrame(this.frameFilter.filter(frameToArray(raw.frame), sec));
    const features = arrayToFeatures(this.featureFilter.filter(featuresToArray(raw.features), sec));
    return { frame, features, oval: raw.oval, contours: raw.contours, expressions: raw.expressions };
  }

  step(t) {
    if (!this.source) return;
    const raw = this.detect(t);
    if (raw !== undefined) {
      const before = this.tracking.phase;
      if (raw && (before === 'searching' || before === 'lost')) {
        this.frameFilter.reset();
        this.featureFilter.reset();
      }
      this.tracking = stepTracking(this.tracking, { face: raw, now: t });
      if (raw) this.face = this.smooth(raw, t);
      if (this.tracking.phase !== before) {
        if (this.tracking.phase === 'lost') {
          this.bank.clear();
          this.renderer.clearBank();
        }
        this.setPhase(this.tracking.phase, t);
      }
    } else if (this.tracking.phase === 'holding') {
      this.tracking = stepTracking(this.tracking, { face: null, now: t });
      if (this.tracking.phase !== 'holding') {
        if (this.tracking.phase === 'lost') {
          this.bank.clear();
          this.renderer.clearBank();
        }
        this.setPhase(this.tracking.phase, t);
      }
    }

    const r0 = now();
    const { seed, glitch } = this.params;
    const bankOpts = this.bankOpts();
    if (this.tracking.phase === 'tracking' && this.face) {
      const bankUpdates = this.bank.update(this.face, t, bankOpts);
      this.renderer.drawCollage(this.source, this.face, this.layout, seed, t, this.reducedMotion, {
        mirror: this.mirror,
        bank: this.bank,
        bankUpdates,
        bankOpts,
      });
    }
    const alpha = collageAlpha(this.tracking, t, this.reducedMotion);
    this.bands = this.renderer.compose(this.source, {
      alpha,
      seed,
      glitch,
      now: t,
      reducedMotion: this.reducedMotion,
      avoidRows: this.protectedRows(),
      face: this.face ? { cx: this.face.frame.ox, iod: this.face.frame.iod } : null,
      mirror: this.mirror,
      gradeAmt: this.gradeAmount(),
    });
    this.stats.renderMs = now() - r0;
    this.countFps(t);
  }

  /** Protects eye cluster and 2-tier nose band from stray full-width glitch bands (QA R4/R5 R11). */
  protectedRows() {
    if (!this.face) return [];
    const { frame, features } = this.face;
    const rows = ['eyeA', 'eyeB'].map((k) => {
      const y = toPixel(frame, features[k]).y;
      const half = EYE_BAND_IOD * frame.iod;
      return [y - half, y + half];
    });
    if (this.params.counts.eye > 2) {
      const y0 = toPixel(frame, { u: 0, v: -0.68 }).y;
      const y1 = toPixel(frame, { u: 0, v: 0.05 }).y;
      rows.push([Math.min(y0, y1), Math.max(y0, y1)]);
    }
    if (this.params.counts.nose > 0) {
      const y0 = toPixel(frame, { u: 0, v: NOSE_BAND_V[0] }).y;
      const y1 = toPixel(frame, { u: 0, v: NOSE_BAND_V[1] }).y;
      rows.push([Math.min(y0, y1), Math.max(y0, y1)]);
    }
    return rows;
  }

  countFps(t) {
    const s = this.stats;
    s.frames += 1;
    s.fpsFrames += 1;
    if (t - s.fpsAt >= FPS_WINDOW_MS) {
      s.fps = (s.fpsFrames * 1000) / (t - s.fpsAt);
      s.fpsFrames = 0;
      s.fpsAt = t;
    }
  }

  /** Read-only state for the debug HUD and the e2e tests (window.__faceCollage). */
  snapshot() {
    const t = now();
    const { fps, detectMs, renderMs, frames } = this.stats;
    const counts = this.layout.reduce((acc, p) => ({ ...acc, [p.kind]: (acc[p.kind] ?? 0) + 1 }), {});
    return {
      renderer: this.renderer.backend,
      phase: this.tracking.phase,
      alpha: collageAlpha(this.tracking, t, this.reducedMotion),
      timeline: this.timeline.slice(),
      fps: Math.round(fps * 10) / 10,
      detectMs: Math.round(detectMs * 10) / 10,
      renderMs: Math.round(renderMs * 10) / 10,
      stages: Object.fromEntries(Object.entries(this.renderer.timings ?? {}).map(([k, v]) => [k, Math.round(v * 10) / 10])),
      frames,
      delegate: this.tracker.delegate,
      seed: this.params.seed,
      glitch: this.params.glitch,
      bankEnabled: Boolean(this.params.bank),
      bank: this.bank.summary(t, this.face?.expressions ?? null),
      bands: this.bands.length,
      counts,
      patches: this.layout.map(({ id, kind, u, v, scale, rot, mask, expr, cut }) => ({
        id,
        kind,
        u,
        v,
        scale,
        rot,
        mask,
        expr,
        hard: cut?.hard ?? [],
      })),
      face: this.face ? { iod: Math.round(this.face.frame.iod), ox: Math.round(this.face.frame.ox), oy: Math.round(this.face.frame.oy) } : null,
      size: { width: this.canvas.width, height: this.canvas.height },
    };
  }

  /** PNG of the distorted output only; raw camera frames are never exported. */
  toPng() {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
    });
  }
}
