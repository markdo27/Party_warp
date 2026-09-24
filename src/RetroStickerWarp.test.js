import { describe, expect, it } from 'vitest';
import {
  BAND_GAP_EM,
  BAND_THEMES,
  DEFAULTS,
  DEFAULT_TAG_FONT,
  DESIGNS,
  FAR_PX,
  FIELD_LIMIT_EM,
  GRAIN_PX,
  ITALIC_MAX,
  MAX_CHARS,
  MAX_LINES,
  MOTION_RATIOS,
  RANGES,
  TIME_FOLD,
  alignOffset,
  bandGeometry,
  bandLine,
  boxSizesForGauss,
  buildFieldData,
  buildSvg,
  caretGeometry,
  caretToRowCol,
  classField,
  cleanText,
  computeFreeArea,
  computeView,
  contrastRatio,
  crc32,
  cssToEm,
  designLayout,
  displayLines,
  effectUniforms,
  emToCss,
  evenSize,
  fileNameFor,
  fillGlyphRow,
  fillHoles,
  fitInCanvas,
  recordFrame,
  viewForRect,
  fillStretchRow,
  foldTime,
  gaussianBlur,
  glyphSoftnessEm,
  gooMeltEm,
  graphemes,
  hexToRgb01,
  hitTestLayout,
  hslToHex,
  italicSlants,
  layoutLines,
  letterClass,
  loopsToPath,
  mapBreaks,
  messageAlignment,
  messageFrame,
  motionCanvas,
  messageLayout,
  messagePlan,
  motionClock,
  noise1,
  ovalGeometry,
  pickVideoType,
  randomPalette,
  rowColToCaret,
  sanitizeInput,
  sanitizeParams,
  sanitizeTagline,
  selectionRects,
  signedDistanceField,
  silhouetteField,
  simplifyLoop,
  stickerBounds,
  stickerReach,
  stretchBreaks,
  stretchBumps,
  stretchScales,
  tagFontSpec,
  taglineExtent,
  textureUniforms,
  traceContours,
  unionField,
  validateFontFile,
  withinLimits,
  zipStore,
} from './RetroStickerWarp.jsx';

const THUMB = String.fromCodePoint(0x1f44d, 0x1f3fd); // thumbs up + skin tone
const CODER = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb); // ZWJ sequence
const monoMeasure = (s) => Array.from(s).length * 0.6;
const baseLayoutOpts = { measure: monoMeasure, capHeight: 0.7, lineSpacing: 1, tracking: 0.1, align: 'left' };

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function squareMask(size, from, to) {
  const alpha = new Uint8Array(size * size);
  for (let y = from; y <= to; y++) for (let x = from; x <= to; x++) alpha[y * size + x] = 255;
  return alpha;
}

