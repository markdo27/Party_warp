/**
 * RetroStickerWarp — a type-able, animated "retro psychedelic sticker" lockup.
 *
 * Single-file React component · Tailwind CSS · lucide-react · WebGL2.
 *
 * Pipeline
 *  1. Lines are laid out in em units and rasterised as four letter classes (row parity ×
 *     letter parity), so no letter's mask holds its neighbours' ink.
 *  2. Each class becomes a signed distance field (exact EDT with sub-pixel seeding, over
 *     its ink box only), lightly blurred to soften the letters; their union, closed and
 *     heavily blurred, is the blobby silhouette. Only text / typeface / spacing / goo
 *     changes pay for this CPU step. Goo also melts neighbouring letters of a word together
 *     in the shader (a smooth union), so words stick while stretching and leaning.
 *  3. Every frame a tiny pass renders an animated warp field (gradient noise plus a
 *     rolling wave) and the main pass reads the distance fields through it:
 *        glyph  = d < weight + swell
 *        red    = d < pad + wobble
 *        stroke = d < pad + wobble + stroke
 *     so every other control is just a shader uniform.
 *  4. Letters stretch like extended cuts and lean into italics one at a time: per glyph
 *     widths and slants drift with 1D noise (the row width is preserved). A letter table
 *     lets the shader draw each letter through its own mapping; the body only stretches.
 *  5. Variations (marquee bands, badge ring, ribbons, wallpaper) remap the same fields in
 *     the same fragment shader.
 *  6. Print textures — halftone dot screen, ordered dither, film grain — run last, sized
 *     in screen pixels. SVG export reads raw coverage, so vectors stay clean.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Blend,
  Check,
  ChevronDown,
  Copy,
  Dices,
  Download,
  CircleDot,
  Eraser,
  FileCode2,
  FileImage,
  FileUp,
  Film,
  Images,
  LayoutGrid,
  LayoutTemplate,
  LoaderCircle,
  Info,
  Keyboard,
  Palette,
  Pause,
  Play,
  RotateCcw,
  Rows3,
  SlidersHorizontal,
  Spline,
  Sticker,
  TextCursorInput,
  TriangleAlert,
  Type,
  Video,
  Waves,
  X,
} from 'lucide-react';

const DESIGN_ICONS = { sticker: Sticker, bands: Rows3, badge: CircleDot, ribbon: Spline, wallpaper: LayoutGrid };

/* ── Config ───────────────────────────────────────────────────────────────── */

export const MAX_LINES = 6;
export const MAX_CHARS = 120;
const LIMIT_MESSAGE = `Stickers top out at ${MAX_LINES} lines and ${MAX_CHARS} characters.`;
export const DEFAULT_TEXT = 'UNIDENTIFIED\nDANCING\nOBJECTS';

const SDF_PX_PER_EM = 64; // distance-field grid resolution
const MAX_FIELD_PIXELS = 450_000; // caps the CPU work for very long text
const FIELD_PAD_EM = 1.1; // blank margin around the ink inside the field
const SIL_CLOSE_EM = 0.28; // silhouette closing radius: bridges word spaces and line gaps
const WARP_TEXELS_PER_EM = 24; // resolution of the animated warp texture
const EXPORT_PX_PER_EM = 240;
const EXPORT_MAX_SIDE = 4096;
const FONT_TIMEOUT_MS = 3500;
const TOAST_MS = 2600;
const ZIGZAG = [-1, 1, 0];
const ZIGZAG_CAPS = 0.95; // zigzag shift, in cap heights
const HEADER_SPACE = 64;
const TOOLBAR_SPACE = 84;
const FIT_MARGIN = 40;
const PANEL_AUTO_OPEN_WIDTH = 1024;
const ACCENT = '#ffc8f8';
const UI_FONT = '"Space Grotesk", ui-sans-serif, system-ui, sans-serif';
const FALLBACK_FONTS = '"Arial Black", Impact, "Helvetica Neue", sans-serif';
const FONT_LINK_ID = 'rsw-google-fonts';
const FONT_CSS_HREF =
  'https://fonts.googleapis.com/css2?family=Archivo+Black&family=Archivo:wght@600' +
  '&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap';

/** The built-in sticker face. Uploaded fonts join it at runtime as `upload-<n>`. */
export const DEFAULT_FONT = Object.freeze({ id: 'archivo', label: 'Archivo Black', family: 'Archivo Black' });
const FONT_ID_RE = /^(archivo|upload-\d+)$/;
const FONT_EXTENSIONS = ['ttf', 'otf', 'woff', 'woff2'];
const MAX_FONT_BYTES = 10 * 1024 * 1024;

// Horizontal stretch ("extended cut") animation.
const STRETCH_RATE = 0.3; // noise cycles per second of animation time
const STRETCH_MAX = 2.6; // extra width a fully extended glyph gains, × stretch amount
const STRETCH_TEXELS_PER_EM = 32;
export const ITALIC_MAX = 0.42; // tan of the steepest random lean (~23°)
const ITALIC_RATE = 0.25;
const ITALIC_RAMP_EM = 0.05; // half-width of the blend between a leaning letter and its neighbour

// Marquee variation.
export const BAND_GAP_EM = 0.5; // space between a sticker and its tagline
const BAND_PAD_EM = 0.1; // band padding above and below the tallest slot
const BAND_SCALE = 0.5; // band em size relative to the Size slider
const MARQUEE_EM_PER_S = 0.9; // scroll speed at Scroll = 1×
const MAX_BAND_ROWS = 32;
const TAG_SCALE = 0.5; // tagline font size in sticker ems
const TAG_PX_PER_EM = 128; // tagline distance-field resolution (per sticker em)
const TAG_MAX_LINES = 2;
const TAG_MAX_CHARS = 40;
export const DEFAULT_TAGLINE = '29 — 31\naugust 2026';

// Badge / wallpaper variations.
const BADGE_GAP_EM = 0.34; // word space between ring repeats (their bodies still merge)
const BADGE_INNER_GAP_EM = 0.3; // clearance between the ring and the centre tagline
const TILE_GAP_EM = 0.08;
const TILE_ANGLE = -0.21; // wallpaper tilt (rad, ≈ -12°)
const TAG_FONT = '600 {px}px "Archivo", "Helvetica Neue", Arial, sans-serif';

export const PALETTES = [
  { id: 'disco', name: 'Disco', fill: '#ececec', sil: '#ff0000', line: '#ffc8f8', bg: '#000000' },
  { id: 'acid', name: 'Acid', fill: '#111111', sil: '#c6ff00', line: '#ff4fd8', bg: '#000000' },
  { id: 'sunset', name: 'Sunset', fill: '#fff3dc', sil: '#ff5a1f', line: '#ffd23f', bg: '#0d0008' },
  { id: 'bubblegum', name: 'Bubblegum', fill: '#ffffff', sil: '#ff3ea5', line: '#b9f3ff', bg: '#000000' },
  { id: 'cosmic', name: 'Cosmic', fill: '#fff6b8', sil: '#6b2bff', line: '#72ffc9', bg: '#05010d' },
  { id: 'cream', name: 'Cream', fill: '#f4eee0', sil: '#141414', line: '#ff3b30', bg: '#f4eee0' },
];

/** Marquee colour cycles; `sil` = band colour hides the body so only the outline shows. */
export const BAND_THEMES = [
  {
    id: 'summer',
    name: 'Summer',
    bands: [
      { bg: '#c8f500', sil: '#c8f500', fill: '#ff1a12', line: '#ff1a12', tag: '#ff1a12' },
      { bg: '#ff1a12', sil: '#ff1a12', fill: '#ececec', line: '#ffc4f0', tag: '#ffd6f4' },
      { bg: '#7e6e57', sil: '#7e6e57', fill: '#c8f500', line: '#a8e4ff', tag: '#a8e4ff' },
    ],
  },
  {
    id: 'disco',
    name: 'Disco',
    bands: [
      { bg: '#000000', sil: '#ff0000', fill: '#ececec', line: '#ffc8f8', tag: '#ffc8f8' },
      { bg: '#ff0000', sil: '#ff0000', fill: '#ececec', line: '#000000', tag: '#ffffff' },
      { bg: '#ffc8f8', sil: '#ffc8f8', fill: '#ff0000', line: '#ff0000', tag: '#ff0000' },
    ],
  },
  {
    id: 'pool',
    name: 'Pool',
    bands: [
      { bg: '#1f3cff', sil: '#1f3cff', fill: '#fff04d', line: '#fff04d', tag: '#fff04d' },
      { bg: '#ff7ac8', sil: '#ff7ac8', fill: '#1f3cff', line: '#ffffff', tag: '#1f3cff' },
      { bg: '#f4efe4', sil: '#f4efe4', fill: '#ff4a1c', line: '#1f3cff', tag: '#1f3cff' },
    ],
  },
];

/** Each design's recommended look, applied when switching (then freely tweakable). */
export const DESIGN_LOOKS = Object.freeze({
  sticker: { pad: 0.18, stroke: 0.12, stretch: 0.35, italic: 0.3, intensity: 0.5, tracking: -0.01 },
  bands: { pad: 0.13, stroke: 0.065, stretch: 0.8, italic: 0.3, intensity: 0.4, tracking: -0.02 },
  badge: { pad: 0.15, stroke: 0.09, stretch: 0.4, italic: 0.25, intensity: 0.35, tracking: -0.02 },
  ribbon: { pad: 0.13, stroke: 0.065, stretch: 0.7, italic: 0.35, intensity: 0.35, tracking: -0.02 },
  wallpaper: { pad: 0.16, stroke: 0.1, stretch: 0.35, italic: 0.25, intensity: 0.45, tracking: -0.01 },
});

/** The variations. `line` designs set the lockup on one line; the others keep its rows. */
export const DESIGN_INFO = Object.freeze({
  sticker: { name: 'Sticker', blurb: 'One warped sticker lockup you can type on directly.', line: false },
  bands: { name: 'Marquee', blurb: 'Scrolling colour bands repeat the text with a tagline.', line: true },
  badge: { name: 'Badge', blurb: 'The text orbits a round sticker with the tagline inside.', line: true },
  ribbon: { name: 'Ribbon', blurb: 'Two wavy tapes cross the stage and scroll past each other.', line: true },
  wallpaper: { name: 'Wallpaper', blurb: 'A tilted sticker-bomb tiling with alternating colourways.', line: false },
});
export const DESIGNS = Object.keys(DESIGN_INFO);
const MODE_INDEX = Object.freeze({ sticker: 0, bands: 1, badge: 2, ribbon: 3, wallpaper: 4 });

const ALIGNS = ['zigzag', 'left', 'center', 'right'];
const EXPORT_SCOPES = ['whole', 'line'];
const MOTION_SECONDS = [2, 4, 8];
const MOTION_FPS = [30, 60];

export const DEFAULTS = Object.freeze({
  design: 'sticker',
  fontId: 'archivo',
  caps: true,
  align: 'zigzag',
  fontSize: 150,
  lineSpacing: 1.16,
  tracking: -0.01,
  weight: 0.012,
  speed: 1,
  intensity: 0.5,
  frequency: 1,
  swell: 0.5,
  stretch: 0.35,
  italic: 0.3,
  boil: false,
  boilFps: 10,
  sticker: true,
  pad: 0.18,
  stroke: 0.12,
  goo: 0.35,
  grain: 0.22,
  halftone: 0,
  dotSize: 9,
  dither: 0,
  ditherLevels: 3,
  ditherPixel: 2,
  fill: '#ececec',
  sil: '#ff0000',
  line: '#ffc8f8',
  bg: '#000000',
  bandTheme: 'summer',
  scroll: 1,
  transparent: false,
  exportScope: 'whole',
  exportLine: 0,
  exportRepeats: 2,
  motionSeconds: 4,
  motionFps: 30,
});

export const RANGES = Object.freeze({
  fontSize: { min: 48, max: 280, step: 1 },
  lineSpacing: { min: 0.6, max: 1.8, step: 0.01 },
  tracking: { min: -0.15, max: 0.35, step: 0.005 },
  weight: { min: -0.04, max: 0.08, step: 0.002 },
  speed: { min: 0, max: 3, step: 0.05 },
  intensity: { min: 0, max: 1, step: 0.01 },
  frequency: { min: 0.2, max: 3, step: 0.05 },
  swell: { min: 0, max: 1, step: 0.01 },
  stretch: { min: 0, max: 1, step: 0.01 },
  italic: { min: 0, max: 1, step: 0.01 },
  scroll: { min: 0, max: 3, step: 0.05 },
  exportLine: { min: 0, max: 2, step: 1 },
  exportRepeats: { min: 1, max: 6, step: 1 },
  boilFps: { min: 4, max: 15, step: 1 },
  pad: { min: 0.04, max: 0.45, step: 0.005 },
  stroke: { min: 0, max: 0.25, step: 0.005 },
  goo: { min: 0, max: 1, step: 0.01 },
  grain: { min: 0, max: 1, step: 0.01 },
  halftone: { min: 0, max: 1, step: 0.01 },
  dotSize: { min: 3, max: 32, step: 1 },
  dither: { min: 0, max: 1, step: 0.01 },
  ditherLevels: { min: 2, max: 8, step: 1 },
  ditherPixel: { min: 1, max: 8, step: 1 },
});

/* ── Validation & text helpers (pure) ─────────────────────────────────────── */

const HEX_RE = /^#[0-9a-f]{6}$/i;
const COLOR_KEYS = ['fill', 'sil', 'line', 'bg'];
const BOOL_KEYS = ['caps', 'boil', 'sticker', 'transparent'];
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Returns a complete, valid settings object; never mutates `input`. */
export function sanitizeParams(input = {}) {
  const merged = { ...DEFAULTS, ...input };
  const numbers = Object.fromEntries(
    Object.entries(RANGES).map(([key, { min, max, step }]) => {
      const n = Number(merged[key]);
      if (!Number.isFinite(n)) return [key, DEFAULTS[key]];
      return [key, clamp(step === 1 ? Math.round(n) : n, min, max)];
    }),
  );
  const oneOf = (key, options) => (options.includes(merged[key]) ? merged[key] : DEFAULTS[key]);
  const colors = Object.fromEntries(
    COLOR_KEYS.map((key) => [key, HEX_RE.test(merged[key]) ? merged[key].toLowerCase() : DEFAULTS[key]]),
  );
  const flags = Object.fromEntries(BOOL_KEYS.map((key) => [key, Boolean(merged[key])]));
  return {
    ...DEFAULTS,
    ...numbers,
    ...colors,
    ...flags,
    fontId: FONT_ID_RE.test(merged.fontId) ? merged.fontId : DEFAULTS.fontId,
    align: oneOf('align', ALIGNS),
    design: oneOf('design', DESIGNS),
    bandTheme: oneOf('bandTheme', BAND_THEMES.map((t) => t.id)),
    exportScope: oneOf('exportScope', EXPORT_SCOPES),
    motionSeconds: oneOf('motionSeconds', MOTION_SECONDS),
    motionFps: oneOf('motionFps', MOTION_FPS),
  };
}

/** Returns a reason the file can't be used as a font, or null if it looks fine. */
export function validateFontFile(file) {
  if (!file) return 'Choose a font file.';
  const ext = String(file.name ?? '').split('.').pop().toLowerCase();
  if (!FONT_EXTENSIONS.includes(ext)) return 'Use a .ttf, .otf, .woff or .woff2 font file.';
  if (file.size > MAX_FONT_BYTES) return `That font is over ${MAX_FONT_BYTES / 1024 / 1024} MB.`;
  return null;
}

const segmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** User-perceived characters, so emoji sequences are laid out and edited as one glyph. */
export const graphemes = (s) => (segmenter ? Array.from(segmenter.segment(s), (g) => g.segment) : Array.from(s));

/** Plain newlines, tabs as spaces, no other control characters. Doesn't enforce limits. */
export const cleanText = (raw) =>
  String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL_RE, '');

/** Length is counted in UTF-16 units, matching the textarea's native maxLength. */
export const withinLimits = (value) => value.split('\n').length <= MAX_LINES && value.length <= MAX_CHARS;

function limitText(raw, maxLines, maxChars) {
  const text = cleanText(raw).split('\n').slice(0, maxLines).join('\n');
  let out = '';
  for (const g of graphemes(text)) {
    if (out.length + g.length > maxChars) break;
    out += g;
  }
  return out;
}

/** Cleans text from outside the editor (props) and trims it to the limits by whole graphemes. */
export const sanitizeInput = (raw) => limitText(raw, MAX_LINES, MAX_CHARS);

/** The marquee's small print: at most two short lines. */
export const sanitizeTagline = (raw) => limitText(raw, TAG_MAX_LINES, TAG_MAX_CHARS);

/** Marquee stickers are one line: the lockup's lines joined by spaces. */
export const bandLine = (lines) =>
  lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');

const upperKeepLength = (g) => {
  const up = g.toLocaleUpperCase();
  return up.length === g.length ? up : g;
};

/** Lines as drawn. Uppercasing is per grapheme and length-preserving, so carets stay aligned. */
export function displayLines(text, caps) {
  return text.split('\n').map((line) => (caps ? graphemes(line).map(upperKeepLength).join('') : line));
}

export const TIME_FOLD = 4096;

/** Folds the clock into a triangle wave: bounded for shader precision, with no jumps. */
export function foldTime(t) {
  const m = t % (2 * TIME_FOLD);
  return m <= TIME_FOLD ? m : 2 * TIME_FOLD - m;
}

export function fileNameFor(lines) {
  const slug = lines
    .join(' ')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug ? `sticker-${slug}.png` : 'sticker.png';
}

/* ── Colour helpers (pure) ─────────────────────────────────────────────────── */

