import { describe, expect, it } from 'vitest';
import { hashSeed, mulberry32, seedToText, textToSeed } from './prng.js';

describe('prng', () => {
  it('same seed gives the same stream, values in [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i += 1) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
  it('hashSeed separates streams', () => {
    expect(hashSeed(1, 2)).not.toBe(hashSeed(1, 3));
    expect(hashSeed(1, 2)).toBe(hashSeed(1, 2));
  });
  it('seed text round-trips and rejects bad input', () => {
    expect(textToSeed(seedToText(parseInt('abc123', 36)))).toBe(parseInt('abc123', 36));
    expect(seedToText(5)).toBe('000005');
    expect(textToSeed('ABC123')).toBe(parseInt('abc123', 36));
    expect(textToSeed('abc-12')).toBeNull();
    expect(textToSeed('1234567')).toBeNull();
    expect(textToSeed('')).toBeNull();
  });
});
