/** Camera access: support check, open, stop, and error -> screen mapping. */

/** Why the camera cannot work here, or null when it can. */
export function cameraSupport(env = globalThis) {
  if (env.isSecureContext === false) return 'insecure';
  if (!env.navigator?.mediaDevices?.getUserMedia) return 'no-media';
  return null;
}

/** getUserMedia error -> app screen. */
export function mapCameraError(err) {
  const name = err?.name ?? '';
  if (['NotAllowedError', 'SecurityError', 'PermissionDeniedError'].includes(name)) return 'denied';
  if (['NotFoundError', 'OverconstrainedError', 'DevicesNotFoundError'].includes(name)) return 'no-camera';
  if (['NotReadableError', 'TrackStartError'].includes(name)) return 'busy';
  return 'camera-error';
}

const IDEAL_WIDTH = 1280;

/** Opens a video-only stream. Throws the browser's error unchanged (map it with mapCameraError). */
export async function openCamera({ deviceId } = {}) {
  const video = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: IDEAL_WIDTH } }
    : { facingMode: 'user', width: { ideal: IDEAL_WIDTH } };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

/** Stops every track so the camera light goes off. Safe on null. */
export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

/** Video inputs (labels only show after permission is granted). */
export async function listCameras() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  } catch (err) {
    console.warn('[face-collage] enumerateDevices failed', err?.name);
    return [];
  }
}

/** True when the stream is a front (selfie) camera, so the view should be mirrored. */
export function isFrontFacing(stream) {
  const track = stream?.getVideoTracks?.()[0];
  const mode = track?.getSettings?.().facingMode;
  return mode !== 'environment';
}
