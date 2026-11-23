/**
 * WebGL2 renderer for the Morph grid design (see morphGrid.js for the timing model).
 * Each glyph of the loop is rasterised once into a signed distance field; every frame
 * blends two fields per cell, draws the ink with thin scanlines and a beaded edge, and
 * lays flat colour rings (iso-distance bands) around it.
 */
import { MORPH_CELLS, MORPH_COLS, MORPH_ROWS, MORPH_RINGS_PER_STAGE, MORPH_THEME, morphGridRect } from './morphGrid.js';

const GLYPH_W = 192; // field size of one cell, px (4:5 like the cell)
const GLYPH_H = 240;
const GLYPH_MARGIN = 0.07; // share of the cell kept clear around a glyph
const HALO_MAX = 0.12; // widest ring stack, in cell heights
const REST_FRINGE = 0.01; // thin colour fringe left at rest, in cell heights
const RING_STEP = 0.024; // width of one flat ring, in cell heights
const BLOB = 0.02; // extra swell mid-melt, in cell heights
const SCAN_LINES = 46; // scanlines per cell height

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uGlyphs;
uniform vec2 uRes;
uniform vec4 uGrid;          // x, y (top-down), width, height in device px
uniform vec4 uCellA[${MORPH_CELLS}]; // from, to, mix, halo
uniform vec4 uCellB[${MORPH_CELLS}]; // tint, tint stage, 0, 0
uniform vec3 uRings[${4 * MORPH_RINGS_PER_STAGE}];
uniform vec4 uTints[4];      // rgb, has tint
uniform vec3 uBg;
uniform vec3 uInk;
uniform vec3 uScan;
uniform float uHaloScale;
uniform float uFringe;      // rest fringe width; 0 in still (reduced motion) mode
out vec4 outColor;

const float PI = 3.14159265;

vec3 ring(int stage, int k) {
  return uRings[(stage % 4) * ${MORPH_RINGS_PER_STAGE} + (k % ${MORPH_RINGS_PER_STAGE})];
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) - uGrid.xy;
  vec2 uv = p / uGrid.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) { outColor = vec4(uBg, 1.0); return; }
  vec2 g = uv * vec2(${MORPH_COLS}.0, ${MORPH_ROWS}.0);
  vec2 cell = floor(g);
  vec2 local = g - cell;
  int idx = int(cell.y) * ${MORPH_COLS} + int(cell.x);
  vec4 a = uCellA[idx];
  vec4 b = uCellB[idx];
  float d0 = texture(uGlyphs, vec3(local, a.x)).r;
  float d1 = texture(uGlyphs, vec3(local, a.y)).r;
  float m = a.z;
  float d = mix(d0, d1, m) - ${BLOB} * sin(PI * m);
  // Beaded edge: a small scallop that runs along the outline.
  vec2 bead = local * vec2(${GLYPH_W}.0, ${GLYPH_H}.0) * 0.32;
  d += 0.0035 * sin(bead.x) * sin(bead.y);
  float aa = max(fwidth(d), 1e-4) * 0.8;

  int tstage = int(b.y + 0.5);
  vec4 tint = uTints[tstage % 4];
  vec3 col = mix(uBg, tint.rgb, tint.a * b.x);

  // Flat rings around the outline: a thin fringe at rest, up to HALO_MAX while melting.
  float width = uFringe + ${HALO_MAX} * uHaloScale * a.w;
  int stage = int((m < 0.5 ? a.x : a.y) + 0.5);
  if (d > 0.0 && d < width + aa) {
    float band = floor(d / ${RING_STEP});
    vec3 rc = ring(stage, int(band));
    float edge = smoothstep(width + aa, width - aa, d);
    col = mix(col, rc, edge);
  }
  // Ink with thin horizontal scanlines.
  float scan = step(0.72, fract(local.y * ${SCAN_LINES}.0));
  vec3 ink = mix(uInk, uScan, scan);
  col = mix(col, ink, smoothstep(aa, -aa, d));
  outColor = vec4(col, 1.0);
}`;

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Morph grid shader failed: ${log}`);
  }
  return shader;
}