describe('sanitizeInput', () => {
  it('normalises newlines, turns tabs into spaces and strips control characters', () => {
    expect(sanitizeInput('A\r\nB\x07C\tD\rE')).toBe('A\nBC D\nE');
  });

  it('limits the number of lines', () => {
    const input = Array.from({ length: MAX_LINES + 3 }, (_, i) => `L${i}`).join('\n');
    expect(sanitizeInput(input).split('\n')).toHaveLength(MAX_LINES);
  });

  it('limits total length in UTF-16 units without splitting emoji', () => {
    const grin = String.fromCodePoint(0x1f600);
    expect(sanitizeInput(grin.repeat(MAX_CHARS))).toBe(grin.repeat(MAX_CHARS / 2));
    const packed = sanitizeInput(CODER.repeat(40));
    expect(packed.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(packed.length % CODER.length).toBe(0);
  });

  it('coerces non-string input', () => {
    expect(sanitizeInput(undefined)).toBe('');
    expect(sanitizeInput(42)).toBe('42');
  });
});

describe('cleanText and withinLimits', () => {
  it('cleans characters without enforcing limits', () => {
    expect(cleanText(`a\tb\r\nc${String.fromCharCode(7)}`)).toBe('a b\nc');
    const long = 'x'.repeat(MAX_CHARS + 5);
    expect(cleanText(long)).toBe(long);
  });

  it('checks the line and length limits', () => {
    expect(withinLimits(`${'a\n'.repeat(MAX_LINES - 1)}a`)).toBe(true);
    expect(withinLimits('a\n'.repeat(MAX_LINES))).toBe(false);
    expect(withinLimits('x'.repeat(MAX_CHARS))).toBe(true);
    expect(withinLimits('x'.repeat(MAX_CHARS + 1))).toBe(false);
  });
});

describe('graphemes', () => {
  it('keeps emoji sequences together', () => {
    expect(graphemes(`a${THUMB}${CODER}b`)).toEqual(['a', THUMB, CODER, 'b']);
  });
});

describe('foldTime', () => {
  it('stays bounded and never jumps', () => {
    expect(foldTime(10)).toBe(10);
    expect(foldTime(TIME_FOLD + 10)).toBe(TIME_FOLD - 10);
    expect(foldTime(2 * TIME_FOLD + 10)).toBe(10);
    for (const t of [TIME_FOLD, 2 * TIME_FOLD, 5 * TIME_FOLD]) {
      expect(Math.abs(foldTime(t + 1e-3) - foldTime(t - 1e-3))).toBeLessThan(0.01);
    }
  });
});

describe('displayLines', () => {
  it('uppercases character by character, keeping the length stable', () => {
    const lines = displayLines('straße\nok', true);
    expect(lines).toEqual(['STRAßE', 'OK']);
    expect(Array.from(lines[0])).toHaveLength(6);
  });

  it('leaves text alone when caps are off', () => {
    expect(displayLines('Mixed\ncase', false)).toEqual(['Mixed', 'case']);
  });
});

describe('layoutLines', () => {
  it('positions carets with kerning-aware prefixes plus tracking', () => {
    const { rows } = layoutLines(['ABC'], baseLayoutOpts);
    expect(rows[0].carets).toEqual([0, expect.closeTo(0.7, 9), expect.closeTo(1.4, 9)]);
    expect(rows[0].width).toBeCloseTo(2.0, 9);
    expect(rows[0].stops.map((s) => +s.toFixed(6))).toEqual([0, 0.65, 1.35, 2]);
  });

  it('stacks baselines by cap height times line spacing', () => {
    const { rows, gap } = layoutLines(['A', 'B', 'C'], { ...baseLayoutOpts, lineSpacing: 1.5 });
    expect(gap).toBeCloseTo(1.05, 9);
    expect(rows.map((r) => r.baseline)).toEqual([0, expect.closeTo(1.05, 9), expect.closeTo(2.1, 9)]);
  });

  it('handles empty lines', () => {
    const { rows } = layoutLines(['', 'AB'], baseLayoutOpts);
    expect(rows[0]).toMatchObject({ width: 0, stops: [0], carets: [] });
  });

  it('aligns rows left, right, center and zigzag', () => {
    expect(alignOffset('left', 1, 3, 0, 3, 0.7)).toBe(0);
    expect(alignOffset('right', 1, 3, 0, 3, 0.7)).toBe(2);
    expect(alignOffset('center', 1, 3, 0, 3, 0.7)).toBe(1);
    const zig = [0, 1, 2].map((i) => alignOffset('zigzag', 2, 2, i, 3, 1));
    expect(zig[0]).toBeLessThan(0);
    expect(zig[1]).toBeGreaterThan(0);
    expect(zig[2]).toBe(0);
    expect(alignOffset('zigzag', 2, 2, 0, 1, 1)).toBe(0);
  });
});

describe('caret mapping', () => {
  it('maps a string index to row and column', () => {
    expect(caretToRowCol('AB\nCDE', 0)).toEqual({ row: 0, col: 0 });
    expect(caretToRowCol('AB\nCDE', 3)).toEqual({ row: 1, col: 0 });
    expect(caretToRowCol('AB\nCDE', 4)).toEqual({ row: 1, col: 1 });
  });

  it('round-trips through astral characters', () => {
    const value = 'A😀B\nC';
    expect(caretToRowCol(value, 3)).toEqual({ row: 0, col: 2 });
    expect(rowColToCaret(value, 0, 2)).toBe(3);
    expect(rowColToCaret(value, 1, 1)).toBe(6);
  });

  it('treats emoji sequences as single caret stops', () => {
    const value = `A${CODER}B`;
    expect(caretToRowCol(value, 1 + CODER.length)).toEqual({ row: 0, col: 2 });
    expect(rowColToCaret(value, 0, 2)).toBe(1 + CODER.length);
    expect(layoutLines([value], baseLayoutOpts).rows[0].chars).toEqual(['A', CODER, 'B']);
  });

  it('clamps rows and columns that are out of range', () => {
    expect(rowColToCaret('AB\nCDE', 1, 99)).toBe(6);
    expect(rowColToCaret('AB', 5, 0)).toBe(2);
  });

  it('hit-tests the nearest row and caret stop', () => {
    const layout = layoutLines(['ABC', 'DE'], baseLayoutOpts);
    const [, second] = layout.rows;
    const hit = hitTestLayout(layout, [second.x + second.stops[1] + 0.05, second.baseline - 0.3]);
    expect(hit).toEqual({ row: 1, col: 1 });
    expect(hitTestLayout({ rows: [], capHeight: 1 }, [0, 0])).toEqual({ row: 0, col: 0 });
  });

  it('places the caret geometry at the stop, spanning the cap height', () => {
    const layout = layoutLines(['ABC'], baseLayoutOpts);
    const g = caretGeometry(layout, 0, 2);
    expect(g.x).toBeCloseTo(1.35, 9);
    expect(g.top).toBeLessThan(-0.7);
    expect(g.bottom).toBeGreaterThan(0);
    expect(caretGeometry({ rows: [], capHeight: 1 }, 0, 0)).toBeNull();
  });

  it('builds selection highlight rects per row', () => {
    const value = 'ABC\nDE';
    const layout = layoutLines(displayLines(value, true), baseLayoutOpts);
    const [first, second] = layout.rows;
    const rects = selectionRects(layout, value, 5, 1);
    expect(rects).toHaveLength(2);
    expect(rects[0].x).toBeCloseTo(first.x + first.stops[1], 9);
    expect(rects[0].x + rects[0].width).toBeCloseTo(first.x + first.stops[3], 9);
    expect(rects[1].x).toBeCloseTo(second.x, 9);
    expect(rects[1].width).toBeCloseTo(second.stops[1], 9);
    expect(rects[0].top).toBeLessThan(rects[0].bottom);
    expect(selectionRects(layout, value, 2, 2)).toEqual([]);
  });
});

describe('signedDistanceField', () => {
  const size = 21;
  const sdf = signedDistanceField(squareMask(size, 6, 14), size, size);
  const at = (x, y) => sdf[y * size + x];

  it('is negative inside and positive outside', () => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const inside = x >= 6 && x <= 14 && y >= 6 && y <= 14;
        expect(Math.sign(at(x, y))).toBe(inside ? -1 : 1);
      }
    }
  });

  it('measures Euclidean distances to the edge', () => {
    expect(at(10, 10)).toBeGreaterThan(-5.25);
    expect(at(10, 10)).toBeLessThan(-4.25);
    expect(at(2, 10)).toBeGreaterThan(3.25);
    expect(at(2, 10)).toBeLessThan(4.25);
    expect(at(2, 2)).toBeGreaterThan(4.9);
    expect(at(2, 2)).toBeLessThan(5.75);
  });

  it('uses partial coverage for sub-pixel edges', () => {
    const w = 20;
    const alpha = new Uint8Array(w * 3);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < w; x++) alpha[y * w + x] = x < 10 ? 255 : x === 10 ? 128 : 0;
    }
    const field = signedDistanceField(alpha, w, 3);
    expect(Math.abs(field[w + 10])).toBeLessThan(0.05);
    expect(field[w + 15]).toBeGreaterThan(4);
  });
});

describe('gaussianBlur', () => {
  it('keeps constant fields constant and returns a copy', () => {
    const src = new Float32Array(30 * 20).fill(3.5);
    const out = gaussianBlur(src, 30, 20, 4);
    expect(out).not.toBe(src);
    out.forEach((v) => expect(v).toBeCloseTo(3.5, 4));
  });

  it('preserves linear ramps away from the borders', () => {
    const w = 80;
    const h = 8;
    const src = Float32Array.from({ length: w * h }, (_, i) => i % w);
    const out = gaussianBlur(src, w, h, 3);
    for (let x = 20; x < 60; x++) expect(out[4 * w + x]).toBeCloseTo(x, 3);
  });

  it('spreads an impulse symmetrically while conserving mass', () => {
    const w = 41;
    const src = new Float32Array(w * w);
    src[20 * w + 20] = 1000;
    const out = gaussianBlur(src, w, w, 3);
    const total = out.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1000, 1);
    expect(out[20 * w + 17]).toBeCloseTo(out[20 * w + 23], 4);
    expect(out[17 * w + 20]).toBeCloseTo(out[23 * w + 20], 4);
    expect(out[20 * w + 20]).toBeLessThan(1000);
  });

  it('is a plain copy for negligible sigma', () => {
    const src = Float32Array.from([1, 2, 3, 4]);
    expect(Array.from(gaussianBlur(src, 2, 2, 0))).toEqual([1, 2, 3, 4]);
  });
});

