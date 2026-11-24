import { describe, expect, it } from 'vitest';
import { BANK_TTL_MS, ExpressionBank } from './frameBank.js';

const mkFace = ({ eyeOpenA = 0.34, eyeOpenB = 0.34, gazeA = 0, gazeB = 0, mouthOpen = 0.03, mouthOuterH = 0.22, mouthWidth = 0.56, cornerLift = 0 } = {}) => ({
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
  expressions: {
    eyeOpenA,
    eyeOpenB,
    gazeA,
    gazeB,
    mouthOpen,
    mouthOuterH,
    mouthWidth,
    cornerLift,
    mouthSmile: mouthWidth + cornerLift * 1.6,
  },
});

describe('ExpressionBank (R10 frame bank)', () => {
  it('captures distinct closed eye, side gaze, wide-open mouth, smile, and closed lips across a clip', () => {
    const bank = new ExpressionBank({ ttlMs: 10000 });
    // t=0: neutral
    bank.update(mkFace({}), 0);
    // t=2000: blink
    const blinkCaps = bank.update(mkFace({ eyeOpenB: 0.11 }), 2000);
    expect(blinkCaps.some((c) => c.slot === 'eyeClosed')).toBe(true);
    // t=3500: side gaze
    const gazeCaps = bank.update(mkFace({ gazeA: 0.28 }), 3500);
    expect(gazeCaps.some((c) => c.slot === 'eyeGaze')).toBe(true);
    // t=5000: wide-open screaming mouth
    const openCaps = bank.update(mkFace({ mouthOpen: 0.42, mouthOuterH: 0.65, mouthWidth: 0.58 }), 5000);
    expect(openCaps.some((c) => c.slot === 'mouthOpen')).toBe(true);
    // t=6500: wide grin / smile
    const smileCaps = bank.update(mkFace({ mouthOpen: 0.12, mouthOuterH: 0.34, mouthWidth: 0.72, cornerLift: 0.08 }), 6500);
    expect(smileCaps.some((c) => c.slot === 'mouthSmile')).toBe(true);
    // t=8000: back to neutral; all distinct poses remain simultaneously resolvable!
    bank.update(mkFace({ mouthOpen: 0.03 }), 8000);

    expect(bank.resolve('eyeClosed', 8000)?.eyeOpen).toBeCloseTo(0.11, 3);
    expect(bank.resolve('eyeGaze', 8000)?.gaze).toBeCloseTo(0.28, 3);
    expect(bank.resolve('mouthOpen', 8000)?.mouthOpen).toBeCloseTo(0.42, 3);
    expect(bank.resolve('mouthSmile', 8000)?.mouthWidth).toBeCloseTo(0.72, 3);
    expect(bank.resolve('mouthClosed', 8000)?.mouthOpen).toBeCloseTo(0.03, 3);
    expect(bank.resolve('live', 8000)).toBeNull();

    const sum = bank.summary(8000, mkFace({}).expressions);
    expect(sum.hasClosedEye).toBe(true);
    expect(sum.hasGazeEye).toBe(true);
    expect(sum.hasOpenMouth).toBe(true);
    expect(sum.hasSmileMouth).toBe(true);
    expect(sum.mouthOpenSpread).toBeGreaterThanOrEqual(0.25);
  });

  it('never invents an open mouth or blink when the user stays neutral', () => {
    const bank = new ExpressionBank();
    for (let t = 0; t <= 4000; t += 200) bank.update(mkFace({}), t);
    expect(bank.resolve('eyeClosed', 4000)).toBeNull();
    expect(bank.resolve('mouthOpen', 4000)).toBeNull();
  });

  it('disables capture and resolution on still images, reduced motion, or when toggled off', () => {
    const bank = new ExpressionBank();
    expect(bank.update(mkFace({ mouthOpen: 0.5 }), 1000, { enabled: false })).toEqual([]);
    expect(bank.update(mkFace({ mouthOpen: 0.5 }), 1000, { isStill: true })).toEqual([]);
    expect(bank.update(mkFace({ mouthOpen: 0.5 }), 1000, { reducedMotion: true })).toEqual([]);
    bank.update(mkFace({ mouthOpen: 0.5 }), 1000, { enabled: true });
    expect(bank.resolve('mouthOpen', 1500, { reducedMotion: true })).toBeNull();
    expect(bank.resolve('mouthOpen', 1500, { enabled: false })).toBeNull();
  });

  it('expires old entries after TTL and clears completely on stop/lost', () => {
    const bank = new ExpressionBank();
    bank.update(mkFace({ mouthOpen: 0.45, eyeOpenA: 0.1 }), 1000);
    expect(bank.resolve('mouthOpen', 1000 + BANK_TTL_MS)).not.toBeNull();
    expect(bank.resolve('mouthOpen', 1000 + BANK_TTL_MS + 1)).toBeNull();
    bank.clear();
    expect(bank.summary(2000).activeCount).toBe(0);
  });
});
