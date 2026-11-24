/**
 * GLSL ES 3.00 shaders for the WebGL2 Face Collage renderer.
 *
 * Coordinate convention across ALL textures (UNPACK_FLIP_Y_WEBGL = true):
 *   - UV (0, 1) = top-left of screen/image, UV (1, 0) = bottom-right.
 *   - Pixel (px, py) with py=0 at top maps to UV = vec2(px / W, 1.0 - py / H).
 *   - Mirroring of live camera input is applied solely when sampling `uVideo` (`uMirror > 0.5`).
 */

export const FULLSCREEN_VERT = `#version 300 es
precision highp float;
const vec2 POS[4] = vec2[4](
  vec2(-1.0, -1.0),
  vec2( 1.0, -1.0),
  vec2(-1.0,  1.0),
  vec2( 1.0,  1.0)
);
out vec2 vUv;
void main() {
  vec2 p = POS[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export const COPY_VIDEO_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uMirror;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 uv = vec2(uMirror > 0.5 ? 1.0 - vUv.x : vUv.x, vUv.y);
  fragColor = texture(uTex, uv);
}
`;

/** Simple 2D polygon rasteriser for the smooth face-oval mask. */
export const POLY_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos; // pixel coords (0..W, 0..H, y-down)
uniform vec2 uSize;
void main() {
  vec2 ndc = vec2((aPos.x / uSize.x) * 2.0 - 1.0, 1.0 - (aPos.y / uSize.y) * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

export const SOLID_WHITE_FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(1.0);
}
`;

/** Separable 9-tap Gaussian blur (used for soft face-oval feather and background privacy blur). */
export const BLUR_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uDir; // texel step * radius scale
in vec2 vUv;
out vec4 fragColor;
void main() {
  const float w0 = 0.227027;
  const float w1 = 0.1945946;
  const float w2 = 0.1216216;
  const float w3 = 0.054054;
  const float w4 = 0.016216;
  vec4 acc = texture(uTex, vUv) * w0;
  acc += (texture(uTex, clamp(vUv + uDir * 1.0, 0.001, 0.999)) + texture(uTex, clamp(vUv - uDir * 1.0, 0.001, 0.999))) * w1;
  acc += (texture(uTex, clamp(vUv + uDir * 2.0, 0.001, 0.999)) + texture(uTex, clamp(vUv - uDir * 2.0, 0.001, 0.999))) * w2;
  acc += (texture(uTex, clamp(vUv + uDir * 3.0, 0.001, 0.999)) + texture(uTex, clamp(vUv - uDir * 3.0, 0.001, 0.999))) * w3;
  acc += (texture(uTex, clamp(vUv + uDir * 4.0, 0.001, 0.999)) + texture(uTex, clamp(vUv - uDir * 4.0, 0.001, 0.999))) * w4;
  fragColor = acc;
}
`;

/**
 * Pass 0 seed: samples video inside the face oval bbox, replaces outside-oval and original
 * eye/brow/nose/mouth areas with GPU-sampled cheek skin colours (zero CPU readPixels!).
 */
export const PLATE_SEED_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uVideo;
uniform sampler2D uOvalMask;
uniform float uMirror;
uniform vec2 uSize;
uniform vec4 uBox;       // bx, by, bw, bh in pixels
uniform vec4 uFrame;     // ox, oy, ax, ay
uniform float uIod;
uniform vec2 uCheekA;    // pixel coords (mirrored space)
uniform vec2 uCheekB;
uniform vec4 uCoverEyeA; // u, v, w, h in face units
uniform vec4 uCoverEyeB;
uniform vec4 uCoverNose;
uniform vec4 uCoverMouth;
in vec2 vUv;
out vec4 fragColor;

vec2 pxToVidUv(vec2 px) {
  vec2 uv = vec2(px.x / uSize.x, 1.0 - px.y / uSize.y);
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  return clamp(uv, 0.001, 0.999);
}

vec3 sampleCheek(vec2 px) {
  float r = max(2.0, uIod * 0.05);
  vec3 c = texture(uVideo, pxToVidUv(px)).rgb;
  c += texture(uVideo, pxToVidUv(px + vec2(r, 0.0))).rgb;
  c += texture(uVideo, pxToVidUv(px - vec2(r, 0.0))).rgb;
  c += texture(uVideo, pxToVidUv(px + vec2(0.0, r))).rgb;
  c += texture(uVideo, pxToVidUv(px - vec2(0.0, r))).rgb;
  return c * 0.2;
}

bool inRect(vec2 q, vec4 r) {
  return abs(q.x - r.x) <= r.z * 0.5 && abs(q.y - r.y) <= r.w * 0.5;
}

void main() {
  // vUv (0..1, y-up) -> pixel inside uBox (y-down)
  vec2 px = vec2(uBox.x + vUv.x * uBox.z, uBox.y + (1.0 - vUv.y) * uBox.w);
  vec2 d = px - uFrame.xy;
  vec2 q = vec2(d.x * uFrame.z + d.y * uFrame.w, -d.x * uFrame.w + d.y * uFrame.z) / uIod;

  vec3 ca = sampleCheek(uCheekA);
  vec3 cb = sampleCheek(uCheekB);
  vec3 cmid = 0.5 * (ca + cb);
  vec2 maskUv = vec2(px.x / uSize.x, 1.0 - px.y / uSize.y);
  float oval = texture(uOvalMask, clamp(maskUv, 0.001, 0.999)).r;

  vec3 col = texture(uVideo, pxToVidUv(px)).rgb;
  if (oval < 0.5) col = cmid;
  if (inRect(q, uCoverEyeA)) col = ca;
  if (inRect(q, uCoverEyeB)) col = cb;
  if (inRect(q, uCoverNose)) col = cmid;
  if (inRect(q, uCoverMouth)) col = cmid;
  fragColor = vec4(col, 1.0);
}
`;

/** Composites the blurred skin plate over the live frame weighted by the feathered oval mask. */
export const PLATE_COMPOSITE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uPlate;
uniform sampler2D uOvalMask;
uniform sampler2D uVideo;
uniform float uMirror;
uniform vec2 uSize;
uniform vec4 uBox; // bx, by, bw, bh in pixels
uniform vec4 uFrame;
uniform float uIod;
uniform float uRealCheekTex; // 0 on Minimal (pure flatten Q1), 1 on multi-copy collage (prevents flat cheek gaps R7)
in vec2 vUv;
out vec4 fragColor;
void main() {
  float a = texture(uOvalMask, vUv).r;
  if (a < 0.002) discard;
  vec2 px = vec2(vUv.x * uSize.x, (1.0 - vUv.y) * uSize.y);
  vec2 pUv = vec2((px.x - uBox.x) / uBox.z, 1.0 - (px.y - uBox.y) / uBox.w);
  vec3 skin = texture(uPlate, clamp(pUv, 0.001, 0.999)).rgb;
  // In multi-copy collage modes, restore subtle real photographic cheek/forehead shading outside the
  // central nose/lip cover zone so exposed skin gaps never read as flat solid colour (R7).
  if (uRealCheekTex > 0.5) {
    vec2 d = px - uFrame.xy;
    vec2 q = vec2(d.x * uFrame.z + d.y * uFrame.w, -d.x * uFrame.w + d.y * uFrame.z) / max(1.0, uIod);
    float offNose = smoothstep(0.30, 0.48, abs(q.x)) + smoothstep(0.82, 0.96, q.y) + smoothstep(0.08, -0.08, q.y);
    float safe = clamp(offNose, 0.0, 1.0) * smoothstep(0.25, 0.7, a);
    vec2 vUvM = vec2(uMirror > 0.5 ? 1.0 - vUv.x : vUv.x, vUv.y);
    vec3 live = texture(uVideo, clamp(vUvM, 0.001, 0.999)).rgb;
    skin = mix(skin, live, safe * 0.55);
  }
  // Subtle skin-plate tone match so patch rims melt invisibly into the flattened face.
  vec3 lift = vec3(1.0, 0.973, 0.941);
  skin = 1.0 - (1.0 - skin) * (1.0 - lift * 0.035);
  fragColor = vec4(skin, a);
}
`;

/** Captures a face-aligned unrotated feature crop into a tile of the Expression Frame Bank atlas. */
export const BANK_CROP_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uVideo;
uniform float uMirror;
uniform vec2 uSize;
uniform vec4 uFrame;   // ox, oy, ax, ay
uniform float uIod;
uniform vec4 uFeat;    // u, v, w, h in face units
in vec2 vUv;
out vec4 fragColor;
void main() {
  // vUv (0..1, y-up) -> local face units [-w/2..w/2, -h/2..h/2] with y-down
  vec2 local = vec2((vUv.x - 0.5) * uFeat.z, (0.5 - vUv.y) * uFeat.w);
  vec2 fuv = uFeat.xy + local;
  vec2 px = uFrame.xy + vec2(fuv.x * uFrame.z - fuv.y * uFrame.w, fuv.x * uFrame.w + fuv.y * uFrame.z) * uIod;
  vec2 uv = vec2(px.x / uSize.x, 1.0 - px.y / uSize.y);
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  fragColor = texture(uVideo, clamp(uv, 0.001, 0.999));
}
`;

/**
 * Quad vertex shader for organic feature patches & cheek edge slices.
 * Transforms patch-local units `aLocal` ([-w/2..w/2, -h/2..h/2], y-down) through the patch
 * placement (du, dv, rot, flipX, scale) and the face frame matrix into screen NDC.
 */
export const PATCH_VERT = `#version 300 es
precision highp float;
const vec2 UNIT[4] = vec2[4](
  vec2(-0.5, -0.5),
  vec2( 0.5, -0.5),
  vec2(-0.5,  0.5),
  vec2( 0.5,  0.5)
);
uniform vec2 uSize;
uniform vec4 uFrame;    // ox, oy, ax, ay
uniform float uIod;
uniform vec2 uDestUV;   // destination centre in face units
uniform vec2 uBoxWH;    // patch w, h in face units
uniform float uScale;
uniform float uRot;     // radians
uniform float uFlipX;   // 1.0 or -1.0
uniform float uPad;     // extra margin (face units) so organic feathers are never clipped by the quad
out vec2 vLocal;        // patch-local unflipped face units (y-down)
void main() {
  vec2 u = UNIT[gl_VertexID];
  vLocal = u * (uBoxWH + 2.0 * uPad);
  vec2 p = vec2(vLocal.x * uFlipX, vLocal.y) * uScale;
  float c = cos(uRot);
  float s = sin(uRot);
  vec2 r = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  vec2 fuv = uDestUV + r;
  vec2 px = uFrame.xy + vec2(fuv.x * uFrame.z - fuv.y * uFrame.w, fuv.x * uFrame.w + fuv.y * uFrame.z) * uIod;
  vec2 ndc = vec2((px.x / uSize.x) * 2.0 - 1.0, 1.0 - (px.y / uSize.y) * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

/**
 * Organic anatomical contour patch shader with selective crisp collage cut seams,
 * local micro-sharpening, and nostril deepening. Supports BOTH live video and Frame Bank atlas!
 */
export const PATCH_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform float uFromBank;   // 0.0 = live video, 1.0 = bank atlas tile
uniform float uMirror;     // live video mirror flag
uniform vec2 uSize;        // canvas W, H
uniform vec4 uFrame;       // ox, oy, ax, ay
uniform float uIod;
uniform vec4 uSrcFeat;     // live feature (u, v, w, h)
uniform vec4 uTileRect;    // bank tile UV (x0, y0, tw, th)
uniform vec2 uTexel;       // 1 / source texture W, H
uniform float uPad;        // quad / bank-tile margin around the feature box (face units)
uniform vec2 uPoly[16];    // anatomical contour polygon in local face units
uniform int uPolyCount;
uniform vec3 uCut;         // selective hard cut plane (nx, ny, dist) in local face units
uniform float uHasCut;     // 1.0 if hard cut active
uniform float uFeatherTop; // organic feather width (IOD) at upper contour
uniform float uFeatherBot; // organic feather width (IOD) at lower contour
uniform float uScale;      // patch scale (to compute crisp 1.5 px AA & 1.5 px seam)
uniform float uGrow;       // add-animation alpha
uniform float uShade;      // deterministic ±4.5% brightness jitter
uniform float uDeepen;     // nose nostril / tip shadow deepening
uniform float uSharpen;    // unsharp-mask crispness for eyes/noses/mouths
in vec2 vLocal;
out vec4 fragColor;

float sdPolygon(vec2 p, int n) {
  float d = dot(p - uPoly[0], p - uPoly[0]);
  float s = 1.0;
  for (int i = 0; i < 16; i++) {
    if (i >= n) break;
    int j = (i == 0) ? (n - 1) : (i - 1);
    vec2 e = uPoly[j] - uPoly[i];
    vec2 w = p - uPoly[i];
    vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-6), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= uPoly[i].y, p.y < uPoly[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s *= -1.0;
  }
  return s * sqrt(d);
}

vec2 sampleUv(vec2 localPos) {
  if (uFromBank > 0.5) {
    vec2 tileWH = uSrcFeat.zw + 2.0 * uPad;
    vec2 t = vec2(localPos.x / tileWH.x + 0.5, 0.5 - localPos.y / tileWH.y);
    t = clamp(t, 0.002, 0.998);
    return uTileRect.xy + t * uTileRect.zw;
  }
  vec2 fuv = uSrcFeat.xy + localPos;
  vec2 px = uFrame.xy + vec2(fuv.x * uFrame.z - fuv.y * uFrame.w, fuv.x * uFrame.w + fuv.y * uFrame.z) * uIod;
  vec2 uv = vec2(px.x / uSize.x, 1.0 - px.y / uSize.y);
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  return clamp(uv, 0.001, 0.999);
}

void main() {
  // Pixel size in patch-local face units for razor-sharp <= 2 px collage cut edge (Q3).
  float pxUnit = 1.0 / max(1.0, uIod * uScale);
  float aa = pxUnit * 0.5;

  // 1. Organic anatomical contour mask (100% solid inside landmark hull + rim, smooth falloff outside).
  float sd = sdPolygon(vLocal, uPolyCount);
  float yFrac = clamp(vLocal.y / max(0.05, uSrcFeat.w) + 0.5, 0.0, 1.0);
  float feather = mix(uFeatherTop, uFeatherBot, yFrac);
  float organicA = 1.0 - smoothstep(-aa * 0.5, max(feather, aa * 1.5), sd);
  if (organicA < 0.003) discard;

  // 2. Selective crisp collage cut chord (keeps hard cuts <= 1.5 px without rectangular blinds).
  float cutA = 1.0;
  float seam = 0.0;
  if (uHasCut > 0.5) {
    float dc = dot(vLocal, uCut.xy) - uCut.z;
    cutA = 1.0 - smoothstep(-aa, aa, dc);
    if (cutA < 0.003) discard;
    float seamW = pxUnit * 1.4;
    seam = smoothstep(-seamW, -aa * 0.25, dc) * cutA;
  }

  // 3. Sample source texture with subtle unsharp-mask sharpening so irises/nostrils/teeth pop.
  vec2 uv = sampleUv(vLocal);
  vec3 col = texture(uSource, uv).rgb;
  if (uSharpen > 0.001) {
    vec3 blur = 0.25 * (
      texture(uSource, clamp(uv + vec2(uTexel.x, 0.0), 0.001, 0.999)).rgb +
      texture(uSource, clamp(uv - vec2(uTexel.x, 0.0), 0.001, 0.999)).rgb +
      texture(uSource, clamp(uv + vec2(0.0, uTexel.y), 0.001, 0.999)).rgb +
      texture(uSource, clamp(uv - vec2(0.0, uTexel.y), 0.001, 0.999)).rgb
    );
    col = clamp(col + (col - blur) * uSharpen, 0.0, 1.0);
  }

  // 4. Deterministic shade jitter & nose shadow deepening (keeps 2-tier nostrils readable).
  if (uShade > 0.0) col = mix(col, vec3(1.0), uShade);
  else if (uShade < 0.0) col = mix(col, vec3(0.0), -uShade);
  if (uDeepen > 0.001) {
    vec3 mul = col * col;
    col = mix(col, mul, uDeepen);
    // Lift midtones back slightly while keeping dark nostrils & tip shadows deep.
    col = mix(col, vec3(1.0), uDeepen * 0.26);
  }

  // Subtle 15% dark paper-cut seam line right along the crisp collage cut edge.
  col *= (1.0 - seam * 0.16);
  fragColor = vec4(col, organicA * cutA * uGrow);
}
`;

/**
 * Cheek / jaw edge slice shader: copies a strip of the finished collage at srcU and pastes
 * it shifted outwards with crisp top, bottom, and angled outer collage cuts + drop shadow seam.
 */
export const SLICE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uCollage;
uniform vec2 uSize;
uniform vec4 uFrame;    // ox, oy, ax, ay
uniform float uIod;
uniform vec2 uSrcUV;    // srcU, v in face units
uniform vec2 uBoxWH;    // len, h in face units
uniform float uSide;    // +1 right, -1 left
uniform float uOuterSlope; // tan(outerAngle)
uniform float uGrow;
uniform float uShade;
in vec2 vLocal;
out vec4 fragColor;

void main() {
  float pxUnit = 1.0 / max(1.0, uIod);
  float aa = pxUnit * 0.5;
  float hw = uBoxWH.x * 0.5;
  float hh = uBoxWH.y * 0.5;

  // Hard top and bottom edges.
  float dTop = -vLocal.y - hh;
  float dBot = vLocal.y - hh;
  // Hard angled outer edge on the outward-facing side (always inside [-hw, hw] so the slant never stubs).
  float safeSlope = clamp(uOuterSlope, -0.65 * hw / max(hh, 0.02), 0.65 * hw / max(hh, 0.02));
  float outerX = hw - abs(safeSlope) * hh - safeSlope * vLocal.y;
  float dOuter = (uSide > 0.0 ? vLocal.x : -vLocal.x) - outerX;
  // Soft inner anchor edge facing the centre of the face.
  float innerCoord = uSide > 0.0 ? -vLocal.x : vLocal.x;
  float innerFeather = min(uBoxWH.x * 0.42, 0.12);
  float innerA = 1.0 - smoothstep(hw - innerFeather, hw, innerCoord);

  float topA = 1.0 - smoothstep(-aa, aa, dTop);
  float botA = 1.0 - smoothstep(-aa, aa, dBot);
  float outerA = 1.0 - smoothstep(-aa, aa, dOuter);
  float alpha = topA * botA * outerA * innerA;
  if (alpha < 0.003) discard;

  vec2 fuv = uSrcUV + vLocal;
  vec2 px = uFrame.xy + vec2(fuv.x * uFrame.z - fuv.y * uFrame.w, fuv.x * uFrame.w + fuv.y * uFrame.z) * uIod;
  vec2 uv = vec2(px.x / uSize.x, 1.0 - px.y / uSize.y);
  vec3 col = texture(uCollage, clamp(uv, 0.001, 0.999)).rgb;

  if (uShade > 0.0) col = mix(col, vec3(1.0), uShade);
  else if (uShade < 0.0) col = mix(col, vec3(0.0), -uShade);

  // Crisp collage cut shadows (<= 1.5 px) on bottom and angled outer cut edges.
  float seamW = pxUnit * 1.4;
  float botSeam = smoothstep(-seamW, -aa * 0.2, dBot) * botA;
  float outSeam = smoothstep(-seamW, -aa * 0.2, dOuter) * outerA;
  col *= (1.0 - max(botSeam, outSeam) * 0.18);

  fragColor = vec4(col, alpha * uGrow);
}
`;

/**
 * Pass 3 final composite: blends privacy blur + collage, runs GPU horizontal glitch slip bands
 * with R/B channel split, applies global high-key magazine-scan tone curve (zero spatial box or
 * halo ring!), and overlays deterministic magazine-scan film grain.
 */
export const FINAL_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uCollage;
uniform sampler2D uBgBlur;
uniform sampler2D uGrain;
uniform vec2 uSize;
uniform float uAlpha;
uniform float uHasCollage;
uniform float uGradeAmt;      // 0 on Minimal (pure flatten test), 1 on Default/Ref
uniform int uBandCount;
uniform vec4 uBandRect[16];   // x0, y0, x1, y1 in pixel coords (y-down)
uniform vec2 uBandShift[16];  // shiftPx, splitPx
uniform float uGrainAlpha;
uniform vec2 uGrainOffset;    // in pixels
uniform float uGrainSize;
in vec2 vUv;
out vec4 fragColor;

vec3 sampleBase(vec2 uv) {
  uv = clamp(uv, 0.001, 0.999);
  vec3 c = (uAlpha < 0.999 || uHasCollage < 0.5) ? texture(uBgBlur, uv).rgb : vec3(0.0);
  if (uAlpha > 0.001 && uHasCollage > 0.5) {
    vec3 col = texture(uCollage, uv).rgb;
    c = mix(c, col, uAlpha);
  }
  return c;
}

/**
 * Global high-key warm magazine-scan tone curve (ref-match guide section 6).
 * Spatially uniform across the entire frame -> ZERO rectangular box step and ZERO bright halo!
 * Neutral bright wall lifts cleanly to washed-out off-white (L ~ 225-238); warm skin shifts
 * toward ref's golden-peach flash look (L p5/p50/p95 ~ 45/172/218, R-G ~ 38, G-B ~ 30).
 */
vec3 applyScanGrade(vec3 c) {
  // Smooth warmness factor: 0 for neutral grey/white background, 1 for warm skin tones.
  float warm = smoothstep(0.03, 0.14, c.r - c.b);
  vec3 kWarm = vec3(1.85, 1.78, 0.96);
  vec3 kNeut = vec3(1.85, 1.85, 1.82);
  vec3 k = mix(kNeut, kWarm, warm);
  vec3 lifted = (1.0 - exp(-k * c)) / (1.0 - exp(-k));

  // Luma contrast stretch around midtone keeps pupils/nostrils/open mouth deep (p5 <= 55)
  // while pushing skin highlights & washed-out background to glossy flash brightness (p95 >= 215).
  float luma = dot(lifted, vec3(0.299, 0.587, 0.114));
  float mid = 0.578;
  float contrast = 1.50;
  float delta = (luma - mid) * (contrast - 1.0);
  vec3 graded = clamp(lifted + vec3(delta), 0.0, 1.0);

  // Subtle highlight shoulder for neutral washed-out white background without clipping skin hue.
  float hiNeut = (1.0 - warm) * smoothstep(0.72, 0.95, luma);
  graded = mix(graded, vec3(0.94, 0.938, 0.925), hiNeut * 0.18);
  return graded;
}

vec3 blendOverlay(vec3 base, vec3 blend) {
  vec3 lo = 2.0 * base * blend;
  vec3 hi = 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
  return mix(lo, hi, step(0.5, base));
}

void main() {
  vec2 px = vec2(vUv.x * uSize.x, (1.0 - vUv.y) * uSize.y);
  float shiftPx = 0.0;
  float splitPx = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= uBandCount) break;
    vec4 r = uBandRect[i];
    if (px.y >= r.y && px.y < r.w && px.x >= r.x && px.x < r.z) {
      shiftPx = uBandShift[i].x;
      splitPx = uBandShift[i].y;
    }
  }

  vec3 col;
  if (abs(shiftPx) > 0.001 || abs(splitPx) > 0.001) {
    float duR = (-shiftPx - splitPx) / uSize.x;
    float duG = (-shiftPx) / uSize.x;
    float duB = (-shiftPx + splitPx) / uSize.x;
    col = vec3(
      sampleBase(vUv + vec2(duR, 0.0)).r,
      sampleBase(vUv + vec2(duG, 0.0)).g,
      sampleBase(vUv + vec2(duB, 0.0)).b
    );
  } else {
    col = sampleBase(vUv);
  }

  if (uGradeAmt > 0.001) {
    col = mix(col, applyScanGrade(col), uGradeAmt);
  }

  if (uGrainAlpha > 0.001) {
    vec2 gUv = mod(px + uGrainOffset, uGrainSize) / uGrainSize;
    vec3 g = texture(uGrain, gUv).rgb;
    col = mix(col, blendOverlay(col, g), uGrainAlpha);
  }

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