describe('boxSizesForGauss', () => {
  it('returns three odd boxes whose variances add up to sigma squared', () => {
    for (const sigma of [1.5, 4, 9.7, 20]) {
      const sizes = boxSizesForGauss(sigma);
      expect(sizes).toHaveLength(3);
      sizes.forEach((s) => expect(s % 2).toBe(1));
      const variance = sizes.reduce((acc, s) => acc + (s * s - 1) / 12, 0);
      expect(variance / (sigma * sigma)).toBeGreaterThan(0.8);
      expect(variance / (sigma * sigma)).toBeLessThan(1.2);
    }
    expect(boxSizesForGauss(0.1)).toEqual([]);
  });
});

describe('fillHoles', () => {
  it('fills enclosed holes (including their anti-aliased rims) but not the exterior', () => {
    const size = 12;
    const alpha = squareMask(size, 2, 9);
    for (let y = 4; y <= 7; y++) for (let x = 4; x <= 7; x++) alpha[y * size + x] = 0;
    alpha[4 * size + 4] = 200; // partially covered rim pixel inside the hole
    const filled = fillHoles(alpha, size, size);
    expect(filled).not.toBe(alpha);
    expect(filled[5 * size + 5]).toBe(255);
    expect(filled[4 * size + 4]).toBe(255);
    expect(filled[0]).toBe(0);
    expect(alpha[5 * size + 5]).toBe(0);
  });

  it('keeps anti-aliased pixels on the outer edge', () => {
    const size = 8;
    const alpha = squareMask(size, 2, 5);
    alpha[1 * size + 3] = 140;
    expect(fillHoles(alpha, size, size)[1 * size + 3]).toBe(140);
  });
});

describe('silhouetteField', () => {
  const pxPerEm = 40;
  const sdfOf = (alpha, w, h) => signedDistanceField(alpha, w, h);
  const sampleEm = (sil, fullX, fullY) =>
    sil.data[Math.floor(fullY / 2) * sil.width + Math.floor(fullX / 2)];

  it('bridges gaps narrower than twice the closing radius', () => {
    const w = 120;
    const h = 80;
    const alpha = new Uint8Array(w * h);
    // two blocks 16px (0.4em) apart
    for (let y = 30; y < 50; y++) for (let x = 20; x < 52; x++) alpha[y * w + x] = 255;
    for (let y = 30; y < 50; y++) for (let x = 68; x < 100; x++) alpha[y * w + x] = 255;
    const raw = sdfOf(alpha, w, h);
    const sil = silhouetteField(raw, w, h, pxPerEm);
    expect(raw[40 * w + 60] / pxPerEm).toBeGreaterThan(0.15);
    expect(sampleEm(sil, 60, 40)).toBeLessThan(0.03);
    expect(sampleEm(sil, 5, 5)).toBeGreaterThan(0.3);
  });

  it('never leaves a hole inside a ring of ink', () => {
    const w = 160;
    const h = 160;
    const alpha = squareMask(w, 20, 139);
    for (let y = 36; y <= 123; y++) for (let x = 36; x <= 123; x++) alpha[y * w + x] = 0;
    const sil = silhouetteField(sdfOf(alpha, w, h), w, h, pxPerEm);
    expect(sampleEm(sil, 80, 80)).toBeLessThan(0);
  });
});

describe('tagline typeface', () => {
  it('defaults to the built-in Archivo and accepts uploaded fonts', () => {
    expect(sanitizeParams().tagFontId).toBe(DEFAULT_TAG_FONT.id);
    expect(sanitizeParams({ tagFontId: 'upload-3' }).tagFontId).toBe('upload-3');
    expect(sanitizeParams({ tagFontId: 'comic-sans' }).tagFontId).toBe(DEFAULT_TAG_FONT.id);
    expect(sanitizeParams({ tagFontId: 'archivo' }).tagFontId).toBe(DEFAULT_TAG_FONT.id);
  });

  it('builds a canvas font for the built-in face and for uploads', () => {
    expect(tagFontSpec(DEFAULT_TAG_FONT, 20)).toMatch(/^600 20px "Archivo", /);
    expect(tagFontSpec({ family: 'RSW Upload 2' }, 12.5)).toMatch(/^400 12.5px "RSW Upload 2", /);
  });

  it('sizes the tagline canvas to the measured ink of any font, with padding', () => {
    const lines = [
      { left: 0.1, right: 3, ascent: 0.7, descent: 0.2 },
      { left: 0, right: 4.5, ascent: 1.3, descent: 0.6 }, // a tall display face
    ];
    const { originEm, sizeEm } = taglineExtent(lines, { lineGap: 1, pad: 0.2 });
    expect(originEm[0]).toBeCloseTo(-0.3, 9); // widest left overhang + pad
    expect(originEm[1]).toBeCloseTo(-0.9, 9); // first line's ascent + pad
    expect(originEm[0] + sizeEm[0]).toBeCloseTo(4.7, 9);
    expect(originEm[1] + sizeEm[1]).toBeCloseTo(1.8, 9); // second baseline (1) + descent + pad
    // The second line's tall ascent reaches above its baseline but not above the canvas.
    expect(1 - 1.3).toBeGreaterThanOrEqual(originEm[1]);
  });
});

