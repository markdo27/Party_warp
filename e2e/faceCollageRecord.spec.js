// Face Collage video export and GPU context loss (architecture-r5 §6.1, P3/P6), against Chrome's
// fake camera fed by the same synthetic-face clip as faceCollage.spec.js.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FACE = resolve(ROOT, 'e2e/fixtures/synthetic-face.jpg');
const CLIP = resolve(ROOT, 'test-results/fake-camera-record.y4m');
const EVIDENCE = process.env.FC_EVIDENCE_DIR;
const URL_ = '/face-collage.html?debug=1&seed=abc123';
const RECORD_FPS = 30;
const RESTORE_LIMIT_MS = 3000;

if (!existsSync(CLIP)) {
  mkdirSync(dirname(CLIP), { recursive: true });
  execFileSync('python', [resolve(ROOT, 'scripts/fake-camera.py'), FACE, CLIP]);
}

test.describe.configure({ mode: 'serial' });
test.use({
  launchOptions: {
    args: ['--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${CLIP}`],
  },
});

const snap = (page) => page.evaluate(() => window.__faceCollage?.snapshot());
const ui = (page) => page.evaluate(() => window.__faceCollage?.ui());
const save = (name, data) => {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(resolve(EVIDENCE, name), JSON.stringify(data, null, 2));
};
const loseContext = (page) =>
  page.evaluate(() => {
    const ext = document.querySelector('[data-testid="fc-canvas"]').getContext('webgl2').getExtension('WEBGL_lose_context');
    window.__fcLoseExt = ext;
    ext.loseContext();
  });

async function startTracking(page) {
  await page.goto(URL_);
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect.poll(async () => (await snap(page))?.phase, { timeout: 60_000, intervals: [100] }).toBe('tracking');
}

test('record: paced 30 fps export, file saved, debug HUD reports gpuMs and degrade level', async ({ page }) => {
  test.setTimeout(120_000);
  await startTracking(page);
  await page.getByTestId('fc-record').click();
  await page.waitForTimeout(3000);
  const during = await snap(page);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.getByTestId('fc-record').click()]);
  const file = resolve(ROOT, 'test-results', `record-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  await expect(page.getByRole('status').filter({ hasText: 'Clip saved' })).toBeVisible();
  save('record-export.json', { export: during.export, gpuMs: during.gpuMs, degrade: during.degrade, bytes: statSync(file).size });
  expect(during.export.paced).toBe(true);
  // 3 s at 30 fps, allowing for the click/poll slack around the window.
  expect(during.export.pushed).toBeGreaterThan(RECORD_FPS * 2.5);
  expect(during.export.pushed).toBeLessThan(RECORD_FPS * 3.6);
  expect(statSync(file).size).toBeGreaterThan(10_000);
  expect(during.gpuMs === 'n/a' || during.gpuMs === null || typeof during.gpuMs === 'number').toBe(true);
  expect(during.degrade.level).toBe(0);
  expect((await snap(page)).export).toBeNull();
});

test('context lost while recording: clip stops with a notice, image comes back, no error screen', async ({ page }) => {
  test.setTimeout(120_000);
  await startTracking(page);
  await page.getByTestId('fc-record').click();
  await page.waitForTimeout(1000);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), loseContext(page)]);
  await expect(page.getByRole('status').filter({ hasText: 'Recording stopped' })).toBeVisible();
  expect((await ui(page)).recording).toBe(false);
  const file = resolve(ROOT, 'test-results', `lost-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  const t0 = Date.now();
  await page.evaluate(() => window.__fcLoseExt.restoreContext());
  await expect.poll(async () => (await snap(page)).contextLost, { timeout: RESTORE_LIMIT_MS, intervals: [50] }).toBe(false);
  const backMs = Date.now() - t0;
  // Past the 3 s window the restored session must still be live, not on the error screen.
  await page.waitForTimeout(RESTORE_LIMIT_MS + 500);
  const after = await ui(page);
  save('record-context-lost.json', { backMs, ui: after, bytes: statSync(file).size, contextEvents: (await snap(page)).contextEvents });
  expect(after.screen).toBe('active');
  expect(backMs).toBeLessThan(RESTORE_LIMIT_MS);
});

test('context not restored within 3 s: error screen whose Try again reloads the page', async ({ page }) => {
  test.setTimeout(120_000);
  await startTracking(page);
  const t0 = Date.now();
  await loseContext(page);
  await expect(page.locator('[data-error="gpu-lost"]')).toBeVisible({ timeout: RESTORE_LIMIT_MS + 2000 });
  const shownMs = Date.now() - t0;
  save('record-context-timeout.json', { shownMs });
  expect(shownMs).toBeGreaterThanOrEqual(RESTORE_LIMIT_MS - 100);
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Try again' }).click()]);
  await expect(page.getByRole('button', { name: 'Start camera' })).toBeVisible();
});