function link(gl) {
  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Morph grid program failed: ${log}`);
  }
  return program;
}

/**
 * Rasterises `glyph` centred in a GLYPH_W × GLYPH_H canvas, scaled to fill the cell, and
 * returns its distance field in cell heights (negative inside).
 */
export function glyphField(glyph, family, sdf) {
  const canvas = document.createElement('canvas');
  canvas.width = GLYPH_W;
  canvas.height = GLYPH_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const probe = 100;
  ctx.font = `900 ${probe}px "${family}", "Arial Black", sans-serif`;
  const m = ctx.measureText(glyph);
  const inkW = Math.max(1, (m.actualBoundingBoxLeft ?? 0) + (m.actualBoundingBoxRight ?? m.width));
  const inkH = Math.max(1, (m.actualBoundingBoxAscent ?? probe * 0.7) + (m.actualBoundingBoxDescent ?? 0));
  const room = 1 - 2 * GLYPH_MARGIN;
  const scale = Math.min((GLYPH_W * room) / inkW, (GLYPH_H * room) / inkH);
  ctx.font = `900 ${probe * scale}px "${family}", "Arial Black", sans-serif`;
  ctx.fillStyle = '#fff';
  const left = (m.actualBoundingBoxLeft ?? 0) * scale;
  const ascent = (m.actualBoundingBoxAscent ?? probe * 0.7) * scale;
  const x = (GLYPH_W - inkW * scale) / 2 + left;
  const y = (GLYPH_H - inkH * scale) / 2 + ascent;
  ctx.fillText(glyph, x, y);
  const rgba = ctx.getImageData(0, 0, GLYPH_W, GLYPH_H).data;
  const alpha = new Uint8Array(GLYPH_W * GLYPH_H);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  const field = sdf(alpha, GLYPH_W, GLYPH_H);
  const out = new Float32Array(field.length);
  for (let i = 0; i < field.length; i++) out[i] = field[i] / GLYPH_H;
  return out;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ sdf: (alpha: Uint8Array, w: number, h: number) => Float32Array, theme?: typeof MORPH_THEME }} deps
 */
export function createMorphGridRenderer(canvas, { sdf, theme = MORPH_THEME }) {
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 is not available for the Morph grid.');
  const program = link(gl);
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  const loc = (name) => gl.getUniformLocation(program, name);
  const U = Object.fromEntries(
    ['uGlyphs', 'uRes', 'uGrid', 'uCellA', 'uCellB', 'uRings', 'uTints', 'uBg', 'uInk', 'uScan', 'uHaloScale', 'uFringe'].map((n) => [n, loc(n)]),
  );
  let glyphCount = 0;

  gl.useProgram(program);
  gl.uniform1i(U.uGlyphs, 0);
  const rings = theme.stages.flatMap((s) => s.rings.flatMap(hexRgb));
  gl.uniform3fv(U.uRings, new Float32Array(rings));
  gl.uniform4fv(U.uTints, new Float32Array(theme.stages.flatMap((s) => (s.tint ? [...hexRgb(s.tint), 1] : [0, 0, 0, 0]))));
  gl.uniform3fv(U.uBg, hexRgb(theme.bg));
  gl.uniform3fv(U.uInk, hexRgb(theme.ink));
  gl.uniform3fv(U.uScan, hexRgb(theme.scan));

  function draw({ width, height, grid, cells, haloScale = 1, still = false }, fbo) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.uniform2f(U.uRes, width, height);
    gl.uniform4f(U.uGrid, grid.x, grid.y, grid.width, grid.height);
    const last = Math.max(0, glyphCount - 1);
    gl.uniform4fv(U.uCellA, new Float32Array(cells.flatMap((c) => [Math.min(c.from, last), Math.min(c.to, last), c.mix, c.halo])));
    gl.uniform4fv(U.uCellB, new Float32Array(cells.flatMap((c) => [c.tint, c.tintStage % theme.stages.length, 0, 0])));
    gl.uniform1f(U.uHaloScale, still ? 0 : haloScale);
    gl.uniform1f(U.uFringe, still ? 0 : REST_FRINGE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return {
    get ready() {
      return glyphCount > 0;
    },
    /** Rasterises the loop's glyphs in `family`; call again when the font or glyphs change. */
    setGlyphs(glyphs, family) {
      const fields = glyphs.map((g) => glyphField(g, family, sdf));
      const data = new Float32Array(GLYPH_W * GLYPH_H * fields.length);
      fields.forEach((f, i) => data.set(f, i * GLYPH_W * GLYPH_H));
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R16F, GLYPH_W, GLYPH_H, fields.length, 0, gl.RED, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      glyphCount = fields.length;
    },
    /** Draws to the canvas. `rect` is the grid's area in CSS px; `dpr` scales it. */
    render({ cells, rect, dpr = 1, haloScale, still = false }) {
      if (!glyphCount) return;
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const fit = morphGridRect(rect);
      const grid = { x: fit.x * dpr, y: fit.y * dpr, width: fit.width * dpr, height: fit.height * dpr };
      draw({ width, height, grid, cells, haloScale, still }, null);
    },
    /** Renders off-screen at `width` × `height` and returns bottom-up opaque RGBA bytes. */
    readPixels({ cells, width, height, haloScale, still = false }) {
      if (!glyphCount) throw new Error('The Morph grid is still loading its letters.');
      const target = gl.createTexture();
      const fbo = gl.createFramebuffer();
      try {
        gl.bindTexture(gl.TEXTURE_2D, target);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('Export buffer is not supported at this size.');
        }
        draw({ width, height, grid: morphGridRect({ x: 0, y: 0, width, height }), cells, haloScale, still }, fbo);
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(target);
      }
    },
    get maxSize() {
      return gl.getParameter(gl.MAX_TEXTURE_SIZE);
    },
    dispose() {
      gl.deleteProgram(program);
      gl.deleteTexture(tex);
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
    },
  };
}