describe('recording canvas', () => {
  it('offers fit plus the common social ratios', () => {
    expect(sanitizeParams().motionRatio).toBe('fit');
    expect(sanitizeParams({ motionRatio: '9:16' }).motionRatio).toBe('9:16');
    expect(sanitizeParams({ motionRatio: '3:2' }).motionRatio).toBe('fit');
    expect(MOTION_RATIOS).toEqual(['fit', '1:1', '4:5', '9:16', '16:9']);
  });

  it('sizes each ratio at its standard resolution, scaled to fit the GPU', () => {
    expect(motionCanvas('fit', 4096)).toBeNull();
    expect(motionCanvas('1:1', 4096)).toEqual({ width: 1080, height: 1080 });
    expect(motionCanvas('4:5', 4096)).toEqual({ width: 1080, height: 1350 });
    expect(motionCanvas('9:16', 4096)).toEqual({ width: 1080, height: 1920 });
    expect(motionCanvas('16:9', 4096)).toEqual({ width: 1920, height: 1080 });
    const small = motionCanvas('9:16', 960);
    expect(small.height).toBeLessThanOrEqual(960);
    expect(small.width % 2 + small.height % 2).toBe(0); // video codecs want even sizes
    expect(small.width / small.height).toBeCloseTo(9 / 16, 2);
  });

  it('frames the recording on the stage: the largest rect of that ratio in the free area', () => {
    const free = { x: 0, y: 60, width: 900, height: 600 };
    expect(recordFrame(free, 'fit')).toBeNull();
    const r = recordFrame(free, '9:16');
    expect(r.width / r.height).toBeCloseTo(9 / 16, 6);
    expect(r.height).toBeLessThan(free.height);
    expect(r.x + r.width / 2).toBeCloseTo(450, 6); // centred
    expect(r.y + r.height / 2).toBeCloseTo(360, 6);
    const wide = recordFrame(free, '16:9');
    expect(wide.width / wide.height).toBeCloseTo(16 / 9, 6);
    expect(wide.width).toBeLessThan(free.width);
  });

  it('records exactly what the frame shows, scaled to the canvas', () => {
    const view = { pxPerEm: 100, center: [450, 360], centerEm: [0, 0] };
    const rect = { x: 350, y: 160, width: 225, height: 400 }; // 9:16, right of centre
    const v = viewForRect(view, rect, { width: 1080, height: 1920 });
    expect(v.pxPerEm).toBeCloseTo(480, 6); // 1080 / 225 × 100
    expect(v.centerPx).toEqual([540, 960]);
    // The rect's centre (462.5, 360) on screen is 0.125 em right of the view centre.
    expect(v.centerEm[0]).toBeCloseTo(0.125, 9);
    expect(v.centerEm[1]).toBeCloseTo(0, 9);
  });

  it('centres a design inside the canvas with a margin all round', () => {
    const box = { x: -2, y: -0.5, width: 4, height: 1 };
    const { pxPerEm, centerEm } = fitInCanvas(box, 1080, 1920);
    expect(centerEm).toEqual([0, 0]);
    expect(box.width * pxPerEm).toBeLessThan(1080);
    expect(box.width * pxPerEm).toBeGreaterThan(1080 * 0.7); // a wide design fills the width
    const tall = fitInCanvas({ x: 0, y: 0, width: 1, height: 4 }, 1920, 1080);
    expect(4 * tall.pxPerEm).toBeLessThan(1080);
    expect(tall.centerEm).toEqual([0.5, 2]);
  });
});

describe('messageFrame', () => {
  // Two messages, each held 2 s then melted for 1 s.
  const at = (t) => messageFrame(t, 2, 2, 1);

  it('holds each message, then melts into the next and loops', () => {
    expect(at(1)).toMatchObject({ index: 0, next: 1, mix: 0 });
    expect(at(2.5).mix).toBeCloseTo(0.5, 9);
    expect(at(4)).toMatchObject({ index: 1, next: 0, mix: 0 });
    expect(at(6.2).index).toBe(0); // back to the first message
  });

  it('lets letters stretch and lean only while a message holds', () => {
    expect(at(0).alive).toBe(0); // just melted in: at rest
    expect(at(1).alive).toBe(1); // mid-hold: fully alive
    expect(at(1.999).alive).toBeLessThan(0.01); // settled before the melt
    expect(at(2.5).alive).toBe(0); // melting: at rest, so shared text lines up
    expect(at(0.2).alive).toBeGreaterThan(0);
    expect(at(0.2).alive).toBeLessThan(1);
    // Short holds still get a full ease in and out.
    expect(messageFrame(0.25, 2, 0.5, 1).alive).toBeGreaterThan(0.9);
  });
});

describe('messageLayout', () => {
  it('moves the rows into the message field, centred on its ink', () => {
    const base = {
      layout: { rows: [{ x: 2, baseline: 1, chars: ['A'], stops: [0, 1] }], capHeight: 0.7, gap: 0.8 },
      inkBox: { x: 2, y: 0.3, width: 1, height: 0.7 },
      originEm: [1, -0.5],
      sizeEm: [3, 2],
    };
    const m = messageLayout(base);
    expect(m.layout.rows[0].x).toBeCloseTo(-0.5, 9); // ink centre x = 2.5
    expect(m.layout.rows[0].baseline).toBeCloseTo(0.35, 9); // ink centre y = 0.65
    expect(m.fieldOrigin).toEqual([-1.5, -1.15]);
    expect(m.fieldSize).toEqual([3, 2]);
    expect(m.rowGeom[0]).toBeCloseTo(0.35 - 0.35, 9);
    expect(m.rowGeom[1]).toBe(0.8);
  });
});

describe('messageAlignment', () => {
  // A one-row "base" with 1 em wide monospace letters, centred like the renderer centres it.
  const base = (rows) => {
    const laid = rows.map((text, i) => ({ x: 0, baseline: i * 1.2, chars: Array.from(text), carets: Array.from(text, (_, k) => k), width: text.length }));
    const width = Math.max(...rows.map((t) => t.length));
    return { layout: { rows: laid, capHeight: 0.7 }, inkBox: { x: 0, y: -0.7, width, height: 0.7 + (rows.length - 1) * 1.2 } };
  };

  it('keeps shared text still: BLK → BLK46 shifts the new message by half the added width', () => {
    expect(messageAlignment(base(['BLK']), base(['BLK46']))).toEqual([1, 0]);
    expect(messageAlignment(base(['BLK46']), base(['BLK']))).toEqual([-1, 0]);
  });

  it('aligns shared text found anywhere, including on another row', () => {
    const [dx, dy] = messageAlignment(base(['LETS', 'DANCE']), base(['XDANCEX']));
    // D: x 0 on row 2 of the old message (ink centre 2.5, 0.25), x 1 in the new (3.5, -0.35).
    expect(dx).toBeCloseTo(0 - 2.5 - (1 - 3.5), 9);
    expect(dy).toBeCloseTo(1.2 - 0.25 - (0 + 0.35), 9);
  });

  it('marks only the matched run as shared, in centred coordinates of the old message', () => {
    const [x0, y0, x1, y1] = messagePlan(base(['BLK']), base(['BLK46'])).sharedBox;
    expect([x0, x1]).toEqual([-1.5, 1.5]); // B's left edge to K's right edge
    expect(y0).toBeLessThan(0.35 - 0.7); // above the caps (baseline sits 0.35 below centre)
    expect(y1).toBeGreaterThan(0.35);
    // Letters that merely overlap by chance are not shared: they drain and pour.
    expect(messagePlan(base(['BLK']), base(['LOVE'])).sharedBox).toBeNull();
  });

  it('keeps both centred when they share fewer than two visible letters', () => {
    expect(messageAlignment(base(['BLK']), base(['46']))).toEqual([0, 0]);
    expect(messageAlignment(base(['A B']), base(['A CD']))).toEqual([0, 0]);
  });
});

