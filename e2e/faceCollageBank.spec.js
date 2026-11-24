// Expression Frame Bank (r5 bank step) against Chrome's fake camera.
// Clips come from face-collage/r5/bank-step/tools/make_bank_clips.py (synthetic face, 10 s loop):
//   pose-teeth   blink, gaze, open mouth with teeth, smile with teeth
//   pose-noteeth same timeline, open mouth shows only cavity/tongue, smile keeps lips closed
//   pose-neutral the face never moves
// The bank must fill a slot only when the frame really shows that expression.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Outside test-results/: Playwright wipes its output dir at the start of every run.
const CLIPS = process.env.FC_BANK_CLIPS ?? resolve(ROOT, '../face-collage/r5/bank-step/clips');
const LOSS_CLIP = resolve(CLIPS, 'face-loss.y4m');
const FACE = resolve(ROOT, 'e2e/fixtures/synthetic-face.jpg');
const EVIDENCE = process.env.FC_EVIDENCE_DIR;
const URL_ = '/face-collage.html?debug=1&seed=abc123';
const LOOP_MS = 10_000;
const TEETH_MIN = 0.18;
const CLOSED_MOUTH_MAX = 0.035;
const TEETH_MS_P95_MAX = 4; // extra CPU per detect frame for the teeth read

const snap = (page) => page.evaluate(() => window.__faceCollage?.snapshot());
const waitPhase = (page, phase, timeout = 60_000) =>
  expect.poll(async () => (await snap(page))?.phase, { timeout, intervals: [100] }).toBe(phase);
const save = (name, data) => {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(resolve(EVIDENCE, name), JSON.stringify(data, null, 2));
};
const shot = async (page, name) => {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.locator('[data-testid="fc-canvas"]').screenshot({ path: resolve(EVIDENCE, `${name}.png`) });
};
/**
 * Each clip needs its own Chrome (the fake camera file is a launch flag, and Playwright forbids
 * launchOptions inside a describe), so every group launches one browser and hands out pages.
 */
function useClip(clip) {
  let browser;
  test.beforeAll(async ({ playwright }, info) => {
    const { channel } = info.project.use;
    browser = await playwright.chromium.launch({
      channel,
      args: ['--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${clip}`],
    });
  });
  test.afterAll(async () => browser?.close());
  return async (info) => {
    const { baseURL, viewport } = info.project.use;
    const ctx = await browser.newContext({ baseURL, viewport });
    return ctx.newPage();
  };
}

async function selectRef(page) {
  await page.getByLabel('Preset').selectOption('ref');
  await page.getByTestId('fc-seed').fill('abc123');
  await page.getByTestId('fc-seed').press('Enter');
}

async function startRef(page) {
  await page.goto(URL_);
  await page.getByRole('button', { name: 'Start camera' }).click();
  await waitPhase(page, 'tracking');
  await selectRef(page);
  expect((await snap(page)).bankEnabled).toBe(true);
}

/** Polls the snapshot for `ms`; merges every capture the bank logged (deduped by slot+t). */
async function record(page, ms) {
  const samples = [];
  const captures = new Map();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await snap(page);
    samples.push({ phase: s.phase, e: s.expressions, active: Object.keys(s.bank.active), teethMs: s.teethMs });
    for (const c of s.bank.recent) captures.set(`${c.slot}@${c.t}`, c);
    await page.waitForTimeout(100);
  }
  const last = await snap(page);
  return { samples, captures: [...captures.values()].sort((a, b) => a.t - b.t), last };
}

const bySlot = (caps, slot) => caps.filter((c) => c.slot === slot);
const maxOf = (xs) => (xs.length ? Math.max(...xs) : null);
const liveTeeth = (samples) => samples.map((s) => s.e?.teeth).filter((x) => typeof x === 'number');
const waitBankFilled = (page) =>
  expect.poll(async () => (await snap(page)).bank.activeCount, { timeout: 15_000, intervals: [100] }).toBeGreaterThan(0);

// Groups run in order on one worker (one real-GPU Chrome at a time); a failure does not skip the rest.
test.describe.configure({ mode: 'default' });

