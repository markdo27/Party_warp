import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MORPH_VARIANT,
  MORPH_VARIANTS,
  MORPH_VARIANT_IDS,
  MORPH_START_OFFSET_S,
  cellDelay,
  morphCellState,
  morphCycle,
  morphGridFrame,
  morphVariantId,
  pulseBeat,
  swirlTurn,
  tintSwitchesPerSecond,
  variantDelay,
} from './morphGrid.js';
import { DEFAULTS, morphCells, sanitizeParams } from './RetroStickerWarp.jsx';

const OPTS = { count: 4, hold: 0.95, melt: 0.7, colDelay: 0.085, rowDelay: 0.46 };
const SLOT = OPTS.hold + OPTS.melt;
const NEW_VARIANTS = MORPH_VARIANT_IDS.filter((id) => id !== 'classic');

const delays = (variant, cols, rows, opts = OPTS) => {
  const out = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) out.push(variantDelay(variant, col, row, { ...opts, cols, rows }));
  }
  return out;
};
const share = (variant, cols, rows) => delays(variant, cols, rows).map((d) => Number((d / SLOT).toFixed(2)));
const phaseGroups = (variant, cols, rows) => new Set(delays(variant, cols, rows).map((d) => d.toFixed(6))).size;
const partitionKey = (variant, cols, rows) => {
  const groups = new Map();
  delays(variant, cols, rows).forEach((d, i) => {
    const key = d.toFixed(6);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  return [...groups.values()].map((g) => g.join(',')).sort().join('|');
};
const orderKey = (variant, cols, rows) => delays(variant, cols, rows)
  .map((d, i) => [d, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, i]) => i).join(',');

describe('morph variants: ids and sanitizing', () => {
  it('lists classic first and the five new variations, with names and hints', () => {
    expect(MORPH_VARIANT_IDS).toEqual(['classic', 'horizontal', 'diagonal', 'swirl', 'checker', 'pulse']);
    expect(DEFAULT_MORPH_VARIANT).toBe('classic');
    MORPH_VARIANTS.forEach((v) => {
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.hint.length).toBeGreaterThan(0);
    });
  });

  it('falls back to classic for unknown, empty or null ids', () => {
    for (const bad of ['', null, undefined, 'SWIRL', 'spiral', 3, {}]) expect(morphVariantId(bad)).toBe('classic');
    for (const id of MORPH_VARIANT_IDS) expect(morphVariantId(id)).toBe(id);
  });

  it('sanitizeParams keeps a valid variation and drops a bad one', () => {
    expect(DEFAULTS.morphVariant).toBe('classic');
    expect(sanitizeParams({ morphVariant: 'swirl' }).morphVariant).toBe('swirl');
    expect(sanitizeParams({ morphVariant: '<b>x</b>' }).morphVariant).toBe('classic');
    expect(sanitizeParams({ morphVariant: null }).morphVariant).toBe('classic');
  });
});

describe('morph variants: classic is unchanged', () => {
  it('matches the shipped cellDelay lag exactly with or without the variant key', () => {
    for (const [cols, rows] of [[3, 3], [6, 6], [1, 6], [6, 1]]) {
      for (let i = 0; i < 40; i++) {
        const t = i * 0.173;
        const plain = morphGridFrame(t, { ...OPTS, cols, rows });
        const named = morphGridFrame(t, { ...OPTS, cols, rows, variant: 'classic' });
        expect(named).toEqual(plain);
        plain.forEach((cell) => {
          const expected = morphCellState(t + MORPH_START_OFFSET_S - cellDelay(cell.col, cell.row, OPTS.colDelay, OPTS.rowDelay), OPTS.count, OPTS.hold, OPTS.melt);
          expect(cell.mix).toBe(expected.mix);
          expect(cell.halo).toBe(expected.halo);
        });
      }
    }
  });
});

