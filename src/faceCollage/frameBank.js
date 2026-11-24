/**
 * Expression Frame Bank (pure state + tile scheduling; GPU crops live in renderer's WebGL2 atlas).
 *
 * Captures distinct user expressions from recent camera frames (within TTL_MS) so different
 * collage slots can simultaneously display a closed eye, side-glancing eye, open eye, closed
 * lips, wide-open mouth and a mouth that really shows teeth, while kept originals stay live.
 *
 * Honesty rules: a slot is filled only when the measured face actually made that expression on
 * the same video frame that is copied into the tile. Unseen expressions resolve to the live frame.
 * Privacy (foundation D7): volatile RAM/GPU only, never persisted or exported raw, cleared on
 * stop(), source change, tracking loss and WebGL context loss.
 */

export const BANK_SLOTS = [
  'eyeClosed',
  'eyeGaze',
  'eyeWide',
  'eyeDelay',
  'mouthOpen',
  'mouthTeeth',
  'mouthClosed',
  'mouthDelay',
];

export const BANK_TILE_INDEX = Object.fromEntries(BANK_SLOTS.map((k, i) => [k, i]));
export const BANK_COLS = 4;
export const BANK_ROWS = 2;
export const BANK_TILE_SIZE = 256;
export const BANK_TTL_MS = 10000;

/** Fresh detections and time needed after (re)acquiring a face before anything is captured. */
export const BANK_WARMUP_SAMPLES = 4;
export const BANK_WARMUP_MS = 250;

/** Expression captures kept for the QA log (delay slots excluded: they fire on a timer). */
const CAPTURE_LOG_MAX = 64;
const EYE_DELAY_INTERVAL_MS = 450;
const MOUTH_DELAY_INTERVAL_MS = 550;

// Eye aspect (lid height / eye width). Thresholds follow the user's own open-eye baseline once
// learned, so narrow eyes are not read as closed and wide eyes still register a real blink.
const BASELINE_MIN_SAMPLES = 8;
const BASELINE_MIN_EAR = 0.18;
const BASELINE_ALPHA = 0.05;
const EYE_CLOSED_DEFAULT = 0.14;
const EYE_CLOSED_VS_BASELINE = 0.5;
const EYE_CLOSED_RANGE = [0.08, 0.17];
const EYE_OPEN_DEFAULT = 0.24;
const EYE_OPEN_VS_BASELINE = 0.85;
const EYE_GAZE_MIN = 0.15;
const GAZE_EYE_OPEN_VS_THRESHOLD = 0.8;

// Mouth, inner-lip gap / IOD.
const MOUTH_CLOSED_MAX = 0.035;
const MOUTH_OPEN_MIN = 0.14;
const MOUTH_OUTER_OPEN_MIN = 0.42;
const MOUTH_OUTER_GAP_MIN = 0.08;
const MOUTH_TEETH_GAP_MIN = 0.02;
export const MOUTH_TEETH_FRAC_MIN = 0.18;

// Head-turn gate: one foreshortened eye fakes a blink or a gaze; a turned mouth is a squashed crop.
const EYE_YAW_MAX = 0.22;
const EYE_WIDTH_RATIO_MIN = 0.72;
const MOUTH_YAW_MAX = 0.3;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round3 = (x) => Math.round(x * 1000) / 1000;
const cloneFeature = (f) => ({ u: f.u, v: f.v, w: f.w, h: f.h });
const cloneContour = (c) => (c ? c.map(([x, y]) => [x, y]) : null);
/** Numbers only (no pixels): what was measured on the frame that filled a tile. */
const logItem = (s) => ({
  slot: s.slot,
  t: Math.round(s.capturedAt),
  source: s.sourceKey,
  ...(s.eyeOpen !== undefined && { eyeOpen: round3(s.eyeOpen), gaze: round3(s.gaze) }),
  mouthOpen: round3(s.mouthOpen),
  teeth: s.teeth === null ? null : round3(s.teeth),
});

/** Secondary source a patch may use when its own expression has not been seen (a real frame). */
const FALLBACKS = { eyeGaze: 'eyeDelay' };