export function hexToRgb01(hex) {
  if (!HEX_RE.test(hex ?? '')) return [0, 0, 0];
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function hslToHex(h, s, l) {
  const sat = clamp(s, 0, 100) / 100;
  const lig = clamp(l, 0, 100) / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const channel = (n) => {
    const k = (n + h / 30) % 12;
    const v = lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(clamp(v, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

const relativeLuminance = (hex) => {
  const [r, g, b] = hexToRgb01(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A saturated silhouette, a light complementary stroke and a legible fill. */
export function randomPalette(rand = Math.random) {
  const hue = Math.floor(rand() * 360);
  const sil = hslToHex(hue, 90 + rand() * 10, 47 + rand() * 8);
  const line = hslToHex((hue + 140 + rand() * 80) % 360, 85 + rand() * 15, 78 + rand() * 8);
  const fill = contrastRatio('#f4f4f4', sil) >= 3 ? '#f4f4f4' : '#101010';
  return { fill, sil, line, bg: '#000000' };
}

/* ── Layout & caret geometry (pure, em units) ─────────────────────────────── */

export function alignOffset(align, width, maxWidth, index, count, capHeight) {
  if (align === 'left') return 0;
  if (align === 'right') return maxWidth - width;
  const centered = (maxWidth - width) / 2;
  if (align !== 'zigzag' || count < 2) return centered;
  return centered + ZIGZAG[index % ZIGZAG.length] * capHeight * ZIGZAG_CAPS;
}

/**
 * Lays out lines in em units. `measure(str)` returns the kerned advance of `str` in em.
 * Each row gets `carets` (left edge of every glyph) and `stops` (caret positions,
 * halfway into the tracking gap between glyphs).
 */
export function layoutLines(lines, { measure, capHeight, lineSpacing, tracking, align }) {
  const gap = capHeight * lineSpacing;
  const measured = lines.map((text) => {
    const chars = graphemes(text);
    const n = chars.length;
    const carets = chars.map((_, k) => (k === 0 ? 0 : measure(chars.slice(0, k).join('')) + tracking * k));
    const width = n > 0 ? measure(text) + tracking * (n - 1) : 0;
    const stops = n === 0 ? [0] : [0, ...carets.slice(1).map((x) => x - tracking / 2), width];
    return { text, chars, carets, stops, width };
  });
  const maxWidth = measured.reduce((m, row) => Math.max(m, row.width), 0);
  const rows = measured.map((row, i) => ({
    ...row,
    x: alignOffset(align, row.width, maxWidth, i, lines.length, capHeight),
    baseline: i * gap,
  }));
  return { rows, capHeight, gap };
}

/** String index (UTF-16) → { row, col } with `col` counted in graphemes. */
export function caretToRowCol(value, index) {
  const before = value.slice(0, index);
  const row = before.split('\n').length - 1;
  const col = graphemes(before.slice(before.lastIndexOf('\n') + 1)).length;
  return { row, col };
}

export function rowColToCaret(value, row, col) {
  const lines = value.split('\n');
  if (row >= lines.length) return value.length;
  const start = lines.slice(0, row).reduce((acc, line) => acc + line.length + 1, 0);
  return start + graphemes(lines[row]).slice(0, Math.max(0, col)).join('').length;
}

export function hitTestLayout(layout, [x, y]) {
  const { rows, capHeight } = layout;
  if (rows.length === 0) return { row: 0, col: 0 };
  const nearest = (items, distance) =>
    items.reduce((best, item, i) => {
      const d = distance(item);
      return d < best.d ? { i, d } : best;
    }, { i: 0, d: Infinity }).i;
  const row = nearest(rows, (r) => Math.abs(y - (r.baseline - capHeight / 2)));
  const r = rows[row];
  const col = nearest(r.stops, (s) => Math.abs(x - (r.x + s)));
  return { row, col };
}

export function caretGeometry(layout, row, col) {
  const r = layout.rows[Math.min(row, layout.rows.length - 1)];
  if (!r) return null;
  const k = clamp(col, 0, r.stops.length - 1);
  return { x: r.x + r.stops[k], top: r.baseline - layout.capHeight * 1.08, bottom: r.baseline + layout.capHeight * 0.08 };
}

const MIN_SELECTION_EM = 0.12; // so selected empty lines still show a sliver

/** Highlight boxes (em) covering the selected graphemes, one per row. */
export function selectionRects(layout, value, start, end) {
  if (start === end) return [];
  const a = caretToRowCol(value, Math.min(start, end));
  const b = caretToRowCol(value, Math.max(start, end));
  return layout.rows.slice(a.row, b.row + 1).map((r, i) => {
    const row = a.row + i;
    const last = r.stops.length - 1;
    const x0 = r.x + r.stops[clamp(row === a.row ? a.col : 0, 0, last)];
    const x1 = r.x + r.stops[clamp(row === b.row ? b.col : last, 0, last)];
    return {
      x: x0,
      width: Math.max(x1 - x0, MIN_SELECTION_EM),
      top: r.baseline - layout.capHeight * 1.08,
      bottom: r.baseline + layout.capHeight * 0.08,
    };
  });
}

/* ── Stretch: glyphs extending like wide cuts (pure) ──────────────────────── */

const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

const hash1 = (n) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
};

/** Smooth 1D value noise in [-1, 1]. */
export function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

/**
 * Per-glyph horizontal scales for one row at `time`: a few glyphs balloon out like an
 * extended cut while the rest condense, so the row keeps its overall width. `fixed`
 * marks glyphs (spaces) that never extend on their own.
 */
export function stretchScales(widths, time, amount, seed, fixed = []) {
  if (!(amount > 0) || widths.length < 2) return widths.map(() => 1);
  const raw = stretchBumps(widths, time, seed, fixed).map((b) => 1 + amount * STRETCH_MAX * b);
  const total = widths.reduce((sum, w) => sum + w, 0);
  const grown = widths.reduce((sum, w, k) => sum + w * raw[k], 0);
  return raw.map((r) => (r * total) / grown);
}

/** How far each glyph is into an "extend" at `time`: 0 at rest, 1 fully extended. */
export function stretchBumps(widths, time, seed, fixed = []) {
  return widths.map((_, k) => (fixed[k] ? 0 : smoothstep(0.05, 0.75, noise1(time * STRETCH_RATE + seed * 17.31 + k * 4.37))));
}

/** Matching break points: field-space glyph edges `F` and where they land once stretched `D`. */
export function stretchBreaks(row, scales) {
  const F = row.stops.map((s) => row.x + s);
  const D = [F[0]];
  for (let k = 0; k < F.length - 1; k++) D.push(D[k] + (F[k + 1] - F[k]) * scales[k]);
  return { F, D };
}

/** Piecewise-linear map between matching break points; a plain offset outside them. */
export function mapBreaks(from, to, x) {
  const n = from.length - 1;
  if (n < 1 || x <= from[0]) return x - from[0] + to[0];
  if (x >= from[n]) return x - from[n] + to[n];
  let k = 0;
  while (k < n - 1 && x >= from[k + 1]) k++;
  const span = from[k + 1] - from[k];
  return span > 1e-9 ? to[k] + ((x - from[k]) * (to[k + 1] - to[k])) / span : to[k];
}

/**
 * Per-glyph forward lean (tan of the angle). Only the odd letter tips over at any moment,
 * and `busy[k]` (a glyph's stretch weight) keeps extending letters upright, so the row
 * reads as "one letter stretches, another leans" rather than a slanted word.
 */
export function italicSlants(widths, time, amount, seed, fixed = [], busy = null) {
  if (!(amount > 0)) return widths.map(() => 0);
  return widths.map((_, k) => {
    if (fixed[k]) return 0;
    const lean = smoothstep(0.3, 0.75, noise1(time * ITALIC_RATE + seed * 9.73 + k * 2.91 + 50));
    return amount * ITALIC_MAX * lean * (busy ? 1 - busy[k] : 1);
  });
}

// Glyph slant at display x: constant across each letter, blended only across a short
// ramp centred on the gap between letters, so a lean never bleeds into the neighbour.
function slantAt(x, D, slants) {
  const n = slants.length;
  if (n === 0) return 0;
  let k = 0;
  while (k < n - 1 && x >= D[k + 1]) k++;
  const ramp = (j) => Math.min(ITALIC_RAMP_EM, (D[j + 1] - D[j - 1]) / 4);
  if (k > 0 && x - D[k] < ramp(k)) {
    return slants[k - 1] + (slants[k] - slants[k - 1]) * smoothstep(D[k] - ramp(k), D[k] + ramp(k), x);
  }
  if (k < n - 1 && D[k + 1] - x < ramp(k + 1)) {
    return slants[k] + (slants[k + 1] - slants[k]) * smoothstep(D[k + 1] - ramp(k + 1), D[k + 1] + ramp(k + 1), x);
  }
  return slants[k];
}

/**
 * Writes one texture row into `out` (two channels per texel, starting at texel `start`):
 * the display→field x offset (em) the sticker body follows, and the index of the letter
 * under that display x. Texel i samples display x = x0 + (i + 0.5)·dx. Mutates `out`, a
 * buffer reused between frames.
 */
export function fillStretchRow(out, start, texels, x0, dx, { F, D }) {
  const n = D.length - 1;
  let k = 0;
  for (let i = 0; i < texels; i++) {
    const x = x0 + (i + 0.5) * dx;
    while (k < n - 1 && x >= D[k + 1]) k++;
    let fx = x;
    if (n >= 1 && x > D[0] && x < D[n]) {
      const span = D[k + 1] - D[k];
      fx = span > 1e-9 ? F[k] + ((x - D[k]) * (F[k + 1] - F[k])) / span : F[k];
    }
    out[2 * (start + i)] = fx - x;
    out[2 * (start + i) + 1] = k;
  }
}

/**
 * Writes one row of the letter table into `out` (RGBA per texel, `width` texels from texel
 * `start`): each letter's display edge, field edge, lean and a flag — 1 for a letter, 0.5 for
 * a space (`fixed`), which is never drawn or melted across. The shader draws every letter
 * through its own mapping, clipped to its own cell, so a lean never cuts into a neighbour.
 * Texels after the last letter hold its closing edges with a 0 flag.
 */
export function fillGlyphRow(out, start, width, { F, D }, slants = [], fixed = []) {
  const n = D.length - 1;
  for (let j = 0; j < width; j++) {
    const o = 4 * (start + j);
    const real = j < n;
    const e = Math.min(j, Math.max(n, 0));
    out[o] = D[e];
    out[o + 1] = F[e];
    out[o + 2] = real ? (slants[j] ?? 0) : 0;
    out[o + 3] = real ? (fixed[j] ? 0.5 : 1) : 0;
  }
}

/* ── Stage / view math (pure) ─────────────────────────────────────────────── */

/** Shader-facing effect sizes in em, derived from the UI-facing settings. */
/** Goo softness (em): the blur that rounds each letter, and the scale of the melt between them. */
export const glyphSoftnessEm = (goo) => 0.012 + 0.05 * goo;

/**
 * Smooth-union radius (em) between letters of a word: two letters bridge when their gap is
 * under half of it. It eases in, so the default goo already sticks each word together while
 * full goo stays readable. Rows melt gently (GOO_ROW_MELT × softness) so stacked lines stay
 * apart, and spaces never melt.
 */
export const gooMeltEm = (goo) => 0.06 + 0.17 * (1 - (1 - goo) ** 3);
const GOO_ROW_MELT = 2;

export function effectUniforms(p) {
  return {
    freq: 0.55 * p.frequency,
    amp: 0.16 * p.intensity,
    swell: 0.045 * p.swell,
    swellAmt: p.swell,
    wobble: 0.05 * p.intensity,
    weight: p.weight,
    pad: p.pad,
    stroke: p.stroke,
    gooK: gooMeltEm(p.goo),
    gooRowK: GOO_ROW_MELT * glyphSoftnessEm(p.goo),
  };
}

export const GRAIN_PX = 1.3; // grain speck size (CSS px)
const FX_FPS = 24; // the grain re-rolls at film rate (or on boil steps)

/**
 * Print-texture inputs. Cells are sized in on-screen CSS pixels and converted to em, so an
 * export at any scale keeps the texture you see relative to the lettering.
 */
export function textureUniforms(p, pxPerEm, shown = 0) {
  const px = pxPerEm > 0 ? pxPerEm : 1;
  return {
    grain: p.grain,
    grainEm: GRAIN_PX / px,
    fxSeed: Math.floor(Math.max(0, shown) * FX_FPS) % 997,
    halftone: p.halftone,
    dotEm: p.dotSize / px,
    dither: p.dither,
    levels: p.ditherLevels,
    pixelEm: p.ditherPixel / px,
  };
}

const expandBox = (box, m) => ({ x: box.x - m, y: box.y - m, width: box.width + 2 * m, height: box.height + 2 * m });

/** How far past the ink anything is drawn (sticker body, stroke, swell, warp), in em. */
export function stickerReach(params) {
  const u = effectUniforms(params);
  const body = params.sticker ? Math.max(u.pad + u.stroke * 1.4 + u.wobble, u.swell) : u.swell;
  const lean = ITALIC_MAX * (params.italic ?? 0) * 0.4; // a leaning cap overhangs its slot
  return body + u.amp * 1.4 + lean + 0.03;
}

/** The ink box grown by everything drawn around it. Stretching preserves row widths. */
export const stickerBounds = (inkBox, params) => expandBox(inkBox, stickerReach(params));

/**
 * Marquee band layout in em. Each period holds a sticker slot [0, stickerW) and a tagline
 * slot starting at `tagSlotX`. `slot` maps slot coordinates back into the two fields:
 * [sticker field x at slot x = 0, sticker field y at band centre, tagline field x, tagline centre y].
 */
export function bandGeometry(inkBox, tagBox, params) {
  const reach = stickerReach(params);
  const stickerW = inkBox.width + 2 * reach;
  const stickerH = inkBox.height + 2 * reach;
  const tagW = tagBox ? tagBox.width : 0;
  const tagH = tagBox ? tagBox.height : 0;
  return {
    bandH: Math.max(stickerH, tagH) + 2 * BAND_PAD_EM,
    period: stickerW + BAND_GAP_EM + (tagW > 0 ? tagW + BAND_GAP_EM : 0),
    tagSlotX: stickerW + BAND_GAP_EM,
    slot: [
      inkBox.x - reach,
      inkBox.y + inkBox.height / 2,
      tagBox ? tagBox.x : 0,
      tagBox ? tagBox.y + tagBox.height / 2 : 0,
    ],
  };
}

/**
 * Badge ring: whole repeats of the line around a circle that clears the tagline in the
 * middle. `period` is one repeat's length and `ringH` the line's height, both in em.
 */
export function badgeGeometry(period, ringH, tagBox) {
  const tagR = tagBox ? Math.hypot(tagBox.width / 2, tagBox.height / 2) : 0;
  const minRadius = ringH / 2 + tagR + BADGE_INNER_GAP_EM;
  const repeats = Math.max(2, Math.ceil((2 * Math.PI * minRadius) / period));
  const radius = (repeats * period) / (2 * Math.PI);
  return { repeats, radius, outer: radius + ringH / 2 };
}

/**
 * Two wavy tapes crossing the free area (em): centre line y, amplitude, wavenumber,
 * phase and scroll direction. Amplitudes have opposite signs so the tapes cross.
 */
export function ribbonGeometry(stageEm, freeEm, bandH) {
  const cy = freeEm.y + freeEm.height / 2;
  const room = Math.max(0, freeEm.height / 2 - bandH / 2);
  return [
    { cy, amp: room * 0.7, k: (2 * Math.PI) / (stageEm.width * 1.15), phase: 0.4, dir: 1 },
    { cy, amp: -room * 0.55, k: (2 * Math.PI) / (stageEm.width * 0.8), phase: 1.9, dir: -1 },
  ];
}

export const PALETTE_KEYS = ['bg', 'sil', 'fill', 'line', 'tag'];

/** Three colourways flattened into the shader's vec3[3] arrays, one Float32Array per key. */
export const packPalettes = (list) =>
  Object.fromEntries(PALETTE_KEYS.map((key) => [key, Float32Array.from(list.flatMap((pal) => hexToRgb01(pal[key])))]));

/**
 * Everything a design needs to render, in em: shader mode, CSS view, warp domain,
 * palettes, stretch row count and the design's own geometry. Null until there's ink.
 */
export function designLayout({ design, scene, tagBox, params, stage, free }) {
  if (!scene || scene.empty || !stage.width || !stage.height) return null;
  const mode = MODE_INDEX[design] ?? 0;
  const sticker = { bg: params.bg, sil: params.sil, fill: params.fill, line: params.line, tag: params.line };
  const theme = BAND_THEMES.find((t) => t.id === params.bandTheme) ?? BAND_THEMES[0];
  const result = (layout) => ({ ...layout, mode, palettes: packPalettes(layout.colours), stageRgb: hexToRgb01(layout.stage) });

  if (design === 'sticker') {
    const bounds = stickerBounds(scene.inkBox, params);
    return result({ view: computeView(free, bounds, params.fontSize), warpDomain: null, colours: [sticker, sticker, sticker], stage: params.bg, rows: scene.layout.rows.length, bounds });
  }

  if (design === 'badge') {
    // A tight period: neighbouring repeats overlap and the shader unions them into one ring.
    const reach = stickerReach(params);
    const ringH = scene.inkBox.height + 2 * reach;
    const period = scene.inkBox.width + BADGE_GAP_EM;
    const ring = badgeGeometry(period, ringH, tagBox);
    const extent = ring.outer + 0.1;
    const bounds = { x: -extent, y: -extent, width: 2 * extent, height: 2 * extent };
    return result({
      view: computeView(free, bounds, params.fontSize * BAND_SCALE * 1.4),
      warpDomain: { origin: [-extent, -extent], size: [2 * extent, 2 * extent] },
      colours: [sticker, sticker, sticker],
      stage: params.bg,
      rows: ring.repeats,
      focus: [0, 0],
      bounds,
      badge: {
        ...ring,
        period,
        slot: [
          scene.inkBox.x - BADGE_GAP_EM / 2,
          scene.inkBox.y + scene.inkBox.height / 2,
          tagBox ? tagBox.x + tagBox.width / 2 : 0,
          tagBox ? tagBox.y + tagBox.height / 2 : 0,
        ],
      },
    });
  }

  // Whole-stage designs: the world origin sits at the stage's top-left corner.
  const pxPerEm = params.fontSize * BAND_SCALE;
  const stageEm = { width: stage.width / pxPerEm, height: stage.height / pxPerEm };
  const freeEm = { x: free.x / pxPerEm, y: free.y / pxPerEm, width: free.width / pxPerEm, height: free.height / pxPerEm };
  const world = {
    view: { pxPerEm, center: [0, 0], centerEm: [0, 0] },
    warpDomain: { origin: [0, 0], size: [stageEm.width, stageEm.height] },
    stageEm,
  };

  if (design === 'wallpaper') {
    const bounds = stickerBounds(scene.inkBox, params);
    const swapped = { ...sticker, sil: params.fill, fill: params.sil };
    return result({
      ...world,
      colours: [sticker, swapped, sticker],
      stage: params.bg,
      rows: scene.layout.rows.length,
      focus: [stageEm.width / 2, stageEm.height / 2],
      tile: {
        width: bounds.width + TILE_GAP_EM,
        height: bounds.height + TILE_GAP_EM,
        origin: [bounds.x - TILE_GAP_EM / 2, bounds.y - TILE_GAP_EM / 2],
      },
    });
  }

  const band = bandGeometry(scene.inkBox, tagBox, params);
  if (design === 'ribbon') {
    return result({ ...world, band, colours: theme.bands, stage: params.bg, rows: 3, ribbons: ribbonGeometry(stageEm, freeEm, band.bandH) });
  }
  return result({
    ...world,
    band,
    colours: theme.bands,
    stage: theme.bands[0].bg,
    rows: Math.min(MAX_BAND_ROWS, Math.max(3, Math.ceil(stageEm.height / band.bandH) + 1)),
  });
}

/** The part of the stage the sticker may occupy (clear of header, toolbar and panel). */
export function computeFreeArea(stage, panel) {
  const base = {
    x: 0,
    y: HEADER_SPACE,
    width: stage.width,
    height: Math.max(0, stage.height - HEADER_SPACE - TOOLBAR_SPACE),
  };
  if (!panel) return base;
  if (panel.x > stage.width * 0.35) return { ...base, width: Math.max(0, panel.x - 12) };
  return { ...base, height: Math.max(0, panel.y - 12 - HEADER_SPACE) };
}

/** Centres `bounds` (em) in `free` (CSS px) at `fontSize` px/em, shrinking to fit. */
export function computeView(free, bounds, fontSize, margin = FIT_MARGIN) {
  const availW = Math.max(1, free.width - 2 * margin);
  const availH = Math.max(1, free.height - 2 * margin);
  const fit = Math.min(1, availW / (bounds.width * fontSize), availH / (bounds.height * fontSize));
  return {
    pxPerEm: fontSize * fit,
    center: [free.x + free.width / 2, free.y + free.height / 2],
    centerEm: [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2],
  };
}

export const emToCss = (view, [x, y]) => [
  view.center[0] + (x - view.centerEm[0]) * view.pxPerEm,
  view.center[1] + (y - view.centerEm[1]) * view.pxPerEm,
];

export const cssToEm = (view, [x, y]) => [
  (x - view.center[0]) / view.pxPerEm + view.centerEm[0],
  (y - view.center[1]) / view.pxPerEm + view.centerEm[1],
];

/* ── Distance field (pure) ────────────────────────────────────────────────── */

const INF = 1e20;

// 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher), in place.
function edt1d(grid, offset, stride, length, f, v, z) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    let s;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}

function edt2d(grid, width, height, f, v, z) {
  for (let x = 0; x < width; x++) edt1d(grid, x, width, height, f, v, z);
  for (let y = 0; y < height; y++) edt1d(grid, y * width, 1, width, f, v, z);
}

/**
 * Signed distance field (px) from an 8-bit coverage mask: negative inside, positive
 * outside. Partially covered pixels seed sub-pixel distances, so anti-aliased
 * glyph edges come out smooth instead of stair-stepped.
 */
export function signedDistanceField(alpha, width, height) {
  const n = width * height;
  const outer = new Float64Array(n);
  const inner = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = alpha[i] / 255;
    if (a >= 1) {
      inner[i] = INF;
    } else if (a <= 0) {
      outer[i] = INF;
    } else {
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  const size = Math.max(width, height);
  const f = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);
  edt2d(outer, width, height, f, v, z);
  edt2d(inner, width, height, f, v, z);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
  return out;
}

/** Box widths whose repeated application approximates a Gaussian of `sigma` px. */
export function boxSizesForGauss(sigma, passes = 3) {
  if (!(sigma >= 0.5)) return [];
  const ideal = Math.sqrt((12 * sigma * sigma) / passes + 1);
  const lower = Math.floor(ideal) % 2 === 0 ? Math.floor(ideal) - 1 : Math.floor(ideal);
  const upper = lower + 2;
  const m = Math.round(
    (12 * sigma * sigma - passes * lower * lower - 4 * passes * lower - 3 * passes) / (-4 * lower - 4),
  );
  return Array.from({ length: passes }, (_, i) => (i < m ? lower : upper));
}

// Running-sum box blur along rows (horizontal) or columns, clamping at the borders.
function boxBlurLines(src, dst, width, height, r, horizontal) {
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const stride = horizontal ? 1 : width;
  const step = horizontal ? width : 1;
  const inv = 1 / (2 * r + 1);
  const last = length - 1;
  for (let l = 0; l < lines; l++) {
    const base = l * step;
    let acc = r * src[base];
    for (let j = 0; j <= r; j++) acc += src[base + Math.min(j, last) * stride];
    for (let i = 0; i < length; i++) {
      dst[base + i * stride] = acc * inv;
      acc += src[base + Math.min(i + r + 1, last) * stride] - src[base + Math.max(i - r, 0) * stride];
    }
  }
}

/** Separable Gaussian approximation (3 box passes). Returns a new array. */
export function gaussianBlur(field, width, height, sigma) {
  const out = Float32Array.from(field);
  const scratch = new Float32Array(field.length);
  for (const size of boxSizesForGauss(sigma)) {
    const r = (size - 1) >> 1;
    if (r > 0) {
      boxBlurLines(out, scratch, width, height, r, true);
      boxBlurLines(scratch, out, width, height, r, false);
    }
  }
  return out;
}

/**
 * Marks everything not reachable from the border through mostly-uncovered pixels as
 * solid, so enclosed holes (and their anti-aliased rims) disappear. Returns a copy.
 */
export function fillHoles(alpha, width, height) {
  const n = width * height;
  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const visit = (i) => {
    if (!outside[i] && alpha[i] < 128) {
      outside[i] = 1;
      stack[top++] = i;
    }
  };
  for (let x = 0; x < width; x++) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  while (top > 0) {
    const i = stack[--top];
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < n - width) visit(i + width);
  }
  const touchesOutside = (i) => {
    const x = i % width;
    return (x > 0 && outside[i - 1]) || (x < width - 1 && outside[i + 1]) || (i >= width && outside[i - width]) || (i < n - width && outside[i + width]);
  };
  return alpha.map((a, i) => (outside[i] || touchesOutside(i) ? a : 255));
}

/**
 * Silhouette distance field in em, at half resolution. The ink is morphologically
 * closed (dilated then eroded by SIL_CLOSE_EM) and its enclosed holes are filled,
 * so word spaces and line gaps stay red instead of exposing the stroke colour.
 */
export function silhouetteField(sdfPx, width, height, pxPerEm) {
  const hw = Math.ceil(width / 2);
  const hh = Math.ceil(height / 2);
  const halfPxPerEm = pxPerEm / 2;
  const at = (x, y) => sdfPx[Math.min(y, height - 1) * width + Math.min(x, width - 1)];
  const dilated = new Uint8Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const dFull = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) / 4;
      const dHalf = dFull / 2 - SIL_CLOSE_EM * halfPxPerEm;
      dilated[y * hw + x] = Math.round(clamp(0.5 - dHalf, 0, 1) * 255);
    }
  }
  const closedPx = signedDistanceField(fillHoles(dilated, hw, hh), hw, hh);
  return { data: closedPx.map((d) => d / halfPxPerEm + SIL_CLOSE_EM), width: hw, height: hh };
}

/**
 * Letters are split into four classes — row parity × letter parity — each with its own
 * distance field, so a letter's field never holds ink from its neighbours in the row or
 * from the rows above and below. The shader can then draw every letter through its own
 * stretch and lean, however tightly the rows are set.
 */
export const letterClass = (row, k) => (row % 2) * 2 + (k % 2);

export const FAR_PX = 1e4; // "no ink anywhere near" in pixel fields
export const FIELD_LIMIT_EM = 16; // the same in em, finite in half floats
const CLASS_MARGIN_EM = 0.75; // exact distances are kept this far past a class's ink

/** SDF (px) of one class, computed only over its ink box plus `margin` px. */
export function classField(alpha, width, height, [bx0, by0, bx1, by1], margin) {
  const x = Math.max(0, bx0 - margin);
  const y = Math.max(0, by0 - margin);
  const w = Math.min(width - 1, bx1 + margin) - x + 1;
  const h = Math.min(height - 1, by1 + margin) - y + 1;
  const crop = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) crop.set(alpha.subarray((y + j) * width + x, (y + j) * width + x + w), j * w);
  return { data: signedDistanceField(crop, w, h), x, y, width: w, height: h };
}

