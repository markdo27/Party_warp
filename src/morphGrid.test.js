import { describe, expect, it } from 'vitest';
import {
  MORPH_MAX_CELLS,
  MORPH_START_OFFSET_S,
  MORPH_THEME,
  cellDelay,
  cubicBezier,
  gridDims,
  meltEnvelope,
  morphCellState,
  morphCycle,
  morphEase,
  morphGlyphList,
  morphGridFrame,
  morphGridRect,
  tintSwitchesPerSecond,
} from './morphGrid.js';

const OPTS = { count: 4, hold: 0.95, melt: 0.7, colDelay: 0.085, rowDelay: 0.46 };

describe('morphGlyphList', () => {
  it('keeps visible graphemes, drops spaces and caps the count', () => {
    expect(morphGlyphList('R a u m')).toEqual(['R', 'a', 'u', 'm']);
    expect(morphGlyphList('ABCDEFGH')).toHaveLength(6);
  });
  it('falls back to the default loop when fewer than two glyphs are left', () => {
    expect(morphGlyphList(' x ')).toEqual(['R', 'a', 'u', 'm']);
    expect(morphGlyphList(null)).toEqual(['R', 'a', 'u', 'm']);
  });
});

describe('easing', () => {
  it('matches the cubic-bezier end points and is monotonic', () => {
    expect(morphEase(0)).toBe(0);
    expect(morphEase(1)).toBe(1);
    expect(morphEase(0.5)).toBeCloseTo(0.5, 3);
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const v = morphEase(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });
  it('is slow at both ends, like ease-in-out', () => {
    expect(morphEase(0.15)).toBeLessThan(0.05);
    expect(morphEase(0.85)).toBeGreaterThan(0.95);
    expect(cubicBezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 4);
  });
});

describe('morphCellState', () => {
  it('holds without rings once the tail has faded, then melts with swelling rings', () => {
    const hold = morphCellState(0.8, 4, 0.95, 0.7);
    expect(hold).toMatchObject({ from: 0, to: 1, mix: 0, melting: false });
    expect(hold.halo).toBe(0);
    const mid = morphCellState(0.95 + 0.4, 4, 0.95, 0.7);
    expect(mid.melting).toBe(true);
    expect(mid.halo).toBeGreaterThan(0.9);
    expect(mid.mix).toBeGreaterThan(0.5);
  });
  it('wraps around the loop and handles negative times', () => {
    const cycle = morphCycle(4, 0.95, 0.7);
    expect(cycle).toBeCloseTo(6.6, 6);
    expect(morphCellState(-0.1, 4, 0.95, 0.7)).toEqual(morphCellState(cycle - 0.1, 4, 0.95, 0.7));
    expect(morphCellState(cycle - 0.1, 4, 0.95, 0.7)).toMatchObject({ from: 3, to: 0, melting: true });
  });
  it('ring size is continuous from a melt into the next hold', () => {
    const end = morphCellState(1.65 - 1e-6, 4, 0.95, 0.7).halo;
    const start = morphCellState(1.65 + 1e-6, 4, 0.95, 0.7).halo;
    expect(Math.abs(end - start)).toBeLessThan(0.01);
    expect(meltEnvelope(0)).toBe(0);
  });
});

describe('morphGridFrame', () => {
  it('lags each column by ~85 ms and each row by ~460 ms', () => {
    expect(cellDelay(1, 0, 0.085, 0.46)).toBeCloseTo(0.085, 6);
    expect(cellDelay(0, 1, 0.085, 0.46)).toBeCloseTo(0.46, 6);
    // Cell (0,0) starts its first melt at hold - offset; cell (1,0) 85 ms later, cell (0,1) 460 ms later.
    const meltStart = 0.95 - MORPH_START_OFFSET_S;
    const at = (t) => morphGridFrame(t, OPTS);
    expect(at(meltStart + 0.01)[0].melting).toBe(true);
    expect(at(meltStart + 0.01)[1].melting).toBe(false);
    expect(at(meltStart + 0.085 + 0.01)[1].melting).toBe(true);
    expect(at(meltStart + 0.46 - 0.01)[3].melting).toBe(false);
    expect(at(meltStart + 0.46 + 0.01)[3].melting).toBe(true);
  });
  it('cell (0,0) holds its first glyph until ~0.83 s, as in the reference', () => {
    const frames = [0.25, 0.5, 0.75].map((t) => morphGridFrame(t, OPTS)[0]);
    frames.forEach((c) => expect(c).toMatchObject({ from: 0, melting: false }));
    expect(morphGridFrame(1.0, OPTS)[0].melting).toBe(true);
  });
  it('returns nine cells in reading order', () => {
    const cells = morphGridFrame(2, OPTS);
    expect(cells).toHaveLength(9);
    expect(cells.map((c) => [c.col, c.row])[5]).toEqual([2, 1]);
  });
  it('drops rings, tint and melts in still (reduced motion) mode', () => {
    for (let t = 0; t < 6.6; t += 0.1) {
      morphGridFrame(t, { ...OPTS, still: true }).forEach((c) => {
        expect(c.halo).toBe(0);
        expect(c.tint).toBe(0);
        expect(c.mix).toBe(0);
      });
    }
  });
});

describe('morphGridRect', () => {
  it('fits a 4:5 grid inside the rect, centred', () => {
    const r = morphGridRect({ x: 0, y: 0, width: 1000, height: 1000 });
    expect(r.width / r.height).toBeCloseTo(0.8, 6);
    expect(r.height).toBeCloseTo(1000, 6);
    expect(r.x).toBeCloseTo(100, 6);
    const wide = morphGridRect({ x: 10, y: 20, width: 400, height: 1000 }, 0.05);
    expect(wide.width).toBeCloseTo(360, 6);
    expect(wide.y + wide.height / 2).toBeCloseTo(520, 6);
  });
});

describe('accessibility limits', () => {
  it('a tinted cell background switches at most 3 times in any second', () => {
    expect(tintSwitchesPerSecond(4, 0.95, 0.7)).toBeLessThanOrEqual(3);
    expect(tintSwitchesPerSecond(2, 0.3, 0.2)).toBeLessThanOrEqual(3);
  });
  it('theme colours are valid hex and every stage has four rings', () => {
    const hex = /^#[0-9a-f]{6}$/;
    [MORPH_THEME.bg, MORPH_THEME.ink, MORPH_THEME.scan].forEach((c) => expect(c).toMatch(hex));
    MORPH_THEME.stages.forEach((s) => {
      expect(s.rings).toHaveLength(4);
      s.rings.forEach((c) => expect(c).toMatch(hex));
    });
  });
});

describe('stage colour (QA round 1 fixes)', () => {
  const H = 0.95;
  const M = 0.7;
  const slot = H + M;
  it('a glyph with no hold rings is clean mid-hold (no rest fringe)', () => {
    expect(morphCellState(0.6, 4, H, M).halo).toBe(0); // R mid-hold
    expect(morphCellState(slot + 0.6, 4, H, M).halo).toBe(0); // a mid-hold
  });
  it('u keeps a ring stack through the middle of its hold', () => {
    expect(morphCellState(2 * slot + 0.6, 4, H, M).halo).toBeGreaterThan(0.4);
  });
  it('the double arch (m) floods its cell purple as it arrives, then clears early in the hold', () => {
    expect(MORPH_THEME.stages[3].tint).toBe('#8079da');
    const arriving = morphCellState(3 * slot - 0.01, 4, H, M);
    expect(arriving).toMatchObject({ tintStage: 3, melting: true });
    expect(arriving.tint).toBeGreaterThan(0.95);
    expect(morphCellState(3 * slot + 0.01, 4, H, M).tint).toBeGreaterThan(0.95);
    expect(morphCellState(3 * slot + 0.5, 4, H, M).tint).toBe(0);
  });
  it('tint stays within the flash limit', () => {
    expect(tintSwitchesPerSecond(4, H, M)).toBeLessThanOrEqual(3);
  });
});

describe('grid size', () => {
  it('defaults to 3 × 3 when cols/rows are missing', () => {
    const cells = morphGridFrame(1, OPTS);
    expect(cells).toHaveLength(9);
    expect(cells.map((c) => [c.col, c.row])).toEqual([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]]);
  });
  it('returns cols × rows cells, row-major, capped at 6 × 6', () => {
    const cells = morphGridFrame(1, { ...OPTS, cols: 5, rows: 4 });
    expect(cells).toHaveLength(20);
    cells.forEach((c, i) => expect([c.col, c.row]).toEqual([i % 5, Math.floor(i / 5)]));
    expect(morphGridFrame(1, { ...OPTS, cols: 40, rows: 40 })).toHaveLength(MORPH_MAX_CELLS);
    expect(morphGridFrame(1, { ...OPTS, cols: 1, rows: 1 })).toHaveLength(1);
    expect(gridDims('x', -3)).toEqual({ cols: 3, rows: 1 });
  });
  it('lags cell (c, r) by c × colDelay + r × rowDelay on a 5 × 4 grid', () => {
    const opts = { ...OPTS, cols: 5, rows: 4 };
    [0.3, 1.7, 3.9, 5.2].forEach((t) => {
      const cells = morphGridFrame(t, opts);
      cells.forEach((c) => {
        const ref = morphGridFrame(t - (c.col * OPTS.colDelay + c.row * OPTS.rowDelay), opts)[0];
        expect(c.from).toBe(ref.from);
        expect(c.mix).toBeCloseTo(ref.mix, 6);
        expect(c.halo).toBeCloseTo(ref.halo, 6);
      });
    });
  });
  it('keeps the 3 × 3 default frame identical when cols/rows are given explicitly', () => {
    [0.5, 1.25, 2.33, 3.75, 5.5].forEach((t) => {
      expect(morphGridFrame(t, { ...OPTS, cols: 3, rows: 3 })).toEqual(morphGridFrame(t, OPTS));
    });
  });
  it('morphGridRect keeps 4:5 cells and centres the grid', () => {
    const rect = { x: 0, y: 0, width: 1000, height: 800 };
    [[1, 1], [5, 2], [6, 6], [2, 5]].forEach(([cols, rows]) => {
      const r = morphGridRect(rect, 0, cols, rows);
      expect(r.width / r.height).toBeCloseTo((cols * 0.8) / rows, 6);
      expect(r.width).toBeLessThanOrEqual(1000 + 1e-9);
      expect(r.height).toBeLessThanOrEqual(800 + 1e-9);
      expect(r.x + r.width / 2).toBeCloseTo(500, 6);
      expect(r.y + r.height / 2).toBeCloseTo(400, 6);
    });
  });
});
