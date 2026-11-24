/**
 * Visible-teeth measurement for the Expression Frame Bank (`mouthTeeth` slot).
 *
 * Landmarks alone cannot tell "lips parted over teeth" from "lips parted over a dark mouth",
 * so this samples real pixels inside the inner-lip ring on the small detect canvas (already
 * CPU-side for the tracker) and compares them with the user's own cheek skin. Teeth read as
 * brighter than the cavity and less saturated than skin, lips and tongue. Only a number leaves
 * this module; no pixels are stored.
 */

/** MediaPipe inner-lip ring (closed polygon, 20 points). */
export const INNER_LIP_RING = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
/** Cheek points used as the user's skin reference (both sides, so one shadowed cheek is not decisive). */
export const SKIN_REF_POINTS = [50, 280, 101, 330];

export const TEETH_MIN_PIXELS = 24; // below this the inner mouth is too small to judge
export const TEETH_FRAC_MIN = 0.18; // share of inner-mouth pixels that must read as teeth

const SKIN_BOX = 3; // half size of each cheek sample box, detect-canvas pixels
const TOOTH_LUMA_VS_SKIN = 0.72; // tooth luma >= this * skin luma
const TOOTH_LUMA_FLOOR = 0.42; // and never darker than this (0..1), cavity guard
const TOOTH_CHROMA_VS_SKIN = 0.8; // tooth chroma <= this * skin chroma + slack
const TOOTH_CHROMA_SLACK = 0.04;

const luma = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
const chroma = (r, g, b) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;

/** Even-odd point-in-polygon test. */
export function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Integer bounding box of a polygon clamped to the image. */
export function polygonBounds(poly, width, height) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(width, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(height, Math.ceil(Math.max(...ys)));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Mean luma/chroma of RGBA pixels.
 * @param {Uint8ClampedArray|Uint8Array} data
 * @returns {{ luma: number, chroma: number, n: number }}
 */
export function meanTone(data) {
  let l = 0;
  let c = 0;
  let n = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    l += luma(data[i], data[i + 1], data[i + 2]);
    c += chroma(data[i], data[i + 1], data[i + 2]);
    n += 1;
  }
  return n ? { luma: l / n, chroma: c / n, n } : { luma: 0, chroma: 0, n: 0 };
}

/**
 * Share of inner-mouth pixels that read as teeth.
 * @param {{ data: Uint8ClampedArray|Uint8Array, x: number, y: number, w: number }} region RGBA crop and its origin
 * @param {Array<[number, number]>} poly inner-lip polygon in the same pixel space as the crop origin
 * @param {{ luma: number, chroma: number }} skin user's cheek tone
 * @returns {{ frac: number, pixels: number }}
 */
export function teethFraction(region, poly, skin) {
  const { data, x: ox, y: oy, w } = region;
  const lumaMin = Math.max(TOOTH_LUMA_FLOOR, skin.luma * TOOTH_LUMA_VS_SKIN);
  const chromaMax = skin.chroma * TOOTH_CHROMA_VS_SKIN + TOOTH_CHROMA_SLACK;
  const h = Math.floor(data.length / 4 / Math.max(1, w));
  let pixels = 0;
  let teeth = 0;
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      if (!insidePolygon(ox + i + 0.5, oy + j + 0.5, poly)) continue;
      const k = (j * w + i) * 4;
      const r = data[k];
      const g = data[k + 1];
      const b = data[k + 2];
      pixels += 1;
      if (luma(r, g, b) >= lumaMin && chroma(r, g, b) <= chromaMax) teeth += 1;
    }
  }
  return { frac: pixels ? teeth / pixels : 0, pixels };
}

/** Integer box around a point, clamped to the image. */
function pointBox(cx, cy, half, W, H) {
  const x = Math.max(0, cx - half);
  const y = Math.max(0, cy - half);
  return { x, y, w: Math.max(0, Math.min(W, cx + half + 1) - x), h: Math.max(0, Math.min(H, cy + half + 1) - y) };
}

/** Smallest box containing every non-empty box. */
function unionBox(boxes) {
  const live = boxes.filter((b) => b.w > 0 && b.h > 0);
  const x0 = Math.min(...live.map((b) => b.x));
  const y0 = Math.min(...live.map((b) => b.y));
  const x1 = Math.max(...live.map((b) => b.x + b.w));
  const y1 = Math.max(...live.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Copies a sub-box out of an RGBA crop whose origin is (img.x, img.y). */
function cropOf(img, box) {
  const out = new Uint8ClampedArray(box.w * box.h * 4);
  for (let j = 0; j < box.h; j += 1) {
    const from = ((box.y - img.y + j) * img.w + (box.x - img.x)) * 4;
    out.set(img.data.subarray(from, from + box.w * 4), j * box.w * 4);
  }
  return out;
}

/** Mean tone of the brighter half of the cheek samples (one cheek may sit in shadow). */
function skinTone(img, boxes) {
  const parts = boxes.filter((b) => b.w > 0 && b.h > 0).map((b) => meanTone(cropOf(img, b)));
  if (parts.length === 0) return null;
  const top = [...parts].sort((a, b) => b.luma - a.luma).slice(0, Math.ceil(parts.length / 2));
  return {
    luma: top.reduce((s, t) => s + t.luma, 0) / top.length,
    chroma: top.reduce((s, t) => s + t.chroma, 0) / top.length,
  };
}

/**
 * Measures visible teeth on a 2D canvas context from normalised landmarks.
 * Reads the canvas once (one box around mouth and cheeks): each getImageData is a GPU readback.
 * Returns null when it cannot judge (mouth too small, no skin sample); never guesses "teeth".
 * @param {CanvasRenderingContext2D} ctx detect canvas context (landmarks were computed on it)
 * @param {Array<{x: number, y: number}>} lm normalised landmarks
 * @returns {{ frac: number, pixels: number } | null}
 */
export function measureTeeth(ctx, lm) {
  const { width: W, height: H } = ctx.canvas;
  const poly = INNER_LIP_RING.map((i) => [lm[i].x * W, lm[i].y * H]);
  const mouth = polygonBounds(poly, W, H);
  if (mouth.w < 2 || mouth.h < 2) return null;
  const cheeks = SKIN_REF_POINTS.map((i) => pointBox(Math.round(lm[i].x * W), Math.round(lm[i].y * H), SKIN_BOX, W, H));
  const all = unionBox([mouth, ...cheeks]);
  const img = { ...all, data: ctx.getImageData(all.x, all.y, all.w, all.h).data };
  const skin = skinTone(img, cheeks);
  if (!skin) return null;
  const res = teethFraction({ data: cropOf(img, mouth), x: mouth.x, y: mouth.y, w: mouth.w }, poly, skin);
  return res.pixels >= TEETH_MIN_PIXELS ? res : null;
}
