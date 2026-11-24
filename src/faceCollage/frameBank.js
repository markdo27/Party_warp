/**
 * Expression Frame Bank (pure state + tile scheduling; GPU crops live in renderer's WebGL2 atlas).
 *
 * Captures distinct user expressions from recent camera frames (within TTL_MS) so different
 * collage slots can simultaneously display a closed/blinking eye, side-glancing eye, wide-open
 * eye, closed lips, wide-open mouth, and grinning smile — while kept originals stay 100% live.
 *
 * Privacy (foundation D7): volatile RAM/GPU only, never persisted or exported raw, cleared on
 * stop() or tracking loss. Never invents teeth or expressions the user did not make.
 */

export const BANK_SLOTS = [
  'eyeClosed',
  'eyeGaze',
  'eyeWide',
  'eyeDelay',
  'mouthOpen',
  'mouthSmile',
  'mouthClosed',
  'mouthDelay',
];

export const BANK_TILE_INDEX = Object.fromEntries(BANK_SLOTS.map((k, i) => [k, i]));
export const BANK_COLS = 4;
export const BANK_ROWS = 2;
export const BANK_TILE_SIZE = 256;
export const BANK_TTL_MS = 10000;

const EYE_DELAY_INTERVAL_MS = 450;
const MOUTH_DELAY_INTERVAL_MS = 550;
const EYE_CLOSED_ABS = 0.22;
const EYE_CLOSED_DROP = 0.055;
const EYE_GAZE_MIN = 0.075;
const MOUTH_OPEN_MIN = 0.14;
const MOUTH_OUTER_OPEN_MIN = 0.42;

const cloneFeature = (f) => ({ u: f.u, v: f.v, w: f.w, h: f.h });
const cloneContour = (c) => (c ? c.map(([x, y]) => [x, y]) : null);

