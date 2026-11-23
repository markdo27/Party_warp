/** Records the output canvas (never the raw camera) to MP4/WebM, capped at 15 s. */

export const MAX_RECORD_MS = 15000;
export const RECORD_FPS = 30;
const VIDEO_TYPES = ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

/** First type this browser's MediaRecorder can write, or null. */
export const pickVideoType = (isSupported) => VIDEO_TYPES.find((t) => isSupported(t)) ?? null;

export const extensionFor = (type) => (type?.startsWith('video/mp4') ? 'mp4' : 'webm');

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {{ type: string, done: Promise<Blob>, stop: () => void }}
 */
export function startRecording(canvas, { maxMs = MAX_RECORD_MS, fps = RECORD_FPS } = {}) {
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) throw new Error('Recording is not supported in this browser');
  const type = pickVideoType((t) => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error('No supported video format');
  const stream = canvas.captureStream(fps);
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
  return { type, done, stop: () => rec.state !== 'inactive' && rec.stop() };
}