/** Nearest-ink union of cropped class fields on the full grid; FAR_PX where none reaches. */
export function unionField(fields, width, height) {
  const out = new Float32Array(width * height).fill(FAR_PX);
  fields.forEach((field) => {
    if (!field) return;
    for (let j = 0; j < field.height; j++) {
      const row = (field.y + j) * width + field.x;
      for (let i = 0; i < field.width; i++) out[row + i] = Math.min(out[row + i], field.data[j * field.width + i]);
    }
  });
  return out;
}

/**
 * Texture payloads in em. `glyphs`: RGBA, one lightly blurred letter-class SDF per channel
 * (gooey letters). `body`: the blurred, hole-free silhouette field at half resolution
 * (rounded sticker body).
 */
export function buildFieldData({ glyphSdf, sil, width, height, pxPerEm }, goo) {
  const glyphs = new Float32Array(width * height * 4).fill(FIELD_LIMIT_EM);
  const inv = 1 / pxPerEm;
  glyphSdf.forEach((field, c) => {
    if (!field) return;
    const blurred = gaussianBlur(field.data, field.width, field.height, glyphSoftnessEm(goo) * pxPerEm);
    for (let j = 0; j < field.height; j++) {
      const row = (field.y + j) * width + field.x;
      for (let i = 0; i < field.width; i++) {
        glyphs[4 * (row + i) + c] = Math.min(blurred[j * field.width + i] * inv, FIELD_LIMIT_EM);
      }
    }
  });
  const body = gaussianBlur(sil.data, sil.width, sil.height, (0.05 + 0.11 * goo) * (pxPerEm / 2));
  return { glyphs, body };
}

/* ── Vector & archive export (pure) ───────────────────────────────────────── */

// Marching-squares cases → edge pairs. Edges: 0 top, 1 right, 2 bottom, 3 left.
// Corner bits: 8 top-left, 4 top-right, 2 bottom-right, 1 bottom-left. Saddles (5, 10)
// are resolved with the cell centre below.
const MS_SEGMENTS = [
  [], [[3, 2]], [[2, 1]], [[3, 1]], [[0, 1]], null, [[0, 2]], [[0, 3]],
  [[3, 0]], [[0, 2]], null, [[0, 1]], [[3, 1]], [[2, 1]], [[3, 2]], [],
];

/**
 * Iso-contours of an 8-bit coverage grid at `threshold`, as closed loops of [x, y] in
 * pixel units (pixel centres at +0.5). The grid is treated as padded with zeros, so
 * shapes touching the border still close. Loops are unoriented: fill them even-odd.
 */
export function traceContours(values, width, height, threshold = 127.5) {
  const W = width + 2;
  const at = (x, y) => (x < 1 || y < 1 || x > width || y > height ? 0 : values[(y - 1) * width + (x - 1)]);
  const links = new Map();
  const points = new Map();
  const edgeId = (x, y, e) => {
    if (e === 0) return (y * W + x) * 2;
    if (e === 2) return ((y + 1) * W + x) * 2;
    if (e === 3) return (y * W + x) * 2 + 1;
    return (y * W + x + 1) * 2 + 1;
  };
  const edgePoint = (x, y, e) => {
    const [ax, ay, bx, by] = [
      [x, y, x + 1, y],
      [x + 1, y, x + 1, y + 1],
      [x, y + 1, x + 1, y + 1],
      [x, y, x, y + 1],
    ][e];
    const a = at(ax, ay);
    const t = (threshold - a) / (at(bx, by) - a);
    return [ax + (bx - ax) * t - 0.5, ay + (by - ay) * t - 0.5];
  };
  const link = (a, b) => {
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  };
  for (let y = 0; y <= height; y++) {
    for (let x = 0; x <= width; x++) {
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);
      const c = (tl > threshold ? 8 : 0) | (tr > threshold ? 4 : 0) | (br > threshold ? 2 : 0) | (bl > threshold ? 1 : 0);
      if (c === 0 || c === 15) continue;
      let segs = MS_SEGMENTS[c];
      if (!segs) {
        const centreIn = (tl + tr + br + bl) / 4 > threshold;
        segs = c === 5 ? (centreIn ? [[3, 0], [2, 1]] : [[0, 1], [3, 2]]) : centreIn ? [[0, 1], [3, 2]] : [[3, 0], [2, 1]];
      }
      segs.forEach(([e1, e2]) => {
        const a = edgeId(x, y, e1);
        const b = edgeId(x, y, e2);
        if (!points.has(a)) points.set(a, edgePoint(x, y, e1));
        if (!points.has(b)) points.set(b, edgePoint(x, y, e2));
        link(a, b);
      });
    }
  }
  const seen = new Set();
  const loops = [];
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let prev = -1;
    let cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      loop.push(points.get(cur));
      const [a, b] = links.get(cur);
      const next = a !== prev ? a : b;
      prev = cur;
      cur = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// Ramer–Douglas–Peucker on an open polyline.
function rdp(points, epsilon) {
  if (points.length < 3) return points;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let worst = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
    if (d > worst) {
      worst = d;
      index = i;
    }
  }
  if (worst <= epsilon) return [points[0], points[points.length - 1]];
  return [...rdp(points.slice(0, index + 1), epsilon).slice(0, -1), ...rdp(points.slice(index), epsilon)];
}