export class ExpressionBank {
  constructor({ ttlMs = BANK_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.clear();
  }

  clear() {
    this.slots = Object.create(null);
    this.eyeMaxSeen = 0;
    this.mouthWidthMin = Infinity;
    this.mouthOpenMin = Infinity;
    this.mouthOpenMax = 0;
    this.lastEyeDelayAt = -Infinity;
    this.lastMouthDelayAt = -Infinity;
    this.eyeDelayToggle = 0;
  }

  isFresh(entry, now) {
    return Boolean(entry && now - entry.capturedAt <= this.ttlMs);
  }

  /**
   * Evaluates current face expressions and returns GPU atlas tile captures to perform this frame.
   * Each capture contains `{ slot, tileIndex, sourceKey, feature, contour }`.
   */
  update(face, now, { enabled = true, isStill = false, reducedMotion = false } = {}) {
    if (!enabled || isStill || reducedMotion || !face?.expressions || !face?.features) return [];
    const e = face.expressions;
    const f = face.features;
    const contours = face.contours ?? {};
    const captures = [];

    // Drop expired entries first.
    for (const key of BANK_SLOTS) {
      if (this.slots[key] && !this.isFresh(this.slots[key], now)) delete this.slots[key];
    }

    const minEar = Math.min(e.eyeOpenA, e.eyeOpenB);
    const maxEar = Math.max(e.eyeOpenA, e.eyeOpenB);
    const closedEyeKey = e.eyeOpenA <= e.eyeOpenB ? 'eyeA' : 'eyeB';
    const wideEyeKey = e.eyeOpenA >= e.eyeOpenB ? 'eyeA' : 'eyeB';
    const gazeEyeKey = Math.abs(e.gazeA) >= Math.abs(e.gazeB) ? 'eyeA' : 'eyeB';
    const absGaze = Math.max(Math.abs(e.gazeA), Math.abs(e.gazeB));

    this.eyeMaxSeen = Math.max(this.eyeMaxSeen * 0.999, maxEar);
    this.mouthWidthMin = Math.min(this.mouthWidthMin, e.mouthWidth);
    this.mouthOpenMin = Math.min(this.mouthOpenMin, e.mouthOpen);
    this.mouthOpenMax = Math.max(this.mouthOpenMax * 0.999, e.mouthOpen);

    const record = (slot, sourceKey, score, extra = {}) => {
      const feat = f[sourceKey];
      if (!feat) return;
      const entry = {
        slot,
        tileIndex: BANK_TILE_INDEX[slot],
        sourceKey,
        capturedAt: now,
        score,
        feature: cloneFeature(feat),
        contour: cloneContour(contours[sourceKey]),
        eyeOpen: sourceKey === 'eyeA' ? e.eyeOpenA : sourceKey === 'eyeB' ? e.eyeOpenB : undefined,
        gaze: sourceKey === 'eyeA' ? e.gazeA : sourceKey === 'eyeB' ? e.gazeB : undefined,
        mouthOpen: e.mouthOpen,
        mouthOuterH: e.mouthOuterH,
        mouthWidth: e.mouthWidth,
        ...extra,
      };
      this.slots[slot] = entry;
      captures.push({
        slot,
        tileIndex: entry.tileIndex,
        sourceKey,
        feature: entry.feature,
        contour: entry.contour,
      });
    };

    const ageDecay = (entry) => (entry ? Math.max(0, (now - entry.capturedAt) / this.ttlMs) : 1);

    // 1. eyeClosed: capture distinct blink / lid drop.
    const isBlink = minEar <= EYE_CLOSED_ABS || (this.eyeMaxSeen - minEar >= EYE_CLOSED_DROP && minEar < 0.27);
    if (isBlink) {
      const cur = this.slots.eyeClosed;
      const closedScore = 1 - minEar;
      if (!cur || closedScore >= cur.score - 0.04 * ageDecay(cur)) {
        record('eyeClosed', closedEyeKey, closedScore);
      }
    }

    // 2. eyeGaze: capture strongest side-glancing iris offset.
    if (absGaze >= EYE_GAZE_MIN) {
      const cur = this.slots.eyeGaze;
      if (!cur || absGaze >= cur.score - 0.05 * ageDecay(cur)) {
        record('eyeGaze', gazeEyeKey, absGaze);
      }
    }

    // 3. eyeWide: capture widest open eye.
    {
      const cur = this.slots.eyeWide;
      if (!cur || maxEar >= cur.score - 0.04 * ageDecay(cur)) {
        record('eyeWide', wideEyeKey, maxEar);
      }
    }

    // 4. eyeDelay: periodic rolling eye snapshot.
    if (now - this.lastEyeDelayAt >= EYE_DELAY_INTERVAL_MS) {
      this.lastEyeDelayAt = now;
      this.eyeDelayToggle = 1 - this.eyeDelayToggle;
      record('eyeDelay', this.eyeDelayToggle ? 'eyeB' : 'eyeA', maxEar);
    }

    // 5. mouthOpen: capture widest open mouth (scream / yawn / teeth).
    const isMouthOpen = e.mouthOpen >= MOUTH_OPEN_MIN || e.mouthOuterH >= MOUTH_OUTER_OPEN_MIN;
    if (isMouthOpen) {
      const cur = this.slots.mouthOpen;
      const openScore = e.mouthOpen + e.mouthOuterH * 0.25;
      if (!cur || openScore >= cur.score - 0.05 * ageDecay(cur)) {
        record('mouthOpen', 'mouth', openScore);
      }
    }

    // 6. mouthSmile: capture wide smile / grin distinct from peak vertical scream.
    {
      const openPeak = this.slots.mouthOpen?.mouthOpen ?? this.mouthOpenMax;
      const wideEnough = e.mouthWidth >= Math.max(0.56, this.mouthWidthMin * 1.07);
      const horizontalAspect = e.mouthWidth / Math.max(0.16, e.mouthOuterH);
      const notPeakScream = openPeak < MOUTH_OPEN_MIN || e.mouthOpen <= openPeak * 0.72 || horizontalAspect >= 1.55;
      if (wideEnough && notPeakScream) {
        const cur = this.slots.mouthSmile;
        const smileScore = e.mouthSmile + (e.mouthOpen >= 0.04 && e.mouthOpen <= 0.24 ? 0.08 : 0);
        if (!cur || smileScore >= cur.score - 0.04 * ageDecay(cur)) {
          record('mouthSmile', 'mouth', smileScore);
        }
      }
    }

    // 7. mouthClosed: capture most closed / relaxed lip pose.
    {
      const cur = this.slots.mouthClosed;
      const closedScore = 1 - e.mouthOpen;
      if (!cur || closedScore >= cur.score - 0.03 * ageDecay(cur)) {
        record('mouthClosed', 'mouth', closedScore);
      }
    }

    // 8. mouthDelay: periodic rolling mouth snapshot.
    if (now - this.lastMouthDelayAt >= MOUTH_DELAY_INTERVAL_MS) {
      this.lastMouthDelayAt = now;
      record('mouthDelay', 'mouth', e.mouthOpen);
    }

    return captures;
  }

  /**
   * Resolves a layout patch's requested expression slot (`expr`) to a fresh GPU atlas entry,
   * or null when the patch should sample the live video frame directly.
   */
  resolve(expr, now, { enabled = true, isStill = false, reducedMotion = false } = {}) {
    if (!enabled || isStill || reducedMotion || !expr || expr === 'live') return null;
    const entry = this.slots[expr];
    if (this.isFresh(entry, now)) return entry;
    // Graceful secondary fallback: if mouthSmile not seen yet, try mouthDelay; if eyeGaze not seen, eyeDelay.
    if (expr === 'mouthSmile' && this.isFresh(this.slots.mouthDelay, now)) return this.slots.mouthDelay;
    if (expr === 'eyeGaze' && this.isFresh(this.slots.eyeDelay, now)) return this.slots.eyeDelay;
    return null;
  }

  /** Read-only summary for debug HUD and QA (R10 verification). */
  summary(now, liveExpr = null) {
    const active = {};
    const mouthOpens = [];
    const eyeOpens = [];
    if (liveExpr) {
      mouthOpens.push(liveExpr.mouthOpen);
      eyeOpens.push(Math.min(liveExpr.eyeOpenA, liveExpr.eyeOpenB), Math.max(liveExpr.eyeOpenA, liveExpr.eyeOpenB));
    }
    for (const key of BANK_SLOTS) {
      const s = this.slots[key];
      if (!this.isFresh(s, now)) continue;
      active[key] = {
        tile: s.tileIndex,
        ageMs: Math.round(now - s.capturedAt),
        ...(s.eyeOpen !== undefined && { eyeOpen: Math.round(s.eyeOpen * 1000) / 1000 }),
        ...(s.gaze !== undefined && { gaze: Math.round(s.gaze * 1000) / 1000 }),
        ...(key.startsWith('mouth') && {
          mouthOpen: Math.round(s.mouthOpen * 1000) / 1000,
          mouthWidth: Math.round(s.mouthWidth * 1000) / 1000,
        }),
      };
      if (key.startsWith('mouth')) mouthOpens.push(s.mouthOpen);
      if (key.startsWith('eye') && s.eyeOpen !== undefined) eyeOpens.push(s.eyeOpen);
    }
    const mouthOpenSpread = mouthOpens.length >= 2 ? Math.round((Math.max(...mouthOpens) - Math.min(...mouthOpens)) * 1000) / 1000 : 0;
    const eyeOpenSpread = eyeOpens.length >= 2 ? Math.round((Math.max(...eyeOpens) - Math.min(...eyeOpens)) * 1000) / 1000 : 0;
    return {
      activeCount: Object.keys(active).length,
      active,
      mouthOpenSpread,
      eyeOpenSpread,
      hasClosedEye: Boolean(active.eyeClosed),
      hasGazeEye: Boolean(active.eyeGaze),
      hasOpenMouth: Boolean(active.mouthOpen),
      hasSmileMouth: Boolean(active.mouthSmile),
    };
  }
}
