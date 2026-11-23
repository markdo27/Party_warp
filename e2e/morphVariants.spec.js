import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// Morph grid variations: the selector, redraw while paused, loops, export name, mobile.
const VARIANTS = [
  ['classic', 'Classic'],
  ['horizontal', 'Horizontal wave'],
  ['diagonal', 'Diagonal wave'],
  ['swirl', 'Swirl'],
  ['checker', 'Checker'],
  ['pulse', 'Pulse'],
];
const LOOP_S = 6.6; // default Raum loop: 4 × (0.95 + 0.7)
let consoleErrors = [];

const morphCanvas = (page) => page.getByRole('img', { name: /^Morph grid reading:/ });
const group = (page) => page.getByRole('radiogroup', { name: 'Wave pattern', exact: true });
const variantButton = (page, name) => group(page).getByRole('radio', { name, exact: true });
const nextFrames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
const pause = (page) => page.getByRole('button', { name: 'Pause', exact: true }).first().click();
const pngSize = (bytes) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];

async function seek(page, seconds) {
  await page.evaluate((s) => window.__rswSeek(s), seconds);
  await nextFrames(page);
}

function morphHash(page) {
  return morphCanvas(page).evaluate((canvas) => {
    const url = canvas.toDataURL('image/png');
    return `${url.length}:${url.slice(-400)}`;
  });
}