/** Simplifies a closed loop, keeping the two most distant points as anchors. */
export function simplifyLoop(loop, epsilon) {
  if (loop.length < 4) return loop;
  const [x0, y0] = loop[0];
  const far = loop.reduce((best, [x, y], i) => ((x - x0) ** 2 + (y - y0) ** 2 > best.d ? { i, d: (x - x0) ** 2 + (y - y0) ** 2 } : best), { i: 0, d: -1 }).i;
  const first = rdp(loop.slice(0, far + 1), epsilon);
  const second = rdp([...loop.slice(far), loop[0]], epsilon);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

const fmtNum = (n) => {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

/** Closed loops → smooth path data (quadratic curves through edge midpoints). */
export function loopsToPath(loops, offset = [0, 0]) {
  return loops
    .filter((loop) => loop.length >= 3)
    .map((loop) => {
      const pt = (i) => loop[(i + loop.length) % loop.length];
      const mid = (i) => [(pt(i)[0] + pt(i + 1)[0]) / 2 + offset[0], (pt(i)[1] + pt(i + 1)[1]) / 2 + offset[1]];
      const [mx, my] = mid(0);
      const curves = loop.map((_, i) => {
        const [cx, cy] = [pt(i + 1)[0] + offset[0], pt(i + 1)[1] + offset[1]];
        const [ex, ey] = mid(i + 1);
        return `Q${fmtNum(cx)} ${fmtNum(cy)} ${fmtNum(ex)} ${fmtNum(ey)}`;
      });
      return `M${fmtNum(mx)} ${fmtNum(my)}${curves.join('')}Z`;
    })
    .join('');
}

/**
 * An editable SVG: optional background, then one group per named layer (path data
 * and/or rectangles), painted back to front.
 */
export function buildSvg({ width, height, background = null, layers }) {
  const body = layers
    .filter((l) => l.d || l.rects?.length)
    .map((l) => {
      const rects = (l.rects ?? [])
        .map((r) => `<rect x="${fmtNum(r.x)}" y="${fmtNum(r.y)}" width="${fmtNum(r.width)}" height="${fmtNum(r.height)}"/>`)
        .join('');
      const path = l.d ? `<path fill-rule="evenodd" d="${l.d}"/>` : '';
      return `<g id="${l.id}" fill="${l.color}">${rects}${path}</g>`;
    })
    .join('\n');
  const bg = background ? `<rect width="${width}" height="${height}" fill="${background}"/>\n` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n${bg}${body}\n</svg>\n`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A minimal uncompressed ZIP (PNGs are already compressed). `files`: [{ name, data }]. */
export function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  files.forEach(({ name, data }) => {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0, 2], [8, 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4],
      [18, data.length, 4], [22, data.length, 4], [26, nameBytes.length, 2], [28, 0, 2]].forEach(([at, v, size]) =>
      size === 4 ? local.setUint32(at, v, true) : local.setUint16(at, v, true),
    );
    const entry = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0, 2], [10, 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4],
      [20, data.length, 4], [24, data.length, 4], [28, nameBytes.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2],
      [36, 0, 2], [38, 0, 4], [42, offset, 4]].forEach(([at, v, size]) =>
      size === 4 ? entry.setUint32(at, v, true) : entry.setUint16(at, v, true),
    );
    parts.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  });
  const size = central.reduce((sum, p) => sum + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, size, 4],
    [16, offset, 4], [20, 0, 2]].forEach(([at, v, s]) => (s === 4 ? end.setUint32(at, v, true) : end.setUint16(at, v, true)));
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/** Animation clock for exported frame `frame` at `fps`, stepped like the live boil mode. */
export function motionClock(frame, fps, { speed, scroll, boil, boilFps }) {
  const t = frame / fps;
  const step = Math.floor(t * boilFps);
  const shown = boil ? step / boilFps : t;
  return { time: shown * speed, scroll: shown * scroll, seed: boil ? step % 3 : 0 };
}

const VIDEO_TYPES = ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

/** The first container/codec this browser's MediaRecorder can write (MP4 edits most easily). */
export const pickVideoType = (isSupported) => VIDEO_TYPES.find((t) => isSupported(t)) ?? null;

/** Video encoders want even dimensions. */
export const evenSize = (px) => Math.max(2, Math.ceil(px / 2) * 2);

/* ── Rasterising (DOM) ────────────────────────────────────────────────────── */

const MEASURE_PX = 100;
const fontStackFor = (family) => `"${family}", ${FALLBACK_FONTS}`;

/** Canvas alpha as a byte mask plus the inked pixel box [x0, y0, x1, y1] (null if blank). */
function readAlpha(ctx, width, height) {
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = rgba[(y * width + x) * 4 + 3];
      alpha[y * width + x] = a;
      if (a > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { alpha, box: x1 < 0 ? null : [x0, y0, x1, y1] };
}

const mergeBoxes = (a, b) =>
  a && b ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : (a ?? b);

const inkBoxEm = ([x0, y0, x1, y1], originEm, pxPerEm) => ({
  x: originEm[0] + x0 / pxPerEm,
  y: originEm[1] + y0 / pxPerEm,
  width: (x1 - x0 + 1) / pxPerEm,
  height: (y1 - y0 + 1) / pxPerEm,
});

/**
 * Lays out, rasterises and distance-transforms the lockup. The expensive step.
 * `maxSide` is the GPU's texture limit; the field is scaled down to respect it.
 */
function rasterizeSticker(canvas, { lines, family, lineSpacing, tracking, align, maxSide }) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  const fontStack = fontStackFor(family);
  ctx.font = `${MEASURE_PX}px ${fontStack}`;
  const measure = (s) => ctx.measureText(s).width / MEASURE_PX;
  const capHeight = (ctx.measureText('H').actualBoundingBoxAscent || 72) / MEASURE_PX;
  const layout = layoutLines(lines, { measure, capHeight, lineSpacing, tracking, align });
  const emptyBox = { x: -0.5, y: -capHeight, width: 1, height: capHeight };
  const hasInk = layout.rows.some((r) => r.chars.some((c) => c.trim() !== ''));
  if (!hasInk) return { empty: true, layout, inkBox: emptyBox };

  const all = ctx.measureText(lines.join(' '));
  const ascent = Math.max(all.fontBoundingBoxAscent || 0, all.actualBoundingBoxAscent || 0, capHeight * 120) / MEASURE_PX;
  const descent = Math.max(all.fontBoundingBoxDescent || 0, all.actualBoundingBoxDescent || 0, 30) / MEASURE_PX;
  const { rows } = layout;
  const minX = Math.min(...rows.map((r) => r.x)) - 0.3;
  const maxX = Math.max(...rows.map((r) => r.x + r.width)) + 0.3;
  const originEm = [minX - FIELD_PAD_EM, -ascent - FIELD_PAD_EM];
  const approxW = maxX - minX + 2 * FIELD_PAD_EM;
  const approxH = rows[rows.length - 1].baseline + descent + ascent + 2 * FIELD_PAD_EM;
  const pxPerEm = Math.min(
    SDF_PX_PER_EM,
    Math.sqrt(MAX_FIELD_PIXELS / (approxW * approxH)),
    (maxSide - 2) / approxW,
    (maxSide - 2) / approxH,
  );
  const width = Math.ceil(approxW * pxPerEm);
  const height = Math.ceil(approxH * pxPerEm);

  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  ctx.font = `${pxPerEm}px ${fontStack}`;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  const drawClass = (c) => {
    ctx.clearRect(0, 0, width, height);
    let inked = false;
    rows.forEach((r, ri) =>
      r.chars.forEach((ch, k) => {
        if (letterClass(ri, k) !== c || ch.trim() === '') return;
        inked = true;
        ctx.fillText(ch, (r.x + r.carets[k] - originEm[0]) * pxPerEm, (r.baseline - originEm[1]) * pxPerEm);
      }),
    );
    return inked ? readAlpha(ctx, width, height) : { alpha: null, box: null };
  };
  const classes = [0, 1, 2, 3].map(drawClass);
  const box = classes.reduce((acc, c) => mergeBoxes(acc, c.box), null);
  if (!box) return { empty: true, layout, inkBox: emptyBox };

  const margin = Math.ceil(CLASS_MARGIN_EM * pxPerEm);
  const glyphSdf = classes.map((c) => (c.box ? classField(c.alpha, width, height, c.box, margin) : null));
  return {
    empty: false,
    layout,
    inkBox: inkBoxEm(box, originEm, pxPerEm),
    glyphSdf,
    sil: silhouetteField(unionField(glyphSdf, width, height), width, height, pxPerEm),
    width,
    height,
    pxPerEm,
    originEm,
    sizeEm: [width / pxPerEm, height / pxPerEm],
  };
}

/**
 * The marquee's small print: plain Archivo, unwarped, as a distance field in sticker ems
 * so it stays crisp at any band size. Returns null when there is nothing to draw.
 */
function rasterizeTagline(canvas, lines, maxSide) {
  if (!lines.some((l) => l.trim() !== '')) return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  const lineGap = TAG_SCALE * 0.9;
  const pad = 0.2;
  ctx.font = TAG_FONT.replace('{px}', MEASURE_PX);
  const widestEm = Math.max(...lines.map((l) => ctx.measureText(l).width)) / MEASURE_PX * TAG_SCALE;
  const originEm = [-pad, -TAG_SCALE - pad];
  const approxW = widestEm + 2 * pad;
  const approxH = (lines.length - 1) * lineGap + TAG_SCALE * 1.35 + 2 * pad;
  const pxPerEm = Math.min(TAG_PX_PER_EM, (maxSide - 2) / approxW, (maxSide - 2) / approxH);
  const width = Math.ceil(approxW * pxPerEm);
  const height = Math.ceil(approxH * pxPerEm);

  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  ctx.font = TAG_FONT.replace('{px}', TAG_SCALE * pxPerEm);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => ctx.fillText(line, -originEm[0] * pxPerEm, (i * lineGap - originEm[1]) * pxPerEm));

  const { alpha, box } = readAlpha(ctx, width, height);
  if (!box) return null;
  const sdf = signedDistanceField(alpha, width, height);
  return {
    width,
    height,
    originEm,
    sizeEm: [width / pxPerEm, height / pxPerEm],
    data: sdf.map((d) => d / pxPerEm),
    inkBox: inkBoxEm(box, originEm, pxPerEm),
  };
}

/* ── Fonts ────────────────────────────────────────────────────────────────── */

let fontCssPromise = null;
let uploadCounter = 0;

function ensureFontStylesheet() {
  if (fontCssPromise) return fontCssPromise;
  fontCssPromise = new Promise((resolve) => {
    if (document.getElementById(FONT_LINK_ID)) {
      resolve(true);
      return;
    }
    const link = document.createElement('link');
    link.id = FONT_LINK_ID;
    link.rel = 'stylesheet';
    link.href = FONT_CSS_HREF;
    link.onload = () => resolve(true);
    link.onerror = () => resolve(false);
    document.head.appendChild(link);
  });
  return fontCssPromise;
}

/** Loads a Google Fonts face by CSS font spec (e.g. `600 64px "Archivo"`). */
async function loadFontSpec(spec, sample = 'UNIDENTIFIED DANCING') {
  const cssOk = await ensureFontStylesheet();
  if (!cssOk || !document.fonts?.load) return false;
  try {
    const faces = await document.fonts.load(spec, sample);
    return faces.length > 0;
  } catch {
    return false;
  }
}

const loadFontFamily = (family) => loadFontSpec(`64px "${family}"`);

/** Registers a user's font file with the document and returns it as a font option. */
async function registerUploadedFont(file) {
  const problem = validateFontFile(file);
  if (problem) throw new Error(problem);
  uploadCounter += 1;
  const family = `RSW Upload ${uploadCounter}`;
  const face = new FontFace(family, await file.arrayBuffer());
  await face.load();
  document.fonts.add(face);
  const label = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Uploaded font';
  return { id: `upload-${uploadCounter}`, label, family, face, uploaded: true };
}

/* ── WebGL2 renderer ──────────────────────────────────────────────────────── */

const VERT_SRC = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// 3D gradient noise with a sine-free hash (after Dave Hoskins), quintic fade.
const NOISE_GLSL = `
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
}
float corner(vec3 i, vec3 f, vec3 o) { return dot(hash33(i + o), f - o); }
float gnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float x00 = mix(corner(i, f, vec3(0, 0, 0)), corner(i, f, vec3(1, 0, 0)), u.x);
  float x10 = mix(corner(i, f, vec3(0, 1, 0)), corner(i, f, vec3(1, 1, 0)), u.x);
  float x01 = mix(corner(i, f, vec3(0, 0, 1)), corner(i, f, vec3(1, 0, 1)), u.x);
  float x11 = mix(corner(i, f, vec3(0, 1, 1)), corner(i, f, vec3(1, 1, 1)), u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}`;

// Pass 1: low-res animated warp field over the distance-field domain.
// RG = displacement (encoded 0.5 ± 0.2·w), B = swell, A = silhouette wobble.
const WARP_FRAG_SRC = `#version 300 es
precision highp float;
uniform vec2 uOrigin;
uniform vec2 uSize;
uniform vec2 uTexels;
uniform float uTime;
uniform float uFreq;
uniform float uBoil;
uniform float uSeed;
out vec4 outColor;
${NOISE_GLSL}
void main() {
  vec2 p = uOrigin + gl_FragCoord.xy / uTexels * uSize;
  float t = uTime;
  vec3 q = vec3(p * uFreq, t * 0.42);

  vec2 w = vec2(gnoise(q), gnoise(q + vec3(17.3, 9.1, 4.7)));
  w += 0.5 * vec2(gnoise(q * 2.03 + vec3(5.2, 1.3, t * 0.21)),
                  gnoise(q * 2.03 + vec3(11.8, 23.1, t * 0.21)));
  w += 0.26 * vec2(gnoise(q * 4.11 + vec3(2.9, 7.7, t * 0.6)),
                   gnoise(q * 4.11 + vec3(19.4, 3.6, t * 0.6)));

  float phase = p.x * uFreq * 1.35 - t * 1.7;
  w += vec2(0.18 * cos(phase * 0.5 + p.y * uFreq * 0.8), 0.42 * sin(phase));

  vec3 b = vec3(p * uFreq * 2.6, uSeed * 3.17 + 0.5);
  w += uBoil * 0.4 * vec2(gnoise(b), gnoise(b + vec3(3.3, 8.8, 1.1)));

  float swell = 0.65 * gnoise(vec3(p * uFreq * 0.9 + 3.1, t * 0.55)) + 0.45 * sin(phase + 1.3);
  float wobble = gnoise(vec3(p * uFreq * 0.7 - 7.3, t * 0.33 + 2.0)) + uBoil * 0.4 * gnoise(b * 0.8 + 5.0);

  outColor = vec4(0.5 + 0.2 * w, 0.5 + 0.5 * clamp(swell, -1.0, 1.0), 0.5 + 0.5 * clamp(wobble, -1.0, 1.0));
}`;

// Pass 2: every design maps the pixel to one or two "layers" — a position in the sticker
// field (q), a position in the tagline field (tq), a stretch row, a background strip and
// a colourway — then samples the fields through the warp, stretch and italic shear.
// uOutput 1/2 writes raw layer coverages for the SVG tracer instead of colour.
const MAIN_FRAG_SRC = `#version 300 es
precision highp float;
uniform sampler2D uField;      // RGBA: letter-class SDFs, row parity × letter parity (em)
uniform sampler2D uBody;       // R: silhouette SDF, half resolution (em)
uniform sampler2D uWarp;       // RG: displacement, B: swell, A: wobble
uniform sampler2D uStretch;    // RG32F: display→field x offset, letter index (per row)
uniform sampler2D uGlyphs;     // RGBA32F letter table: display edge, field edge, lean, valid
uniform sampler2D uTag;        // R: tagline SDF (em)
uniform vec2 uRes;
uniform vec2 uViewCenter;
uniform float uPxPerEm;
uniform vec2 uCenterEm;
uniform vec2 uOrigin;          // field domain (em)
uniform vec2 uSize;
uniform vec2 uBodySize;        // body field domain (same origin)
uniform vec2 uWarpOrigin;      // warp domain (em)
uniform vec2 uWarpSize;
uniform vec2 uTagOrigin;       // tagline field domain (em)
uniform vec2 uTagSize;
uniform float uAmp;
uniform float uSwell;
uniform float uSwellAmt;       // 0..1 Swell setting; also breathes the outline width
uniform float uWobble;
uniform float uWeight;
uniform float uPad;
uniform float uStroke;
uniform float uGooK;           // smooth-union radius that melts letters within a word (em)
uniform float uGooRowK;        // gentler radius between rows and ring repeats (em)
uniform float uSticker;        // 1 draws the silhouette and outer stroke
uniform float uStretchOn;
uniform vec2 uStretchDomain;   // x0, width (em)
uniform vec2 uRowGeom;         // first lockup row centre y, row gap (em)
uniform int uMode;             // 0 sticker, 1 marquee, 2 badge, 3 ribbon, 4 wallpaper
uniform int uOutput;           // 0 colour, 1 coverage (glyph, body, edge, tag), 2 strip
uniform int uSelect;           // -1 every colourway, else only this one (SVG tracing)
uniform vec2 uFocus;           // badge / wallpaper centre (em)
uniform vec4 uBandGeom;        // band height, period, tagline slot x, scroll (em)
uniform vec4 uSlotMap;         // sticker field x0, sticker centre y, tagline field x0|centre x, centre y
uniform vec4 uBadge;           // radius, repeats, rotation (em along the ring), period
uniform vec4 uRibbon0;         // centre y, amplitude, wavenumber, phase
uniform vec4 uRibbon1;
uniform vec4 uTile;            // tile width, height, angle, scroll
uniform vec2 uTileOrigin;      // sticker field position of a tile's corner (em)
uniform vec3 uBg;              // stage colour
uniform vec3 uPalBg[3];
uniform vec3 uPalSil[3];
uniform vec3 uPalFill[3];
uniform vec3 uPalLine[3];
uniform vec3 uPalTag[3];
uniform float uBgAlpha;
uniform float uMaxAA;          // widest legitimate anti-aliasing footprint (em)
uniform float uGrain;          // film grain amount
uniform float uGrainEm;        // grain cell (em)
uniform float uFxSeed;         // grain frame seed
uniform float uHalftone;       // halftone mix
uniform float uDotEm;          // halftone cell (em)
uniform float uDither;         // dither mix
uniform float uLevels;         // dither levels per channel
uniform float uPixelEm;        // dither pixel (em)
out vec4 outColor;

const float LOCKUP = -1.0e4;

struct Layer {
  vec2 q;       // sticker field position before warp
  vec2 tq;      // tagline field position
  float row;    // stretch row (LOCKUP = the lockup's own rows, by height)
  float pivot;  // italic pivot line (field y)
  float strip;  // coverage of the layer's own background strip
  int group;    // colourway 0..2
  float wrap;   // > 0: repeat period whose neighbouring copies merge (badge ring)
};

// The cap keeps derivative spikes at wrap seams from smearing faint lines.
float cover(float d) {
  float w = min(length(vec2(dFdx(d), dFdy(d))), uMaxAA);
  return clamp(0.5 - d / max(w, 1e-6), 0.0, 1.0);
}

// Display→field x offset the sticker body follows (stretch only), for one row.
float stretchAt(int row, float x) {
  ivec2 size = textureSize(uStretch, 0);
  float u = clamp((x - uStretchDomain.x) / uStretchDomain.y * float(size.x) - 0.5, 0.0, float(size.x - 1));
  int i0 = int(u);
  int i1 = min(i0 + 1, size.x - 1);
  int r = clamp(row, 0, size.y - 1);
  return mix(texelFetch(uStretch, ivec2(i0, r), 0).r, texelFetch(uStretch, ivec2(i1, r), 0).r, u - float(i0));
}

// Lockup rows ease between lines so the body stays one smooth blob.
float bodyX(vec2 q, float row) {
  if (uStretchOn < 0.5) return q.x;
  int rows = textureSize(uStretch, 0).y;
  if (row > LOCKUP) return q.x + stretchAt(int(mod(row, float(rows))), q.x);
  if (rows < 2) return q.x + stretchAt(0, q.x);
  float r = clamp((q.y - uRowGeom.x) / uRowGeom.y, 0.0, float(rows - 1));
  float r0 = floor(r);
  return q.x + mix(stretchAt(int(r0), q.x), stretchAt(int(r0) + 1, q.x), smoothstep(0.35, 0.65, r - r0));
}

const float EDGE_REACH = 0.5; // outer letters may swell past the row ends (em)

// Polynomial smooth minimum: shapes closer than k melt together like the goo they are.
// melt scales the bridge, so a neighbour can fade out of the union without a seam.
float smin(float a, float b, float k, float melt) {
  float h = max(k - abs(a - b), 0.0) / max(k, 1.0e-5);
  return min(a, b) - melt * h * h * k * 0.25;
}

float classDist(vec4 f, int c) {
  return c == 0 ? f.r : c == 1 ? f.g : c == 2 ? f.b : f.a;
}

// One letter through its own stretch and lean. Its class field holds no neighbouring ink,
// so it may reach halfway into each neighbour's cell (crossbars, swollen ink); the clip
// keeps out the next-but-one letters, which share its class.
float letterDist(vec2 w, float pivot, int rowClass, int j, vec4 prev, vec4 g, vec4 next, vec4 next2, float t) {
  if (g.w < 0.75) return 1.0e3; // spaces and padding carry no ink
  float span = next.x - g.x;
  float fx = g.y + (w.x - g.x) * (span > 1.0e-5 ? (next.y - g.y) / span : 1.0) + g.z * (w.y - pivot);
  float lo = j == 0 ? g.y - EDGE_REACH : 0.5 * (prev.y + g.y);
  float hi = next.w < 0.25 ? next.y + EDGE_REACH : 0.5 * (next.y + next2.y);
  float s = classDist(textureLod(uField, (vec2(fx, w.y) - uOrigin) / uSize, 0.0), rowClass + (j & 1));
  return max(s, max(lo - fx, fx - hi) + t);
}

// Glyph distance for one stretch row (fieldRow: the lockup row it draws): the letter under
// w and its two neighbours, unioned. t is the ink threshold, so clips sit on the drawn edge.
float glyphRow(vec2 w, int row, int fieldRow, float pivot, float t) {
  ivec2 size = textureSize(uStretch, 0);
  int r = clamp(row, 0, size.y - 1);
  int i = clamp(int((w.x - uStretchDomain.x) / uStretchDomain.y * float(size.x)), 0, size.x - 1);
  int k = int(texelFetch(uStretch, ivec2(i, r), 0).g + 0.5);
  int last = textureSize(uGlyphs, 0).x - 1;
  int rowClass = (fieldRow & 1) * 2;
  vec4 g0 = texelFetch(uGlyphs, ivec2(clamp(k - 2, 0, last), r), 0);
  vec4 g1 = texelFetch(uGlyphs, ivec2(clamp(k - 1, 0, last), r), 0);
  vec4 g2 = texelFetch(uGlyphs, ivec2(clamp(k, 0, last), r), 0);
  vec4 g3 = texelFetch(uGlyphs, ivec2(clamp(k + 1, 0, last), r), 0);
  vec4 g4 = texelFetch(uGlyphs, ivec2(clamp(k + 2, 0, last), r), 0);
  vec4 g5 = texelFetch(uGlyphs, ivec2(clamp(k + 3, 0, last), r), 0);
  float d = letterDist(w, pivot, rowClass, k, g1, g2, g3, g4, t);
  // A neighbour melts fully at the edge it shares with this letter and not at all at the far
  // edge, where it leaves this three-letter window — so the melt never seams between cells.
  // Over a space nothing melts, so words stay apart.
  float across = clamp((w.x - g2.x) / max(g3.x - g2.x, 1.0e-5), 0.0, 1.0);
  float melt = g2.w > 0.75 ? 1.0 : 0.0;
  if (k > 0) d = smin(d, letterDist(w, pivot, rowClass, k - 1, g0, g1, g2, g3, t), uGooK, melt * (1.0 - across));
  if (k + 1 <= last) d = smin(d, letterDist(w, pivot, rowClass, k + 1, g2, g3, g4, g5, t), uGooK, melt * across);
  return d;
}

// Glyph distance at w. One-line designs draw the single lockup row in every band; lockups
// union the two rows around w. Rows alternate classes, so each row's letters are drawn
// whole through their own stretch and lean, even where tight rows overlap.
float glyphAt(vec2 w, float row, float pivot, float t) {
  if (uStretchOn < 0.5) {
    vec4 f = textureLod(uField, (w - uOrigin) / uSize, 0.0);
    // Each row's even and odd letters melt (a space keeps words' same-class letters apart).
    return smin(smin(f.r, f.g, uGooK, 1.0), smin(f.b, f.a, uGooK, 1.0), uGooRowK, 1.0);
  }
  int rows = textureSize(uStretch, 0).y;
  if (row > LOCKUP) return glyphRow(w, int(mod(row, float(rows))), 0, pivot, t);
  if (rows < 2) return glyphRow(w, 0, 0, uRowGeom.x, t);
  float r = clamp((w.y - uRowGeom.x) / uRowGeom.y, 0.0, float(rows - 1));
  int r0 = min(int(r), rows - 2);
  float c0 = uRowGeom.x + float(r0) * uRowGeom.y;
  // Rows melt across the gap between them, fading out at row centres where the pair changes.
  float f = r - float(r0);
  return smin(glyphRow(w, r0, r0, c0, t), glyphRow(w, r0 + 1, r0 + 1, c0 + uRowGeom.y, t), uGooRowK, 4.0 * f * (1.0 - f));
}

Layer stickerLayer(vec2 p) {
  return Layer(p, vec2(-1.0e4), LOCKUP, 0.0, 0.0, 0, 0.0);
}

Layer bandLayer(vec2 p) {
  float band = floor(p.y / uBandGeom.x);
  float yl = p.y - (band + 0.5) * uBandGeom.x;
  float dir = mod(band, 2.0) < 0.5 ? 1.0 : -1.0;
  float xl = mod(p.x + dir * uBandGeom.w + fract(band * 0.618034) * uBandGeom.y, uBandGeom.y);
  return Layer(vec2(uSlotMap.x + xl, uSlotMap.y + yl), vec2(uSlotMap.z + xl - uBandGeom.z, uSlotMap.w + yl),
               band, uSlotMap.y, uBgAlpha, int(mod(band, 3.0)), 0.0);
}

// Text runs clockwise round the ring, letter tops pointing outward; the tagline sits inside.
Layer badgeLayer(vec2 p) {
  vec2 v = p - uFocus;
  float s = (atan(v.y, v.x) + 3.14159265) * uBadge.x + uBadge.z;
  float xl = mod(s, uBadge.w);
  float rep = mod(floor(s / uBadge.w), uBadge.y);
  return Layer(vec2(uSlotMap.x + xl, uSlotMap.y - (length(v) - uBadge.x)), uSlotMap.zw + v, rep, uSlotMap.y, 0.0, 0, uBadge.w);
}

// A tape following a sine wave; distance to its centre line is measured along the normal.
Layer ribbonLayer(vec2 p, vec4 wave, float dir, float index) {
  float arg = wave.z * p.x + wave.w;
  float slope = wave.y * wave.z * cos(arg);
  float yl = (p.y - wave.x - wave.y * sin(arg)) / sqrt(1.0 + slope * slope);
  float xl = mod(p.x + dir * uBandGeom.w + index * 0.37 * uBandGeom.y, uBandGeom.y);
  float strip = cover(abs(yl) - uBandGeom.x * 0.5);
  return Layer(vec2(uSlotMap.x + xl, uSlotMap.y + yl), vec2(uSlotMap.z + xl - uBandGeom.z, uSlotMap.w + yl),
               index, uSlotMap.y, strip, int(index), 0.0);
}

// Tilted brick tiling; neighbouring tiles alternate colourways.
Layer tileLayer(vec2 p) {
  vec2 v = p - uFocus;
  float c = cos(uTile.z);
  float s = sin(uTile.z);
  vec2 pr = vec2(c * v.x - s * v.y, s * v.x + c * v.y);
  float row = floor(pr.y / uTile.y);
  float dir = mod(row, 2.0) < 0.5 ? 1.0 : -1.0;
  float x = pr.x + row * 0.5 * uTile.x + dir * uTile.w;
  float col = floor(x / uTile.x);
  vec2 local = vec2(x - col * uTile.x, pr.y - row * uTile.y);
  return Layer(uTileOrigin + local, vec2(-1.0e4), LOCKUP, 0.0, 0.0, int(mod(row + col, 2.0)), 0.0);
}

// Glyph distance (per-letter stretch + lean) and silhouette distance (stretch only) at w.
vec2 fieldAt(vec2 w, float row, float pivot, float t) {
  float glyph = glyphAt(w, row, pivot, t);
  float body = texture(uBody, (vec2(bodyX(w, row), w.y) - uOrigin) / uBodySize).r;
  return vec2(glyph, body);
}

// Coverage of glyph, silhouette body, outer stroke edge and tagline for one layer.
vec4 coverages(Layer L, vec2 offset, float swellN, float wobble) {
  vec2 w = L.q + offset;
  float t = uWeight + swellN * uSwell;
  vec2 d = fieldAt(w, L.row, L.pivot, t);
  if (L.wrap > 0.0) {
    // Union with the neighbouring repeats: bodies merge into one ring, letters melt across.
    float n = float(textureSize(uStretch, 0).y);
    vec2 before = fieldAt(w + vec2(L.wrap, 0.0), mod(L.row - 1.0 + n, n), L.pivot, t);
    vec2 after = fieldAt(w - vec2(L.wrap, 0.0), mod(L.row + 1.0, n), L.pivot, t);
    d = vec2(smin(smin(d.x, before.x, uGooRowK, 1.0), after.x, uGooRowK, 1.0), min(d.y, min(before.y, after.y)));
  }
  float glyph = cover(d.r - t);
  float body = uSticker * cover(d.g - uPad - wobble);
  float edge = uSticker * cover(d.g - uPad - wobble - uStroke * (1.0 + 0.4 * swellN * uSwellAmt));
  float tag = cover(texture(uTag, (L.tq - uTagOrigin) / uTagSize).r);
  return vec4(glyph, body, edge, tag);
}

vec4 over(vec4 base, vec3 color, float a) {
  return mix(base, vec4(color, 1.0), a);
}

vec4 paint(vec4 base, vec4 c, float strip, int k) {
  base = over(base, uPalBg[k], strip);
  base = over(base, uPalLine[k], c.z);
  base = over(base, uPalSil[k], c.y);
  base = over(base, uPalFill[k], c.x);
  return over(base, uPalTag[k], c.w);
}

// Maps a point to its design's layers and their coverages.
void evaluate(vec2 p, out Layer a, out Layer b, out vec4 ca, out vec4 cb) {
  vec4 w = texture(uWarp, (p - uWarpOrigin) / uWarpSize);
  vec2 offset = (w.xy - 0.5) / 0.2 * uAmp;
  float swellN = w.z * 2.0 - 1.0;
  float wobble = (w.w * 2.0 - 1.0) * uWobble;
  b = stickerLayer(p);
  if (uMode == 1) a = bandLayer(p);
  else if (uMode == 2) a = badgeLayer(p);
  else if (uMode == 3) {
    a = ribbonLayer(p, uRibbon0, 1.0, 0.0);
    b = ribbonLayer(p, uRibbon1, -1.0, 1.0);
  } else if (uMode == 4) a = tileLayer(p);
  else a = stickerLayer(p);
  ca = coverages(a, offset, swellN, wobble);
  cb = uMode == 3 ? coverages(b, offset, swellN, wobble) : vec4(0.0);
}

// Composited (premultiplied) colour of the design at p, before texture effects.
vec4 shade(vec2 p) {
  Layer a;
  Layer b;
  vec4 ca;
  vec4 cb;
  evaluate(p, a, b, ca, cb);
  vec4 col = vec4(uBg * uBgAlpha, uBgAlpha);
  col = paint(col, ca, a.strip, a.group);
  if (uMode == 3) col = paint(col, cb, b.strip, b.group);
  return col;
}

// 45° dot screen: every colour is re-printed as dots over a deep tone of itself, brighter
// colours getting bigger dots. Shapes stay crisp; flat areas read as coarse print.
vec4 halftone(vec4 col, vec2 p) {
  const float c = 0.70710678;
  vec2 g = vec2(p.x + p.y, p.y - p.x) * c / uDotEm;
  float d = length(fract(g) - 0.5);
  vec3 rgb = col.a > 0.0 ? col.rgb / col.a : vec3(0.0);
  float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
  float r = mix(0.2, 0.64, sqrt(luma));
  float aa = clamp(fwidth(d), 1e-4, 0.3);
  float ink = 1.0 - smoothstep(r - aa, r + aa, d);
  return vec4(mix(rgb * 0.28, rgb, ink) * col.a, col.a);
}

vec4 styled(vec2 p) {
  vec4 col = shade(p);
  return uHalftone > 0.0 ? mix(col, halftone(col, p), uHalftone) : col;
}

float bayer4(vec2 c) {
  const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[int(c.y) * 4 + int(c.x)] + 0.5) / 16.0;
}

// Ordered (Bayer 4×4) dither to a few levels per channel, on chunky pixels.
vec4 dither(vec2 p) {
  vec2 cell = floor(p / uPixelEm);
  vec4 src = styled((cell + 0.5) * uPixelEm);
  float t = bayer4(mod(cell, 4.0)) - 0.5;
  float n = uLevels - 1.0;
  vec3 rgb = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  rgb = clamp(floor(rgb * n + 0.5 + t) / n, 0.0, 1.0);
  float a = uBgAlpha > 0.5 ? 1.0 : step(0.5 + t * 0.9, src.a);
  return vec4(rgb * a, a);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = (px - uViewCenter) / uPxPerEm + uCenterEm;

  if (uOutput > 0) {
    Layer a;
    Layer b;
    vec4 ca;
    vec4 cb;
    evaluate(p, a, b, ca, cb);
    vec4 m = vec4(0.0);
    if (uSelect < 0 || a.group == uSelect) m = max(m, uOutput == 1 ? ca : vec4(a.strip, 0.0, 0.0, 0.0));
    if (uMode == 3 && (uSelect < 0 || b.group == uSelect)) m = max(m, uOutput == 1 ? cb : vec4(b.strip, 0.0, 0.0, 0.0));
    outColor = m;
    return;
  }

  vec4 col = uDither < 1.0 ? styled(p) : vec4(0.0);
  if (uDither > 0.0) col = mix(col, dither(p), uDither);
  if (uGrain > 0.0) {
    float n = hash12(floor(p / uGrainEm) + uFxSeed * 7.13) - 0.5;
    col.rgb = clamp(col.rgb + n * uGrain * 0.4 * col.a, 0.0, col.a);
  }
  outColor = col;
}`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader failed to compile: ${log}`);
  }
  return shader;
}

