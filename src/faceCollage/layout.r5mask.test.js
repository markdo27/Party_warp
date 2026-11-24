import { describe, expect, it } from 'vitest';
import { CROP } from './features.js';
import { CORE_U, PRESETS, cutHalfPlane, makeLayout } from './layout.js';
import { MASK_STYLE, MIN_FEATHER_SCALE, PATCH_PAD_IOD } from './maskStyle.js';

const seeds = [1, 7, 42, 77, 0xabc123, 99991];
const organic = (p) => p.kind === 'eye' || p.kind === 'nose' || p.kind === 'mouth';

describe('R5 mask step: soft core, hard cuts only on the outer rim (QA-R5 C1)', () => {
  it('patches centred inside the core carry no hard cut (C1c)', () => {
    for (const seed of seeds) {
      const core = makeLayout({ seed, counts: PRESETS.ref.counts }).filter((p) => organic(p) && Math.abs(p.u) < CORE_U.cutFrom);
      expect(core.length).toBeGreaterThan(0);
      for (const p of core) expect(cutHalfPlane(0.8, 0.6, p.cut)).toBeNull();
    }
  });

  it('outer copies get one outward hard cut whose line sits outside the soft core', () => {
    for (const seed of seeds) {
      const outer = makeLayout({ seed, counts: PRESETS.ref.counts }).filter((p) => organic(p) && !p.original && Math.abs(p.u) >= CORE_U.cutFrom);
      expect(outer.length).toBeGreaterThan(0);
      for (const p of outer) {
        expect(p.cut.hard).toEqual([p.u < 0 ? 'left' : 'right']);
        const w = p.kind === 'eye' ? CROP.eye.w : p.kind === 'nose' ? CROP.nose.w : 0.8;
        const lineU = Math.abs(p.u) + p.cut.chord * (w / 2) * p.scale * Math.cos((p.cut.angle * Math.PI) / 180);
        expect(lineU).toBeGreaterThanOrEqual(CORE_U.soft);
      }
    }
  });

  it('no eye, nose or mouth uses a horizontal top/bottom cut, so rows cannot form blinds (C1a)', () => {
    for (const seed of seeds) {
      for (const p of makeLayout({ seed, counts: PRESETS.ref.counts }).filter(organic)) {
        for (const e of p.cut.hard) expect(['left', 'right']).toContain(e);
      }
    }
  });

  it('nose tiers draw after every eye, upper tier over lower, all before the mouths (C5a/C5c)', () => {
    for (const seed of seeds) {
      const l = makeLayout({ seed, counts: PRESETS.ref.counts });
      const idx = (p) => l.indexOf(p);
      const noses = l.filter((p) => p.kind === 'nose');
      const upper = noses.filter((p) => p.v < 0.46);
      const lower = noses.filter((p) => p.v >= 0.46);
      expect(upper).toHaveLength(2);
      expect(lower).toHaveLength(2);
      expect(Math.min(...upper.map(idx))).toBeGreaterThan(Math.max(...lower.map(idx)));
      const lastEye = Math.max(...l.filter((p) => p.kind === 'eye').map(idx));
      expect(Math.min(...noses.map(idx))).toBeGreaterThan(lastEye);
      const firstMouth = Math.min(...l.filter((p) => p.kind === 'mouth').map(idx));
      expect(Math.max(...noses.map(idx))).toBeLessThan(firstMouth);
    }
  });

  it('the patch quad is padded enough that no feather is clipped into a straight box edge', () => {
    for (const style of Object.values(MASK_STYLE)) {
      expect(PATCH_PAD_IOD).toBeGreaterThanOrEqual(Math.max(style.featherTop, style.featherBot) / MIN_FEATHER_SCALE);
    }
  });
});
