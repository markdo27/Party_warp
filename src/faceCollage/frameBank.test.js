import { describe, expect, it } from 'vitest';
import { BANK_SLOTS, BANK_TTL_MS, BANK_WARMUP_MS, BANK_WARMUP_SAMPLES, ExpressionBank } from './frameBank.js';

const mkFace = ({
  eyeOpenA = 0.34,
  eyeOpenB = 0.34,
  gazeA = 0,
  gazeB = 0,
  mouthOpen = 0.03,
  mouthOuterH = 0.22,
  mouthWidth = 0.56,
  teeth = null,
  yaw = 0,
  eyeWidthRatio = 1,
} = {}) => ({
  features: {
    eyeA: { u: -0.5, v: -0.09, w: 0.86, h: 0.64 },
    eyeB: { u: 0.5, v: -0.09, w: 0.86, h: 0.64 },
    nose: { u: 0, v: 0.45, w: 0.72, h: 0.68 },
    mouth: { u: 0, v: 1.05, w: Math.max(0.56, mouthWidth * 1.48), h: Math.max(0.56, mouthOuterH * 1.56) },
  },
  contours: {
    eyeA: [[-0.2, -0.1], [0.2, -0.1], [0.2, 0.1], [-0.2, 0.1]],
    eyeB: [[-0.2, -0.1], [0.2, -0.1], [0.2, 0.1], [-0.2, 0.1]],
    mouth: [[-0.3, -0.15], [0.3, -0.15], [0.3, 0.15], [-0.3, 0.15]],
  },
  expressions: { eyeOpenA, eyeOpenB, gazeA, gazeB, mouthOpen, mouthOuterH, mouthWidth, teeth, yaw, eyeWidthRatio },
});

/** Feeds neutral frames until the warm-up is over; returns the next timestamp. */
const warm = (bank, face = mkFace({}), start = 0, step = 100) => {
  let t = start;
  for (let i = 0; i < BANK_WARMUP_SAMPLES + 1; i += 1, t += step) bank.update(face, t);
  return Math.max(t, start + BANK_WARMUP_MS + step);
};

const slotsOf = (caps) => caps.map((c) => c.slot);

