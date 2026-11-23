import { describe, expect, it } from 'vitest';
import { cameraSupport, mapCameraError, stopStream } from './camera.js';
import { ERROR_COPY } from './copy.js';

const fakeTrack = () => ({ stopped: false, stop() { this.stopped = true; } });

describe('camera', () => {
  it('reports why the camera cannot run', () => {
    expect(cameraSupport({ isSecureContext: false, navigator: {} })).toBe('insecure');
    expect(cameraSupport({ isSecureContext: true, navigator: {} })).toBe('no-media');
    expect(cameraSupport({ isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } } })).toBeNull();
  });
  it('maps browser errors to screens that have copy', () => {
    const cases = { NotAllowedError: 'denied', NotFoundError: 'no-camera', NotReadableError: 'busy', AbortError: 'camera-error', TypeError: 'camera-error' };
    for (const [name, screen] of Object.entries(cases)) {
      expect(mapCameraError({ name })).toBe(screen);
      expect(ERROR_COPY[screen]).toBeDefined();
    }
    expect(mapCameraError(undefined)).toBe('camera-error');
  });
  it('stopStream ends every track and is safe on null', () => {
    const tracks = [fakeTrack(), fakeTrack()];
    stopStream({ getTracks: () => tracks });
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(() => stopStream(null)).not.toThrow();
  });
});
