/**
 * Frame loop: camera (or photo) -> mirrored frame canvas -> landmarks on a small detect canvas
 * -> smoothed face frame -> tracking state -> collage renderer. Owns no camera stream itself;
 * the UI opens and stops the stream so the camera light always follows the Stop button.
 */
import { CollageRenderer } from './renderer.js';
import { OneEuro, arrayToFrame, frameToArray, measureFace, toPixel, toPixels } from './faceFrame.js';
import { arrayToFeatures, featuresToArray } from './features.js';
import { makeLayout } from './layout.js';
import { collageAlpha, initialTracking, stepTracking } from './trackingState.js';

const MAX_OUT_SIDE = 960; // output canvas long side (perf on mid phones)
const DETECT_WIDTH = 480;
const SLOW_DETECT_MS = 20; // above this, detect every other frame
const EYE_BAND_IOD = 0.3;
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
    this.frameCanvas = document.createElement('canvas');
    this.fctx = this.frameCanvas.getContext('2d');
    this.detectCanvas = document.createElement('canvas');
    this.dctx = this.detectCanvas.getContext('2d', { willReadFrequently: false });
    this.frameFilter = new OneEuro({ minCutoff: 1.2, beta: 0.03 });
    this.featureFilter = new OneEuro({ minCutoff: 1.0, beta: 0.02 });
    this.params = { seed: 1, counts: { eye: 6, nose: 0, mouth: 3, cheek: 0 }, glitch: 0.3 };
    this.layout = makeLayout(this.params);
    this.source = null;
    this.isStill = false;
    this.stillFace = null;
    this.mirror = false;
    this.raf = 0;
    this.running = false;
    this.face = null;
    this.tracking = initialTracking(now());
    this.stats = { fps: 0, detectMs: 0, renderMs: 0, frames: 0, fpsFrames: 0, fpsAt: now(), skipNext: false };
    this.timeline = [];
    this.bands = [];
  }

  setParams({ seed, counts, glitch }) {
    const next = { ...this.params, ...(seed !== undefined && { seed }), ...(counts && { counts: { ...counts } }), ...(glitch !== undefined && { glitch }) };
    const layoutChanged = next.seed !== this.params.seed || JSON.stringify(next.counts) !== JSON.stringify(this.params.counts);
    this.params = next;
    if (layoutChanged) {
      this.layout = makeLayout(next);
      // While holding, the frozen collage must still show the new layout.
      if (this.face && this.tracking.phase === 'holding') this.renderer.drawCollage(this.frameCanvas, this.face, this.layout, next.seed, now(), this.reducedMotion);
    }
  }

  /** @param {HTMLVideoElement|HTMLImageElement} source */
  start(source, { mirror }) {
    this.stop();
    this.source = source;
    this.isStill = typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement;
    this.stillFace = null;
    this.mirror = mirror;
    const { w, h } = sourceSize(source);
    const out = fitSize(w, h);
    this.frameCanvas.width = out.width;
    this.frameCanvas.height = out.height;
    this.detectCanvas.width = DETECT_WIDTH;
    this.detectCanvas.height = Math.round((DETECT_WIDTH * out.height) / out.width);
    this.renderer.resize(out.width, out.height);
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

  drawFrame() {
    const { fctx, frameCanvas: c } = this;
    fctx.setTransform(this.mirror ? -1 : 1, 0, 0, 1, this.mirror ? c.width : 0, 0);
    fctx.drawImage(this.source, 0, 0, c.width, c.height);
    fctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  detect(t) {
    if (this.isStill && this.stillFace) return this.stillFace;
    const s = this.stats;
    if (s.skipNext) {
      s.skipNext = false;
      return undefined; // no new result this frame
    }
    this.dctx.drawImage(this.frameCanvas, 0, 0, this.detectCanvas.width, this.detectCanvas.height);
    const t0 = now();
    const lm = this.tracker.detect(this.detectCanvas, t);
    s.detectMs = now() - t0;
    s.skipNext = s.detectMs > SLOW_DETECT_MS;
    if (!lm) return null;
    // The detect canvas is already mirrored, so landmarks map straight onto the frame canvas.
    const measured = measureFace(toPixels(lm, this.frameCanvas.width, this.frameCanvas.height, false));
    if (this.isStill && measured) this.stillFace = measured;
    return measured;
  }

  smooth(raw, t) {
    if (this.isStill) return raw;
    const sec = t / 1000;
    const frame = arrayToFrame(this.frameFilter.filter(frameToArray(raw.frame), sec));
    const features = arrayToFeatures(this.featureFilter.filter(featuresToArray(raw.features), sec));
    return { frame, features, oval: raw.oval };
  }

  step(t) {
    if (!this.source) return;
    this.drawFrame();
    const raw = this.detect(t);
    if (raw !== undefined) {
      const before = this.tracking.phase;
      if (raw && (before === 'searching' || before === 'lost')) {
        this.frameFilter.reset();
        this.featureFilter.reset();
      }
      this.tracking = stepTracking(this.tracking, { face: raw, now: t });
      if (raw) this.face = this.smooth(raw, t);
      if (this.tracking.phase !== before) this.setPhase(this.tracking.phase, t);
    } else if (this.tracking.phase === 'holding') {
      this.tracking = stepTracking(this.tracking, { face: null, now: t });
      if (this.tracking.phase !== 'holding') this.setPhase(this.tracking.phase, t);
    }
    const r0 = now();
    const { seed, glitch } = this.params;
    if (this.tracking.phase === 'tracking' && this.face) {
      this.renderer.drawCollage(this.frameCanvas, this.face, this.layout, seed, t, this.reducedMotion);
    }
    const alpha = collageAlpha(this.tracking, t, this.reducedMotion);
    this.bands = this.renderer.compose(this.frameCanvas, { alpha, seed, glitch, now: t, reducedMotion: this.reducedMotion, avoidRows: this.eyeRows(), face: this.face ? { cx: this.face.frame.ox, iod: this.face.frame.iod } : null });
    this.stats.renderMs = now() - r0;
    this.countFps(t);
  }

  eyeRows() {
    if (!this.face) return [];
    const { frame, features } = this.face;
    return ['eyeA', 'eyeB'].map((k) => {
      const y = toPixel(frame, features[k]).y;
      const half = EYE_BAND_IOD * frame.iod;
      return [y - half, y + half];
    });
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
    const { fps, detectMs, renderMs, frames } = this.stats;
    const counts = this.layout.reduce((acc, p) => ({ ...acc, [p.kind]: (acc[p.kind] ?? 0) + 1 }), {});
    return {
      phase: this.tracking.phase,
      alpha: collageAlpha(this.tracking, now(), this.reducedMotion),
      timeline: this.timeline.slice(),
      fps: Math.round(fps * 10) / 10,
      detectMs: Math.round(detectMs * 10) / 10,
      renderMs: Math.round(renderMs * 10) / 10,
      frames,
      delegate: this.tracker.delegate,
      seed: this.params.seed,
      glitch: this.params.glitch,
      bands: this.bands.length,
      counts,
      patches: this.layout.map(({ id, kind, u, v, scale, rot }) => ({ id, kind, u, v, scale, rot })),
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