export class ExpressionBank {
  constructor({ ttlMs = BANK_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.clear();
  }

  /** Drops every capture and everything learned about the current face (new source, lost face, stop). */
  clear() {
    this.slots = Object.create(null);
    this.samples = 0;
    this.firstAt = null;
    this.earBaseline = null;
    this.earBaselineN = 0;
    this.lastEyeDelayAt = -Infinity;
    this.lastMouthDelayAt = -Infinity;
    this.eyeDelayToggle = 0;
    this.rejected = { warmup: 0, pose: 0 };
    this.log = [];
  }

  isFresh(entry, now) {
    return Boolean(entry && now - entry.capturedAt <= this.ttlMs);
  }

  /** Zero-allocation fresh slot count for lightweight UI status updates. */
  activeCountAt(now) {
    let n = 0;
    for (const key of BANK_SLOTS) if (this.isFresh(this.slots[key], now)) n += 1;
    return n;
  }

  thresholds() {
    const ready = this.earBaselineN >= BASELINE_MIN_SAMPLES;
    return {
      closed: ready ? clamp(this.earBaseline * EYE_CLOSED_VS_BASELINE, ...EYE_CLOSED_RANGE) : EYE_CLOSED_DEFAULT,
      open: ready ? this.earBaseline * EYE_OPEN_VS_BASELINE : EYE_OPEN_DEFAULT,
    };
  }

  learnBaseline(maxEar, closedThr) {
    if (maxEar < BASELINE_MIN_EAR || maxEar <= closedThr) return;
    this.earBaseline = this.earBaseline === null ? maxEar : this.earBaseline * (1 - BASELINE_ALPHA) + maxEar * BASELINE_ALPHA;
    this.earBaselineN += 1;
  }

  /**
   * Evaluates one detection and returns the GPU atlas tile captures to perform this frame.
   * Each capture is `{ slot, tileIndex, sourceKey, feature, contour }`.
   * `fresh: false` means the landmarks were not measured on the current video frame; nothing is
   * captured then, so a tile never pairs one frame's pixels with another frame's expression.
   */
  update(face, now, { enabled = true, isStill = false, reducedMotion = false, fresh = true } = {}) {
    if (!enabled || isStill || reducedMotion || !fresh || !face?.expressions || !face?.features) return [];
    const e = face.expressions;
    const captures = [];

    for (const key of BANK_SLOTS) {
      if (this.slots[key] && !this.isFresh(this.slots[key], now)) delete this.slots[key];
    }

    if (this.firstAt === null) this.firstAt = now;
    this.samples += 1;
    const thr = this.thresholds();
    this.learnBaseline(Math.max(e.eyeOpenA, e.eyeOpenB), thr.closed);

    if (this.samples < BANK_WARMUP_SAMPLES || now - this.firstAt < BANK_WARMUP_MS) {
      this.rejected.warmup += 1;
      return captures;
    }

    const yaw = Math.abs(e.yaw ?? 0);
    const eyesUsable = yaw <= EYE_YAW_MAX && (e.eyeWidthRatio ?? 1) >= EYE_WIDTH_RATIO_MIN;
    const mouthUsable = yaw <= MOUTH_YAW_MAX;
    if (!eyesUsable || !mouthUsable) this.rejected.pose += 1;

    const record = (slot, sourceKey, score) => {
      const entry = this.makeEntry(face, slot, sourceKey, score, now);
      if (!entry) return;
      this.slots[slot] = entry;
      if (!slot.endsWith('Delay')) this.log = [...this.log.slice(1 - CAPTURE_LOG_MAX), logItem(entry)];
      captures.push({ slot, tileIndex: entry.tileIndex, sourceKey, feature: entry.feature, contour: entry.contour });
    };
    // Replace when better, or when the kept one has aged (keeps the tile reasonably recent).
    const better = (slot, score, slack) => {
      const cur = this.slots[slot];
      return !cur || score >= cur.score - slack * Math.max(0, (now - cur.capturedAt) / this.ttlMs);
    };

    if (eyesUsable) this.updateEyes(e, now, thr, record, better);
    if (mouthUsable) this.updateMouth(e, now, record, better);
    return captures;
  }

  makeEntry(face, slot, sourceKey, score, now) {
    const feat = face.features[sourceKey];
    if (!feat) return null;
    const e = face.expressions;
    const isEye = sourceKey === 'eyeA' || sourceKey === 'eyeB';
    return {
      slot,
      tileIndex: BANK_TILE_INDEX[slot],
      sourceKey,
      capturedAt: now,
      score,
      feature: cloneFeature(feat),
      contour: cloneContour(face.contours?.[sourceKey]),
      eyeOpen: isEye ? (sourceKey === 'eyeA' ? e.eyeOpenA : e.eyeOpenB) : undefined,
      gaze: isEye ? (sourceKey === 'eyeA' ? e.gazeA : e.gazeB) : undefined,
      mouthOpen: e.mouthOpen,
      mouthOuterH: e.mouthOuterH,
      mouthWidth: e.mouthWidth,
      teeth: typeof e.teeth === 'number' ? e.teeth : null,
    };
  }

  updateEyes(e, now, thr, record, better) {
    const keyOf = (pickA) => (pickA ? 'eyeA' : 'eyeB');
    const minEar = Math.min(e.eyeOpenA, e.eyeOpenB);
    const maxEar = Math.max(e.eyeOpenA, e.eyeOpenB);

    if (minEar <= thr.closed && better('eyeClosed', 1 - minEar, 0.04)) {
      record('eyeClosed', keyOf(e.eyeOpenA <= e.eyeOpenB), 1 - minEar);
    }
    if (maxEar >= thr.open && better('eyeWide', maxEar, 0.04)) {
      record('eyeWide', keyOf(e.eyeOpenA >= e.eyeOpenB), maxEar);
    }
    const gazeA = Math.abs(e.gazeA);
    const gazeB = Math.abs(e.gazeB);
    const gazeKey = keyOf(gazeA >= gazeB);
    const gazeEar = gazeKey === 'eyeA' ? e.eyeOpenA : e.eyeOpenB;
    const absGaze = Math.max(gazeA, gazeB);
    if (absGaze >= EYE_GAZE_MIN && gazeEar >= thr.open * GAZE_EYE_OPEN_VS_THRESHOLD && better('eyeGaze', absGaze, 0.05)) {
      record('eyeGaze', gazeKey, absGaze);
    }
    if (now - this.lastEyeDelayAt >= EYE_DELAY_INTERVAL_MS) {
      this.lastEyeDelayAt = now;
      this.eyeDelayToggle = 1 - this.eyeDelayToggle;
      record('eyeDelay', this.eyeDelayToggle ? 'eyeB' : 'eyeA', maxEar);
    }
  }

  updateMouth(e, now, record, better) {
    const isOpen = e.mouthOpen >= MOUTH_OPEN_MIN || (e.mouthOuterH >= MOUTH_OUTER_OPEN_MIN && e.mouthOpen >= MOUTH_OUTER_GAP_MIN);
    const openScore = e.mouthOpen + e.mouthOuterH * 0.25;
    if (isOpen && better('mouthOpen', openScore, 0.05)) record('mouthOpen', 'mouth', openScore);

    const hasTeeth = typeof e.teeth === 'number' && e.teeth >= MOUTH_TEETH_FRAC_MIN && e.mouthOpen >= MOUTH_TEETH_GAP_MIN;
    const teethScore = (e.teeth ?? 0) + e.mouthWidth * 0.25;
    if (hasTeeth && better('mouthTeeth', teethScore, 0.05)) record('mouthTeeth', 'mouth', teethScore);

    const closedScore = 1 - e.mouthOpen;
    if (e.mouthOpen <= MOUTH_CLOSED_MAX && better('mouthClosed', closedScore, 0.03)) record('mouthClosed', 'mouth', closedScore);

    if (now - this.lastMouthDelayAt >= MOUTH_DELAY_INTERVAL_MS) {
      this.lastMouthDelayAt = now;
      record('mouthDelay', 'mouth', e.mouthOpen);
    }
  }

  /**
   * Resolves a patch's requested expression (`expr`) to a fresh atlas entry, or null when the
   * patch should sample the live video frame (expression not seen yet: never faked).
   */
  resolve(expr, now, { enabled = true, isStill = false, reducedMotion = false } = {}) {
    if (!enabled || isStill || reducedMotion || !expr || expr === 'live') return null;
    const entry = this.slots[expr];
    if (this.isFresh(entry, now)) return entry;
    const alt = FALLBACKS[expr];
    return alt && this.isFresh(this.slots[alt], now) ? this.slots[alt] : null;
  }

  /** Read-only summary for the debug HUD and QA (R10). */
  summary(now, liveExpr = null) {
    const active = {};
    const mouthOpens = liveExpr ? [liveExpr.mouthOpen] : [];
    const eyeOpens = liveExpr ? [Math.min(liveExpr.eyeOpenA, liveExpr.eyeOpenB), Math.max(liveExpr.eyeOpenA, liveExpr.eyeOpenB)] : [];
    for (const key of BANK_SLOTS) {
      const s = this.slots[key];
      if (!this.isFresh(s, now)) continue;
      const isMouth = key.startsWith('mouth');
      active[key] = {
        tile: s.tileIndex,
        ageMs: Math.round(now - s.capturedAt),
        ...(s.eyeOpen !== undefined && { eyeOpen: round3(s.eyeOpen) }),
        ...(s.gaze !== undefined && { gaze: round3(s.gaze) }),
        ...(isMouth && { mouthOpen: round3(s.mouthOpen), mouthWidth: round3(s.mouthWidth), teeth: s.teeth === null ? null : round3(s.teeth) }),
      };
      if (isMouth) mouthOpens.push(s.mouthOpen);
      if (key.startsWith('eye') && s.eyeOpen !== undefined) eyeOpens.push(s.eyeOpen);
    }
    const spread = (xs) => (xs.length >= 2 ? round3(Math.max(...xs) - Math.min(...xs)) : 0);
    const thr = this.thresholds();
    return {
      activeCount: Object.keys(active).length,
      active,
      missing: BANK_SLOTS.filter((k) => !active[k]),
      fallbacks: Object.fromEntries(Object.entries(FALLBACKS).filter(([k, alt]) => !active[k] && active[alt])),
      warm: this.samples >= BANK_WARMUP_SAMPLES,
      earBaseline: this.earBaseline === null ? null : round3(this.earBaseline),
      thresholds: { closed: round3(thr.closed), open: round3(thr.open) },
      rejected: { ...this.rejected },
      recent: this.log.slice(),
      mouthOpenSpread: spread(mouthOpens),
      eyeOpenSpread: spread(eyeOpens),
      hasClosedEye: Boolean(active.eyeClosed),
      hasOpenEye: Boolean(active.eyeWide),
      hasGazeEye: Boolean(active.eyeGaze),
      hasClosedMouth: Boolean(active.mouthClosed),
      hasOpenMouth: Boolean(active.mouthOpen),
      hasTeethMouth: Boolean(active.mouthTeeth),
    };
  }
}
