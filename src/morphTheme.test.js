import { describe, expect, it } from 'vitest';
import { MORPH_THEME, morphGridFrame, tintSwitchesPerSecond } from './morphGrid.js';
import { MORPH_MIN_INK_CONTRAST, MORPH_MIN_TINT_CONTRAST, deriveMorphTheme, morphInk, morphThemeFor } from './morphTheme.js';
import { contrastRatio, mixHex } from './color.js';
import { DEFAULTS, PALETTES, morphLoopText } from './RetroStickerWarp.jsx';

const GREY = { fill: '#808080', sil: '#808080', line: '#808080', bg: '#808080' };
const CASES = [...PALETTES.map((p) => [p.name, p]), ['grey x3', GREY]];

describe('deriveMorphTheme', () => {
  it.each(CASES)('%s: letters keep at least 4.5:1 on the background (A3)', (_, pal) => {
    const theme = deriveMorphTheme(pal);
    expect(theme.bg).toBe(pal.bg);
    expect(contrastRatio(theme.ink, theme.bg)).toBeGreaterThanOrEqual(MORPH_MIN_INK_CONTRAST);
  });

  it.each(CASES)('%s: letters keep at least 3:1 on every tinted cell', (_, pal) => {
    const theme = deriveMorphTheme(pal);
    theme.stages.filter((s) => s.tint).forEach((s) => {
      expect(contrastRatio(theme.ink, s.tint)).toBeGreaterThanOrEqual(MORPH_MIN_TINT_CONTRAST);
    });
  });

  it('keeps the Reference shape: 4 stages × 4 rings, tints on stages 2 and 4 only, same timing fields', () => {
    const theme = deriveMorphTheme(PALETTES[0]);
    expect(theme.stages).toHaveLength(4);
    theme.stages.forEach((s, i) => {
      expect(s.rings).toHaveLength(4);
      expect(Boolean(s.tint)).toBe(Boolean(MORPH_THEME.stages[i].tint));
      expect(s.tintMode).toBe(MORPH_THEME.stages[i].tintMode);
      expect(s.holdHalo).toBe(MORPH_THEME.stages[i].holdHalo);
    });
  });

  it('never makes more tint switches per second than the Reference (A5)', () => {
    for (const [, pal] of CASES) {
      const { stages } = deriveMorphTheme(pal);
      expect(tintSwitchesPerSecond(4, 0.95, 0.7, 120, stages)).toBeLessThanOrEqual(tintSwitchesPerSecond(4, 0.95, 0.7));
      expect(tintSwitchesPerSecond(2, 0.2, 0.15, 120, stages)).toBeLessThanOrEqual(tintSwitchesPerSecond(2, 0.2, 0.15));
    }
  });

  it('Disco: light fill is the ink, red sil the first ring and stage-2 tint, scan is ink with 20% bg', () => {
    const disco = PALETTES.find((p) => p.id === 'disco');
    const theme = deriveMorphTheme(disco);
    expect(theme.ink).toBe(disco.fill);
    expect(theme.stages[0].rings[0]).toBe(disco.sil);
    expect(theme.stages[1].tint).toBe(disco.sil);
    expect(theme.scan).toBe(mixHex(disco.fill, disco.bg, 0.2));
  });

  it('Acid: picks the lime sil as ink because the dark fill vanishes on black', () => {
    const acid = PALETTES.find((p) => p.id === 'acid');
    expect(morphInk(acid)).toBe(acid.sil);
  });

  it('falls back to near black or near white when neither fill nor sil reads on bg', () => {
    expect(['#08020f', '#fefefe']).toContain(morphInk(GREY));
    expect(morphInk({ fill: '#f4eee0', sil: '#f4eee0', bg: '#f4eee0' })).toBe('#08020f');
  });

  it('memoises by colour so the renderer only re-uploads on a real change', () => {
    expect(deriveMorphTheme({ ...PALETTES[2] })).toBe(deriveMorphTheme({ ...PALETTES[2] }));
  });

  it('morphThemeFor returns the untouched Reference when the flag is on (A4)', () => {
    expect(morphThemeFor({ ...DEFAULTS, morphReference: true })).toBe(MORPH_THEME);
    expect(morphThemeFor({ ...DEFAULTS, morphReference: false })).not.toBe(MORPH_THEME);
  });

  it('morphGridFrame gives the same cell states for derived stages (timing never depends on colour)', () => {
    const opts = { cols: 3, rows: 3, count: 4, hold: 0.95, melt: 0.7, colDelay: 0.085, rowDelay: 0.46, variant: 'classic' };
    const stages = deriveMorphTheme(PALETTES[1]).stages;
    for (const t of [0, 0.4, 1.3, 2.9, 5.1]) expect(morphGridFrame(t, { ...opts, stages })).toEqual(morphGridFrame(t, opts));
  });
});

describe('morphLoopText', () => {
  it('reads the loop at 1×, at another speed, and when paused by Speed 0 (C4)', () => {
    expect(morphLoopText(6.6, 1)).toBe('Full loop: 6.60s at 1×.');
    expect(morphLoopText(6.6, 2)).toBe('Full loop: 3.30s (Speed 2×).');
    expect(morphLoopText(6.6, 0)).toBe('Paused by Speed 0.');
  });
});