function createProgram(gl, fragSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Shader program failed to link: ${log}`);
  }
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  const uniforms = Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const { name } = gl.getActiveUniform(program, i);
      return [name, gl.getUniformLocation(program, name)];
    }),
  );
  return { program, u: (name) => uniforms[name] ?? null };
}

const MAX_AA_PX = 6; // edges condensed up to ~6× still anti-alias; wrap seams exceed it by far

const EFFECT_UNIFORMS = [
  ['amp', 'uAmp'],
  ['swell', 'uSwell'],
  ['swellAmt', 'uSwellAmt'],
  ['wobble', 'uWobble'],
  ['weight', 'uWeight'],
  ['pad', 'uPad'],
  ['stroke', 'uStroke'],
  ['gooK', 'uGooK'],
  ['gooRowK', 'uGooRowK'],
];

const TEXTURE_UNIFORMS = [
  ['grain', 'uGrain'],
  ['grainEm', 'uGrainEm'],
  ['fxSeed', 'uFxSeed'],
  ['halftone', 'uHalftone'],
  ['dotEm', 'uDotEm'],
  ['dither', 'uDither'],
  ['levels', 'uLevels'],
  ['pixelEm', 'uPixelEm'],
];

const PALETTE_UNIFORMS = [
  ['bg', 'uPalBg[0]'],
  ['sil', 'uPalSil[0]'],
  ['fill', 'uPalFill[0]'],
  ['line', 'uPalLine[0]'],
  ['tag', 'uPalTag[0]'],
];

const ZERO4 = [0, 0, 0, 0];

// Stand-in tagline field: one texel "far away" from any ink.
const NO_TAG = Object.freeze({ width: 1, height: 1, originEm: [0, 0], sizeEm: [1, 1], data: new Float32Array([1000]) });

function createTexture(gl, filter) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');

  const warpProg = createProgram(gl, WARP_FRAG_SRC);
  const mainProg = createProgram(gl, MAIN_FRAG_SRC);
  const vao = gl.createVertexArray();
  const fieldTex = createTexture(gl, gl.LINEAR);
  const bodyTex = createTexture(gl, gl.LINEAR);
  const warpTex = createTexture(gl, gl.LINEAR);
  const stretchTex = createTexture(gl, gl.NEAREST); // RG32F isn't filterable everywhere; the shader lerps
  const glyphTex = createTexture(gl, gl.NEAREST);
  const tagTex = createTexture(gl, gl.LINEAR);
  const warpFbo = gl.createFramebuffer();
  const maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  let floatWarp = Boolean(gl.getExtension('EXT_color_buffer_float'));
  let field = null;
  let tag = null;
  let warpTexels = [0, 0];
  let stretchSize = [0, 0];
  let glyphSize = [0, 0];

  function allocateWarp(w, h) {
    gl.bindTexture(gl.TEXTURE_2D, warpTex);
    if (floatWarp) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, warpFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, warpTex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete && floatWarp) {
      floatWarp = false;
      allocateWarp(w, h);
      return;
    }
    if (!complete) throw new Error('Could not allocate the warp buffer.');
    warpTexels = [w, h];
  }

  function uploadFloat(tex, internalFormat, format, { width, height, data }, what) {
    for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++); // drain stale error flags
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, gl.FLOAT, data);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`${what} upload failed (GL error 0x${error.toString(16)}).`);
  }

  /** Letter-class fields (RGBA, full resolution) and the sticker body (R, half resolution). */
  function setField(next) {
    field = null; // never pair a stale texture with new bounds
    if (!next) return;
    const { width, height, data, body } = next;
    uploadFloat(fieldTex, gl.RGBA16F, gl.RGBA, { width, height, data: data.glyphs }, 'Distance field');
    uploadFloat(bodyTex, gl.R16F, gl.RED, { width: body.width, height: body.height, data: data.body }, 'Body field');
    // Half-resolution texel i covers full-resolution pixels 2i and 2i + 1.
    const bodySizeEm = [(next.sizeEm[0] * 2 * body.width) / width, (next.sizeEm[1] * 2 * body.height) / height];
    field = { originEm: next.originEm, sizeEm: next.sizeEm, bodySizeEm };
  }

  function setTag(next) {
    const t = next ?? NO_TAG;
    tag = null;
    uploadFloat(tagTex, gl.R16F, gl.RED, t, 'Tagline field');
    tag = { originEm: t.originEm, sizeEm: t.sizeEm };
  }

  // Float textures re-uploaded every frame; storage is reallocated only when the size changes.
  function uploadFrameTexture(tex, size, internalFormat, format, width, rows, data) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (width === size[0] && rows === size[1]) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, rows, format, gl.FLOAT, data);
      return size;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, rows, 0, format, gl.FLOAT, data);
    return [width, rows];
  }

  /** Per-frame stretch offsets + letter indices, and the letter table (edges, lean). */
  function setStretch({ data, width, rows, glyphs, letters }) {
    stretchSize = uploadFrameTexture(stretchTex, stretchSize, gl.RG32F, gl.RG, width, rows, data);
    glyphSize = uploadFrameTexture(glyphTex, glyphSize, gl.RGBA32F, gl.RGBA, letters, rows, glyphs);
  }

  setTag(null);
  setStretch({ data: new Float32Array(2), width: 1, rows: 1, glyphs: new Float32Array(4), letters: 1 });

  function drawWarp(frame) {
    const { origin, size } = frame.warpDomain ?? { origin: field.originEm, size: field.sizeEm };
    const w = clamp(Math.ceil(size[0] * WARP_TEXELS_PER_EM), 4, 2048);
    const h = clamp(Math.ceil(size[1] * WARP_TEXELS_PER_EM), 4, 2048);
    if (w !== warpTexels[0] || h !== warpTexels[1]) allocateWarp(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, warpFbo);
    gl.viewport(0, 0, warpTexels[0], warpTexels[1]);
    gl.useProgram(warpProg.program);
    const u = warpProg.u;
    gl.uniform2f(u('uOrigin'), origin[0], origin[1]);
    gl.uniform2f(u('uSize'), size[0], size[1]);
    gl.uniform2f(u('uTexels'), warpTexels[0], warpTexels[1]);
    gl.uniform1f(u('uTime'), frame.time);
    gl.uniform1f(u('uFreq'), frame.freq);
    gl.uniform1f(u('uBoil'), frame.boil);
    gl.uniform1f(u('uSeed'), frame.seed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function drawMain(frame, target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, frame.width, frame.height);
    gl.useProgram(mainProg.program);
    const u = mainProg.u;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fieldTex);
    gl.uniform1i(u('uField'), 0);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, bodyTex);
    gl.uniform1i(u('uBody'), 5);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, warpTex);
    gl.uniform1i(u('uWarp'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, stretchTex);
    gl.uniform1i(u('uStretch'), 2);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, glyphTex);
    gl.uniform1i(u('uGlyphs'), 4);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, tagTex);
    gl.uniform1i(u('uTag'), 3);
    gl.uniform2f(u('uRes'), frame.width, frame.height);
    gl.uniform2f(u('uViewCenter'), frame.view.centerPx[0], frame.view.centerPx[1]);
    gl.uniform1f(u('uPxPerEm'), frame.view.pxPerEm);
    gl.uniform2f(u('uCenterEm'), frame.view.centerEm[0], frame.view.centerEm[1]);
    gl.uniform2f(u('uOrigin'), field.originEm[0], field.originEm[1]);
    gl.uniform2f(u('uSize'), field.sizeEm[0], field.sizeEm[1]);
    gl.uniform2f(u('uBodySize'), field.bodySizeEm[0], field.bodySizeEm[1]);
    const warpDomain = frame.warpDomain ?? { origin: field.originEm, size: field.sizeEm };
    gl.uniform2f(u('uWarpOrigin'), warpDomain.origin[0], warpDomain.origin[1]);
    gl.uniform2f(u('uWarpSize'), warpDomain.size[0], warpDomain.size[1]);
    gl.uniform2f(u('uTagOrigin'), tag.originEm[0], tag.originEm[1]);
    gl.uniform2f(u('uTagSize'), tag.sizeEm[0], tag.sizeEm[1]);
    EFFECT_UNIFORMS.forEach(([key, name]) => gl.uniform1f(u(name), frame[key]));
    TEXTURE_UNIFORMS.forEach(([key, name]) => gl.uniform1f(u(name), frame.texture?.[key] ?? 0));
    gl.uniform1f(u('uSticker'), frame.sticker);
    const { stretch } = frame;
    gl.uniform1f(u('uStretchOn'), stretch ? 1 : 0);
    if (stretch) {
      gl.uniform2f(u('uStretchDomain'), stretch.domain[0], stretch.domain[1]);
      gl.uniform2f(u('uRowGeom'), stretch.rowGeom[0], stretch.rowGeom[1]);
    }
    gl.uniform3fv(u('uBg'), frame.stage);
    PALETTE_UNIFORMS.forEach(([key, name]) => gl.uniform3fv(u(name), frame.palettes[key]));
    gl.uniform1i(u('uMode'), frame.mode);
    gl.uniform1i(u('uOutput'), frame.output ?? 0);
    gl.uniform1i(u('uSelect'), frame.select ?? -1);
    gl.uniform2fv(u('uFocus'), frame.focus ?? [0, 0]);
    gl.uniform4fv(u('uBandGeom'), frame.band ?? [1, 1, 0, 0]);
    gl.uniform4fv(u('uSlotMap'), frame.slot ?? ZERO4);
    gl.uniform4fv(u('uBadge'), frame.badge ?? [1, 1, 0, 1]);
    gl.uniform4fv(u('uRibbon0'), frame.ribbons?.[0] ?? ZERO4);
    gl.uniform4fv(u('uRibbon1'), frame.ribbons?.[1] ?? ZERO4);
    gl.uniform4fv(u('uTile'), frame.tile ?? [1, 1, 0, 0]);
    gl.uniform2fv(u('uTileOrigin'), frame.tileOrigin ?? [0, 0]);
    gl.uniform1f(u('uBgAlpha'), frame.bgAlpha);
    gl.uniform1f(u('uMaxAA'), MAX_AA_PX / frame.view.pxPerEm);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function draw(frame, target) {
    gl.disable(gl.BLEND);
    gl.bindVertexArray(vao);
    if (!field || !frame.view) {
      const [r, g, b] = frame.stage;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.viewport(0, 0, frame.width, frame.height);
      gl.clearColor(r * frame.bgAlpha, g * frame.bgAlpha, b * frame.bgAlpha, frame.bgAlpha);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    drawWarp(frame);
    drawMain(frame, target);
  }

  return {
    maxSize,
    setField,
    setTag,
    setStretch,
    render(frame) {
      if (canvas.width !== frame.width) canvas.width = frame.width;
      if (canvas.height !== frame.height) canvas.height = frame.height;
      const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;
      if (w === frame.width && h === frame.height) {
        draw(frame, null);
        return;
      }
      // The browser allocated a smaller drawing buffer than requested; map onto it.
      const scale = w / frame.width;
      const view = frame.view && {
        centerPx: [frame.view.centerPx[0] * scale, frame.view.centerPx[1] * scale],
        pxPerEm: frame.view.pxPerEm * scale,
        centerEm: frame.view.centerEm,
      };
      draw({ ...frame, width: w, height: h, view }, null);
    },
    /** Renders `frame` off-screen and returns bottom-up, premultiplied RGBA bytes. */
    readPixels(frame) {
      const tex = gl.createTexture();
      const fbo = gl.createFramebuffer();
      try {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, frame.width, frame.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('Export buffer is not supported at this size.');
        }
        draw(frame, fbo);
        const pixels = new Uint8Array(frame.width * frame.height * 4);
        gl.readPixels(0, 0, frame.width, frame.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(tex);
      }
    },
    dispose() {
      gl.deleteProgram(warpProg.program);
      gl.deleteProgram(mainProg.program);
      gl.deleteTexture(fieldTex);
      gl.deleteTexture(bodyTex);
      gl.deleteTexture(warpTex);
      gl.deleteTexture(stretchTex);
      gl.deleteTexture(glyphTex);
      gl.deleteTexture(tagTex);
      gl.deleteFramebuffer(warpFbo);
      gl.deleteVertexArray(vao);
    },
  };
}

/* ── Export helpers (DOM) ─────────────────────────────────────────────────── */

const MOTION_MAX_SIDE = 1920;
const SVG_MAX_SIDE = 2048;
const SVG_EPSILON_PX = 0.3; // contour simplification tolerance
const glslMod = (x, y) => ((x % y) + y) % y;

/** GL pixels (bottom-up, premultiplied) → top-down ImageData, optionally un-premultiplied. */
function pixelsToImageData(pixels, width, height, unpremultiply = true) {
  const image = new ImageData(width, height);
  const out = image.data;
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * rowBytes;
    const dst = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 4) {
      const a = pixels[src + x + 3];
      const k = unpremultiply && a > 0 ? 255 / a : 1;
      out[dst + x] = Math.min(255, Math.round(pixels[src + x] * k));
      out[dst + x + 1] = Math.min(255, Math.round(pixels[src + x + 1] * k));
      out[dst + x + 2] = Math.min(255, Math.round(pixels[src + x + 2] * k));
      out[dst + x + 3] = a;
    }
  }
  return image;
}

function pixelsToCanvas(pixels, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(pixelsToImageData(pixels, width, height), 0, 0);
  return canvas;
}

const canvasToBlob = (canvas) =>
  new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const downloadCanvas = async (canvas, filename) => downloadBlob(await canvasToBlob(canvas), filename);

/**
 * Output size and view for an export of the live design. `scope: 'line'` renders one
 * marquee band (colourway `line`) exactly `repeats` periods wide, starting on a sticker,
 * so the image tiles horizontally. `even` rounds sizes for video encoders.
 */
function exportFraming(live, clock, { scope, line, repeats, maxSide, wholeScale = 2, even = false }) {
  const { layout: L, params: p, stage, scene } = live;
  const size = (px) => (even ? evenSize(px) : Math.max(1, Math.round(px)));
  const fitBox = (box) => {
    const pxPerEm = Math.min(EXPORT_PX_PER_EM, maxSide / Math.max(box.width, box.height));
    const width = size(box.width * pxPerEm);
    const height = size(box.height * pxPerEm);
    const centerEm = [box.x + box.width / 2, box.y + box.height / 2];
    return { width, height, patch: { view: { centerPx: [width / 2, height / 2], pxPerEm, centerEm } } };
  };

  if (scope === 'line' && L.band) {
    const g = L.band;
    const wEm = repeats * g.period;
    const pxPerEm = Math.min(EXPORT_PX_PER_EM, maxSide / wEm);
    const scroll = (clock.shownScroll * MARQUEE_EM_PER_S) % g.period;
    const dir = line % 2 === 0 ? 1 : -1;
    const x0 = glslMod(-(dir * scroll + ((line * 0.618034) % 1) * g.period), g.period);
    const origin = [x0, line * g.bandH];
    return {
      width: size(wEm * pxPerEm),
      height: size(g.bandH * pxPerEm),
      line: true,
      patch: { mode: MODE_INDEX.bands, view: { centerPx: [0, 0], pxPerEm, centerEm: origin }, warpDomain: { origin, size: [wEm, g.bandH] } },
    };
  }
  if (p.design === 'sticker') return fitBox(expandBox(stickerBounds(scene.inkBox, p), 0.08));
  if (p.design === 'badge') return fitBox(L.bounds);
  const scale = Math.min(wholeScale, maxSide / Math.max(stage.width, stage.height));
  return {
    width: size(stage.width * scale),
    height: size(stage.height * scale),
    patch: { view: { centerPx: [0, 0], pxPerEm: L.view.pxPerEm * scale, centerEm: [0, 0] } },
  };
}

/**
 * Traces a rendered export frame into an editable SVG: per colourway, the shader's
 * coverage masks (tape strip, outer stroke, silhouette, letters, tagline) become
 * even-odd paths in named groups, painted back to front like the raster version.
 */
function traceSvg(renderer, frame, live, framing) {
  const { width: W, height: H } = frame;
  const { layout: L, params: p } = live;
  const transparent = frame.bgAlpha === 0;
  const masks = (select, output) => {
    const px = renderer.readPixels({ ...frame, output, select });
    return (c) => {
      const out = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) {
        const src = (H - 1 - y) * W * 4;
        for (let x = 0; x < W; x++) out[y * W + x] = px[src + x * 4 + c];
      }
      return out;
    };
  };
  const trace = (values) => loopsToPath(traceContours(values, W, H).map((l) => simplifyLoop(l, SVG_EPSILON_PX)));
  const groupLayers = (k, prefix, { strip = false, rects = null } = {}) => {
    const pal = L.colours[k];
    const ch = masks(k, 1);
    return [
      ...(rects && !transparent ? [{ id: `${prefix}band`, color: pal.bg, rects }] : []),
      ...(strip ? [{ id: `${prefix}tape`, color: pal.bg, d: trace(masks(k, 2)(0)) }] : []),
      { id: `${prefix}stroke`, color: pal.line, d: trace(ch(2)) },
      { id: `${prefix}silhouette`, color: pal.sil, d: trace(ch(1)) },
      { id: `${prefix}letters`, color: pal.fill, d: trace(ch(0)) },
      { id: `${prefix}tagline`, color: pal.tag, d: trace(ch(3)) },
    ];
  };

  const bands = frame.mode === MODE_INDEX.bands;
  let layers;
  if (bands) {
    const { pxPerEm, centerEm } = frame.view;
    const bandPx = L.band.bandH * pxPerEm;
    const first = Math.floor(centerEm[1] / L.band.bandH);
    const count = Math.ceil(H / bandPx);
    const rectsFor = (k) =>
      Array.from({ length: count }, (_, i) => first + i)
        .filter((b) => b % 3 === k)
        .map((b) => ({ x: 0, y: (b * L.band.bandH - centerEm[1]) * pxPerEm, width: W, height: bandPx }));
    const groups = framing.line ? [live.params.exportLine] : [0, 1, 2];
    layers = groups.flatMap((k) => groupLayers(k, groups.length > 1 ? `band-${k + 1}-` : '', { rects: rectsFor(k) }));
  } else if (frame.mode === MODE_INDEX.ribbon) {
    layers = [0, 1].flatMap((k) => groupLayers(k, `tape-${k + 1}-`, { strip: true }));
  } else if (frame.mode === MODE_INDEX.wallpaper) {
    layers = [0, 1].flatMap((k) => groupLayers(k, `tile-${k ? 'b' : 'a'}-`));
  } else {
    layers = groupLayers(0, '');
  }
  const background = transparent || bands ? null : L.stage ?? p.bg;
  return buildSvg({ width: W, height: H, background, layers });
}

const canStepCapture =
  typeof CanvasCaptureMediaStreamTrack !== 'undefined' && 'requestFrame' in CanvasCaptureMediaStreamTrack.prototype;

/** Records `frames` rendered frames to a video file in real time at `fps`. */
async function recordVideo({ width, height, fps, frames, renderPixels, type, onProgress, cancelled }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(canStepCapture ? 0 : fps);
  const [track] = stream.getVideoTracks();
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 16_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = (e) => reject(e.error ?? new Error('Recording failed'));
  });
  recorder.start(250);
  const t0 = performance.now();
  for (let i = 0; i < frames && !cancelled(); i++) {
    ctx.putImageData(pixelsToImageData(renderPixels(i), width, height, false), 0, 0);
    if (canStepCapture) track.requestFrame();
    onProgress((i + 1) / frames);
    const wait = t0 + ((i + 1) * 1000) / fps - performance.now();
    await new Promise((r) => setTimeout(r, Math.max(0, wait)));
  }
  recorder.stop();
  await stopped;
  track.stop();
  return new Blob(chunks, { type: type.split(';')[0] });
}

/** Renders `frames` frames to PNGs (alpha kept) and packs them into a ZIP. */
async function renderSequence({ width, height, frames, renderPixels, onProgress, cancelled }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const files = [];
  for (let i = 0; i < frames && !cancelled(); i++) {
    ctx.putImageData(pixelsToImageData(renderPixels(i), width, height, true), 0, 0);
    const blob = await canvasToBlob(canvas);
    files.push({ name: `frame_${String(i + 1).padStart(4, '0')}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
    onProgress((i + 1) / frames);
  }
  return zipStore(files);
}

/* ── Frame assembly ───────────────────────────────────────────────────────── */

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

const currentDpr = () => clamp(window.devicePixelRatio || 1, 1, 2);

/**
 * Stretch + italic state for one frame: break points and slants per row (the caret and
 * selection follow the letters with them), the per-texel offset/letter texture and the
 * letter table. One-line designs give every band, tape and ring repeat its own rhythm.
 * `cache` keeps both buffers between frames.
 */
function computeStretchFrame(scene, params, time, rowCount, cache) {
  if (!scene || scene.empty || !(params.stretch > 0 || params.italic > 0)) return null;
  const rows = DESIGN_INFO[params.design]?.line
    ? Array.from({ length: rowCount }, (_, b) => ({ row: scene.layout.rows[0], seed: b + 1 }))
    : scene.layout.rows.map((row, i) => ({ row, seed: i + 1 }));
  const texels = clamp(Math.ceil(scene.fieldSize[0] * STRETCH_TEXELS_PER_EM), 16, 2048);
  const size = texels * rows.length * 2;
  if (cache.data?.length !== size) cache.data = new Float32Array(size);
  const letters = Math.max(...rows.map(({ row }) => row.chars.length)) + 1;
  const tableSize = letters * rows.length * 4;
  if (cache.glyphs?.length !== tableSize) cache.glyphs = new Float32Array(tableSize);
  const dx = scene.fieldSize[0] / texels;
  const breaks = rows.map(({ row, seed }, r) => {
    const widths = row.chars.map((_, k) => Math.max(row.stops[k + 1] - row.stops[k], 1e-4));
    const fixed = row.chars.map((c) => c.trim() === '');
    const b = stretchBreaks(row, stretchScales(widths, time, params.stretch, seed, fixed));
    // Letters busy extending stay upright, so stretch and italic land on different letters.
    const hold = Math.min(1, params.stretch * 3);
    const busy = hold > 0 ? stretchBumps(widths, time, seed, fixed).map((v) => v * hold) : null;
    const slants = italicSlants(widths, time, params.italic, seed, fixed, busy);
    fillStretchRow(cache.data, r * texels, texels, scene.fieldOrigin[0], dx, b);
    fillGlyphRow(cache.glyphs, r * letters, letters, b, slants, fixed);
    return { ...b, slants };
  });
  return {
    data: cache.data,
    width: texels,
    rows: rows.length,
    glyphs: cache.glyphs,
    letters,
    breaks,
    domain: [scene.fieldOrigin[0], scene.fieldSize[0]],
  };
}

