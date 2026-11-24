/** Records the output canvas (never the raw camera) to MP4/WebM, capped at 15 s. */

export const MAX_RECORD_MS = 15000;
export const RECORD_FPS = 30;
/** A frame may come this share of a step early (rAF jitter) and still count as on time. */
const PACE_TOLERANCE = 0.25;
const VIDEO_TYPES = ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

/** First type this browser's MediaRecorder can write, or null. */
export const pickVideoType = (isSupported) => VIDEO_TYPES.find((t) => isSupported(t)) ?? null;

export const extensionFor = (type) => (type?.startsWith('video/mp4') ? 'mp4' : 'webm');

/**
 * Decides which rendered frames go into the file so the file keeps an even `fps` cadence.
 * `captureStream(30)` samples on its own clock against a 60 Hz rAF and lands frames in pairs
 * (<20 ms then >40 ms apart), which players show as stutter and count as ~25-27 fps.
 * The schedule keeps its phase (next += step) so a 50 Hz or 40 Hz loop still averages `fps`,
 * and snaps forward after a stall instead of bursting to catch up.
 * @param {number} fps
 * @returns {(t: number) => boolean} true when the frame drawn at time `t` (ms) should be captured
 */
export function makeFramePacer(fps = RECORD_FPS) {
  const step = 1000 / fps;
  const early = step * PACE_TOLERANCE;
  let next = null;
  return (t) => {
    if (next === null || t - next > step) {
      next = t + step;
      return true;
    }
    if (t < next - early) return false;
    next += step;
    return true;
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {{ type: string, done: Promise<Blob>, stop: () => void, pushFrame: (t: number) => void, stats: () => { paced: boolean, pushed: number } }}
 *   With `paced` the caller must call `pushFrame(t)` after every drawn frame; otherwise it is a no-op.
 */
export function startRecording(canvas, { maxMs = MAX_RECORD_MS, fps = RECORD_FPS } = {}) {
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) throw new Error('Recording is not supported in this browser');
  const type = pickVideoType((t) => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error('No supported video format');
  // captureStream(0) + requestFrame lets the draw loop decide the cadence; browsers without
  // requestFrame fall back to the timed capture.
  const manual = canvas.captureStream(0);
  const manualTrack = manual.getVideoTracks()[0];
  const paced = typeof manualTrack?.requestFrame === 'function';
  if (!paced) manual.getTracks().forEach((t) => t.stop());
  const stream = paced ? manual : canvas.captureStream(fps);
  const track = stream.getVideoTracks()[0];
  const shouldCapture = makeFramePacer(fps);
  let pushed = 0;
  const rec = new MediaRecorder(stream, { mimeType: type });
  const chunks = [];
  let timer = 0;
  const done = new Promise((resolve, reject) => {
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onerror = (e) => reject(e.error ?? new Error('Recording failed'));
    rec.onstop = () => {
      clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: type.split(';')[0] }));
    };
  });
  rec.start(250);
  timer = setTimeout(() => rec.state !== 'inactive' && rec.stop(), maxMs);
  const pushFrame = (t) => {
    if (!paced || rec.state !== 'recording' || !shouldCapture(t)) return;
    track.requestFrame();
    pushed += 1;
  };
  return {
    type,
    done,
    stop: () => rec.state !== 'inactive' && rec.stop(),
    pushFrame,
    stats: () => ({ paced, pushed }),
  };
}