describe('goo', () => {
  it('softens letters, melts each word together and keeps rows apart', () => {
    const soft = (goo) => glyphSoftnessEm(goo);
    expect(soft(0)).toBeGreaterThan(0);
    expect(soft(1)).toBeGreaterThan(soft(0.35));
    const u = (goo) => effectUniforms(sanitizeParams({ goo }));
    expect(u(0.35).gooK).toBeCloseTo(gooMeltEm(0.35), 9);
    expect(u(0).gooK / 2).toBeLessThan(0.04); // no goo: only touching letters join
    expect(u(1).gooK).toBeGreaterThan(u(0.35).gooK);
    // Two letters bridge when their gap is under half the melt radius. By default most
    // letter pairs in a word stick (gaps ~0.05–0.1 em); at full goo, nearly all do…
    expect(u(0.35).gooK / 2).toBeGreaterThan(0.08);
    expect(u(1).gooK / 2).toBeGreaterThan(0.11);
    // …while rows melt gently, so lines 0.11 em apart stay apart even at full goo.
    expect(u(1).gooRowK).toBeLessThan(u(1).gooK);
    expect(u(1).gooRowK / 2).toBeLessThan(0.08);
  });
});

describe('letter classes', () => {
  it('alternates by letter and by row, so neighbours never share a field', () => {
    expect([letterClass(0, 0), letterClass(0, 1), letterClass(0, 2)]).toEqual([0, 1, 0]);
    expect([letterClass(1, 0), letterClass(1, 1), letterClass(2, 3)]).toEqual([2, 3, 1]);
  });

  it('distance-transforms only the ink box plus a margin', () => {
    const alpha = new Uint8Array(20 * 10);
    alpha[5 * 20 + 10] = 255;
    const field = classField(alpha, 20, 10, [10, 5, 10, 5], 3);
    expect([field.x, field.y, field.width, field.height]).toEqual([7, 2, 7, 7]);
    expect(field.data[3 * 7 + 3]).toBeLessThan(0); // the inked pixel
    expect(field.data[0]).toBeCloseTo(Math.hypot(3, 3), 0);
  });

  it('unions class fields onto the full grid, far away where no class reaches', () => {
    const a = { data: new Float32Array([1, -2]), x: 0, y: 0, width: 2, height: 1 };
    const b = { data: new Float32Array([-1, 3]), x: 1, y: 0, width: 2, height: 1 };
    const u = unionField([a, null, b], 4, 2);
    expect(Array.from(u.slice(0, 4))).toEqual([1, -2, 3, FAR_PX]);
    expect(u[4]).toBe(FAR_PX);
  });
});

describe('buildFieldData', () => {
  it('writes one letter class per channel in em, and the silhouette apart', () => {
    const cls = (v, x) => ({ data: new Float32Array(4 * 4).fill(v), x, y: 0, width: 4, height: 4 });
    const sil = { data: new Float32Array(4 * 4).fill(0.75), width: 4, height: 4 };
    const { glyphs, body } = buildFieldData({ glyphSdf: [cls(48, 0), null, cls(24, 4), null], sil, width: 8, height: 4, pxPerEm: 96 }, 0.5);
    expect(glyphs).toHaveLength(8 * 4 * 4);
    expect(glyphs[0]).toBeCloseTo(0.5, 4);
    expect(glyphs[1]).toBe(FIELD_LIMIT_EM); // empty class
    expect(glyphs[2]).toBe(FIELD_LIMIT_EM); // outside class 2's box
    expect(glyphs[4 * 4 + 2]).toBeCloseTo(0.25, 4);
    expect(body).toHaveLength(16);
    expect(body[5]).toBeCloseTo(0.75, 4);
  });
});

