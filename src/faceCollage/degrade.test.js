import { describe, expect, it } from 'vitest';
import { DEGRADE_LEVELS, degradeSettings, initialDegrade, stepDegrade } from './degrade.js';

const feed = (state, readings) => readings.reduce((s, r, i) => stepDegrade(s, { t: (i + 1) * 1000, ...r }), state);

describe('degrade ladder', () => {
  it('starts at full quality', () => {
    expect(degradeSettings(initialDegrade())).toEqual({ detectEvery: 1, detectWidth: 480, outSide: 960 });
  });

  it('does not step on one slow second', () => {
    const s = feed(initialDegrade(), [{ fps: 20 }]);
    expect(s.level).toBe(0);
    expect(s.slowWindows).toBe(1);
  });

  it('steps one level after 2 slow seconds', () => {
    const s = feed(initialDegrade(), [{ fps: 20 }, { fps: 22 }]);
    expect(s.level).toBe(1);
    expect(s.slowWindows).toBe(0);
    expect(s.steps).toEqual([{ level: 1, t: 2000, fps: 22 }]);
    expect(degradeSettings(s).detectEvery).toBe(2);
  });

  it('a fast second in between resets the count', () => {
    const s = feed(initialDegrade(), [{ fps: 20 }, { fps: 30 }, { fps: 20 }]);
    expect(s.level).toBe(0);
  });

  it('walks the ladder in order and stops at the last level', () => {
    const s = feed(initialDegrade(), Array.from({ length: 12 }, () => ({ fps: 10 })));
    expect(s.level).toBe(DEGRADE_LEVELS.length - 1);
    expect(s.steps.map((x) => x.level)).toEqual([1, 2, 3]);
    expect(degradeSettings(s)).toEqual({ detectEvery: 2, detectWidth: 320, outSide: 720 });
  });

  it('never reduces patch count (levels carry no patch setting)', () => {
    DEGRADE_LEVELS.forEach((l) => expect(Object.keys(l).sort()).toEqual(['detectEvery', 'detectWidth', 'outSide']));
  });

  it('holds the output-resize step while recording', () => {
    const atTwo = feed(initialDegrade(), Array.from({ length: 4 }, () => ({ fps: 10 })));
    expect(atTwo.level).toBe(2);
    const held = feed(atTwo, [{ fps: 10, holdOutput: true }, { fps: 10, holdOutput: true }, { fps: 10, holdOutput: true }]);
    expect(held.level).toBe(2);
    const after = stepDegrade(held, { fps: 10, t: 9000 });
    expect(after.level).toBe(3);
  });

  it('ignores non-finite readings and does not mutate the input', () => {
    const s0 = initialDegrade();
    const frozen = JSON.stringify(s0);
    expect(stepDegrade(s0, { fps: NaN, t: 1 })).toBe(s0);
    stepDegrade(s0, { fps: 5, t: 1 });
    expect(JSON.stringify(s0)).toBe(frozen);
  });
});