test.describe('clip with real teeth', () => {
  test.skip(!existsSync(resolve(CLIPS, 'pose-teeth.y4m')), 'run make_bank_clips.py first');
  const openPage = useClip(resolve(CLIPS, 'pose-teeth.y4m'));

  test('fills each slot only with its real expression; teeth only from pixels', async ({}, info) => {
    test.setTimeout(120_000);
    const page = await openPage(info);
    await startRef(page);
    const run = await record(page, LOOP_MS + 1500);
    await shot(page, 'bank-teeth-end');
    const caps = run.captures;
    const teeth = bySlot(caps, 'mouthTeeth');
    const closedEye = bySlot(caps, 'eyeClosed');
    const closedMouth = bySlot(caps, 'mouthClosed');
    const open = bySlot(caps, 'mouthOpen');
    const th = run.last.bank.thresholds;
    const teethMs = run.samples.map((s) => s.teethMs).filter((x) => x > 0).sort((a, b) => a - b);
    const p95 = teethMs.length ? teethMs[Math.floor(teethMs.length * 0.95)] : null;
    save('bank-teeth-clip.json', {
      summary: run.last.bank,
      captures: caps,
      liveTeethMax: maxOf(liveTeeth(run.samples)),
      teethMsMax: maxOf(teethMs),
      teethMsP95: p95,
      teethMsMean: teethMs.length ? teethMs.reduce((a, b) => a + b, 0) / teethMs.length : null,
      samples: run.samples,
    });

    expect(teeth.length).toBeGreaterThan(0);
    expect(teeth.every((c) => c.teeth >= TEETH_MIN && c.mouthOpen >= 0.02)).toBe(true);
    expect(closedEye.length).toBeGreaterThan(0);
    expect(closedEye.every((c) => c.eyeOpen <= th.closed)).toBe(true);
    expect(open.length).toBeGreaterThan(0);
    expect(closedMouth.every((c) => c.mouthOpen <= CLOSED_MOUTH_MAX)).toBe(true);
    expect(p95).toBeLessThan(TEETH_MS_P95_MAX);
  });

  test('source switch camera -> photo empties the bank, the still never refills it', async ({}, info) => {
    test.setTimeout(120_000);
    const page = await openPage(info);
    await startRef(page);
    await waitBankFilled(page);
    const before = (await snap(page)).bank.activeCount;
    // The UI offers "Use a photo" on the stopped screen: camera -> stop -> photo.
    await page.getByTestId('fc-stop').click();
    await page.getByTestId('fc-photo').first().setInputFiles(FACE);
    await waitPhase(page, 'tracking');
    const photo = await snap(page);
    await page.waitForTimeout(1000);
    const photoLater = await snap(page);
    save('bank-source-switch.json', { before, afterSwitch: photo.bank, oneSecondLater: photoLater.bank });
    expect(photo.bank.activeCount).toBe(0);
    expect(photo.bank.recent).toEqual([]);
    expect(photoLater.bank.activeCount).toBe(0);
  });

  test('stop camera empties the bank', async ({}, info) => {
    test.setTimeout(120_000);
    const page = await openPage(info);
    await startRef(page);
    await waitBankFilled(page);
    const before = (await snap(page)).bank.activeCount;
    await page.getByTestId('fc-stop').click();
    const after = await page.evaluate(() => window.__faceCollage?.snapshot() ?? null);
    save('bank-stop.json', { before, after: after?.bank ?? null });
    expect(after === null || after.bank.activeCount === 0).toBe(true);
  });

  test('WebGL context loss: bank emptied, image back within 3 s, bank refills from new frames', async ({}, info) => {
    test.setTimeout(120_000);
    const page = await openPage(info);
    await startRef(page);
    await waitBankFilled(page);
    const before = await snap(page);
    await page.evaluate(() => {
      const ext = document.querySelector('[data-testid="fc-canvas"]').getContext('webgl2').getExtension('WEBGL_lose_context');
      window.__fcLoseExt = ext;
      ext.loseContext();
    });
    await expect.poll(async () => (await snap(page)).contextLost, { timeout: 2000, intervals: [50] }).toBe(true);
    const lost = await snap(page);
    const t0 = Date.now();
    await page.evaluate(() => window.__fcLoseExt.restoreContext());
    await expect.poll(async () => (await snap(page)).contextLost, { timeout: 3000, intervals: [50] }).toBe(false);
    const framesAt = (await snap(page)).frames;
    await expect.poll(async () => (await snap(page)).frames, { timeout: 3000, intervals: [50] }).toBeGreaterThan(framesAt + 3);
    const backMs = Date.now() - t0;
    const meanLuma = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="fc-canvas"]');
      const o = Object.assign(document.createElement('canvas'), { width: c.width, height: c.height });
      const g = o.getContext('2d', { willReadFrequently: true });
      g.drawImage(c, 0, 0);
      const d = g.getImageData(c.width * 0.3, c.height * 0.3, c.width * 0.4, c.height * 0.4).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return sum / (d.length / 4) / 3;
    });
    await shot(page, 'bank-context-restored');
    await waitBankFilled(page);
    const after = await snap(page);
    save('bank-context-loss.json', {
      bankBefore: before.bank.activeCount,
      whileLost: lost.bank,
      backMs,
      meanLuma,
      contextEvents: after.contextEvents,
      refilled: after.bank.activeCount,
    });
    expect(lost.bank.activeCount).toBe(0);
    expect(backMs).toBeLessThan(3000);
    expect(meanLuma).toBeGreaterThan(20);
    expect(after.contextEvents).toEqual({ lost: 1, restored: 1 });
  });

  test('same seed after reload: same layout, bank starts empty', async ({}, info) => {
    test.setTimeout(120_000);
    const page = await openPage(info);
    await startRef(page);
    await waitBankFilled(page);
    const first = await snap(page);
    await page.reload();
    await page.getByRole('button', { name: 'Start camera' }).click();
    await waitPhase(page, 'tracking');
    const presetAfterReload = await page.getByLabel('Preset').inputValue();
    const reloaded = await snap(page);
    const bankAfterReload = reloaded.bankEnabled;
    await selectRef(page);
    const fresh = await snap(page);
    save('bank-reload.json', {
      seed: [first.seed, fresh.seed],
      samePatches: JSON.stringify(first.patches) === JSON.stringify(fresh.patches),
      presetAfterReload,
      bankEnabledAfterReload: bankAfterReload,
      bankBeforeReload: first.bank.activeCount,
      bankAfterReload: reloaded.bank,
      bankAfterRefReselected: fresh.bank,
    });
    expect(fresh.seed).toBe(first.seed);
    expect(fresh.patches).toEqual(first.patches);
    expect(reloaded.bank.activeCount).toBe(0);
    expect(reloaded.bank.recent).toEqual([]);
  });
});

