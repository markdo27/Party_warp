// Copies the MediaPipe WASM runtime next to the model so the demo is fully self-hosted.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const to = join(root, 'public', 'face-collage', 'wasm');
const FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm'];

if (!existsSync(from)) {
  console.error(`[face-collage] missing ${from}; run npm install first`);
  process.exit(1);
}
mkdirSync(to, { recursive: true });
for (const f of FILES) {
  if (existsSync(join(from, f))) copyFileSync(join(from, f), join(to, f));
}
if (!existsSync(join(root, 'public', 'face-collage', 'face_landmarker.task'))) {
  console.warn('[face-collage] public/face-collage/face_landmarker.task is missing (see FACE_COLLAGE.md)');
}