describe('morph variants: delay shapes (spec 3.3, 3×3 as share of a slot)', () => {
  it.each([
    ['classic', [0, 0.05, 0.1, 0.28, 0.33, 0.38, 0.56, 0.61, 0.66]],
    ['horizontal', [0, 0.12, 0.24, 0, 0.12, 0.24, 0, 0.12, 0.24]],
    ['diagonal', [0, 0.1, 0.2, 0.1, 0.2, 0.3, 0.2, 0.3, 0.4]],
    ['swirl', [0.92, 0.2, 0.33, 0.72, 0, 0.34, 0.71, 0.57, 0.54]],
    ['checker', [0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0]],
    ['pulse', [0.75, 0.5, 0.75, 0.75, 0.25, 0.75, 0, 0.5, 0.5]],
  ])('%s', (variant, expected) => {
    expect(share(variant, 3, 3)).toEqual(expected);
  });

  it('horizontal: same column same phase, columns differ', () => {
    const d = delays('horizontal', 5, 2);
    for (let col = 0; col < 5; col++) expect(d[col]).toBe(d[5 + col]);
    expect(phaseGroups('horizontal', 6, 6)).toBe(6);
  });

  it('diagonal: same col + row same phase', () => {
    const d = delays('diagonal', 4, 4);
    expect(d[1]).toBeCloseTo(d[4], 12); // (1,0) and (0,1)
    expect(phaseGroups('diagonal', 6, 6)).toBe(11);
  });

  it('checker: exactly two groups half a slot apart', () => {
    const values = [...new Set(delays('checker', 6, 6))].sort();
    expect(values).toHaveLength(2);
    expect(values[1] - values[0]).toBeCloseTo(SLOT / 2, 12);
  });

  it('pulse: every delay is a multiple of a quarter slot, 4 beats from 3×3 up', () => {
    for (const d of delays('pulse', 6, 6)) { const beats = d / (SLOT / 4); expect(beats).toBeCloseTo(Math.round(beats), 9); }
    expect(phaseGroups('pulse', 3, 3)).toBe(4);
    expect(phaseGroups('pulse', 6, 6)).toBe(4);
  });

  it('new variations scale with Hold and Melt (same shape, other tempo)', () => {
    const slow = { ...OPTS, hold: 1.9, melt: 1.4 };
    for (const v of NEW_VARIANTS) {
      const a = delays(v, 4, 4);
      const b = delays(v, 4, 4, slow);
      a.forEach((d, i) => expect(b[i]).toBeCloseTo(d * 2, 9));
    }
  });
});

describe('morph variants: pulse golden table (spec 3.2)', () => {
  const GOLDEN = [
    [3, 2, 3, 2, 3, 1],
    [3, 1, 3, 3, 1, 0],
    [0, 2, 2, 0, 1, 2],
    [0, 3, 0, 3, 1, 0],
    [2, 2, 0, 1, 0, 3],
    [1, 0, 2, 3, 1, 2],
  ];
  it('matches the 6×6 table', () => {
    GOLDEN.forEach((line, row) => line.forEach((beat, col) => expect(pulseBeat(col, row)).toBe(beat)));
  });
  it('keeps old cells on the same beat when the grid grows', () => {
    const small = delays('pulse', 3, 3);
    const big = delays('pulse', 6, 6);
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) expect(big[row * 6 + col]).toBe(small[row * 3 + col]);
  });
});

describe('morph variants: swirl (spec 3.1)', () => {
  it('starts at 12 o\'clock and turns clockwise', () => {
    // 3×3: top middle (1,0) = 0; right (2,1) = 0.25; bottom (1,2) = 0.5; left (0,1) = 0.75.
    expect(swirlTurn(1, 0, 3, 3)).toBeCloseTo(0, 12);
    expect(swirlTurn(2, 1, 3, 3)).toBeCloseTo(0.25, 12);
    expect(swirlTurn(1, 2, 3, 3)).toBeCloseTo(0.5, 12);
    expect(swirlTurn(0, 1, 3, 3)).toBeCloseTo(0.75, 12);
  });
  it('gives the centre cell of an odd grid a delay of 0', () => {
    expect(variantDelay('swirl', 1, 1, { ...OPTS, cols: 3, rows: 3 })).toBe(0);
    expect(variantDelay('swirl', 2, 2, { ...OPTS, cols: 5, rows: 5 })).toBe(0);
  });
  it('has 36 distinct phases at 6×6 and stays under one slot', () => {
    expect(phaseGroups('swirl', 6, 6)).toBe(36);
    for (const d of delays('swirl', 6, 6)) expect(d).toBeLessThanOrEqual(SLOT + 1e-9);
  });
});

