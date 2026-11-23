// Face Collage prototype, run against Chrome's fake camera fed by a synthetic (AI-made) face.
// The clip (scripts/fake-camera.py) holds still, rolls/zooms, drops the face for 2 s, then comes back.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FACE = resolve(ROOT, 'e2e/fixtures/synthetic-face.jpg');
const CLIP = resolve(ROOT, 'test-results/fake-camera.y4m');
const EVIDENCE = process.env.FC_EVIDENCE_DIR;
const URL_ = '/face-collage.html?debug=1&seed=abc123';
// Antivirus on the test machine injects its own script into every page; it is not app traffic.
const INJECTED_HOSTS = [/\.kaspersky-labs\.com$/];

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
const shot = async (page, name) => {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.locator('[data-testid="fc-canvas"]').screenshot({ path: resolve(EVIDENCE, `${name}.png`) });
};
const waitPhase = (page, phase, timeout = 30_000) =>
  expect.poll(async () => (await snap(page))?.phase, { timeout, intervals: [100] }).toBe(phase);

test('camera: tracks, follows the face, survives loss, stops the camera', async ({ page }) => {
  test.setTimeout(120_000);
  const foreign = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (['blob:', 'data:'].includes(u.protocol)) return;
    if (INJECTED_HOSTS.some((h) => h.test(u.hostname))) return;
    if (!['localhost', '127.0.0.1'].includes(u.hostname)) foreign.push(r.url());
  });
  await page.goto(URL_);
  await page.getByRole('button', { name: 'Start camera' }).click();
  await waitPhase(page, 'tracking', 60_000);
  const first = await snap(page);
  expect(first.counts).toEqual({ eye: 6, mouth: 3 });
  expect(first.seed).toBe(parseInt('abc123', 36));
  await page.waitForTimeout(400);
  await shot(page, '01-default-tracking');

  // Raising a count keeps the earlier patches exactly where they were.
  await page.getByTestId('fc-count-eye').fill('10');
  await page.getByTestId('fc-count-nose').fill('3');
  const more = await snap(page);
  expect(more.counts).toEqual({ eye: 10, mouth: 3, nose: 3 });
  for (const p of first.patches) expect(more.patches).toContainEqual(p);

  // The layout is a pure function of the seed: no change across frames.
  const a = (await snap(page)).patches;
  await page.waitForTimeout(1500);
  expect((await snap(page)).patches).toEqual(a);

  // Random gives a new seed, same counts.
  await page.getByTestId('fc-random').click();
  const rolled = await snap(page);
  expect(rolled.seed).not.toBe(more.seed);
  expect(rolled.counts).toEqual(more.counts);

  // Ref preset for the screenshot set.
  await page.getByLabel('Preset').selectOption('ref');
  await page.getByTestId('fc-seed').fill('abc123');
  await page.getByTestId('fc-seed').press('Enter');
  await waitPhase(page, 'tracking');
  await page.waitForTimeout(400);
  await shot(page, '02-ref-preset');

  // Output differs from the raw camera frame inside the face (the export is never the raw image).
  const diff = await page.evaluate(() => {
    const out = document.querySelector('[data-testid="fc-canvas"]');
    const video = document.querySelector('video');
    const c = document.createElement('canvas');
    c.width = out.width;
    c.height = out.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.setTransform(-1, 0, 0, 1, c.width, 0);
    g.drawImage(video, 0, 0, c.width, c.height);
    const box = [c.width * 0.3, c.height * 0.25, c.width * 0.4, c.height * 0.6];
    const raw = g.getImageData(...box).data;
    const o = out.getContext('2d').getImageData(...box).data;
    let sum = 0;
    for (let i = 0; i < raw.length; i += 4) sum += Math.abs(raw[i] - o[i]) + Math.abs(raw[i + 1] - o[i + 1]) + Math.abs(raw[i + 2] - o[i + 2]);
    return sum / (raw.length / 4) / 3;
  });
  expect(diff).toBeGreaterThan(8);

  // PNG export downloads the output canvas.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PNG' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^face-collage-[0-9a-z]{6}\.png$/);
  if (EVIDENCE) await download.saveAs(resolve(EVIDENCE, '03-export.png'));

  // The clip drops the face for 2 s: holding (1 s freeze) -> lost -> tracking again, same seed.
  const seedBefore = (await snap(page)).seed;
  await expect
    .poll(async () => /holding,lost(,searching)?,tracking/.test((await snap(page)).timeline.map((x) => x.phase).join(',')), {
      timeout: 40_000,
      intervals: [200],
    })
    .toBe(true);
  const tl = (await snap(page)).timeline;
  const lostAt = tl.findLastIndex((x) => x.phase === 'lost');
  expect(tl[lostAt - 1].phase).toBe('holding');
  expect(tl[lostAt].t - tl[lostAt - 1].t).toBeGreaterThanOrEqual(1000);
  expect((await snap(page)).seed).toBe(seedBefore);

  const perf = await snap(page);
  if (EVIDENCE) {
    const summary = { fps: perf.fps, detectMs: perf.detectMs, renderMs: perf.renderMs, delegate: perf.delegate, size: perf.size };
    writeFileSync(resolve(EVIDENCE, 'camera-run.json'), JSON.stringify({ perf: summary, timeline: tl, foreign }, null, 2));
  }

  // Stop releases every camera track.
  await page.evaluate(() => {
    window.__fcStream = document.querySelector('video').srcObject;
  });
  await page.getByTestId('fc-stop').click();
  await expect(page.getByRole('heading', { name: 'Camera off' })).toBeVisible();
  const states = await page.evaluate(() => window.__fcStream.getTracks().map((t) => t.readyState));
  expect(states.length).toBeGreaterThan(0);
  expect(states.every((s) => s === 'ended')).toBe(true);
  expect(foreign).toEqual([]);
});

test('denied camera shows the blocked screen and a photo still works', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
  });
  await page.goto(URL_);
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.locator('[data-error="denied"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Camera blocked' })).toBeVisible();
  if (EVIDENCE) await page.screenshot({ path: resolve(EVIDENCE, '04-denied.png') });

  await page.getByTestId('fc-photo').first().setInputFiles(FACE);
  await waitPhase(page, 'tracking', 60_000);
  expect((await ui(page)).mode).toBe('photo');
  await page.waitForTimeout(400);
  await shot(page, '05-photo-default');
  await page.getByLabel('Preset').selectOption('minimal');
  await page.waitForTimeout(300);
  await shot(page, '06-photo-minimal');
});

test('reduced motion: no glitch bands, collage still drawn', async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(URL_);
  await page.getByTestId('fc-photo').first().setInputFiles(FACE);
  await waitPhase(page, 'tracking', 60_000);
  await page.getByLabel('Preset').selectOption('ref');
  await page.waitForTimeout(1200);
  const s = await snap(page);
  expect(s.glitch).toBeGreaterThan(0);
  expect(s.bands).toBe(0);
  await context.close();
});