/**
 * Shader inputs for the live view. `clock.shown` is the pose on screen: it tracks
 * `clock.time` in smooth mode but only advances on boil steps, so unrelated re-renders
 * never draw in-between poses. Scroll offsets wrap on each design's own period.
 */
function frameFromLive(live, clock, stretch) {
  const { params: p, stage, dpr, layout: L } = live;
  const view = L?.view;
  const scroll = clock.shownScroll * MARQUEE_EM_PER_S;
  return {
    width: Math.max(1, Math.round(stage.width * dpr)),
    height: Math.max(1, Math.round(stage.height * dpr)),
    time: foldTime(clock.shown),
    seed: clock.seed,
    boil: p.boil ? 1 : 0,
    ...effectUniforms(p),
    texture: textureUniforms(p, view?.pxPerEm, clock.shown),
    sticker: p.sticker ? 1 : 0,
    mode: L?.mode ?? 0,
    stage: L?.stageRgb ?? hexToRgb01(p.bg),
    palettes: L?.palettes,
    bgAlpha: 1,
    view: view && {
      centerPx: [view.center[0] * dpr, view.center[1] * dpr],
      pxPerEm: view.pxPerEm * dpr,
      centerEm: view.centerEm,
    },
    warpDomain: L?.warpDomain ?? null,
    stretch: stretch && { domain: stretch.domain, rowGeom: live.rowGeom },
    focus: L?.focus,
    ...(L?.band && { band: [L.band.bandH, L.band.period, L.band.tagSlotX, scroll % L.band.period], slot: L.band.slot }),
    ...(L?.badge && {
      badge: [L.badge.radius, L.badge.repeats, scroll % (L.badge.repeats * L.badge.period), L.badge.period],
      slot: L.badge.slot,
    }),
    ...(L?.ribbons && { ribbons: L.ribbons.map((r, i) => [r.cy, r.amp, r.k, r.phase + clock.shown * (i ? -0.21 : 0.27)]) }),
    ...(L?.tile && { tile: [L.tile.width, L.tile.height, TILE_ANGLE, scroll % (2 * L.tile.width)], tileOrigin: L.tile.origin }),
  };
}

/** Slides the caret and selection boxes along with the stretched letters (per-frame DOM writes). */
function syncOverlays(live, stretch, caretEl, selectionEl) {
  const px = live.view?.pxPerEm ?? 0;
  const mapX = (row, x) => {
    const b = stretch?.breaks[row];
    return b ? mapBreaks(b.F, b.D, x) : x;
  };
  if (caretEl && live.caretEm) {
    const { row, x } = live.caretEm;
    const shown = mapX(row, x);
    const b = stretch?.breaks[row];
    caretEl.style.translate = `${(shown - x) * px}px 0`;
    caretEl.style.transform = `skewX(${-Math.atan(b ? slantAt(shown, b.D, b.slants) : 0)}rad)`;
  }
  if (selectionEl) {
    Array.from(selectionEl.children).forEach((el, i) => {
      const s = live.selectionEm[i];
      if (!s) return;
      const x0 = mapX(s.row, s.x0);
      const x1 = mapX(s.row, s.x1);
      el.style.translate = `${(x0 - s.x0) * px}px 0`;
      el.style.scale = `${s.x1 > s.x0 ? (x1 - x0) / (s.x1 - s.x0) : 1} 1`;
    });
  }
}

/* ── Styles that Tailwind utilities can't express ─────────────────────────── */

const STYLES = `
.rsw-mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
.rsw-range{-webkit-appearance:none;appearance:none;width:100%;height:18px;background:transparent;cursor:pointer}
.rsw-range:focus{outline:none}
.rsw-range::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:linear-gradient(90deg,${ACCENT} var(--pct),rgba(255,255,255,.12) var(--pct))}
.rsw-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;margin-top:-5px;border:0;border-radius:999px;background:#fff;box-shadow:0 0 0 3px rgba(255,200,248,.22),0 2px 6px rgba(0,0,0,.6);transition:transform .12s}
.rsw-range:active::-webkit-slider-thumb{transform:scale(1.18)}
.rsw-range:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 4px ${ACCENT}}
.rsw-range::-moz-range-track{height:4px;border-radius:999px;background:rgba(255,255,255,.12)}
.rsw-range::-moz-range-progress{height:4px;border-radius:999px;background:${ACCENT}}
.rsw-range::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:999px;background:#fff;box-shadow:0 0 0 3px rgba(255,200,248,.22)}
.rsw-range:focus-visible::-moz-range-thumb{box-shadow:0 0 0 4px ${ACCENT}}
.rsw-scroll{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.14) transparent}
@keyframes rsw-blink{0%,49%{opacity:1}50%,100%{opacity:0}}
.rsw-caret{animation:rsw-blink 1.06s steps(1,end) infinite}
@keyframes rsw-pop{from{opacity:0;transform:translateY(-6px) scale(.98)}to{opacity:1;transform:none}}
.rsw-pop{animation:rsw-pop .18s ease-out both}
@media (prefers-reduced-motion:reduce){.rsw-caret,.rsw-pop{animation:none}}
`;

/* ── UI atoms ─────────────────────────────────────────────────────────────── */

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ffc8f8]/70';

function Section({ icon: Icon, title, children }) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <section className="border-t border-white/[0.06] first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className={`flex w-full items-center gap-2.5 px-4 py-3 text-left hover:bg-white/[0.02] ${focusRing}`}
      >
        <Icon size={14} className="text-[#ffc8f8]" aria-hidden />
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/60">{title}</span>
        <ChevronDown size={14} className={`text-white/35 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden />
      </button>
      <div id={bodyId} hidden={!open} className="space-y-3.5 px-4 pb-4">
        {children}
      </div>
    </section>
  );
}

const RADIO_KEYS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Arrow-key navigation for a radiogroup whose options carry `data-value`. */
function onRadioGroupKeyDown(event, values, value, onChange) {
  const delta = RADIO_KEYS[event.key];
  if (!delta) return;
  event.preventDefault();
  const next = values[(values.indexOf(value) + delta + values.length) % values.length];
  onChange(next);
  event.currentTarget.querySelector(`[data-value="${CSS.escape(next)}"]`)?.focus();
}

function Slider({ label, value, onChange, range, format, disabled = false }) {
  const id = useId();
  const pct = ((value - range.min) / (range.max - range.min)) * 100;
  return (
    <div className={disabled ? 'opacity-40' : undefined}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[12px] text-white/70">
          {label}
        </label>
        <span className="rsw-mono text-[11px] tabular-nums text-white/60">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rsw-range disabled:cursor-not-allowed"
        style={{ '--pct': `${pct}%` }}
      />
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-2 rounded-lg py-1 pr-1 text-[12px] text-white/75 hover:text-white ${focusRing}`}
    >
      <span className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${checked ? 'bg-[#ffc8f8]' : 'bg-white/15'}`}>
        <span
          className={`absolute left-0 top-[2px] h-[14px] w-[14px] rounded-full shadow transition-transform ${
            checked ? 'translate-x-[16px] bg-[#0c0c0f]' : 'translate-x-[2px] bg-white'
          }`}
        />
      </span>
      {label}
    </button>
  );
}

function Segmented({ label, value, options, onChange }) {
  return (
    <div>
      <p className="mb-1.5 text-[12px] text-white/70">{label}</p>
      <div
        role="radiogroup"
        aria-label={label}
        onKeyDown={(e) => onRadioGroupKeyDown(e, options.map((o) => o.value), value, onChange)}
        className="flex gap-1 rounded-xl border border-white/10 bg-black/30 p-1"
      >
        {options.map(({ value: v, label: optLabel, icon: Icon }) => {
          const active = v === value;
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={optLabel}
              title={optLabel}
              tabIndex={active ? 0 : -1}
              data-value={v}
              onClick={() => onChange(v)}
              className={`flex h-8 flex-1 items-center justify-center rounded-lg text-[12px] font-medium transition-colors ${focusRing} ${
                active ? 'bg-[#ffc8f8] text-[#140a12]' : 'text-white/60 hover:bg-white/[0.07] hover:text-white'
              }`}
            >
              {Icon ? <Icon size={15} aria-hidden /> : optLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2 hover:bg-white/[0.06] focus-within:ring-2 focus-within:ring-[#ffc8f8]/60">
      <span className="relative h-6 w-6 shrink-0 overflow-hidden rounded-md ring-1 ring-white/20" style={{ background: value }}>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} colour`}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block text-[12px] text-white/80">{label}</span>
        <span className="rsw-mono block text-[10px] uppercase text-white/55">{value}</span>
      </span>
    </label>
  );
}

function ToolButton({ label, onClick, pressed, buttonRef, className = 'grid', children }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      className={`group relative h-10 w-10 place-items-center rounded-xl transition-colors ${className} ${focusRing} ${
        pressed ? 'bg-[#ffc8f8] text-[#140a12]' : 'text-white/75 hover:bg-white/10 hover:text-white'
      }`}
    >
      {children}
      <span className="pointer-events-none absolute bottom-full mb-2.5 whitespace-nowrap rounded-md bg-white px-2 py-1 text-[11px] font-medium text-black opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        {label}
      </span>
    </button>
  );
}

const ToolDivider = () => <span className="mx-0.5 h-6 w-px bg-white/10" aria-hidden />;

const fmt = {
  px: (v) => `${Math.round(v)}px`,
  times: (v) => `${v.toFixed(2)}×`,
  em: (v) => `${v > 0 ? '+' : ''}${v.toFixed(3)}em`,
  emAbs: (v) => `${v.toFixed(3)}em`,
  pct: (v) => `${Math.round(v * 100)}%`,
  fps: (v) => `${v} fps`,
  levels: (v) => `${v} levels`,
};

const TOAST_ICONS = { success: Check, info: Info, warn: TriangleAlert, error: TriangleAlert };

/* ── Component ────────────────────────────────────────────────────────────── */