describe('colour helpers', () => {
  it('parses hex colours', () => {
    expect(hexToRgb01('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(hexToRgb01('nope')).toEqual([0, 0, 0]);
  });

  it('converts HSL to hex', () => {
    expect(hslToHex(0, 100, 50)).toBe('#ff0000');
    expect(hslToHex(120, 100, 50)).toBe('#00ff00');
    expect(hslToHex(240, 100, 50)).toBe('#0000ff');
  });

  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it('shuffles legible palettes', () => {
    const rand = seededRandom(7);
    for (let i = 0; i < 25; i++) {
      const p = randomPalette(rand);
      [p.fill, p.sil, p.line, p.bg].forEach((c) => expect(c).toMatch(/^#[0-9a-f]{6}$/));
      expect(contrastRatio(p.fill, p.sil)).toBeGreaterThanOrEqual(2.5);
    }
  });
});

describe('sanitizeParams', () => {
  it('fills defaults', () => {
    expect(sanitizeParams()).toEqual({ ...DEFAULTS });
  });

  it('clamps numbers and rejects invalid enums and colours', () => {
    const p = sanitizeParams({
      fontSize: 9999,
      intensity: -3,
      speed: Number.NaN,
      stretch: 7,
      sil: 'red',
      fill: '#ABCDEF',
      fontId: 'comic-sans',
      align: 'diagonal',
      design: 'poster',
      bandTheme: 'nope',
      boil: 1,
      sticker: 0,
    });
    expect(p.fontSize).toBe(280);
    expect(p.intensity).toBe(0);
    expect(p.speed).toBe(DEFAULTS.speed);
    expect(p.stretch).toBe(1);
    expect(p.sil).toBe(DEFAULTS.sil);
    expect(p.fill).toBe('#abcdef');
    expect(p.fontId).toBe(DEFAULTS.fontId);
    expect(p.align).toBe(DEFAULTS.align);
    expect(p.design).toBe(DEFAULTS.design);
    expect(p.bandTheme).toBe(DEFAULTS.bandTheme);
    expect(p.boil).toBe(true);
    expect(p.sticker).toBe(false);
  });

  it('accepts uploaded font ids and the marquee design', () => {
    const p = sanitizeParams({ fontId: 'upload-3', design: 'bands', bandTheme: BAND_THEMES[1].id });
    expect(p.fontId).toBe('upload-3');
    expect(p.design).toBe('bands');
    expect(p.bandTheme).toBe(BAND_THEMES[1].id);
  });

  it('does not mutate its input', () => {
    const input = Object.freeze({ fontSize: 9999 });
    expect(() => sanitizeParams(input)).not.toThrow();
    expect(input.fontSize).toBe(9999);
  });
});

describe('view math', () => {
  const free = { x: 100, y: 50, width: 500, height: 300 };

  it('fits large stickers into the free area and centres them', () => {
    const view = computeView(free, { x: -5, y: -2.5, width: 10, height: 5 }, 100, 24);
    expect(view.pxPerEm).toBeCloseTo(Math.min(452 / 1000, 252 / 500) * 100, 6);
    expect(view.center).toEqual([350, 200]);
    expect(view.centerEm).toEqual([0, 0]);
  });

  it('never upscales past the requested font size', () => {
    expect(computeView(free, { x: 0, y: 0, width: 1, height: 1 }, 80).pxPerEm).toBe(80);
  });

  it('converts between em and CSS pixels symmetrically', () => {
    const view = computeView(free, { x: 1, y: 2, width: 3, height: 1 }, 60);
    const em = [1.7, 2.2];
    const back = cssToEm(view, emToCss(view, em));
    expect(back[0]).toBeCloseTo(em[0], 9);
    expect(back[1]).toBeCloseTo(em[1], 9);
  });

  it('carves the free area around a right-docked or bottom sheet panel', () => {
    const stage = { width: 1200, height: 800 };
    const bare = computeFreeArea(stage, null);
    expect(bare.width).toBe(1200);
    expect(bare.y).toBeGreaterThan(0);
    const right = computeFreeArea(stage, { x: 850, y: 16, width: 340, height: 768 });
    expect(right.width).toBeLessThan(850);
    const sheet = computeFreeArea({ width: 400, height: 800 }, { x: 8, y: 400, width: 384, height: 392 });
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(400);
  });

  it('grows the sticker bounds with silhouette, stroke and warp', () => {
    const ink = { x: 0, y: 0, width: 4, height: 2 };
    const small = stickerBounds(ink, sanitizeParams({ pad: 0.1, stroke: 0, intensity: 0 }));
    const big = stickerBounds(ink, sanitizeParams({ pad: 0.4, stroke: 0.2, intensity: 1 }));
    expect(small.x).toBeLessThan(0);
    expect(big.width).toBeGreaterThan(small.width);
  });
});

describe('noise1', () => {
  it('is deterministic, bounded and continuous', () => {
    const xs = Array.from({ length: 400 }, (_, i) => i * 0.137 - 20);
    xs.forEach((x) => {
      const v = noise1(x);
      expect(v).toBe(noise1(x));
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
      expect(Math.abs(noise1(x + 1e-4) - v)).toBeLessThan(1e-3);
    });
  });
});

describe('stretchScales', () => {
  const widths = [0.8, 0.3, 0.9, 0.7, 0.28, 0.75, 0.8];

  it('is a no-op when stretching is off or there is a single glyph', () => {
    expect(stretchScales(widths, 3, 0, 1)).toEqual(widths.map(() => 1));
    expect(stretchScales([0.8], 3, 1, 1)).toEqual([1]);
  });

  it('keeps the row width while some glyphs extend and others condense', () => {
    const total = widths.reduce((a, b) => a + b, 0);
    let sawExtended = false;
    for (let t = 0; t < 60; t += 0.7) {
      const scales = stretchScales(widths, t, 1, 2);
      const stretched = widths.reduce((a, w, k) => a + w * scales[k], 0);
      expect(stretched).toBeCloseTo(total, 9);
      scales.forEach((s) => expect(s).toBeGreaterThan(0));
      if (Math.max(...scales) > 1.5) sawExtended = true;
    }
    expect(sawExtended).toBe(true);
  });

  it('never extends fixed glyphs such as spaces', () => {
    for (let t = 0; t < 30; t += 0.9) {
      const scales = stretchScales(widths, t, 1, 5, [false, false, false, false, true, false, false]);
      expect(scales[4]).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe('stretch break points', () => {
  const row = { x: 1, stops: [0, 0.5, 1.2, 2] };

  it('keeps both ends of the row fixed', () => {
    const { F, D } = stretchBreaks(row, [2, 0.5, 0.8125]);
    expect(F).toEqual([1, 1.5, 2.2, 3]);
    expect(D[0]).toBe(1);
    expect(D[3]).toBeCloseTo(3, 9);
    expect(D[1]).toBeCloseTo(2, 9);
  });

  it('maps field and display positions back and forth', () => {
    const { F, D } = stretchBreaks(row, [2, 0.5, 0.8125]);
    for (const x of [-1, 1, 1.2, 1.5, 1.9, 2.5, 3, 4]) {
      expect(mapBreaks(D, F, mapBreaks(F, D, x))).toBeCloseTo(x, 9);
    }
    expect(mapBreaks(F, D, 0.25)).toBe(0.25);
    expect(mapBreaks(F, D, 5)).toBeCloseTo(5, 9);
    expect(mapBreaks([0], [0], 3)).toBe(3);
  });

  it('fills texture rows with display-to-field offsets and the letter under each texel', () => {
    const breaks = stretchBreaks(row, [2, 0.5, 0.8125]); // display edges D = [1, 2, 2.35, 3]
    const texels = 60;
    const dx = 0.05;
    const out = new Float32Array(texels * 2);
    fillStretchRow(out, 0, texels, 0, dx, breaks);
    const letterAt = (x) => out[2 * Math.floor(x / dx) + 1];
    for (let i = 0; i < texels; i++) {
      const x = (i + 0.5) * dx;
      expect(x + out[2 * i]).toBeCloseTo(mapBreaks(breaks.D, breaks.F, x), 5);
    }
    expect([letterAt(0.2), letterAt(1.5), letterAt(2.17), letterAt(2.7), letterAt(2.99)]).toEqual([0, 0, 1, 2, 2]);
    const identity = new Float32Array(20);
    fillStretchRow(identity, 0, 10, 0, 0.4, stretchBreaks(row, [1, 1, 1]));
    identity.filter((_, i) => i % 2 === 0).forEach((v) => expect(v).toBeCloseTo(0, 6));
  });

  it('writes a letter table: display edge, field edge, lean and a letter/space/end flag', () => {
    const breaks = stretchBreaks(row, [2, 0.5, 0.8125]);
    const width = 6;
    const out = new Float32Array(width * 4 * 2).fill(-1);
    fillGlyphRow(out, width, width, breaks, [0.3, 0, 0.1], [false, true, false]);
    const texel = (j) => Array.from(out.slice(4 * (width + j), 4 * (width + j) + 4));
    expect(texel(0)).toEqual([1, 1, expect.closeTo(0.3, 6), 1]);
    expect(texel(1)[0]).toBeCloseTo(2, 6);
    expect(texel(1)[1]).toBeCloseTo(1.5, 6);
    expect(texel(1)[3]).toBe(0.5); // a space: a real cell, but no ink and no melt
    expect(texel(2)[2]).toBeCloseTo(0.1, 6);
    // After the last letter: its closing edges, then padding copies — never valid letters.
    expect(texel(3)).toEqual([expect.closeTo(3, 6), expect.closeTo(3, 6), 0, 0]);
    expect(texel(5)).toEqual(texel(3));
    expect(out.slice(0, 4 * width).every((v) => v === -1)).toBe(true); // other rows untouched
  });
});

describe('textureUniforms', () => {
  it('sizes grain, halftone dots and dither pixels in CSS pixels, converted to em', () => {
    const p = sanitizeParams({ grain: 0.4, halftone: 0.5, dotSize: 10, dither: 1, ditherLevels: 4, ditherPixel: 3 });
    const u = textureUniforms(p, 100, 0);
    expect(u.grain).toBe(0.4);
    expect(u.grainEm).toBeCloseTo(GRAIN_PX / 100);
    expect(u.halftone).toBe(0.5);
    expect(u.dotEm).toBeCloseTo(0.1);
    expect(u.dither).toBe(1);
    expect(u.levels).toBe(4);
    expect(u.pixelEm).toBeCloseTo(0.03);
  });

  it('reseeds the grain over time and holds it within a frame', () => {
    const u = (t) => textureUniforms(DEFAULTS, 100, t).fxSeed;
    expect(u(0)).toBe(u(0.01));
    expect(u(0)).not.toBe(u(0.1));
    expect(Number.isInteger(u(12.34))).toBe(true);
    expect(u(1e6)).toBeLessThan(997);
  });

  it('survives a missing view scale', () => {
    const u = textureUniforms(DEFAULTS, 0, 0);
    expect(Number.isFinite(u.grainEm) && u.grainEm > 0).toBe(true);
    expect(Number.isFinite(u.dotEm) && u.dotEm > 0).toBe(true);
  });

  it('clamps texture settings to their ranges', () => {
    const p = sanitizeParams({ grain: 5, halftone: -1, dotSize: 1, dither: 2, ditherLevels: 3.6, ditherPixel: 99 });
    expect(p.grain).toBe(RANGES.grain.max);
    expect(p.halftone).toBe(0);
    expect(p.dotSize).toBe(RANGES.dotSize.min);
    expect(p.dither).toBe(1);
    expect(p.ditherLevels).toBe(4);
    expect(p.ditherPixel).toBe(RANGES.ditherPixel.max);
  });
});

describe('italicSlants', () => {
  const widths = [0.8, 0.3, 0.9, 0.7, 0.28, 0.75];

  it('is upright when italic is off', () => {
    expect(italicSlants(widths, 4, 0, 1)).toEqual(widths.map(() => 0));
  });

  it('leans some glyphs forward, within the limit, never fixed ones', () => {
    let leaned = false;
    for (let t = 0; t < 40; t += 0.8) {
      const s = italicSlants(widths, t, 1, 3, [false, false, false, false, true, false]);
      s.forEach((v) => {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(ITALIC_MAX + 1e-9);
      });
      expect(s[4]).toBe(0);
      if (Math.max(...s) > ITALIC_MAX * 0.6) leaned = true;
    }
    expect(leaned).toBe(true);
  });

  it('picks out single letters rather than slanting the whole word', () => {
    let leaning = 0;
    let samples = 0;
    for (let t = 0; t < 60; t += 0.37) {
      italicSlants(widths, t, 1, 7).forEach((v) => {
        samples += 1;
        if (v > ITALIC_MAX * 0.25) leaning += 1;
      });
    }
    expect(leaning / samples).toBeGreaterThan(0.05);
    expect(leaning / samples).toBeLessThan(0.35);
  });

  it('keeps a letter upright while it is busy stretching', () => {
    const busy = widths.map(() => 1);
    for (let t = 0; t < 20; t += 1.1) {
      italicSlants(widths, t, 1, 3, [], busy).forEach((v) => expect(v).toBe(0));
    }
  });
});

describe('stretchBumps', () => {
  it('gives each glyph a 0..1 extension weight and none to fixed glyphs', () => {
    const widths = [0.8, 0.3, 0.9, 0.7];
    for (let t = 0; t < 20; t += 0.9) {
      const b = stretchBumps(widths, t, 2, [false, true, false, false]);
      expect(b).toHaveLength(4);
      b.forEach((v) => {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      });
      expect(b[1]).toBe(0);
    }
  });
});

describe('marching squares tracing', () => {
  const grid = (w, h, inside) => {
    const v = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[y * w + x] = inside(x, y) ? 255 : 0;
    return v;
  };

  it('traces a filled square as one closed loop around its pixels', () => {
    const loops = traceContours(grid(12, 10, (x, y) => x >= 3 && x <= 7 && y >= 2 && y <= 5), 12, 10);
    expect(loops).toHaveLength(1);
    const xs = loops[0].map((p) => p[0]);
    const ys = loops[0].map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(3, 1);
    expect(Math.max(...xs)).toBeCloseTo(8, 1);
    expect(Math.min(...ys)).toBeCloseTo(2, 1);
    expect(Math.max(...ys)).toBeCloseTo(6, 1);
  });

  it('keeps holes as separate loops and closes shapes touching the border', () => {
    const ring = grid(16, 16, (x, y) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      return d < 6 && d > 3;
    });
    expect(traceContours(ring, 16, 16)).toHaveLength(2);
    expect(traceContours(grid(6, 6, () => true), 6, 6)).toHaveLength(1);
    expect(traceContours(grid(6, 6, () => false), 6, 6)).toHaveLength(0);
  });

  it('simplifies nearly straight runs', () => {
    const line = Array.from({ length: 50 }, (_, i) => [i, i % 2 ? 0.05 : 0]);
    const square = [...line, [49, 20], [0, 20]];
    const simplified = simplifyLoop(square, 0.3);
    expect(simplified.length).toBeLessThan(8);
    expect(simplified.length).toBeGreaterThanOrEqual(3);
  });

  it('writes smooth closed path data', () => {
    const d = loopsToPath([[[0, 0], [10, 0], [10, 10], [0, 10]]]);
    expect(d.startsWith('M')).toBe(true);
    expect(d).toMatch(/Q/);
    expect(d.trim().endsWith('Z')).toBe(true);
    expect(loopsToPath([[[0, 0], [1, 1]]])).toBe('');
  });
});

describe('buildSvg', () => {
  it('stacks named colour layers over an optional background', () => {
    const svg = buildSvg({
      width: 100,
      height: 50,
      background: '#000000',
      layers: [
        { id: 'stroke', color: '#ffc8f8', d: 'M0 0L10 0L10 10Z' },
        { id: 'letters', color: '#ececec', d: '' },
      ],
    });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('viewBox="0 0 100 50"');
    expect(svg).toContain('<rect width="100" height="50" fill="#000000"/>');
    expect(svg).toContain('id="stroke"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).not.toContain('id="letters"');
    expect(buildSvg({ width: 1, height: 1, layers: [] })).not.toContain('<rect');
  });
});

describe('zip writer', () => {
  it('computes standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('stores files in a valid archive', async () => {
    const files = [
      { name: 'frame_0001.png', data: new Uint8Array([1, 2, 3]) },
      { name: 'frame_0002.png', data: new Uint8Array([4, 5]) },
    ];
    const bytes = new Uint8Array(await zipStore(files).arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const eocd = bytes.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2);
    expect(new TextDecoder().decode(bytes.slice(30, 44))).toBe('frame_0001.png');
  });
});

describe('designLayout', () => {
  it('keeps an oval frame visible even before text is entered', () => {
    const L = layoutFor('oval', { scene: { ...scene, empty: true } });
    expect(L.oval).toHaveLength(4);
    expect(L.bounds.width).toBeGreaterThan(L.bounds.height);
    expect(L.warpDomain.size).toEqual([L.bounds.width, L.bounds.height]);
  });

  it('fits short, long, and stacked text inside the oval with room for motion', () => {
    for (const [width, height] of [[2, 0.7], [15, 0.7], [4, 5]]) {
      const box = { x: -width / 2, y: -height / 2, width, height };
      const params = sanitizeParams({ design: 'oval' });
      const { ellipse: [cx, cy, rx, ry], bounds } = ovalGeometry(box, params);
      expect(cx).toBe(0);
      expect(cy).toBe(0);
      expect((width / 2 / rx) ** 2 + (height / 2 / ry) ** 2).toBeLessThan(1);
      expect(rx / ry).toBeCloseTo(params.ovalAspect);
      expect(bounds.width).toBeGreaterThan(2 * rx);
      expect(bounds.height).toBeGreaterThan(2 * ry);
      const padded = ovalGeometry(box, { ...params, ovalPadding: 0.8 });
      expect(padded.bounds.width).toBeGreaterThan(bounds.width);
    }
  });

  it('falls back to a sticker for removed layouts in saved settings', () => {
    for (const design of ['badge', 'ribbon']) expect(sanitizeParams({ design }).design).toBe('sticker');
  });

  const scene = {
    empty: false,
    inkBox: { x: -2, y: -0.7, width: 4, height: 0.7 },
    layout: { rows: [{}, {}], capHeight: 0.7, gap: 0.8 },
  };
  const stage = { width: 1200, height: 800 };
  const free = { x: 0, y: 64, width: 1200, height: 650 };
  const layoutFor = (design, extra = {}) =>
    designLayout({ design, scene, tagBox: null, params: sanitizeParams({ design }), stage, free, ...extra });

  it('picks a shader mode, a view and palettes for every design', () => {
    DESIGNS.forEach((design, i) => {
      const L = layoutFor(design);
      expect(L.mode).toBe(i);
      expect(L.view.pxPerEm).toBeGreaterThan(0);
      ['bg', 'sil', 'fill', 'line', 'tag'].forEach((k) => expect(L.palettes[k]).toHaveLength(9));
      expect(L.rows).toBeGreaterThan(0);
      expect(L.stageRgb).toHaveLength(3);
    });
  });


  it('alternates wallpaper colourways and swaps fill with silhouette', () => {
    const L = layoutFor('wallpaper');
    expect(Array.from(L.palettes.fill.slice(3, 6))).toEqual(Array.from(L.palettes.sil.slice(0, 3)));
  });

  it('needs ink to lay anything out', () => {
    expect(layoutFor('bands', { scene: { empty: true } })).toBeNull();
  });
});

describe('motion helpers', () => {
  it('steps animation time for boil and keeps it smooth otherwise', () => {
    const smooth = motionClock(15, 30, { speed: 2, scroll: 1, boil: false, boilFps: 10 });
    expect(smooth.time).toBeCloseTo(1, 9);
    expect(smooth.scroll).toBeCloseTo(0.5, 9);
    const boil = [0, 1, 2, 3].map((i) => motionClock(i, 30, { speed: 1, scroll: 1, boil: true, boilFps: 10 }).time);
    expect(boil[0]).toBe(boil[1]);
    expect(boil[1]).toBe(boil[2]);
    expect(boil[3]).toBeGreaterThan(boil[2]);
  });

  it('picks the first recordable video type', () => {
    const supported = new Set(['video/webm;codecs=vp8', 'video/webm']);
    expect(pickVideoType((t) => supported.has(t))).toBe('video/webm;codecs=vp8');
    expect(pickVideoType(() => false)).toBeNull();
  });

  it('rounds export sizes to even pixels for video encoders', () => {
    expect(evenSize(101.2)).toBe(102);
    expect(evenSize(100)).toBe(100);
    expect(evenSize(0.4)).toBe(2);
  });
});

describe('sticker reach and band geometry', () => {
  it('shrinks the reach when the sticker body is off', () => {
    const on = stickerReach(sanitizeParams({ sticker: true }));
    const off = stickerReach(sanitizeParams({ sticker: false }));
    expect(off).toBeLessThan(on);
    expect(off).toBeGreaterThan(0);
  });

  it('lays out sticker + tagline slots within a repeating period', () => {
    const params = sanitizeParams({ pad: 0.1, stroke: 0.05, intensity: 0 });
    const ink = { x: -2, y: -0.7, width: 4, height: 0.7 };
    const tag = { x: 0, y: -0.9, width: 1.5, height: 0.8 };
    const reach = stickerReach(params);
    const g = bandGeometry(ink, tag, params);
    expect(g.tagSlotX).toBeCloseTo(4 + 2 * reach + BAND_GAP_EM, 9);
    expect(g.period).toBeCloseTo(g.tagSlotX + 1.5 + BAND_GAP_EM, 9);
    expect(g.bandH).toBeGreaterThanOrEqual(0.8);
    expect(g.slot).toEqual([-2 - reach, -0.35, 0, -0.5]);
    expect(bandGeometry(ink, null, params).period).toBeCloseTo(4 + 2 * reach + BAND_GAP_EM, 9);
  });
});

describe('marquee text helpers', () => {
  it('joins sticker lines into one marquee line', () => {
    expect(bandLine(['SILENT', ' DISCO ', '', 'PARTY'])).toBe('SILENT DISCO PARTY');
    expect(bandLine(['', ' '])).toBe('');
  });

  it('limits the tagline to two short lines', () => {
    expect(sanitizeTagline('a\tb\nc\nd')).toBe('a b\nc');
    expect(sanitizeTagline('x'.repeat(80))).toHaveLength(40);
  });
});

describe('validateFontFile', () => {
  it('accepts common font formats within the size limit', () => {
    expect(validateFontFile({ name: 'Cool.WOFF2', size: 1000 })).toBeNull();
    expect(validateFontFile({ name: 'x.otf', size: 5 })).toBeNull();
  });

  it('rejects other files with a readable reason', () => {
    expect(validateFontFile({ name: 'photo.png', size: 10 })).toMatch(/\.ttf/);
    expect(validateFontFile({ name: 'huge.ttf', size: 50 * 1024 * 1024 })).toMatch(/MB/);
    expect(validateFontFile(null)).toMatch(/file/i);
  });
});

describe('fileNameFor', () => {
  it('slugifies the sticker text', () => {
    expect(fileNameFor(['SILENT', 'DISCO', 'PARTY'])).toBe('sticker-silent-disco-party.png');
    expect(fileNameFor(['', '  '])).toBe('sticker.png');
  });
});