describe('morph variants: every variation loops and stays finite', () => {
  const SIZES = [[1, 1], [1, 6], [6, 1], [2, 2], [3, 3], [4, 4], [5, 2], [6, 6]];
  it.each(MORPH_VARIANT_IDS)('%s: frame(t) = frame(t + cycle), no NaN', (variant) => {
    for (const count of [2, 4, 6]) {
      const cycle = morphCycle(count, OPTS.hold, OPTS.melt);
      for (const [cols, rows] of SIZES) {
        for (let i = 0; i < 20; i++) {
          const t = i * 0.311 + 0.0007; // off exact slot edges, where end-of-melt and start-of-hold are the same picture
          const a = morphGridFrame(t, { ...OPTS, count, cols, rows, variant });
          const b = morphGridFrame(t + cycle, { ...OPTS, count, cols, rows, variant });
          expect(a).toHaveLength(cols * rows);
          a.forEach((cell, k) => {
            for (const key of ['mix', 'halo', 'tint']) {
              expect(Number.isFinite(cell[key])).toBe(true);
              expect(Math.abs(cell[key] - b[k][key])).toBeLessThan(1e-9);
            }
          });
        }
      }
    }
  });

  it('1×1: every variation but pulse is classic; pulse is the same loop shifted by its beat', () => {
    const ref = morphGridFrame(1.3, { ...OPTS, cols: 1, rows: 1 });
    for (const variant of NEW_VARIANTS.filter((v) => v !== 'pulse')) expect(morphGridFrame(1.3, { ...OPTS, cols: 1, rows: 1, variant })).toEqual(ref);
    const shift = (pulseBeat(0, 0) / 4) * SLOT; // golden table: cell (0, 0) is on beat 3
    expect(morphGridFrame(1.3 + shift, { ...OPTS, cols: 1, rows: 1, variant: 'pulse' })[0].mix).toBeCloseTo(ref[0].mix, 9);
  });

  it('reduced motion keeps every variation still', () => {
    for (const variant of MORPH_VARIANT_IDS) {
      morphGridFrame(2.2, { ...OPTS, cols: 4, rows: 4, variant, still: true }).forEach((c) => {
        expect(c).toMatchObject({ mix: 0, halo: 0, tint: 0, melting: false });
      });
    }
  });
});

describe('morph variants: clearly different (spec 6, criterion 3)', () => {
  it.each([[4, 4], [6, 6]])('%i×%i: every pair differs in phase groups or in delay order', (cols, rows) => {
    for (let i = 0; i < MORPH_VARIANT_IDS.length; i++) {
      for (let j = i + 1; j < MORPH_VARIANT_IDS.length; j++) {
        const a = MORPH_VARIANT_IDS[i];
        const b = MORPH_VARIANT_IDS[j];
        const differs = partitionKey(a, cols, rows) !== partitionKey(b, cols, rows) || orderKey(a, cols, rows) !== orderKey(b, cols, rows);
        expect(differs, `${a} vs ${b}`).toBe(true);
      }
    }
  });
});

describe('morph variants: QA keyframes 4×4 (spec 5)', () => {
  const KEYS = [0.75, 1, 1.25, 1.5];
  const EXPECTED = {
    classic: ['..../..../MMMM/MMM.', 'MMM./..../...M/MMMM', 'MMMM/..../..../MMMM', 'MMMM/MMM./..../...M'],
    horizontal: ['..../..../..../....', 'M.../M.../M.../M...', 'MMM./MMM./MMM./MMM.', 'MMMM/MMMM/MMMM/MMMM'],
    diagonal: ['..../..../..../...M', 'MM../M.../..../....', 'MMM./MM../M.../....', 'MMMM/MMMM/MMM./MM..'],
    swirl: ['MM../MM../MM../MMMM', 'MM../MM../M.../M...', 'MMM./..M./..../....', '..MM/..MM/..MM/....'],
    checker: ['..../..../..../....', 'M.M./.M.M/M.M./.M.M', 'M.M./.M.M/M.M./.M.M', 'M.M./.M.M/M.M./.M.M'],
    pulse: ['M.M./M.MM/..../.M.M', 'M.M./M.MM/M..M/MMMM', '..../.M../M..M/M.M.', '..../.M../M..M/M.M.'],
  };
  const map = (variant, t) => {
    const cells = morphGridFrame(t, { ...OPTS, cols: 4, rows: 4, variant });
    return [0, 1, 2, 3].map((row) => cells.slice(row * 4, row * 4 + 4).map((c) => (c.melting ? 'M' : '.')).join('')).join('/');
  };
  it.each(MORPH_VARIANT_IDS)('%s', (variant) => {
    expect(KEYS.map((t) => map(variant, t))).toEqual(EXPECTED[variant]);
  });
});

describe('morph variants: flash limit unchanged (spec 6, criterion 7)', () => {
  it('stays at or under 3 switches per second for the existing settings', () => {
    expect(tintSwitchesPerSecond(4, 0.95, 0.7)).toBeLessThanOrEqual(3);
    expect(tintSwitchesPerSecond(2, 0.3, 0.2)).toBeLessThanOrEqual(3);
  });
});

describe('morph variants: app wiring', () => {
  it('morphCells uses the chosen variation', () => {
    const p = sanitizeParams({ design: 'morphGrid', morphCols: 4, morphRows: 4, morphGlyphs: 'Raum' });
    for (const variant of MORPH_VARIANT_IDS) {
      const cells = morphCells({ ...p, morphVariant: variant }, 1.25);
      const expected = morphGridFrame(1.25, { cols: 4, rows: 4, count: 4, hold: p.morphHold, melt: p.morphMelt, colDelay: p.morphColDelay, rowDelay: p.morphRowDelay, variant });
      expect(cells).toEqual(expected);
    }
  });
});