test.describe('clip without teeth', () => {
  test.skip(!existsSync(resolve(CLIPS, 'pose-noteeth.y4m')), 'run make_bank_clips.py first');
  const openPage = useClip(resolve(CLIPS, 'pose-noteeth.y4m'));

  test('open mouth and closed-lip smile never fill mouthTeeth', async ({}, info) => {
    test.setTimeout(120_000);
    const page = await openPage(info);
    await startRef(page);
    const run = await record(page, LOOP_MS + 1500);
    save('bank-noteeth-clip.json', { summary: run.last.bank, captures: run.captures, liveTeethMax: maxOf(liveTeeth(run.samples)), samples: run.samples });
    expect(bySlot(run.captures, 'mouthOpen').length).toBeGreaterThan(0);
    expect(bySlot(run.captures, 'mouthTeeth')).toEqual([]);
    expect(run.samples.every((s) => !s.active.includes('mouthTeeth'))).toBe(true);
  });
});

test.describe('neutral clip', () => {
  test.skip(!existsSync(resolve(CLIPS, 'pose-neutral.y4m')), 'run make_bank_clips.py first');
  const openPage = useClip(resolve(CLIPS, 'pose-neutral.y4m'));

  test('a still face never fills blink, gaze, open mouth or teeth', async ({}, info) => {
    test.setTimeout(120_000);
    const page = await openPage(info);
    await startRef(page);
    const run = await record(page, 6000);
    save('bank-neutral-clip.json', { summary: run.last.bank, captures: run.captures });
    const fakes = run.captures.filter((c) => ['eyeClosed', 'eyeGaze', 'mouthOpen', 'mouthTeeth'].includes(c.slot));
    expect(fakes).toEqual([]);
    expect(run.last.bank.missing).toEqual(expect.arrayContaining(['eyeClosed', 'eyeGaze', 'mouthOpen', 'mouthTeeth']));
  });
});

test.describe('face loss', () => {
  // Same generator as faceCollage.spec.js: the face leaves the frame for 2 s in every loop.
  if (!existsSync(LOSS_CLIP)) {
    mkdirSync(CLIPS, { recursive: true });
    execFileSync('python', [resolve(ROOT, 'scripts/fake-camera.py'), FACE, LOSS_CLIP]);
  }
  const openPage = useClip(LOSS_CLIP);

  test('losing the face empties the bank and restarts the warm-up', async ({}, info) => {
    test.setTimeout(120_000);
    const page = await openPage(info);
    await startRef(page);
    await waitPhase(page, 'lost', 40_000);
    const lost = await snap(page);
    save('bank-face-loss.json', { lost: lost.bank });
    expect(lost.bank.activeCount).toBe(0);
    expect(lost.bank.warm).toBe(false);
    expect(lost.bank.recent).toEqual([]);
  });
});