export default function RetroStickerWarp({
  initialText = DEFAULT_TEXT,
  initialTagline = DEFAULT_TAGLINE,
  initialSettings,
  className = '',
}) {
  const [text, setText] = useState(() => sanitizeInput(initialText));
  const [tagline, setTagline] = useState(() => sanitizeTagline(initialTagline));
  const [params, setParams] = useState(() => sanitizeParams(initialSettings));
  const [uploadedFonts, setUploadedFonts] = useState([]);
  const [tagScene, setTagScene] = useState(null);
  const [tagFontReady, setTagFontReady] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const [panelPref, setPanelPref] = useState(null); // null → follow the stage width until toggled
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [panelRect, setPanelRect] = useState(null);
  const [scene, setScene] = useState(null);
  const [fontState, setFontState] = useState({ family: null, loaded: false });
  const [typing, setTyping] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [toast, setToast] = useState(null);
  const [job, setJob] = useState(null); // running export: { kind, label, progress }
  const [glError, setGlError] = useState(null);
  const [rendererVersion, setRendererVersion] = useState(0);
  const [glyphEpoch, setGlyphEpoch] = useState(0); // bumps when extra font subsets arrive

  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const panelRef = useRef(null);
  const panelToggleRef = useRef(null);
  const panelCloseRef = useRef(null);
  const focusAfterPanelRef = useRef(null); // 'panel' | 'text' | 'toggle' — focus target after toggling
  const typeRef = useRef(null);
  const panelTextRef = useRef(null);
  const caretRequestRef = useRef(null);
  const caretElRef = useRef(null);
  const selectionLayerRef = useRef(null);
  const rasterRef = useRef(null);
  const tagRasterRef = useRef(null);
  const rendererRef = useRef(null);
  const liveRef = useRef(null);
  const dirtyRef = useRef(true);
  const clockRef = useRef({ time: 0, shown: 0, scroll: 0, shownScroll: 0, seed: 0 });
  const stretchRef = useRef(null); // latest per-frame stretch (break points per row)
  const stretchCacheRef = useRef({});
  const jobCancelRef = useRef(false);
  const baseRef = useRef(null);
  const fontRequestsRef = useRef(new Set());
  const uploadedFontsRef = useRef(uploadedFonts);

  const { design } = params;
  const oneLine = DESIGN_INFO[design].line; // the lockup set on one line, with a tagline
  const isSticker = design === 'sticker'; // the only design you type on directly
  const bandLike = design === 'bands' || design === 'ribbon'; // band themes + single-line export
  const panelOpen = panelPref ?? stage.width >= PANEL_AUTO_OPEN_WIDTH;
  const lines = useMemo(() => displayLines(text, params.caps), [text, params.caps]);
  const fieldLines = useMemo(() => (oneLine ? [bandLine(lines)] : lines), [oneLine, lines]);
  const fontOptions = useMemo(() => [DEFAULT_FONT, ...uploadedFonts], [uploadedFonts]);
  const fontEntry = fontOptions.find((f) => f.id === params.fontId) ?? DEFAULT_FONT;
  const free = useMemo(() => computeFreeArea(stage, panelRect), [stage, panelRect]);
  const layout = useMemo(
    () => designLayout({ design, scene, tagBox: oneLine ? (tagScene?.inkBox ?? null) : null, params, stage, free }),
    [design, oneLine, scene, tagScene, params, stage, free],
  );
  const view = layout?.view ?? null;
  const rowGeom = useMemo(
    () =>
      scene && !scene.empty
        ? [scene.layout.rows[0].baseline - scene.layout.capHeight / 2, scene.layout.gap]
        : [0, 1],
    [scene],
  );

  const notify = useCallback((tone, message) => setToast({ tone, message, id: Math.random() }), []);
  const update = useCallback((key, value) => setParams((prev) => sanitizeParams({ ...prev, [key]: value })), []);
  const applyPalette = useCallback(
    (pal) => setParams((prev) => sanitizeParams({ ...prev, fill: pal.fill, sil: pal.sil, line: pal.line, bg: pal.bg })),
    [],
  );

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  // Stage size.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setStage((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Panel footprint, so the sticker centres in the space the panel leaves free.
  useEffect(() => {
    const panel = panelRef.current;
    const stageEl = stageRef.current;
    if (!panelOpen || !panel || !stageEl) {
      setPanelRect(null);
      return undefined;
    }
    const measure = () => {
      const p = panel.getBoundingClientRect();
      const s = stageEl.getBoundingClientRect();
      setPanelRect({ x: p.left - s.left, y: p.top - s.top, width: p.width, height: p.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [panelOpen, stage]);

  // WebGL renderer lifecycle (incl. context loss).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let renderer = null;
    const start = () => {
      try {
        renderer = createRenderer(canvas);
        rendererRef.current = renderer;
        setGlError(null);
        setRendererVersion((v) => v + 1);
      } catch (err) {
        console.error('[RetroStickerWarp] renderer failed to start', err);
        rendererRef.current = null;
        setGlError(err instanceof Error ? err.message : String(err));
      }
    };
    const onLost = (event) => {
      event.preventDefault();
      renderer = null;
      rendererRef.current = null;
      setGlError('The graphics context was lost — restoring…');
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', start);
    start();
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', start);
      renderer?.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Typeface loading, with a timeout so a slow network falls back instead of stalling.
  // Uploaded fonts are already loaded into document.fonts when they're registered.
  const { family: fontFamily, uploaded: fontUploaded } = fontEntry;
  useEffect(() => {
    if (fontUploaded) {
      setFontState({ family: fontFamily, loaded: true });
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setFontState((prev) => (prev.family === fontFamily ? prev : { family: fontFamily, loaded: false }));
    }, FONT_TIMEOUT_MS);
    loadFontFamily(fontFamily).then((loaded) => {
      if (cancelled) return;
      clearTimeout(timer);
      setFontState({ family: fontFamily, loaded });
      if (!loaded) notify('warn', `Couldn't load “${fontFamily}” — using a system fallback.`);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fontFamily, fontUploaded, notify]);

  // The marquee tagline's face, fetched the first time the variation is shown.
  useEffect(() => {
    if (!oneLine || tagFontReady) return undefined;
    let cancelled = false;
    const ready = () => !cancelled && setTagFontReady(true);
    const timer = setTimeout(ready, FONT_TIMEOUT_MS);
    loadFontSpec(TAG_FONT.replace('{px}', 64), '0123456789 — augustjuly').then(() => {
      clearTimeout(timer);
      ready();
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [oneLine, tagFontReady]);

  // Uploaded faces live in the global FontFaceSet; release them with the component.
  useEffect(() => {
    uploadedFontsRef.current = uploadedFonts;
  }, [uploadedFonts]);
  useEffect(() => () => uploadedFontsRef.current.forEach((font) => document.fonts.delete(font.face)), []);

  // Google Fonts ships unicode-range subsets; fetch the ones this text needs, then rebuild.
  const requestMissingGlyphs = useCallback((family, sample) => {
    const spec = `64px "${family}"`;
    const requested = fontRequestsRef.current;
    const key = `${family}|${sample}`;
    if (!document.fonts?.check || document.fonts.check(spec, sample) || requested.has(key)) return;
    if (requested.size > 200) requested.clear();
    requested.add(key);
    document.fonts
      .load(spec, sample)
      .then((faces) => faces.length > 0 && setGlyphEpoch((e) => e + 1))
      .catch((err) => console.error('[RetroStickerWarp] font subset failed to load', err));
  }, []);

  // Rebuild the distance field when text or type settings change (coalesced per frame).
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !fontState.family) return undefined;
    const handle = requestAnimationFrame(() => {
      try {
        const settings = [params.lineSpacing, params.tracking, params.align];
        const key = JSON.stringify([fieldLines, fontState, settings, renderer.maxSize, glyphEpoch]);
        if (baseRef.current?.key !== key) {
          rasterRef.current ??= document.createElement('canvas');
          baseRef.current = {
            key,
            ...rasterizeSticker(rasterRef.current, {
              lines: fieldLines,
              family: fontState.family,
              lineSpacing: params.lineSpacing,
              tracking: params.tracking,
              align: params.align,
              maxSide: renderer.maxSize,
            }),
          };
          if (fontState.loaded) requestMissingGlyphs(fontState.family, fieldLines.join(''));
        }
        const base = baseRef.current;
        renderer.setField(
          base.empty
            ? null
            : {
                width: base.width,
                height: base.height,
                originEm: base.originEm,
                sizeEm: base.sizeEm,
                body: { width: base.sil.width, height: base.sil.height },
                data: buildFieldData(base, params.goo),
              },
        );
        setScene({
          layout: base.layout,
          inkBox: base.inkBox,
          empty: base.empty,
          fieldOrigin: base.originEm,
          fieldSize: base.sizeEm,
        });
        dirtyRef.current = true;
      } catch (err) {
        console.error('[RetroStickerWarp] failed to build the sticker', err);
        notify('error', 'Could not build the sticker for this text.');
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [
    fieldLines,
    fontState,
    params.lineSpacing,
    params.tracking,
    params.align,
    params.goo,
    rendererVersion,
    glyphEpoch,
    requestMissingGlyphs,
    notify,
  ]);

  // The marquee tagline: plain small print, rebuilt only when its text changes.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return undefined;
    if (!oneLine || !tagFontReady) {
      if (!oneLine) {
        renderer.setTag(null);
        setTagScene(null);
      }
      return undefined;
    }
    const handle = requestAnimationFrame(() => {
      try {
        tagRasterRef.current ??= document.createElement('canvas');
        const tag = rasterizeTagline(tagRasterRef.current, tagline.split('\n'), renderer.maxSize);
        renderer.setTag(tag);
        setTagScene(tag ? { inkBox: tag.inkBox } : null);
        dirtyRef.current = true;
      } catch (err) {
        console.error('[RetroStickerWarp] failed to build the tagline', err);
        notify('error', 'Could not draw the tagline.');
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [oneLine, tagFontReady, tagline, rendererVersion, notify]);

  // Caret and selection in em; the render loop slides them along with the stretched letters.
  const caretEm = useMemo(() => {
    if (!isSticker || !typing || !scene || selection.start !== selection.end) return null;
    const { row, col } = caretToRowCol(text, selection.end);
    const g = caretGeometry(scene.layout, row, col);
    return g && { row: Math.min(row, scene.layout.rows.length - 1), ...g };
  }, [isSticker, typing, scene, selection, text]);

  const selectionEm = useMemo(() => {
    if (!isSticker || !typing || !scene || selection.start === selection.end) return [];
    const firstRow = caretToRowCol(text, Math.min(selection.start, selection.end)).row;
    return selectionRects(scene.layout, text, selection.start, selection.end).map((r, i) => ({
      row: firstRow + i,
      x0: r.x,
      x1: r.x + r.width,
      top: r.top,
      bottom: r.bottom,
    }));
  }, [isSticker, typing, scene, selection, text]);

  // Hand the latest state to the render loop without restarting it.
  useEffect(() => {
    liveRef.current = {
      params,
      playing,
      view,
      stage,
      scene,
      layout,
      rowGeom,
      caretEm,
      selectionEm,
      dpr: currentDpr(),
    };
    dirtyRef.current = true;
  });

  // Render loop: smooth every frame, or stepped "boil" at a fixed frame rate.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastStep = -1;
    let reported = false;
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      const renderer = rendererRef.current;
      const live = liveRef.current;
      const dt = clamp((now - last) / 1000, 0, 0.1);
      last = now;
      if (!renderer || !live || live.stage.width === 0) return;
      let due = dirtyRef.current;
      if (live.playing) {
        const { params: p } = live;
        const clock = clockRef.current;
        const time = clock.time + dt * p.speed;
        const scroll = clock.scroll + dt * p.scroll;
        let { shown, shownScroll, seed } = clock;
        const boilStep = Math.floor((now / 1000) * p.boilFps);
        if (!p.boil || boilStep !== lastStep) {
          shown = time;
          shownScroll = scroll;
          due = true;
          if (p.boil) {
            lastStep = boilStep;
            seed = boilStep % 3; // cycle three "redraws", like hand-drawn line boil
          }
        }
        clockRef.current = { time, shown, scroll, shownScroll, seed };
      }
      if (!due) return;
      dirtyRef.current = false;
      try {
        const clock = clockRef.current;
        const stretch = computeStretchFrame(live.scene, live.params, clock.shown, live.layout?.rows ?? 1, stretchCacheRef.current);
        if (stretch) renderer.setStretch(stretch);
        stretchRef.current = stretch;
        renderer.render(frameFromLive(live, clock, stretch));
        syncOverlays(live, stretch, caretElRef.current, selectionLayerRef.current);
      } catch (err) {
        if (!reported) console.error('[RetroStickerWarp] render failed', err);
        reported = true;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ── Typing on the stage ── */

  const syncSelection = useCallback(() => {
    const ta = typeRef.current;
    if (!ta) return;
    const { selectionStart: start, selectionEnd: end } = ta;
    setSelection((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  // After a cleaned edit re-renders the textarea, put the caret back where the user was.
  useLayoutEffect(() => {
    const request = caretRequestRef.current;
    if (!request) return;
    caretRequestRef.current = null;
    request.el.setSelectionRange(request.pos, request.pos);
  });

  const onTextChange = useCallback(
    (event) => {
      const el = event.currentTarget;
      const { value, selectionEnd } = el;
      const next = cleanText(value);
      if (!withinLimits(next)) {
        // Refuse the whole edit instead of silently trimming text elsewhere. React restores
        // the previous value after this handler; the microtask then restores the caret.
        const pos = clamp(selectionEnd - (value.length - text.length), 0, text.length);
        queueMicrotask(() => el.setSelectionRange(pos, pos));
        notify('info', LIMIT_MESSAGE);
        return;
      }
      if (next !== value) caretRequestRef.current = { el, pos: cleanText(value.slice(0, selectionEnd)).length };
      setText(next);
      requestAnimationFrame(syncSelection);
    },
    [text, notify, syncSelection],
  );

  const onTextKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape' && event.currentTarget === typeRef.current) {
        event.currentTarget.blur();
      } else if (event.key === 'Enter' && event.currentTarget.value.split('\n').length >= MAX_LINES) {
        event.preventDefault();
        notify('info', LIMIT_MESSAGE);
      }
    },
    [notify],
  );

  const focusTyping = useCallback(
    (index) => {
      // Only the single sticker is typed on directly; the other designs edit in the panel.
      const ta = isSticker ? typeRef.current : panelTextRef.current;
      if (!ta) {
        if (!isSticker) {
          focusAfterPanelRef.current = 'text';
          setPanelPref(true);
        }
        return;
      }
      ta.focus({ preventScroll: true });
      const pos = typeof index === 'number' ? index : ta.value.length;
      ta.setSelectionRange(pos, pos);
      syncSelection();
    },
    [isSticker, syncSelection],
  );

  const placeCaret = useCallback(
    (event) => {
      const ta = typeRef.current;
      const stageEl = stageRef.current;
      if (!ta || !stageEl) return;
      ta.focus({ preventScroll: true });
      if (scene && view && !scene.empty) {
        const rect = stageEl.getBoundingClientRect();
        const [x, y] = cssToEm(view, [event.clientX - rect.left, event.clientY - rect.top]);
        // Undo the current stretch so the click lands on the glyph it visually hit.
        const { row } = hitTestLayout(scene.layout, [x, y]);
        const b = stretchRef.current?.breaks[row];
        const { col } = hitTestLayout(scene.layout, [b ? mapBreaks(b.D, b.F, x) : x, y]);
        const index = rowColToCaret(ta.value, row, col);
        ta.setSelectionRange(index, index);
      }
      syncSelection();
    },
    [scene, view, syncSelection],
  );

  const caret = useMemo(() => {
    if (!caretEm || !view) return null;
    const [x, top] = emToCss(view, [caretEm.x, caretEm.top]);
    const [, bottom] = emToCss(view, [caretEm.x, caretEm.bottom]);
    return { x, top, height: bottom - top, width: Math.max(2, view.pxPerEm * 0.045) };
  }, [caretEm, view]);

  const selectionBoxes = useMemo(
    () =>
      view
        ? selectionEm.map((r) => {
            const [x, top] = emToCss(view, [r.x0, r.top]);
            const [right, bottom] = emToCss(view, [r.x1, r.bottom]);
            return { x, top, width: right - x, height: bottom - top };
          })
        : [],
    [selectionEm, view],
  );

  /* ── Fonts, design ── */

  const onFontFiles = useCallback(
    async (files) => {
      const file = files?.[0];
      if (!file) return;
      const problem = validateFontFile(file);
      if (problem) {
        notify('error', problem); // expected user feedback, not an error to log
        return;
      }
      try {
        const font = await registerUploadedFont(file);
        setUploadedFonts((prev) => [...prev, font]);
        update('fontId', font.id);
        notify('success', `Using “${font.label}”`);
      } catch (err) {
        console.error('[RetroStickerWarp] font upload failed', err);
        notify('error', 'Couldn’t read that font file.');
      }
    },
    [notify, update],
  );

  const removeFont = useCallback(
    (id) => {
      const font = uploadedFonts.find((f) => f.id === id);
      if (!font) return;
      document.fonts.delete(font.face);
      setUploadedFonts((prev) => prev.filter((f) => f.id !== id));
      if (params.fontId === id) update('fontId', DEFAULT_FONT.id);
    },
    [uploadedFonts, params.fontId, update],
  );

  const onDragOver = useCallback((event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    setDropActive(true);
  }, []);

  const onDragLeave = useCallback((event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setDropActive(false);
  }, []);

  const onDrop = useCallback(
    (event) => {
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      setDropActive(false);
      onFontFiles(event.dataTransfer.files);
    },
    [onFontFiles],
  );

  /** Switching design applies that design's recommended look (then everything is tweakable). */
  const setDesign = useCallback((design) => {
    setParams((prev) => (prev.design === design ? prev : sanitizeParams({ ...prev, ...DESIGN_LOOKS[design], design })));
  }, []);

  /* ── Panel ── */

  // Keyboard focus follows the panel so it never falls back to <body> when a control unmounts.
  const setPanel = useCallback((open) => {
    focusAfterPanelRef.current = open ? 'panel' : 'toggle';
    setPanelPref(open);
  }, []);

  useEffect(() => {
    const target = focusAfterPanelRef.current;
    if (!target) return;
    focusAfterPanelRef.current = null;
    const targets = { panel: panelCloseRef, text: panelTextRef, toggle: panelToggleRef };
    const el = targets[target].current ?? typeRef.current;
    el?.focus({ preventScroll: true });
  }, [panelOpen]);

  /* ── Actions ── */

  const clearText = useCallback(() => {
    setText('');
    focusTyping(0);
  }, [focusTyping]);

  const shufflePalette = useCallback(() => {
    if (!bandLike) {
      applyPalette(randomPalette());
      return;
    }
    const next = (BAND_THEMES.findIndex((t) => t.id === params.bandTheme) + 1) % BAND_THEMES.length;
    update('bandTheme', BAND_THEMES[next].id);
  }, [bandLike, params.bandTheme, applyPalette, update]);

  const resetSettings = useCallback(() => {
    setParams((prev) => sanitizeParams({ ...initialSettings, ...DESIGN_LOOKS[prev.design], design: prev.design }));
    notify('info', 'Settings reset');
  }, [initialSettings, notify]);

  /* ── Export ── */

  const exportScope = bandLike ? params.exportScope : 'whole';
  const exportBase = useCallback(
    (suffix = '') => {
      const parts = [fileNameFor(lines).replace(/\.png$/, '')];
      if (design !== 'sticker') parts.push(DESIGN_INFO[design].name.toLowerCase());
      if (exportScope === 'line') parts.push('line');
      if (suffix) parts.push(suffix);
      return parts.join('-');
    },
    [lines, design, exportScope],
  );

  /** Frames an export of the live design; `kind` is 'still', 'svg' or 'motion'. */
  const prepareExport = useCallback((kind) => {
    const renderer = rendererRef.current;
    const live = liveRef.current;
    if (!renderer) throw new Error('The renderer is not ready yet.');
    if (!live?.layout) throw new Error('Nothing to export yet — type something first.');
    const p = live.params;
    const limit = { still: EXPORT_MAX_SIDE, svg: SVG_MAX_SIDE, motion: MOTION_MAX_SIDE }[kind];
    const framing = exportFraming(live, clockRef.current, {
      scope: DESIGN_INFO[p.design].line && live.layout.band ? p.exportScope : 'whole',
      line: p.exportLine,
      repeats: p.exportRepeats,
      maxSide: Math.min(limit, renderer.maxSize),
      wholeScale: kind === 'svg' ? 1 : 2,
      even: kind === 'motion',
    });
    const frameAt = (clock, stretch, bgAlpha) => ({
      ...frameFromLive(live, clock, stretch),
      ...framing.patch,
      width: framing.width,
      height: framing.height,
      bgAlpha,
    });
    return { renderer, live, framing, frameAt };
  }, []);

  const renderSnapshot = useCallback(() => {
    const { renderer, live, frameAt } = prepareExport('still');
    const frame = frameAt(clockRef.current, stretchRef.current, live.params.transparent ? 0 : 1);
    return pixelsToCanvas(renderer.readPixels(frame), frame.width, frame.height);
  }, [prepareExport]);

  const downloadPng = useCallback(async () => {
    try {
      await downloadCanvas(renderSnapshot(), `${exportBase()}.png`);
      notify('success', 'PNG downloaded');
    } catch (err) {
      console.error('[RetroStickerWarp] download failed', err);
      notify('error', err instanceof Error ? err.message : 'Could not export the PNG.');
    }
  }, [renderSnapshot, exportBase, notify]);

  const copyPng = useCallback(async () => {
    let canvas;
    try {
      canvas = renderSnapshot();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Could not export the PNG.');
      return;
    }
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasToBlob(canvas) })]);
      notify('success', 'PNG copied to clipboard');
    } catch (err) {
      console.error('[RetroStickerWarp] clipboard write failed', err);
      try {
        await downloadCanvas(canvas, `${exportBase()}.png`);
        notify('info', 'Clipboard is blocked here — downloaded the PNG instead.');
      } catch (downloadErr) {
        console.error('[RetroStickerWarp] download fallback failed', downloadErr);
        notify('error', 'Could not export the PNG.');
      }
    }
  }, [renderSnapshot, exportBase, notify]);

  const downloadSvg = useCallback(async () => {
    if (job) return;
    setJob({ kind: 'svg', label: 'Tracing SVG…', progress: null });
    try {
      await new Promise((r) => setTimeout(r, 30)); // let the progress pill paint first
      const { renderer, live, framing, frameAt } = prepareExport('svg');
      const frame = frameAt(clockRef.current, stretchRef.current, live.params.transparent ? 0 : 1);
      const svg = traceSvg(renderer, frame, live, framing);
      downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${exportBase()}.svg`);
      notify('success', 'SVG downloaded');
    } catch (err) {
      console.error('[RetroStickerWarp] SVG export failed', err);
      notify('error', err instanceof Error ? err.message : 'Could not export the SVG.');
    } finally {
      setJob(null);
    }
  }, [job, prepareExport, exportBase, notify]);

  /** Video or PNG sequence of `motionSeconds` at `motionFps`, starting from the current pose. */
  const exportMotion = useCallback(
    async (kind) => {
      if (job) return;
      let setup;
      try {
        setup = prepareExport('motion');
      } catch (err) {
        notify('error', err instanceof Error ? err.message : 'Nothing to export yet.');
        return;
      }
      const { renderer, live, framing, frameAt } = setup;
      const { motionFps: fps, motionSeconds: seconds } = live.params;
      const frames = Math.round(fps * seconds);
      const start = clockRef.current;
      const cache = {};
      const alpha = kind === 'frames' && live.params.transparent ? 0 : 1; // video stays opaque
      const renderPixels = (i) => {
        const mc = motionClock(i, fps, live.params);
        const clock = { ...start, shown: start.shown + mc.time, shownScroll: start.shownScroll + mc.scroll, seed: mc.seed };
        const stretch = computeStretchFrame(live.scene, live.params, clock.shown, live.layout.rows, cache);
        if (stretch) renderer.setStretch(stretch);
        return renderer.readPixels(frameAt(clock, stretch, alpha));
      };
      const label = kind === 'video' ? 'Recording video' : 'Rendering PNG frames';
      jobCancelRef.current = false;
      setJob({ kind, label, progress: 0 });
      let lastShown = 0;
      const onProgress = (progress) => {
        if (progress - lastShown < 0.02 && progress < 1) return;
        lastShown = progress;
        setJob((j) => j && { ...j, progress });
      };
      const cancelled = () => jobCancelRef.current;
      const size = { width: framing.width, height: framing.height, fps, frames, renderPixels, onProgress, cancelled };
      try {
        if (kind === 'video') {
          const type = pickVideoType((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t));
          if (!type) throw new Error('This browser can’t record video — try the PNG sequence.');
          const blob = await recordVideo({ ...size, type });
          if (!cancelled()) {
            downloadBlob(blob, `${exportBase()}.${type.includes('mp4') ? 'mp4' : 'webm'}`);
            notify('success', `Video downloaded (${seconds}s, ${fps} fps)`);
          }
        } else {
          const zip = await renderSequence(size);
          if (!cancelled()) {
            downloadBlob(zip, `${exportBase('frames')}.zip`);
            notify('success', `${frames} PNG frames downloaded`);
          }
        }
        if (cancelled()) notify('info', 'Export cancelled');
      } catch (err) {
        console.error('[RetroStickerWarp] motion export failed', err);
        notify('error', err instanceof Error ? err.message : 'The export failed.');
      } finally {
        setJob(null);
        dirtyRef.current = true; // the next live frame re-uploads its own stretch state
      }
    },
    [job, prepareExport, exportBase, notify],
  );

  /* ── Render ── */

  const activePalette = PALETTES.find((p) => COLOR_KEYS.every((k) => p[k] === params[k]))?.id;
  const motionLabel = !playing ? 'paused' : params.boil ? `boil · ${params.boilFps} fps` : 'smooth · 60 fps';
  const designName = DESIGN_INFO[design].name;
  const statusLabel = `${designName.toLowerCase()} · ${motionLabel}`;
  const centerX = free.x + free.width / 2;
  const ToastIcon = toast ? TOAST_ICONS[toast.tone] : null;
  const showToolbar = !(panelOpen && panelRect && panelRect.x <= stage.width * 0.35);
  const bandTheme = BAND_THEMES.find((t) => t.id === params.bandTheme) ?? BAND_THEMES[0];
  const stageColor = design === 'bands' ? bandTheme.bands[0].bg : params.bg;
  const reading = oneLine
    ? `${bandLine(lines) || 'empty'} — ${tagline.replace(/\n/g, ' ')}`
    : lines.join(' ').trim() || 'empty';
  const canvasLabel = { sticker: 'Animated sticker', bands: 'Scrolling marquee' }[design] ?? `${designName} design`;
  const hint = !isSticker
    ? `${designName} — edit the text in the panel`
    : typing
      ? 'Typing — Enter adds a line · Esc to finish'
      : 'Click the sticker and type';
  const nextDesign = DESIGNS[(DESIGNS.indexOf(design) + 1) % DESIGNS.length];

  return (
    <div
      className={`relative h-[100dvh] w-full overflow-hidden bg-black text-white antialiased ${className}`}
      style={{ fontFamily: UI_FONT }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <style>{STYLES}</style>

      {/* Stage */}
      <div ref={stageRef} className="absolute inset-0" style={{ background: stageColor }}>
        <canvas
          ref={canvasRef}
          className="absolute inset-0 block h-full w-full"
          role="img"
          aria-label={`${canvasLabel} reading: ${reading}`}
        />
        {isSticker && (
          <textarea
            ref={typeRef}
            value={text}
            onChange={onTextChange}
            onSelect={syncSelection}
            onKeyUp={syncSelection}
            onKeyDown={onTextKeyDown}
            onFocus={() => {
              setTyping(true);
              syncSelection();
            }}
            onBlur={() => setTyping(false)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={placeCaret}
            maxLength={MAX_CHARS}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize={params.caps ? 'characters' : 'off'}
            aria-label="Type on the sticker"
            className="absolute inset-0 z-10 h-full w-full cursor-text resize-none overflow-hidden bg-transparent p-0 text-base opacity-0 outline-none"
          />
        )}
        {caret && (
          <div
            ref={caretElRef}
            key={`${caret.x}:${caret.top}`}
            className="rsw-caret pointer-events-none absolute z-10 rounded-full"
            style={{
              left: caret.x - caret.width / 2,
              top: caret.top,
              width: caret.width,
              height: caret.height,
              background: ACCENT,
              boxShadow: `0 0 0 1.5px ${params.bg}, 0 0 18px ${ACCENT}`,
            }}
          />
        )}
        <div ref={selectionLayerRef}>
          {selectionBoxes.map((box, i) => (
            <div
              key={i}
              className="rsw-selection pointer-events-none absolute z-10 origin-left rounded-md bg-[#ffc8f8]/35 ring-1 ring-[#ffc8f8]/80"
              style={{ left: box.x, top: box.top, width: box.width, height: box.height }}
            />
          ))}
        </div>
      </div>

      {/* Header */}
      <header className="pointer-events-none absolute left-3 top-3 z-20 flex items-center gap-2.5 rounded-2xl bg-black/55 py-1.5 pl-1.5 pr-3.5 backdrop-blur-md">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#ff1f1f] text-white shadow-[0_0_28px_-6px_#ff1f1f]">
          <Sticker size={17} aria-hidden />
        </span>
        <div className="leading-tight">
          <p className="text-[14px] font-semibold tracking-tight">Sticker Warp</p>
          <p className="rsw-mono text-[10px] uppercase tracking-[0.16em] text-white/70">{statusLabel}</p>
        </div>
      </header>

      {/* Empty-state hint */}
      {scene?.empty && !typing && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-dashed border-white/20 bg-black/40 px-5 py-3 text-center"
          style={{ left: centerX, top: free.y + free.height / 2 }}
        >
          <p className="text-[15px] font-semibold text-white/80">Nothing here yet</p>
          <p className="mt-0.5 text-[12px] text-white/60">
            {isSticker ? 'Click anywhere and start typing' : 'Type the text in the panel'}
          </p>
        </div>
      )}

      {/* Font drop target */}
      {dropActive && (
        <div className="pointer-events-none absolute inset-3 z-50 grid place-items-center rounded-3xl border-2 border-dashed border-[#ffc8f8] bg-black/70 backdrop-blur-sm">
          <div className="text-center">
            <FileUp size={28} className="mx-auto mb-2 text-[#ffc8f8]" aria-hidden />
            <p className="text-[15px] font-semibold">Drop a font to use it</p>
            <p className="mt-1 text-[12px] text-white/65">.ttf · .otf · .woff · .woff2</p>
          </div>
        </div>
      )}

      {/* Toolbar */}
      {showToolbar && (
        <div className="absolute bottom-4 z-20 flex -translate-x-1/2 flex-col items-center gap-2" style={{ left: centerX }}>
          <p className="pointer-events-none flex items-center gap-1.5 whitespace-nowrap rounded-full bg-black/50 px-3 py-1 text-[11px] text-white/65 backdrop-blur">
            <Keyboard size={12} aria-hidden />
            {hint}
          </p>
          <div
            role="toolbar"
            aria-label="Sticker actions"
            className="flex items-center gap-0.5 rounded-2xl border border-white/10 bg-[#0c0c0f]/85 p-1.5 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.9)] backdrop-blur-xl"
          >
            <ToolButton label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying((p) => !p)}>
              {playing ? <Pause size={18} aria-hidden /> : <Play size={18} aria-hidden />}
            </ToolButton>
            <ToolButton label={`Boil mode (${params.boilFps} fps)`} pressed={params.boil} onClick={() => update('boil', !params.boil)}>
              <Film size={18} aria-hidden />
            </ToolButton>
            <ToolDivider />
            <ToolButton label="Sticker body" pressed={params.sticker} onClick={() => update('sticker', !params.sticker)}>
              <Sticker size={18} aria-hidden />
            </ToolButton>
            <ToolButton label={`Design: ${designName} — switch to ${DESIGN_INFO[nextDesign].name}`} onClick={() => setDesign(nextDesign)}>
              <LayoutTemplate size={18} aria-hidden />
            </ToolButton>
            <ToolDivider />
            <ToolButton label="Type on sticker" onClick={() => focusTyping()} className="hidden sm:grid">
              <TextCursorInput size={18} aria-hidden />
            </ToolButton>
            <ToolButton label="Clear text" onClick={clearText}>
              <Eraser size={18} aria-hidden />
            </ToolButton>
            <ToolButton label="Shuffle colours" onClick={shufflePalette} className="hidden sm:grid">
              <Dices size={18} aria-hidden />
            </ToolButton>
            <ToolDivider />
            <button
              type="button"
              onClick={copyPng}
              className={`flex h-10 items-center gap-2 rounded-xl bg-[#ff2020] px-3 text-[13px] font-semibold text-white shadow-[0_6px_20px_-8px_#ff2020] transition-colors hover:bg-[#ff3d3d] ${focusRing}`}
            >
              <Copy size={16} aria-hidden />
              <span className="hidden sm:inline">Copy PNG</span>
              <span className="sr-only sm:hidden">Copy PNG</span>
            </button>
            <ToolButton label="Download PNG" onClick={downloadPng}>
              <Download size={18} aria-hidden />
            </ToolButton>
            <ToolDivider />
            <ToolButton
              label={panelOpen ? 'Hide controls' : 'Show controls'}
              pressed={panelOpen}
              buttonRef={panelToggleRef}
              onClick={() => setPanel(!panelOpen)}
            >
              <SlidersHorizontal size={18} aria-hidden />
            </ToolButton>
          </div>
        </div>
      )}

      {/* Control panel */}
      {panelOpen && (
        <aside
          ref={panelRef}
          aria-label="Sticker controls"
          className="absolute inset-x-2 bottom-2 z-30 flex max-h-[62dvh] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0c0c0f]/90 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.95)] backdrop-blur-xl md:inset-x-auto md:bottom-4 md:right-4 md:top-4 md:max-h-none md:w-[340px]"
        >
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={15} className="text-[#ffc8f8]" aria-hidden />
              <h2 className="text-[13px] font-semibold tracking-tight">Controls</h2>
            </div>
            <button
              ref={panelCloseRef}
              type="button"
              onClick={() => setPanel(false)}
              aria-label="Hide controls"
              className={`grid h-8 w-8 place-items-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white ${focusRing}`}
            >
              <X size={16} aria-hidden />
            </button>
          </div>

          <div className="rsw-scroll flex-1 overflow-y-auto overscroll-contain">
            <Section icon={LayoutTemplate} title="Design">
              <div
                role="radiogroup"
                aria-label="Design"
                onKeyDown={(e) => onRadioGroupKeyDown(e, DESIGNS, design, setDesign)}
                className="grid grid-cols-2 gap-1.5"
              >
                {DESIGNS.map((id) => {
                  const active = id === design;
                  const Icon = DESIGN_ICONS[id];
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      tabIndex={active ? 0 : -1}
                      data-value={id}
                      onClick={() => setDesign(id)}
                      className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-[12px] font-medium transition-colors ${focusRing} ${
                        active ? 'border-[#ffc8f8]/70 bg-[#ffc8f8]/10 text-white' : 'border-white/10 bg-white/[0.03] text-white/75 hover:bg-white/[0.07]'
                      }`}
                    >
                      <Icon size={15} aria-hidden className={active ? 'text-[#ffc8f8]' : 'text-white/55'} />
                      {DESIGN_INFO[id].name}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] leading-relaxed text-white/60">{DESIGN_INFO[design].blurb}</p>
            </Section>

            <Section icon={TextCursorInput} title="Text">
              <textarea
                ref={panelTextRef}
                value={text}
                onChange={onTextChange}
                onKeyDown={onTextKeyDown}
                rows={3}
                maxLength={MAX_CHARS}
                spellCheck={false}
                placeholder="One line per row…"
                aria-label="Sticker text"
                className="block w-full resize-none rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[14px] font-semibold leading-snug tracking-wide text-white placeholder:font-normal placeholder:text-white/30 focus:border-[#ffc8f8]/60 focus:outline-none"
                style={{ textTransform: params.caps ? 'uppercase' : 'none' }}
              />
              {oneLine && (
                <div>
                  <label htmlFor="rsw-tagline" className="mb-1.5 block text-[12px] text-white/70">
                    Tagline
                  </label>
                  <textarea
                    id="rsw-tagline"
                    value={tagline}
                    onChange={(e) => setTagline(sanitizeTagline(e.target.value))}
                    rows={2}
                    maxLength={TAG_MAX_CHARS}
                    spellCheck={false}
                    placeholder="Dates, place…"
                    className="block w-full resize-none rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-[13px] leading-snug text-white placeholder:text-white/30 focus:border-[#ffc8f8]/60 focus:outline-none"
                  />
                </div>
              )}
              <div className="flex items-center gap-2">
                <Toggle label="All caps" checked={params.caps} onChange={(v) => update('caps', v)} />
                <button
                  type="button"
                  onClick={clearText}
                  className={`ml-auto inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[12px] text-white/70 hover:bg-white/[0.06] hover:text-white ${focusRing}`}
                >
                  <Eraser size={13} aria-hidden /> Clear
                </button>
              </div>
              {!oneLine && (
                <Segmented
                  label="Lockup"
                  value={params.align}
                  onChange={(v) => update('align', v)}
                  options={[
                    { value: 'zigzag', label: 'Zigzag' },
                    { value: 'left', label: 'Align left', icon: AlignLeft },
                    { value: 'center', label: 'Align center', icon: AlignCenter },
                    { value: 'right', label: 'Align right', icon: AlignRight },
                  ]}
                />
              )}
            </Section>

            <Section icon={Type} title="Type">
              <div
                role="radiogroup"
                aria-label="Typeface"
                onKeyDown={(e) => onRadioGroupKeyDown(e, fontOptions.map((f) => f.id), fontEntry.id, (id) => update('fontId', id))}
                className="space-y-1.5"
              >
                {fontOptions.map((f) => {
                  const active = fontEntry.id === f.id;
                  return (
                    <div key={f.id} className="flex items-stretch gap-1.5">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={active}
                        tabIndex={active ? 0 : -1}
                        data-value={f.id}
                        onClick={() => update('fontId', f.id)}
                        className={`min-w-0 flex-1 rounded-xl border px-3 py-2 text-left transition-colors ${focusRing} ${
                          active ? 'border-[#ffc8f8]/70 bg-[#ffc8f8]/10' : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07]'
                        }`}
                      >
                        <span className="block truncate text-[16px] leading-tight" style={{ fontFamily: fontStackFor(f.family) }}>
                          {f.label}
                        </span>
                        <span className="rsw-mono mt-0.5 block text-[9.5px] uppercase tracking-wider text-white/55">
                          {f.uploaded ? 'Uploaded' : 'Built in'}
                        </span>
                      </button>
                      {f.uploaded && (
                        <button
                          type="button"
                          onClick={() => removeFont(f.id)}
                          aria-label={`Remove ${f.label}`}
                          className={`grid w-9 shrink-0 place-items-center rounded-xl border border-white/10 text-white/60 hover:bg-white/[0.07] hover:text-white ${focusRing}`}
                        >
                          <X size={14} aria-hidden />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-white/20 px-3 py-2.5 text-[12px] text-white/75 hover:bg-white/[0.06] hover:text-white focus-within:ring-2 focus-within:ring-[#ffc8f8]/60">
                <FileUp size={14} aria-hidden />
                Upload font
                <span className="rsw-mono text-[10px] text-white/55">ttf · otf · woff</span>
                <input
                  type="file"
                  accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
                  className="sr-only"
                  aria-label="Upload a font file"
                  onChange={(e) => {
                    onFontFiles(e.target.files);
                    e.target.value = ''; // allow picking the same file again
                  }}
                />
              </label>
              <Slider label="Size" value={params.fontSize} range={RANGES.fontSize} format={fmt.px} onChange={(v) => update('fontSize', v)} />
              {!oneLine && (
                <Slider label="Line spacing" value={params.lineSpacing} range={RANGES.lineSpacing} format={fmt.times} onChange={(v) => update('lineSpacing', v)} />
              )}
              <Slider label="Tracking" value={params.tracking} range={RANGES.tracking} format={fmt.em} onChange={(v) => update('tracking', v)} />
              <Slider label="Weight" value={params.weight} range={RANGES.weight} format={fmt.em} onChange={(v) => update('weight', v)} />
            </Section>

            <Section icon={Waves} title="Warp">
              <Slider label="Speed" value={params.speed} range={RANGES.speed} format={fmt.times} onChange={(v) => update('speed', v)} />
              <Slider label="Intensity" value={params.intensity} range={RANGES.intensity} format={fmt.pct} onChange={(v) => update('intensity', v)} />
              <Slider label="Frequency" value={params.frequency} range={RANGES.frequency} format={fmt.times} onChange={(v) => update('frequency', v)} />
              <Slider label="Swell" value={params.swell} range={RANGES.swell} format={fmt.pct} onChange={(v) => update('swell', v)} />
              <Slider label="Stretch" value={params.stretch} range={RANGES.stretch} format={fmt.pct} onChange={(v) => update('stretch', v)} />
              <Slider label="Italic" value={params.italic} range={RANGES.italic} format={fmt.pct} onChange={(v) => update('italic', v)} />
              {!isSticker && (
                <Slider
                  label={design === 'badge' ? 'Spin' : 'Scroll'}
                  value={params.scroll}
                  range={RANGES.scroll}
                  format={fmt.times}
                  onChange={(v) => update('scroll', v)}
                />
              )}
              <Segmented
                label="Motion"
                value={params.boil ? 'boil' : 'smooth'}
                onChange={(v) => update('boil', v === 'boil')}
                options={[
                  { value: 'smooth', label: 'Smooth 60' },
                  { value: 'boil', label: 'Boil (stop-motion)' },
                ]}
              />
              {params.boil && (
                <Slider label="Boil frame rate" value={params.boilFps} range={RANGES.boilFps} format={fmt.fps} onChange={(v) => update('boilFps', v)} />
              )}
            </Section>

            <Section icon={Sticker} title="Sticker">
              <Toggle label="Sticker body & outline" checked={params.sticker} onChange={(v) => update('sticker', v)} />
              <Slider
                label="Silhouette"
                value={params.pad}
                range={RANGES.pad}
                format={fmt.emAbs}
                disabled={!params.sticker}
                onChange={(v) => update('pad', v)}
              />
              <Slider
                label="Outer stroke"
                value={params.stroke}
                range={RANGES.stroke}
                format={fmt.emAbs}
                disabled={!params.sticker}
                onChange={(v) => update('stroke', v)}
              />
              <Slider label="Goo" value={params.goo} range={RANGES.goo} format={fmt.pct} onChange={(v) => update('goo', v)} />
            </Section>

            <Section icon={Blend} title="Texture">
              <Slider label="Grain" value={params.grain} range={RANGES.grain} format={fmt.pct} onChange={(v) => update('grain', v)} />
              <Slider label="Halftone" value={params.halftone} range={RANGES.halftone} format={fmt.pct} onChange={(v) => update('halftone', v)} />
              <Slider
                label="Dot size"
                value={params.dotSize}
                range={RANGES.dotSize}
                format={fmt.px}
                disabled={!params.halftone}
                onChange={(v) => update('dotSize', v)}
              />
              <Slider label="Dither" value={params.dither} range={RANGES.dither} format={fmt.pct} onChange={(v) => update('dither', v)} />
              <Slider
                label="Dither levels"
                value={params.ditherLevels}
                range={RANGES.ditherLevels}
                format={fmt.levels}
                disabled={!params.dither}
                onChange={(v) => update('ditherLevels', v)}
              />
              <Slider
                label="Dither pixel"
                value={params.ditherPixel}
                range={RANGES.ditherPixel}
                format={fmt.px}
                disabled={!params.dither}
                onChange={(v) => update('ditherPixel', v)}
              />
              <p className="text-[11px] leading-relaxed text-white/60">Textures render into PNG and video exports; SVG stays clean vectors.</p>
            </Section>

            <Section icon={Palette} title="Colours">
              {bandLike ? (
                <div role="radiogroup" aria-label="Band theme" className="grid grid-cols-3 gap-1.5">
                  {BAND_THEMES.map((theme) => {
                    const active = theme.id === bandTheme.id;
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => update('bandTheme', theme.id)}
                        className={`overflow-hidden rounded-xl border text-left transition-colors ${focusRing} ${
                          active ? 'border-[#ffc8f8]/80' : 'border-white/10 hover:border-white/30'
                        }`}
                      >
                        {theme.bands.map((band) => (
                          <span key={band.bg} className="flex h-4 items-center px-2" style={{ background: band.bg }}>
                            <span className="h-1.5 w-6 rounded-full" style={{ background: band.fill, boxShadow: `0 0 0 1.5px ${band.line}` }} />
                          </span>
                        ))}
                        <span className="block px-2 py-1 text-[11px] text-white/75">{theme.name}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <>
              <div className="grid grid-cols-2 gap-2">
                <ColorField label="Text" value={params.fill} onChange={(v) => update('fill', v)} />
                <ColorField label="Silhouette" value={params.sil} onChange={(v) => update('sil', v)} />
                <ColorField label="Stroke" value={params.line} onChange={(v) => update('line', v)} />
                <ColorField label="Stage" value={params.bg} onChange={(v) => update('bg', v)} />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PALETTES.map((pal) => (
                  <button
                    key={pal.id}
                    type="button"
                    onClick={() => applyPalette(pal)}
                    aria-pressed={activePalette === pal.id}
                    className={`inline-flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-[11px] transition-colors ${focusRing} ${
                      activePalette === pal.id ? 'border-[#ffc8f8]/70 bg-[#ffc8f8]/10 text-white' : 'border-white/10 text-white/65 hover:bg-white/[0.06]'
                    }`}
                  >
                    <span className="grid h-5 w-5 place-items-center rounded-full" style={{ background: pal.line }}>
                      <span className="grid h-3.5 w-3.5 place-items-center rounded-full" style={{ background: pal.sil }}>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: pal.fill }} />
                      </span>
                    </span>
                    {pal.name}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={shufflePalette}
                  className={`inline-flex items-center gap-1.5 rounded-full border border-dashed border-white/20 px-2.5 py-1 text-[11px] text-white/65 hover:bg-white/[0.06] hover:text-white ${focusRing}`}
                >
                  <Dices size={13} aria-hidden /> Shuffle
                </button>
              </div>
                </>
              )}
            </Section>

            <Section icon={Download} title="Export">
              {bandLike && (
                <Segmented
                  label="Scope"
                  value={params.exportScope}
                  onChange={(v) => update('exportScope', v)}
                  options={[
                    { value: 'whole', label: 'Whole design' },
                    { value: 'line', label: 'Single line' },
                  ]}
                />
              )}
              {exportScope === 'line' && (
                <>
                  <div>
                    <p className="mb-1.5 text-[12px] text-white/70">Line colourway</p>
                    <div role="radiogroup" aria-label="Line colourway" className="flex gap-1.5">
                      {bandTheme.bands.map((band, k) => (
                        <button
                          key={band.bg}
                          type="button"
                          role="radio"
                          aria-checked={params.exportLine === k}
                          aria-label={`Colourway ${k + 1}`}
                          onClick={() => update('exportLine', k)}
                          className={`grid h-8 flex-1 place-items-center rounded-lg border transition ${focusRing} ${
                            params.exportLine === k ? 'border-[#ffc8f8] ring-2 ring-[#ffc8f8]/60' : 'border-white/15'
                          }`}
                          style={{ background: band.bg }}
                        >
                          <span className="h-1.5 w-8 rounded-full" style={{ background: band.fill, boxShadow: `0 0 0 1.5px ${band.line}` }} />
                        </button>
                      ))}
                    </div>
                  </div>
                  <Slider
                    label="Repeats"
                    value={params.exportRepeats}
                    range={RANGES.exportRepeats}
                    format={(v) => `${v}×`}
                    onChange={(v) => update('exportRepeats', v)}
                  />
                  <p className="text-[11px] leading-relaxed text-white/55">One band, starting on a sticker, so it tiles side by side.</p>
                </>
              )}
              <Toggle label="Transparent background" checked={params.transparent} onChange={(v) => update('transparent', v)} />

              <p className="pt-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/50">Still</p>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  onClick={copyPng}
                  disabled={Boolean(job)}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#ff2020] py-2.5 text-[12px] font-semibold text-white hover:bg-[#ff3d3d] disabled:opacity-40 ${focusRing}`}
                >
                  <Copy size={14} aria-hidden /> Copy
                </button>
                <button
                  type="button"
                  onClick={downloadPng}
                  disabled={Boolean(job)}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 py-2.5 text-[12px] font-semibold text-white/85 hover:bg-white/[0.06] disabled:opacity-40 ${focusRing}`}
                >
                  <FileImage size={14} aria-hidden /> PNG
                </button>
                <button
                  type="button"
                  onClick={downloadSvg}
                  disabled={Boolean(job)}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 py-2.5 text-[12px] font-semibold text-white/85 hover:bg-white/[0.06] disabled:opacity-40 ${focusRing}`}
                >
                  <FileCode2 size={14} aria-hidden /> SVG
                </button>
              </div>

              <p className="pt-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/50">Motion</p>
              <div className="grid grid-cols-2 gap-2">
                <Segmented
                  label="Length"
                  value={params.motionSeconds}
                  onChange={(v) => update('motionSeconds', v)}
                  options={MOTION_SECONDS.map((s) => ({ value: s, label: `${s}s` }))}
                />
                <Segmented
                  label="Frame rate"
                  value={params.motionFps}
                  onChange={(v) => update('motionFps', v)}
                  options={MOTION_FPS.map((f) => ({ value: f, label: `${f}` }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => exportMotion('video')}
                  disabled={Boolean(job)}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 py-2.5 text-[12px] font-semibold text-white/85 hover:bg-white/[0.06] disabled:opacity-40 ${focusRing}`}
                >
                  <Video size={14} aria-hidden /> Video
                </button>
                <button
                  type="button"
                  onClick={() => exportMotion('frames')}
                  disabled={Boolean(job)}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 py-2.5 text-[12px] font-semibold text-white/85 hover:bg-white/[0.06] disabled:opacity-40 ${focusRing}`}
                >
                  <Images size={14} aria-hidden /> PNG sequence
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-white/55">
                Video records in real time (MP4 or WebM, opaque). PNG sequences keep transparency for compositing.
              </p>
              {job && (
                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2 text-[12px]">
                    <span className="flex items-center gap-2">
                      <LoaderCircle size={13} className="animate-spin text-[#ffc8f8]" aria-hidden />
                      {job.label}
                    </span>
                    {job.progress != null && (
                      <span className="rsw-mono text-[11px] text-white/60">{Math.round(job.progress * 100)}%</span>
                    )}
                  </div>
                  {job.progress != null && (
                    <div
                      role="progressbar"
                      aria-label={job.label}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(job.progress * 100)}
                      className="h-1.5 overflow-hidden rounded-full bg-white/10"
                    >
                      <div className="h-full rounded-full bg-[#ffc8f8] transition-[width]" style={{ width: `${job.progress * 100}%` }} />
                    </div>
                  )}
                  {job.kind !== 'svg' && (
                    <button
                      type="button"
                      onClick={() => {
                        jobCancelRef.current = true;
                      }}
                      className={`mt-2 inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-white/70 hover:bg-white/[0.06] ${focusRing}`}
                    >
                      <X size={12} aria-hidden /> Cancel
                    </button>
                  )}
                </div>
              )}
            </Section>
          </div>

          <div className="flex gap-2 border-t border-white/[0.06] p-3">
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              className={`inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 py-2 text-[12px] text-white/75 hover:bg-white/[0.06] hover:text-white ${focusRing}`}
            >
              {playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              onClick={resetSettings}
              className={`inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 py-2 text-[12px] text-white/75 hover:bg-white/[0.06] hover:text-white ${focusRing}`}
            >
              <RotateCcw size={14} aria-hidden /> Reset
            </button>
          </div>
        </aside>
      )}

      {/* Toasts */}
      <div role="status" aria-live="polite" className="pointer-events-none absolute top-4 z-40 -translate-x-1/2" style={{ left: centerX }}>
        {toast && (
          <div
            key={toast.id}
            className={`rsw-pop flex items-center gap-2 whitespace-nowrap rounded-full border px-3.5 py-2 text-[12px] font-medium shadow-2xl backdrop-blur-xl ${
              toast.tone === 'error' || toast.tone === 'warn'
                ? 'border-red-400/30 bg-[#1a0707]/90 text-red-100'
                : 'border-white/10 bg-[#0c0c0f]/90 text-white'
            }`}
          >
            <ToastIcon size={14} aria-hidden className={toast.tone === 'success' ? 'text-emerald-300' : ''} />
            {toast.message}
          </div>
        )}
      </div>

      {/* Renderer failure */}
      {glError && (
        <div className="absolute inset-0 z-50 grid place-items-center bg-black/80 p-6">
          <div role="alert" className="max-w-sm rounded-2xl border border-red-400/30 bg-[#0c0c0f] p-5 text-center shadow-2xl">
            <TriangleAlert className="mx-auto mb-3 text-red-300" size={22} aria-hidden />
            <p className="text-[14px] font-semibold">The warp renderer couldn’t start</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-white/60">{glError}</p>
            <p className="mt-3 text-[11px] text-white/40">Try a recent Chrome, Edge, Firefox or Safari with hardware acceleration on.</p>
          </div>
        </div>
      )}
    </div>
  );
}
