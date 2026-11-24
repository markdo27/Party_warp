/**
 * Full WebGL2 GPU renderer for Face Collage (foundation D6 + Round 5 architecture).
 *   Pass 0   : Skin plate (GPU cheek sampling + feature cover + Kawase/Gaussian blur + soft oval mask)
 *   Pass 0.5 : Expression Frame Bank atlas update (face-aligned 256x256 tiles on GPU, zero readback)
 *   Pass 1   : Collage composition (organic landmark-contoured masks + selective crisp collage cuts)
 *   Pass 2   : Angled hard-cut edge slices pushed outward from the finished collage
 *   Pass 3   : Privacy blur blend + GPU horizontal glitch slip/R-B split + global magazine-scan tone + grain
 *
 * Zero per-frame canvas allocations, zero CPU getImageData/readPixels readbacks.
 */
import { BANK_COLS, BANK_ROWS, BANK_TILE_SIZE } from './frameBank.js';
import { ellipseContour } from './features.js';
import { MAX_GLITCH_BANDS, glitchBands } from './glitch.js';
import { cutHalfPlane } from './layout.js';
import { MASK_STYLE, MIN_FEATHER_SCALE, PATCH_PAD_IOD } from './maskStyle.js';
import { mulberry32 } from './prng.js';
import { toPixel } from './faceFrame.js';
import { easeOut } from './trackingState.js';
import {
  BANK_CROP_FRAG,
  BLUR_FRAG,
  COPY_VIDEO_FRAG,
  FINAL_FRAG,
  FULLSCREEN_VERT,
  PATCH_FRAG,
  PATCH_VERT,
  PLATE_COMPOSITE_FRAG,
  PLATE_SEED_FRAG,
  POLY_VERT,
  SLICE_FRAG,
  SOLID_WHITE_FRAG,
} from './shaders.js';

const PLATE_SIZE = 64;
const BG_BLUR_DIV = 16;
const GRAIN_SIZE = 192;
const GRAIN_SEED = 0x46434752;
const GRAIN_ALPHA = 0.085;
const GRAIN_SLOT_MS = 120;
const ADD_ANIM_MS = 150;
const FEATHER_IOD = 0.1;
const COVER = {
  eye: { w: 1.0, h: 0.82, lift: 0.12 },
  nose: { w: 0.58, top: 0.04, bottom: 0.86 },
  mouth: { grow: 1.18 },
};

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`WebGL2 shader error: ${log}`);
  }
  return sh;
}

function createProgram(gl, vertSrc, fragSrc, uniformNames) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`WebGL2 link error: ${log}`);
  }
  const u = {};
  for (const name of uniformNames) u[name] = gl.getUniformLocation(prog, name);
  return { prog, u };
}

function createTexture(gl, w, h, { filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE, data = null } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return tex;
}

function createFbo(gl, w, h, opts = {}) {
  const tex = createTexture(gl, w, h, opts);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, w, h };
}

