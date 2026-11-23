import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const READING = 'Morph grid reading: R → a → u → m';
/** The five comparison times of the spec (seconds into the loop). */
const SPEC_TIMES = [0.5, 1.25, 2.33, 3.75, 5.5];
// Evidence for QA lands next to the repo (outside the source tree), or wherever MORPH_EVIDENCE_DIR says.
const EVIDENCE_DIR = process.env.MORPH_EVIDENCE_DIR ?? path.resolve(process.cwd(), '..', 'party-warp-morphgrid-evidence');
let consoleErrors = [];

const morphCanvas = (page) => page.getByRole('img', { name: READING, exact: true });

/** Share of ink (near black), paper (near white) and ring colour (saturated) pixels on the morph canvas. */
function morphShares(page) {
  return morphCanvas(page).evaluate((canvas) => {
    const c = Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height });
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const counts = { ink: 0, paper: 0, colour: 0 };
    let total = 0;
    for (let i = 0; i < data.length; i += 16) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a < 10) continue; // not drawn yet
      const hi = Math.max(r, g, b);
      const lo = Math.min(r, g, b);
      total += 1;
      if (hi < 70) counts.ink += 1;
      else if (lo > 230) counts.paper += 1;
      else if (hi - lo > 60) counts.colour += 1;
    }
    return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, total ? v / total : 0]));
  });
}

/** A cheap fingerprint of the morph canvas, to tell whether two frames differ. */
function morphHash(page) {
  return morphCanvas(page).evaluate((canvas) => {
    const url = canvas.toDataURL('image/png');
    return `${url.length}:${url.slice(-400)}`;
  });
}

const nextFrames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));

async function seek(page, seconds) {
  await page.evaluate((s) => window.__rswSeek(s), seconds);
  await nextFrames(page);
}

async function openMorphGrid(page) {
  await page.getByRole('radio', { name: 'Morph grid', exact: true }).click();
  await expect(morphCanvas(page)).toBeAttached();
  // Wait until the letters are uploaded and drawn: paper and ink both on the canvas.
  await expect
    .poll(async () => {
      const s = await morphShares(page);
      return s.paper > 0.3 && s.ink > 0.01;
    }, { timeout: 20_000 })
    .toBe(true);
}

async function downloadPng(page) {
  await page.getByRole('tab', { name: 'Export', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'PNG', exact: true }).click(),
  ]);
  return [download.suggestedFilename(), await readFile(await download.path())];
}

const pngSize = (bytes) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
const pause = (page) => page.getByRole('button', { name: 'Pause', exact: true }).first().click();

test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && !/net::ERR_/.test(m.text()) && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('img', { name: /^Animated sticker reading:/ })).toBeAttached();
});

test.afterEach(() => {
  expect(consoleErrors).toEqual([]);
});

test('morph grid shows the R → a → u → m loop with ink, paper and colour rings', async ({ page }) => {
  await openMorphGrid(page);
  await expect(page.getByLabel('Letters in the loop', { exact: true })).toHaveValue('Raum');
  await pause(page);
  await seek(page, 1.25); // mid-melt for the first cells: rings at full size
  const s = await morphShares(page);
  expect(s.paper).toBeGreaterThan(0.3);
  expect(s.ink).toBeGreaterThan(0.02);
  expect(s.colour).toBeGreaterThan(0.01);
});

test('morph grid letters can be changed and the reading follows', async ({ page }) => {
  await openMorphGrid(page);
  await page.getByLabel('Letters in the loop', { exact: true }).fill('ABC');
  await expect(page.getByRole('img', { name: 'Morph grid reading: A → B → C', exact: true })).toBeAttached();
  await expect(page.getByText(/Full loop: 4\.95s/)).toBeVisible();
});

test('morph grid moves while playing and freezes on Pause', async ({ page }) => {
  await openMorphGrid(page);
  const a = await morphHash(page);
  await page.waitForTimeout(700);
  expect(await morphHash(page)).not.toBe(a);
  await pause(page);
  await nextFrames(page);
  const b = await morphHash(page);
  await page.waitForTimeout(700);
  expect(await morphHash(page)).toBe(b);
});

test('PNG export is 4:5 at 1080 × 1350; SVG says it is not available yet', async ({ page }) => {
  await openMorphGrid(page);
  await pause(page);
  const [name, png] = await downloadPng(page);
  expect(name).toMatch(/\.png$/);
  expect(pngSize(png)).toEqual([1080, 1350]);
  await page.getByRole('button', { name: 'SVG', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('SVG export is not available for Morph grid yet');
});

test('saves the five spec timestamps as evidence frames', async ({ page }) => {
  await openMorphGrid(page);
  await pause(page);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const shares = {};
  for (const t of SPEC_TIMES) {
    await seek(page, t);
    shares[t.toFixed(2)] = await morphShares(page);
    const [, png] = await downloadPng(page);
    expect(pngSize(png)).toEqual([1080, 1350]);
    await writeFile(path.join(EVIDENCE_DIR, `web_t${t.toFixed(2)}s.png`), png);
  }
  await writeFile(path.join(EVIDENCE_DIR, 'web_shares.json'), `${JSON.stringify(shares, null, 2)}\n`);
  Object.values(shares).forEach((s) => expect(s.ink).toBeGreaterThan(0.02));
  expect(Math.max(...Object.values(shares).map((s) => s.colour))).toBeGreaterThan(0.01);
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('starts paused and shows still letters without rings', async ({ page }) => {
    await openMorphGrid(page);
    await expect(page.getByRole('button', { name: 'Play', exact: true }).first()).toBeVisible();
    await seek(page, 1.25);
    const s = await morphShares(page);
    expect(s.ink).toBeGreaterThan(0.02);
    expect(s.colour).toBeLessThan(0.002);
    const a = await morphHash(page);
    await page.waitForTimeout(500);
    expect(await morphHash(page)).toBe(a);
  });
});