describe('ExpressionBank (R10 frame bank, r5 bank step)', () => {
  it('captures distinct closed eye, side gaze, open mouth, teeth and closed lips across a clip', () => {
    const bank = new ExpressionBank({ ttlMs: 10000 });
    warm(bank);

    expect(slotsOf(bank.update(mkFace({ eyeOpenB: 0.11 }), 2000))).toContain('eyeClosed');
    expect(slotsOf(bank.update(mkFace({ gazeA: 0.28 }), 3500))).toContain('eyeGaze');
    expect(slotsOf(bank.update(mkFace({ mouthOpen: 0.42, mouthOuterH: 0.65, mouthWidth: 0.58, teeth: 0.05 }), 5000))).toContain('mouthOpen');
    const teethCaps = slotsOf(bank.update(mkFace({ mouthOpen: 0.12, mouthOuterH: 0.34, mouthWidth: 0.72, teeth: 0.46 }), 6500));
    expect(teethCaps).toContain('mouthTeeth');
    expect(teethCaps).not.toContain('mouthClosed');
    bank.update(mkFace({ mouthOpen: 0.03 }), 8000);

    expect(bank.resolve('eyeClosed', 8000)?.eyeOpen).toBeCloseTo(0.11, 3);
    expect(bank.resolve('eyeGaze', 8000)?.gaze).toBeCloseTo(0.28, 3);
    expect(bank.resolve('mouthOpen', 8000)?.mouthOpen).toBeCloseTo(0.42, 3);
    expect(bank.resolve('mouthTeeth', 8000)?.teeth).toBeCloseTo(0.46, 3);
    expect(bank.resolve('mouthClosed', 8000)?.mouthOpen).toBeLessThanOrEqual(0.035);
    expect(bank.resolve('live', 8000)).toBeNull();

    const sum = bank.summary(8000, mkFace({}).expressions);
    expect(sum.hasClosedEye && sum.hasGazeEye && sum.hasOpenMouth && sum.hasTeethMouth && sum.hasClosedMouth).toBe(true);
    expect(sum.mouthOpenSpread).toBeGreaterThanOrEqual(0.25);
    expect(sum.missing).toEqual([]);
    const logged = sum.recent.map((r) => r.slot);
    expect(logged).toEqual(expect.arrayContaining(['eyeClosed', 'eyeGaze', 'mouthOpen', 'mouthTeeth', 'mouthClosed']));
    expect(logged.some((s) => s.endsWith('Delay'))).toBe(false);
    expect(sum.recent.find((r) => r.slot === 'mouthTeeth').teeth).toBeCloseTo(0.46, 3);
  });

  it('never invents a blink, open mouth or teeth when the user stays neutral', () => {
    const bank = new ExpressionBank();
    for (let t = 0; t <= 4000; t += 200) bank.update(mkFace({}), t);
    expect(bank.resolve('eyeClosed', 4000)).toBeNull();
    expect(bank.resolve('mouthOpen', 4000)).toBeNull();
    expect(bank.resolve('mouthTeeth', 4000)).toBeNull();
    expect(bank.summary(4000).missing).toEqual(expect.arrayContaining(['eyeClosed', 'eyeGaze', 'mouthOpen', 'mouthTeeth']));
  });

  it('does not call parted lips "teeth" without a pixel measurement or below the teeth share', () => {
    const bank = new ExpressionBank();
    const t = warm(bank);
    expect(slotsOf(bank.update(mkFace({ mouthOpen: 0.16, mouthWidth: 0.74, teeth: null }), t))).not.toContain('mouthTeeth');
    expect(slotsOf(bank.update(mkFace({ mouthOpen: 0.16, mouthWidth: 0.74, teeth: 0.1 }), t + 100))).not.toContain('mouthTeeth');
    expect(slotsOf(bank.update(mkFace({ mouthOpen: 0.01, teeth: 0.5 }), t + 200))).not.toContain('mouthTeeth');
    expect(bank.resolve('mouthTeeth', t + 200)).toBeNull();
  });

  it('a mouth that is open from the start is never stored as closed lips', () => {
    const bank = new ExpressionBank();
    for (let t = 0; t <= 3000; t += 100) bank.update(mkFace({ mouthOpen: 0.2, mouthOuterH: 0.45 }), t);
    expect(bank.resolve('mouthClosed', 3000)).toBeNull();
    expect(bank.resolve('mouthOpen', 3000)).not.toBeNull();
  });

  it('captures nothing during warm-up after (re)acquiring a face', () => {
    const bank = new ExpressionBank();
    const blink = mkFace({ eyeOpenA: 0.08, eyeOpenB: 0.08, mouthOpen: 0.4 });
    for (let i = 0; i < BANK_WARMUP_SAMPLES - 1; i += 1) expect(bank.update(blink, i * 100)).toEqual([]);
    // Enough samples but not enough time.
    const fast = new ExpressionBank();
    for (let i = 0; i < BANK_WARMUP_SAMPLES + 2; i += 1) expect(fast.update(blink, i * 10)).toEqual([]);
    expect(fast.summary(60).rejected.warmup).toBe(BANK_WARMUP_SAMPLES + 2);
  });

  it('skips stale landmarks (fresh:false): pixels and expression must come from the same frame', () => {
    const bank = new ExpressionBank();
    const t = warm(bank);
    expect(bank.update(mkFace({ eyeOpenB: 0.08 }), t, { fresh: false })).toEqual([]);
    expect(bank.resolve('eyeClosed', t)).toBeNull();
  });

  it('rejects eye captures on a turned head (foreshortened eye fakes a blink)', () => {
    const bank = new ExpressionBank();
    const t = warm(bank);
    const turned = slotsOf(bank.update(mkFace({ eyeOpenB: 0.1, yaw: 0.3, eyeWidthRatio: 0.6 }), t));
    expect(turned).not.toContain('eyeClosed');
    expect(bank.summary(t).rejected.pose).toBe(1);
    const narrow = slotsOf(bank.update(mkFace({ eyeOpenB: 0.1, yaw: 0.05, eyeWidthRatio: 0.6 }), t + 100));
    expect(narrow).not.toContain('eyeClosed');
    expect(slotsOf(bank.update(mkFace({ eyeOpenB: 0.1 }), t + 200))).toContain('eyeClosed');
  });

  it('learns a narrow-eyed user baseline so a relaxed open eye is not read as a blink', () => {
    const bank = new ExpressionBank();
    const narrowOpen = mkFace({ eyeOpenA: 0.2, eyeOpenB: 0.19 });
    for (let t = 0; t <= 2000; t += 100) bank.update(narrowOpen, t);
    expect(bank.summary(2000).thresholds.closed).toBeLessThan(0.11);
    expect(bank.resolve('eyeClosed', 2000)).toBeNull();
    expect(slotsOf(bank.update(mkFace({ eyeOpenA: 0.2, eyeOpenB: 0.07 }), 2100))).toContain('eyeClosed');
  });

  it('disables capture and resolution on still images, reduced motion, or when toggled off', () => {
    const bank = new ExpressionBank();
    expect(bank.update(mkFace({ mouthOpen: 0.5 }), 1000, { enabled: false })).toEqual([]);
    expect(bank.update(mkFace({ mouthOpen: 0.5 }), 1000, { isStill: true })).toEqual([]);
    expect(bank.update(mkFace({ mouthOpen: 0.5 }), 1000, { reducedMotion: true })).toEqual([]);
    const t = warm(bank);
    bank.update(mkFace({ mouthOpen: 0.5 }), t, { enabled: true });
    expect(bank.resolve('mouthOpen', t)).not.toBeNull();
    expect(bank.resolve('mouthOpen', t, { reducedMotion: true })).toBeNull();
    expect(bank.resolve('mouthOpen', t, { enabled: false })).toBeNull();
  });

  it('only falls back from gaze to a delayed eye, never from teeth to another mouth', () => {
    const bank = new ExpressionBank();
    const t = warm(bank);
    bank.update(mkFace({}), t);
    expect(bank.resolve('eyeGaze', t)?.slot).toBe('eyeDelay');
    expect(bank.resolve('mouthTeeth', t)).toBeNull();
    expect(bank.summary(t).fallbacks).toEqual({ eyeGaze: 'eyeDelay' });
  });

  it('expires old entries after TTL and clears everything, including the warm-up, on clear()', () => {
    const bank = new ExpressionBank();
    const t = warm(bank);
    bank.update(mkFace({ mouthOpen: 0.45, eyeOpenA: 0.1 }), t);
    expect(bank.resolve('mouthOpen', t + BANK_TTL_MS)).not.toBeNull();
    expect(bank.resolve('mouthOpen', t + BANK_TTL_MS + 1)).toBeNull();
    bank.clear();
    const sum = bank.summary(t);
    expect(sum.activeCount).toBe(0);
    expect(sum.missing).toEqual(BANK_SLOTS);
    expect(sum.warm).toBe(false);
    expect(sum.earBaseline).toBeNull();
    expect(bank.update(mkFace({ mouthOpen: 0.45 }), t + 100)).toEqual([]);
  });
});