/** The hash once two frames in a row agree, so a frame still in flight under GPU load is never compared. */
async function settledHash(page) {
  let prev = await morphHash(page);
  for (let i = 0; i < 10; i++) {
    await nextFrames(page);
    const next = await morphHash(page);
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

/** True once the canvas holds dark glyph ink (the letters are drawn). */
function hasInk(page) {
  return morphCanvas(page).evaluate((canvas) => {
    const c = Object.assign(document.createElement('canvas'), { width: canvas.width, height: canvas.height });
    const ctx = c.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < data.length; i += 16) {
      if (data[i + 3] > 200 && Math.max(data[i], data[i + 1], data[i + 2]) < 90) return true;
    }
    return false;
  });
}

async function openMorphGrid(page, tap = false) {
  const radio = page.getByRole('radio', { name: 'Morph grid', exact: true });
  await (tap ? radio.tap() : radio.click());
  await expect(morphCanvas(page)).toBeAttached();
  await expect.poll(() => hasInk(page), { timeout: 20_000 }).toBe(true);
}

/** The wave pattern picker sits in the Motion tab. */
async function openMotion(page, tap = false) {
  const tab = page.getByRole('tab', { name: 'Motion', exact: true });
  await (tap ? tab.tap() : tab.click());
}

/** Opens Motion > Timing, where Hold, Melting and the lag sliders live. */
async function openTiming(page) {
  await page.getByRole('tab', { name: 'Motion', exact: true }).click();
  const timing = page.locator('details.rsw-advanced', { has: page.getByText('Timing', { exact: true }) });
  if (!(await timing.evaluate((d) => d.open))) await timing.locator('summary').click();
}

async function setGrid(page, cols, rows) {
  await page.getByRole('slider', { name: 'Columns', exact: true }).fill(String(cols));
  await page.getByRole('slider', { name: 'Rows', exact: true }).fill(String(rows));
  await expect(morphCanvas(page)).toHaveAttribute('aria-description', `${cols} × ${rows} grid`);
  await nextFrames(page);
}

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

test('selector: six radios, one checked, lag sliders only on Classic, keyboard works', async ({ page }) => {
  await openMorphGrid(page);
  await openTiming(page);
  for (const [, name] of VARIANTS) await expect(variantButton(page, name)).toBeVisible();
  await expect(variantButton(page, 'Classic')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('slider', { name: 'Column lag', exact: true })).toBeVisible();
  await variantButton(page, 'Swirl').click();
  await expect(variantButton(page, 'Swirl')).toHaveAttribute('aria-checked', 'true');
  await expect(variantButton(page, 'Classic')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('slider', { name: 'Column lag', exact: true })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Row lag', exact: true })).toHaveCount(0);
  await expect(page.locator('#rsw-morph-variant-hint')).toContainText('clockwise');
  await variantButton(page, 'Swirl').focus();
  await page.keyboard.press('ArrowRight');
  await expect(variantButton(page, 'Checker')).toBeFocused();
  await expect(variantButton(page, 'Checker')).toHaveAttribute('aria-checked', 'true');
  await variantButton(page, 'Classic').focus();
  await page.keyboard.press('Space');
  await expect(variantButton(page, 'Classic')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('slider', { name: 'Column lag', exact: true })).toBeVisible();
});

test('paused at 6 × 6: every variation draws a different frame and stays still', async ({ page }) => {
  await openMorphGrid(page);
  await setGrid(page, 6, 6);
  await openMotion(page);
  await pause(page);
  await seek(page, 1.25);
  const hashes = new Map();
  for (const [id, name] of VARIANTS) {
    await variantButton(page, name).click();
    await nextFrames(page);
    hashes.set(id, await morphHash(page));
  }
  expect(new Set(hashes.values()).size).toBe(VARIANTS.length);
  await page.waitForTimeout(400);
  expect(await morphHash(page)).toBe(hashes.get('pulse'));
  await expect(page.getByRole('button', { name: 'Play', exact: true }).first()).toBeVisible();
});

test('every variation loops at 6 × 6: t and t + loop give the same frame', async ({ page }) => {
  await openMorphGrid(page);
  await setGrid(page, 6, 6);
  await openMotion(page);
  await pause(page);
  for (const [, name] of VARIANTS.slice(1)) {
    await variantButton(page, name).click();
    for (const t of [0.9, 3.4]) {
      await seek(page, t);
      const a = await settledHash(page);
      await seek(page, t + LOOP_S);
      expect(await settledHash(page), `${name} at ${t}s`).toBe(a);
    }
  }
});

test('switching 30 times keeps the letters, the grid and the clock running', async ({ page }) => {
  await openMorphGrid(page);
  await page.getByLabel('Letters in the loop', { exact: true }).fill('Ốườab');
  await setGrid(page, 4, 5);
  await openMotion(page);
  for (let i = 0; i < 30; i++) await variantButton(page, VARIANTS[i % VARIANTS.length][1]).click();
  await expect(page.getByRole('img', { name: 'Morph grid reading: Ố → ư → ờ → a → b', exact: true })).toBeAttached();
  await expect(morphCanvas(page)).toHaveAttribute('aria-description', '4 × 5 grid');
  await expect(page.getByRole('button', { name: 'Pause', exact: true }).first()).toBeVisible();
  const a = await morphHash(page);
  await page.waitForTimeout(400);
  expect(await morphHash(page)).not.toBe(a);
});

test('PNG export: 1080 × 1350 with the variation id in the file name', async ({ page }) => {
  await openMorphGrid(page);
  await openMotion(page);
  await variantButton(page, 'Diagonal wave').click();
  await pause(page);
  await seek(page, 1);
  await page.getByRole('tab', { name: 'Export', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'PNG', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-diagonal\.png$/);
  expect(pngSize(await readFile(await download.path()))).toEqual([1080, 1350]);
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  // Each cell shows its current whole letter, so the still arrangement follows the variation.
  test('every variation stays a still frame', async ({ page }) => {
    await openMorphGrid(page);
    await setGrid(page, 4, 4);
    await openMotion(page);
    for (const [, name] of VARIANTS) {
      await variantButton(page, name).click();
      await nextFrames(page);
      const a = await morphHash(page);
      await page.waitForTimeout(300);
      expect(await morphHash(page), name).toBe(a);
      expect(await hasInk(page), name).toBe(true);
    }
  });
});

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
  test.describe(`mobile ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });

    test('variation buttons are 44 px tall, tappable, no sideways scroll', async ({ page }) => {
      await page.getByRole('button', { name: 'Show controls', exact: true }).first().tap();
      await openMorphGrid(page, true);
      await openMotion(page, true);
      for (const [, name] of VARIANTS) {
        const b = variantButton(page, name);
        await b.scrollIntoViewIfNeeded();
        expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44);
      }
      await variantButton(page, 'Swirl').tap();
      await expect(variantButton(page, 'Swirl')).toHaveAttribute('aria-checked', 'true');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}
