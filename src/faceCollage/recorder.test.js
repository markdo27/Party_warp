import { describe, expect, it } from 'vitest';
import { extensionFor, makeFramePacer, pickVideoType } from './recorder.js';

/** Runs a pacer over rAF timestamps at `hz` with optional jitter, returns captured times. */
function run(hz, seconds, { jitter = 0, fps = 30 } = {}) {
  const pace = makeFramePacer(fps);
  const step = 1000 / hz;
  const kept = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let i = 0; i < hz * seconds; i += 1) {
    const t = 1000 + i * step + jitter * rand();
    if (pace(t)) kept.push(t);
  }
  return kept;
}

const gaps = (xs) => xs.slice(1).map((t, i) => t - xs[i]);

describe('makeFramePacer', () => {
  it('keeps every 2nd frame of a 60 Hz loop: even 33 ms gaps', () => {
    const kept = run(60, 5);
    expect(kept.length).toBeGreaterThanOrEqual(149);
    expect(kept.length).toBeLessThanOrEqual(151);
    gaps(kept).forEach((g) => expect(g).toBeCloseTo(1000 / 30, 0));
  });

  it('survives rAF jitter of +-3 ms without paired frames', () => {
    const g = gaps(run(60, 5, { jitter: 6 }));
    expect(Math.min(...g)).toBeGreaterThan(24);
    expect(Math.max(...g)).toBeLessThan(42);
  });

  it('averages 30 fps from a 50 Hz loop', () => {
    const kept = run(50, 10);
    expect(kept.length / 10).toBeGreaterThan(29);
    expect(kept.length / 10).toBeLessThan(31);
  });

  it('takes every frame when the loop is slower than 30 Hz', () => {
    expect(run(24, 5).length).toBe(120);
  });

  it('snaps forward after a stall instead of bursting', () => {
    const pace = makeFramePacer(30);
    const step = 1000 / 60;
    let t = 0;
    for (; t < 1000; t += step) pace(t);
    const after = [];
    for (t = 1500; t < 1600; t += step) if (pace(t)) after.push(t);
    gaps(after).forEach((g) => expect(g).toBeGreaterThan(30));
  });
});

describe('recorder helpers', () => {
  it('picks the first supported type and maps the extension', () => {
    expect(pickVideoType((t) => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9');
    expect(pickVideoType(() => false)).toBeNull();
    expect(extensionFor('video/mp4;codecs=avc1.42E01E')).toBe('mp4');
    expect(extensionFor('video/webm')).toBe('webm');
  });
});
