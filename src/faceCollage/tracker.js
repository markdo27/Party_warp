/**
 * MediaPipe Face Landmarker wrapper. WASM and model are self-hosted under
 * public/face-collage/ so nothing leaves the page's origin (foundation D2).
 * Tries the GPU delegate first and falls back to CPU.
 */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export const ASSET_DIR = 'face-collage';
export const MODEL_FILE = 'face_landmarker.task';
export const CONFIDENCE = { detection: 0.5, presence: 0.5, tracking: 0.5 };

const assetUrl = (path) => new URL(`${ASSET_DIR}/${path}`, document.baseURI).href;

/** Downloads the model with progress (0..1) so the loading screen can show it. */
async function fetchModel(onProgress) {
  const res = await fetch(assetUrl(MODEL_FILE));
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(1);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function createLandmarker(fileset, model, delegate) {
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: model, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: CONFIDENCE.detection,
    minFacePresenceConfidence: CONFIDENCE.presence,
    minTrackingConfidence: CONFIDENCE.tracking,
  });
}

/**
 * @returns {Promise<{ delegate: 'GPU'|'CPU', detect: (src: CanvasImageSource, ts: number) => Array|null, close: () => void }>}
 */
export async function createTracker({ onProgress, preferCpu = false } = {}) {
  const [fileset, model] = await Promise.all([
    FilesetResolver.forVisionTasks(assetUrl('wasm')),
    fetchModel(onProgress),
  ]);
  let landmarker = null;
  let delegate = preferCpu ? 'CPU' : 'GPU';
  try {
    landmarker = await createLandmarker(fileset, model, delegate);
  } catch (err) {
    if (delegate === 'CPU') throw err;
    console.warn('[face-collage] GPU delegate failed, using CPU', err?.message);
    delegate = 'CPU';
    landmarker = await createLandmarker(fileset, model, delegate);
  }
  let lastTs = 0;
  return {
    delegate,
    detect(source, ts) {
      // MediaPipe needs strictly increasing timestamps in VIDEO mode.
      const t = Math.max(lastTs + 1, Math.round(ts));
      lastTs = t;
      const result = landmarker.detectForVideo(source, t);
      return result?.faceLandmarks?.[0] ?? null;
    },
    close() {
      landmarker?.close();
      landmarker = null;
    },
  };
}
