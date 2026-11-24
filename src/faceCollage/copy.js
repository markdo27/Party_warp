/** Error screen copy (foundation 6.3). */
export const ERROR_COPY = {
  denied: { title: 'Camera blocked', body: 'Allow camera access in the browser address bar, then try again. Or use a photo instead.', retry: true },
  'no-camera': { title: 'No camera found', body: 'Connect a camera, or use a photo instead.', retry: true },
  busy: { title: 'Camera is busy', body: 'Another app is using the camera. Close it and try again.', retry: true },
  insecure: { title: 'Needs a secure page', body: 'The camera only works over HTTPS or on localhost. You can still use a photo.', retry: false },
  'no-media': { title: 'Camera not supported', body: 'This browser cannot open the camera. You can still use a photo.', retry: false },
  'model-error': { title: 'Face tracker failed to load', body: 'Check the connection and try again.', retry: true },
  webgl2: { title: 'WebGL2 not available', body: 'This browser cannot run the WebGL2 renderer. Try a modern browser with hardware graphics enabled.', retry: false },
  'photo-error': { title: 'Could not read that photo', body: 'Try another image (JPG or PNG).', retry: false },
  'camera-error': { title: 'Camera error', body: 'Something went wrong opening the camera. Try again.', retry: true },
};