function resizeFbo(gl, target, w, h) {
  if (target.w === w && target.h === h) return;
  target.w = w;
  target.h = h;
  gl.bindTexture(gl.TEXTURE_2D, target.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
}

function makeGrainData() {
  const rand = mulberry32(GRAIN_SEED);
  const data = new Uint8Array(GRAIN_SIZE * GRAIN_SIZE * 4);
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.floor(rand() * 256);
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  return data;
}

export class CollageRenderer {
  constructor(outCanvas) {
    this.out = outCanvas;
    const gl = outCanvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not supported in this browser');
    this.gl = gl;
    this.backend = 'webgl2';
    this.width = Math.max(1, outCanvas.width || 1);
    this.height = Math.max(1, outCanvas.height || 1);
    this.mirror = false;
    this.births = new Map();
    this.layoutSeed = null;
    this.hasCollage = false;
    this.timings = {};

    this.emptyVao = gl.createVertexArray();
    this.polyVao = gl.createVertexArray();
    this.polyBuf = gl.createBuffer();
    gl.bindVertexArray(this.polyVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.polyBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.polyScratch = new Float32Array(32); // 16 vec2 contour vertices
    this.bandRects = new Float32Array(MAX_GLITCH_BANDS * 4);
    this.bandShifts = new Float32Array(MAX_GLITCH_BANDS * 2);

    this.initPrograms();
    this.initResources();
  }

  initPrograms() {
    const { gl } = this;
    this.pCopy = createProgram(gl, FULLSCREEN_VERT, COPY_VIDEO_FRAG, ['uTex', 'uMirror']);
    this.pPoly = createProgram(gl, POLY_VERT, SOLID_WHITE_FRAG, ['uSize']);
    this.pBlur = createProgram(gl, FULLSCREEN_VERT, BLUR_FRAG, ['uTex', 'uDir']);
    this.pPlateSeed = createProgram(gl, FULLSCREEN_VERT, PLATE_SEED_FRAG, [
      'uVideo', 'uOvalMask', 'uMirror', 'uSize', 'uBox', 'uFrame', 'uIod',
      'uCheekA', 'uCheekB', 'uCoverEyeA', 'uCoverEyeB', 'uCoverNose', 'uCoverMouth',
    ]);
    this.pPlateComp = createProgram(gl, FULLSCREEN_VERT, PLATE_COMPOSITE_FRAG, [
      'uPlate', 'uOvalMask', 'uVideo', 'uMirror', 'uSize', 'uBox', 'uFrame', 'uIod', 'uRealCheekTex',
    ]);
    this.pBankCrop = createProgram(gl, FULLSCREEN_VERT, BANK_CROP_FRAG, ['uVideo', 'uMirror', 'uSize', 'uFrame', 'uIod', 'uFeat']);
    this.pPatch = createProgram(gl, PATCH_VERT, PATCH_FRAG, [
      'uSize', 'uFrame', 'uIod', 'uDestUV', 'uBoxWH', 'uScale', 'uRot', 'uFlipX',
      'uSource', 'uFromBank', 'uMirror', 'uSrcFeat', 'uTileRect', 'uTexel', 'uPad',
      'uPoly', 'uPolyCount', 'uCut', 'uHasCut', 'uFeatherTop', 'uFeatherBot',
      'uGrow', 'uShade', 'uDeepen', 'uSharpen',
    ]);
    this.pSlice = createProgram(gl, PATCH_VERT, SLICE_FRAG, [
      'uSize', 'uFrame', 'uIod', 'uDestUV', 'uBoxWH', 'uScale', 'uRot', 'uFlipX',
      'uCollage', 'uSrcUV', 'uSide', 'uOuterSlope', 'uGrow', 'uShade',
    ]);
    this.pFinal = createProgram(gl, FULLSCREEN_VERT, FINAL_FRAG, [
      'uCollage', 'uBgBlur', 'uGrain', 'uSize', 'uAlpha', 'uHasCollage', 'uGradeAmt',
      'uBandCount', 'uBandRect', 'uBandShift', 'uGrainAlpha', 'uGrainOffset', 'uGrainSize',
    ]);
  }

  initResources() {
    const { gl } = this;
    this.texVideo = createTexture(gl, 2, 2);
    this.texGrain = createTexture(gl, GRAIN_SIZE, GRAIN_SIZE, {
      filter: gl.NEAREST,
      wrap: gl.REPEAT,
      data: makeGrainData(),
    });
    this.fboPlateA = createFbo(gl, PLATE_SIZE, PLATE_SIZE);
    this.fboPlateB = createFbo(gl, PLATE_SIZE, PLATE_SIZE);
    this.fboOvalA = createFbo(gl, 2, 2);
    this.fboOvalB = createFbo(gl, 2, 2);
    this.fboCollage = createFbo(gl, 2, 2);
    this.fboSliced = createFbo(gl, 2, 2);
    this.fboBgA = createFbo(gl, 8, 8);
    this.fboBgB = createFbo(gl, 8, 8);
    this.fboBank = createFbo(gl, BANK_COLS * BANK_TILE_SIZE, BANK_ROWS * BANK_TILE_SIZE);
    this.clearBank();
  }

  resize(w, h) {
    if (this.out.width === w && this.out.height === h && this.fboCollage.w === w && this.fboCollage.h === h) return;
    const { gl } = this;
    this.out.width = w;
    this.out.height = h;
    this.width = w;
    this.height = h;
    const hw = Math.max(2, Math.round(w / 2));
    const hh = Math.max(2, Math.round(h / 2));
    const bw = Math.max(8, Math.round(w / BG_BLUR_DIV));
    const bh = Math.max(8, Math.round(h / BG_BLUR_DIV));
    resizeFbo(gl, this.fboCollage, w, h);
    resizeFbo(gl, this.fboSliced, w, h);
    resizeFbo(gl, this.fboOvalA, hw, hh);
    resizeFbo(gl, this.fboOvalB, hw, hh);
    resizeFbo(gl, this.fboBgA, bw, bh);
    resizeFbo(gl, this.fboBgB, bw, bh);
    this.hasCollage = false;
  }

  /** Uploads live video or still image directly to GPU texture (UNPACK_FLIP_Y_WEBGL = true). */
  uploadSource(source, mirror) {
    const { gl } = this;
    this.mirror = Boolean(mirror);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /** Clears the Expression Frame Bank GPU atlas (privacy guarantee D7). */
  clearBank() {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboBank.fbo);
    gl.viewport(0, 0, this.fboBank.w, this.fboBank.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  drawQuad() {
    const { gl } = this;
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  bindTex(unit, tex) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  runBlur(src, dst, dx, dy) {
    const { gl, pBlur } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.disable(gl.BLEND);
    gl.useProgram(pBlur.prog);
    this.bindTex(0, src.tex);
    gl.uniform1i(pBlur.u.uTex, 0);
    gl.uniform2f(pBlur.u.uDir, dx, dy);
    this.drawQuad();
  }

  /** Builds the collage layer from the uploaded GPU source texture. */
  drawCollage(source, face, layout, seed, now, reducedMotion, { mirror = this.mirror, bank = null, bankUpdates = [], bankOpts = null } = {}) {
    const t0 = performance.now();
    this.uploadSource(source, mirror);
    const tUpload = performance.now();

    const plateBox = this.renderPlate(face);
    const tPlate = performance.now();

    if (bankUpdates.length > 0) this.updateBankTiles(face, bankUpdates);
    const tBank = performance.now();

    this.trackBirths(layout, seed, now, reducedMotion);

    const { gl, width: W, height: H } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboCollage.fbo);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);

    // 1. Live frame background.
    gl.useProgram(this.pCopy.prog);
    this.bindTex(0, this.texVideo);
    gl.uniform1i(this.pCopy.u.uTex, 0);
    gl.uniform1f(this.pCopy.u.uMirror, this.mirror ? 1 : 0);
    this.drawQuad();

    // 2. Flattened skin plate masked by feathered face oval.
    if (plateBox) {
      const hasCopies = layout.length > 3 ? 1 : 0;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.pPlateComp.prog);
      this.bindTex(0, this.fboPlateA.tex);
      this.bindTex(1, this.fboOvalA.tex);
      this.bindTex(2, this.texVideo);
      gl.uniform1i(this.pPlateComp.u.uPlate, 0);
      gl.uniform1i(this.pPlateComp.u.uOvalMask, 1);
      gl.uniform1i(this.pPlateComp.u.uVideo, 2);
      gl.uniform1f(this.pPlateComp.u.uMirror, this.mirror ? 1 : 0);
      gl.uniform2f(this.pPlateComp.u.uSize, W, H);
      gl.uniform4f(this.pPlateComp.u.uBox, plateBox.bx, plateBox.by, plateBox.bw, plateBox.bh);
      gl.uniform4f(this.pPlateComp.u.uFrame, face.frame.ox, face.frame.oy, face.frame.ax, face.frame.ay);
      gl.uniform1f(this.pPlateComp.u.uIod, face.frame.iod);
      gl.uniform1f(this.pPlateComp.u.uRealCheekTex, hasCopies);
      this.drawQuad();
    }

    // 3. Organic landmark-contoured body patches (eyes, noses, mouths).
    const slices = [];
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.pPatch.prog);
    gl.uniform2f(this.pPatch.u.uSize, W, H);
    gl.uniform4f(this.pPatch.u.uFrame, face.frame.ox, face.frame.oy, face.frame.ax, face.frame.ay);
    gl.uniform1f(this.pPatch.u.uIod, face.frame.iod);
    gl.uniform1f(this.pPatch.u.uMirror, this.mirror ? 1 : 0);

    for (const p of layout) {
      if (p.kind === 'cheek') {
        slices.push(p);
        continue;
      }
      this.drawPatch(face, p, now, bank, bankOpts);
    }
    const tPatch = performance.now();

    // 4. Copy collage -> fboSliced, then draw hard-cut angled edge slices from fboCollage onto fboSliced.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboSliced.fbo);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.useProgram(this.pCopy.prog);
    this.bindTex(0, this.fboCollage.tex);
    gl.uniform1i(this.pCopy.u.uTex, 0);
    gl.uniform1f(this.pCopy.u.uMirror, 0);
    this.drawQuad();

    if (slices.length > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.pSlice.prog);
      this.bindTex(0, this.fboCollage.tex);
      gl.uniform1i(this.pSlice.u.uCollage, 0);
      gl.uniform2f(this.pSlice.u.uSize, W, H);
      gl.uniform4f(this.pSlice.u.uFrame, face.frame.ox, face.frame.oy, face.frame.ax, face.frame.ay);
      gl.uniform1f(this.pSlice.u.uIod, face.frame.iod);
      for (const s of slices) this.drawSlice(s, now);
    }
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const tEnd = performance.now();
    this.timings = {
      uploadMs: tUpload - t0,
      plateMs: tPlate - tUpload,
      bankMs: tBank - tPlate,
      patchMs: tPatch - tBank,
      sliceMs: tEnd - tPatch,
      gradeMs: 0,
    };
    this.hasCollage = true;
  }

  trackBirths(layout, seed, now, reducedMotion) {
    const instant = reducedMotion || seed !== this.layoutSeed;
    const ids = new Set(layout.map((p) => p.id));
    for (const id of [...this.births.keys()]) if (!ids.has(id)) this.births.delete(id);
    for (const p of layout) if (!this.births.has(p.id)) this.births.set(p.id, instant ? -Infinity : now);
    this.layoutSeed = seed;
  }

  renderPlate(face) {
    const { gl, width: W, height: H } = this;
    const { frame, features, oval } = face;
    if (!oval?.length) return null;
    const ovalPx = oval.map((q) => toPixel(frame, q));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let cx = 0;
    let cy = 0;
    for (const p of ovalPx) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
      cx += p.x;
      cy += p.y;
    }
    cx /= ovalPx.length;
    cy /= ovalPx.length;
    const pad = frame.iod * 0.22;
    const bx = Math.max(0, minX - pad);
    const by = Math.max(0, minY - pad);
    const bw = Math.min(W, maxX + pad) - bx;
    const bh = Math.min(H, maxY + pad) - by;
    if (bw < 4 || bh < 4) return null;

    // 1. Rasterize face oval as a triangle fan into fboOvalA (sharp mask first for plate seeding).
    const verts = new Float32Array((ovalPx.length + 2) * 2);
    verts[0] = cx;
    verts[1] = cy;
    for (let i = 0; i < ovalPx.length; i += 1) {
      verts[(i + 1) * 2] = ovalPx[i].x;
      verts[(i + 1) * 2 + 1] = ovalPx[i].y;
    }
    verts[(ovalPx.length + 1) * 2] = ovalPx[0].x;
    verts[(ovalPx.length + 1) * 2 + 1] = ovalPx[0].y;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboOvalA.fbo);
    gl.viewport(0, 0, this.fboOvalA.w, this.fboOvalA.h);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.pPoly.prog);
    gl.uniform2f(this.pPoly.u.uSize, W, H);
    gl.bindVertexArray(this.polyVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.polyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, ovalPx.length + 2);

    // 2. Seed 64x64 skin plate: fill outside oval + cover eye/brow/nose/mouth using GPU-sampled cheeks.
    const cheekAPx = toPixel(frame, features.cheekA);
    const cheekBPx = toPixel(frame, features.cheekB);
    // Cover full orbital + eyebrow area when building the flattened skin plate (so Minimal Q1 wipes brows!).
    const { eyeA, eyeB, nose, mouth } = features;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboPlateA.fbo);
    gl.viewport(0, 0, PLATE_SIZE, PLATE_SIZE);
    gl.useProgram(this.pPlateSeed.prog);
    this.bindTex(0, this.texVideo);
    this.bindTex(1, this.fboOvalA.tex);
    gl.uniform1i(this.pPlateSeed.u.uVideo, 0);
    gl.uniform1i(this.pPlateSeed.u.uOvalMask, 1);
    gl.uniform1f(this.pPlateSeed.u.uMirror, this.mirror ? 1 : 0);
    gl.uniform2f(this.pPlateSeed.u.uSize, W, H);
    gl.uniform4f(this.pPlateSeed.u.uBox, bx, by, bw, bh);
    gl.uniform4f(this.pPlateSeed.u.uFrame, frame.ox, frame.oy, frame.ax, frame.ay);
    gl.uniform1f(this.pPlateSeed.u.uIod, frame.iod);
    gl.uniform2f(this.pPlateSeed.u.uCheekA, cheekAPx.x, cheekAPx.y);
    gl.uniform2f(this.pPlateSeed.u.uCheekB, cheekBPx.x, cheekBPx.y);
    gl.uniform4f(this.pPlateSeed.u.uCoverEyeA, eyeA.u, eyeA.v - COVER.eye.lift, COVER.eye.w, COVER.eye.h);
    gl.uniform4f(this.pPlateSeed.u.uCoverEyeB, eyeB.u, eyeB.v - COVER.eye.lift, COVER.eye.w, COVER.eye.h);
    gl.uniform4f(this.pPlateSeed.u.uCoverNose, nose.u, (COVER.nose.top + COVER.nose.bottom) * 0.5, COVER.nose.w, COVER.nose.bottom - COVER.nose.top);
    gl.uniform4f(this.pPlateSeed.u.uCoverMouth, mouth.u, mouth.v, mouth.w * COVER.mouth.grow, mouth.h * COVER.mouth.grow);
    this.drawQuad();

    // 3. Multi-pass GPU blur on 64x64 plate (~0.35 IOD equivalent smooth skin lighting gradient, Q1 >= 90%).
    for (const step of [2.5, 4.5, 6.5]) {
      this.runBlur(this.fboPlateA, this.fboPlateB, step / PLATE_SIZE, 0);
      this.runBlur(this.fboPlateB, this.fboPlateA, 0, step / PLATE_SIZE);
    }

    // 4. Feather the oval mask smoothly across 0.10 IOD (zero boundary seam, Q2 PASS).
    const sigmaPx = Math.max(2.5, FEATHER_IOD * frame.iod * 0.65);
    const sx = (sigmaPx * 0.5) / this.fboOvalA.w;
    const sy = (sigmaPx * 0.5) / this.fboOvalA.h;
    this.runBlur(this.fboOvalA, this.fboOvalB, sx, 0);
    this.runBlur(this.fboOvalB, this.fboOvalA, 0, sy);
    this.runBlur(this.fboOvalA, this.fboOvalB, sx * 1.4, 0);
    this.runBlur(this.fboOvalB, this.fboOvalA, 0, sy * 1.4);

    return { bx, by, bw, bh };
  }

  /** Renders requested expression captures directly into their dedicated 256x256 GPU atlas tiles. */
  updateBankTiles(face, captures) {
    const { gl, pBankCrop, width: W, height: H } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboBank.fbo);
    gl.disable(gl.BLEND);
    gl.useProgram(pBankCrop.prog);
    this.bindTex(0, this.texVideo);
    gl.uniform1i(pBankCrop.u.uVideo, 0);
    gl.uniform1f(pBankCrop.u.uMirror, this.mirror ? 1 : 0);
    gl.uniform2f(pBankCrop.u.uSize, W, H);
    gl.uniform4f(pBankCrop.u.uFrame, face.frame.ox, face.frame.oy, face.frame.ax, face.frame.ay);
    gl.uniform1f(pBankCrop.u.uIod, face.frame.iod);
    for (const c of captures) {
      const col = c.tileIndex % BANK_COLS;
      const row = Math.floor(c.tileIndex / BANK_COLS);
      gl.viewport(col * BANK_TILE_SIZE, row * BANK_TILE_SIZE, BANK_TILE_SIZE, BANK_TILE_SIZE);
      // Tiles keep the same pad as the patch quad so the feather never samples a clamped tile edge.
      gl.uniform4f(pBankCrop.u.uFeat, c.feature.u, c.feature.v, c.feature.w + 2 * PATCH_PAD_IOD, c.feature.h + 2 * PATCH_PAD_IOD);
      this.drawQuad();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  drawPatch(face, p, now, bank, bankOpts) {
    const { gl, pPatch, width: W, height: H } = this;
    const srcKey = p.brow && p.kind === 'eye' ? (p.source === 'eyeB' ? 'eyeBrowB' : 'eyeBrowA') : p.source;
    const liveFeat = face.features[srcKey] ?? face.features[p.source];
    if (!liveFeat) return;

    // Top-row brow eyes use the live brow crop unless banked; lower orbital eyes use banked expressions freely.
    const banked = !p.original && !p.brow && bank ? bank.resolve(p.expr, now, bankOpts ?? undefined) : null;
    const feat = banked ? banked.feature : liveFeat;
    const contour = banked?.contour ?? face.contours?.[srcKey] ?? face.contours?.[p.source] ?? ellipseContour(feat.w * 0.36, feat.h * 0.34);

    const age = now - (this.births.get(p.id) ?? -Infinity);
    const grow = age < ADD_ANIM_MS ? easeOut(age / ADD_ANIM_MS) : 1;
    const du = p.original ? liveFeat.u : p.u;
    const dv = p.original ? liveFeat.v : p.v;
    const s = p.scale * (0.6 + 0.4 * grow);
    const style = MASK_STYLE[p.kind] ?? MASK_STYLE.eye;

    const polyN = Math.min(16, contour.length);
    for (let i = 0; i < polyN; i += 1) {
      this.polyScratch[i * 2] = contour[i][0];
      this.polyScratch[i * 2 + 1] = contour[i][1];
    }

    // Selective crisp collage cut chord (originals stay organic without harsh interior slice on Minimal).
    const plane = cutHalfPlane(feat.w, feat.h, p.cut);
    const hasCut = plane && !p.original ? 1 : 0;

    if (banked) {
      const col = banked.tileIndex % BANK_COLS;
      const row = Math.floor(banked.tileIndex / BANK_COLS);
      const tw = 1 / BANK_COLS;
      const th = 1 / BANK_ROWS;
      this.bindTex(0, this.fboBank.tex);
      gl.uniform1f(pPatch.u.uFromBank, 1);
      gl.uniform4f(pPatch.u.uTileRect, col * tw, row * th, tw, th);
      gl.uniform2f(pPatch.u.uTexel, 1 / this.fboBank.w, 1 / this.fboBank.h);
    } else {
      this.bindTex(0, this.texVideo);
      gl.uniform1f(pPatch.u.uFromBank, 0);
      gl.uniform4f(pPatch.u.uTileRect, 0, 0, 1, 1);
      gl.uniform2f(pPatch.u.uTexel, 1 / W, 1 / H);
    }

    gl.uniform1i(pPatch.u.uSource, 0);
    gl.uniform2f(pPatch.u.uDestUV, du, dv);
    gl.uniform2f(pPatch.u.uBoxWH, feat.w, feat.h);
    gl.uniform1f(pPatch.u.uPad, PATCH_PAD_IOD);
    gl.uniform1f(pPatch.u.uScale, s);
    gl.uniform1f(pPatch.u.uRot, (p.rot * Math.PI) / 180);
    gl.uniform1f(pPatch.u.uFlipX, p.flipX ? -1 : 1);
    gl.uniform4f(pPatch.u.uSrcFeat, feat.u, feat.v, feat.w, feat.h);
    gl.uniform2fv(pPatch.u.uPoly, this.polyScratch);
    gl.uniform1i(pPatch.u.uPolyCount, polyN);
    gl.uniform3f(pPatch.u.uCut, plane ? plane[0] : 0, plane ? plane[1] : 1, plane ? plane[2] : 10);
    gl.uniform1f(pPatch.u.uHasCut, hasCut);
    gl.uniform1f(pPatch.u.uFeatherTop, style.featherTop / Math.max(MIN_FEATHER_SCALE, s));
    gl.uniform1f(pPatch.u.uFeatherBot, style.featherBot / Math.max(MIN_FEATHER_SCALE, s));
    gl.uniform1f(pPatch.u.uGrow, grow);
    gl.uniform1f(pPatch.u.uShade, p.shade ?? 0);
    gl.uniform1f(pPatch.u.uDeepen, p.deepen ?? 0);
    gl.uniform1f(pPatch.u.uSharpen, p.original ? 0.15 : style.sharpen);
    this.drawQuad();
  }

  drawSlice(p, now) {
    const { gl, pSlice } = this;
    const age = now - (this.births.get(p.id) ?? -Infinity);
    const grow = age < ADD_ANIM_MS ? easeOut(age / ADD_ANIM_MS) : 1;
    const slope = Math.tan(((p.cut?.signedAngle ?? 24) * Math.PI) / 180);
    gl.uniform2f(pSlice.u.uDestUV, p.srcU + p.shift * grow, p.v);
    gl.uniform2f(pSlice.u.uBoxWH, p.len, p.h);
    gl.uniform1f(pSlice.u.uScale, 1);
    gl.uniform1f(pSlice.u.uRot, 0);
    gl.uniform1f(pSlice.u.uFlipX, 1);
    gl.uniform2f(pSlice.u.uSrcUV, p.srcU, p.v);
    gl.uniform1f(pSlice.u.uSide, p.side);
    gl.uniform1f(pSlice.u.uOuterSlope, slope);
    gl.uniform1f(pSlice.u.uGrow, grow);
    gl.uniform1f(pSlice.u.uShade, p.shade ?? 0);
    this.drawQuad();
  }

  /** Renders low-res blurred camera background (only when alpha < 1 or no collage yet, for privacy). */
  renderBgBlur(source, mirror) {
    const { gl, pCopy } = this;
    if (!this.hasCollage) this.uploadSource(source, mirror);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboBgA.fbo);
    gl.viewport(0, 0, this.fboBgA.w, this.fboBgA.h);
    gl.disable(gl.BLEND);
    gl.useProgram(pCopy.prog);
    this.bindTex(0, this.texVideo);
    gl.uniform1i(pCopy.u.uTex, 0);
    gl.uniform1f(pCopy.u.uMirror, this.mirror ? 1 : 0);
    this.drawQuad();
    this.runBlur(this.fboBgA, this.fboBgB, 1.4 / this.fboBgA.w, 0);
    this.runBlur(this.fboBgB, this.fboBgA, 0, 1.4 / this.fboBgA.h);
  }

  /** Final screen pass: privacy blur + collage + GPU glitch slip/R-B split + magazine-scan tone + grain. */
  compose(source, { alpha, seed, glitch, now, reducedMotion, avoidRows, face = null, mirror = this.mirror, gradeAmt = 1 }) {
    const t0 = performance.now();
    const { gl, pFinal, width: W, height: H } = this;
    if (alpha < 0.999 || !this.hasCollage) {
      this.uploadSource(source, mirror);
      this.renderBgBlur(source, mirror);
    }

    const bands = glitchBands({
      seed,
      timeMs: now,
      intensity: glitch * alpha,
      height: H,
      width: W,
      face,
      avoid: avoidRows,
      reducedMotion,
    });
    const bandCount = Math.min(MAX_GLITCH_BANDS, bands.length);
    for (let i = 0; i < bandCount; i += 1) {
      const b = bands[i];
      this.bandRects[i * 4] = b.x0;
      this.bandRects[i * 4 + 1] = b.y;
      this.bandRects[i * 4 + 2] = b.x1;
      this.bandRects[i * 4 + 3] = b.y + b.h;
      this.bandShifts[i * 2] = b.shift;
      this.bandShifts[i * 2 + 1] = b.split;
    }

    const grainAmt = glitch * alpha;
    const slot = reducedMotion ? 0 : Math.floor(now / GRAIN_SLOT_MS);
    const gx = ((seed ^ Math.imul(slot, 73)) >>> 0) % GRAIN_SIZE;
    const gy = ((seed ^ Math.imul(slot, 151)) >>> 0) % GRAIN_SIZE;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.useProgram(pFinal.prog);
    this.bindTex(0, this.fboSliced.tex);
    this.bindTex(1, this.fboBgA.tex);
    this.bindTex(2, this.texGrain);
    gl.uniform1i(pFinal.u.uCollage, 0);
    gl.uniform1i(pFinal.u.uBgBlur, 1);
    gl.uniform1i(pFinal.u.uGrain, 2);
    gl.uniform2f(pFinal.u.uSize, W, H);
    gl.uniform1f(pFinal.u.uAlpha, alpha);
    gl.uniform1f(pFinal.u.uHasCollage, this.hasCollage ? 1 : 0);
    gl.uniform1f(pFinal.u.uGradeAmt, this.hasCollage ? gradeAmt * alpha : 0);
    gl.uniform1i(pFinal.u.uBandCount, bandCount);
    gl.uniform4fv(pFinal.u.uBandRect, this.bandRects);
    gl.uniform2fv(pFinal.u.uBandShift, this.bandShifts);
    gl.uniform1f(pFinal.u.uGrainAlpha, grainAmt > 0 ? GRAIN_ALPHA * (0.4 + 0.6 * grainAmt) : 0);
    gl.uniform2f(pFinal.u.uGrainOffset, gx, gy);
    gl.uniform1f(pFinal.u.uGrainSize, GRAIN_SIZE);
    this.drawQuad();

    this.timings = { ...this.timings, finalMs: performance.now() - t0 };
    return bands;
  }

  dispose() {
    const { gl } = this;
    this.clearBank();
    for (const p of [this.pCopy, this.pPoly, this.pBlur, this.pPlateSeed, this.pPlateComp, this.pBankCrop, this.pPatch, this.pSlice, this.pFinal]) {
      if (p?.prog) gl.deleteProgram(p.prog);
    }
    for (const f of [this.fboPlateA, this.fboPlateB, this.fboOvalA, this.fboOvalB, this.fboCollage, this.fboSliced, this.fboBgA, this.fboBgB, this.fboBank]) {
      if (f?.fbo) gl.deleteFramebuffer(f.fbo);
      if (f?.tex) gl.deleteTexture(f.tex);
    }
    gl.deleteTexture(this.texVideo);
    gl.deleteTexture(this.texGrain);
    gl.deleteBuffer(this.polyBuf);
    gl.deleteVertexArray(this.emptyVao);
    gl.deleteVertexArray(this.polyVao);
  }
}
