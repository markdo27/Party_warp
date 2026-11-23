import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// Morph grid user controls: the letters notice, and the Columns / Rows sliders.
const EVIDENCE_DIR = process.env.MORPH_EVIDENCE_DIR ?? path.resolve(process.cwd(), '..', 'party-warp-morphgrid-evidence');
const LOOP_S = 6.6; // default Raum loop: 4 × (0.95 + 0.7)
let consoleErrors = [];

const morphCanvas = (page) => page.getByRole('img', { name: /^Morph grid reading:/ });
const slider = (page, name) => page.getByRole('slider', { name, exact: true });
const nextFrames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
const pngSize = (bytes) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
const pause = (page) => page.getByRole('button', { name: 'Pause', exact: true }).first().click();

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

/**
 * Counts glyph columns and rows by projecting the ink (near black) onto the x and y axes and
 * counting the separate runs. Valid while each glyph sits whole in its cell (paused mid-hold
 * with lags at 0, or reduced motion): cells keep a clear margin around their glyph.
 */
function countGlyphGrid(page, source) {
  return page.evaluate(async (src) => {
    let image = document.querySelector('canvas[role="img"][aria-label^="Morph grid reading:"]');
    if (src.kind === 'png') {
      image = new Image();
      image.src = `data:image/png;base64,${src.data}`;
      await image.decode();
    }
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = c.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    const colInk = new Uint32Array(w);
    const rowInk = new Uint32Array(h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] > 200 && Math.max(data[i], data[i + 1], data[i + 2]) < 90) {
          colInk[x] += 1;
          rowInk[y] += 1;
        }
      }
    }
    const runs = (arr) => {
      let count = 0;
      let inRun = false;
      let gap = 0;
      for (const v of arr) {
        if (v > 0) {
          if (!inRun) count += 1;
          inRun = true;
          gap = 0;
        } else if (inRun && ++gap >= 2) inRun = false;
      }
      return count;
    };
    return { cols: runs(colInk), rows: runs(rowInk) };
  }, source);
}

async function openMorphGrid(page, tap = false) {
  const radio = page.getByRole('radio', { name: 'Morph grid', exact: true });
  await (tap ? radio.tap() : radio.click());
  await expect(morphCanvas(page)).toBeAttached();
  await expect
    .poll(() => countGlyphGrid(page, { kind: 'live' }).then((g) => g.cols > 0), { timeout: 20_000 })
    .toBe(true);
}

async function setGrid(page, cols, rows) {
  await slider(page, 'Columns').fill(String(cols));
  await slider(page, 'Rows').fill(String(rows));
  await expect(morphCanvas(page)).toHaveAttribute('aria-description', `${cols} × ${rows} grid`);
  await nextFrames(page);
}

/** Opens Motion > Timing, where Hold, Melting and the lag sliders live. */
async function openTiming(page) {
  await page.getByRole('tab', { name: 'Motion', exact: true }).click();
  const timing = page.locator('details.rsw-advanced', { has: page.getByText('Timing', { exact: true }) });
  if (!(await timing.evaluate((d) => d.open))) await timing.locator('summary').click();
}

/** Lags live in Motion > Timing; the grid sliders are back in Content. */
async function zeroLags(page) {
  await openTiming(page);
  await slider(page, 'Column lag').fill('0');
  await slider(page, 'Row lag').fill('0');
  await page.getByRole('tab', { name: 'Content', exact: true }).click();
}

async function downloadPng(page) {
  await page.getByRole('tab', { name: 'Export', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'PNG', exact: true }).click(),
  ]);
  return readFile(await download.path());
}

async function saveEvidence(name, bytes) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(path.join(EVIDENCE_DIR, name), bytes);
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

test('letters field warns below 2 and above 6 letters', async ({ page }) => {
  await openMorphGrid(page);
  const field = page.getByLabel('Letters in the loop', { exact: true });
  const notice = page.locator('#rsw-morph-glyphs-notice');
  await expect(notice).toHaveAttribute('aria-live', 'polite');
  await field.fill('R');
  await expect(notice).toHaveText('Type at least 2 letters. Showing the sample loop.');
  await expect(page.getByRole('img', { name: 'Morph grid reading: R → a → u → m', exact: true })).toBeAttached();
  await field.fill('ABCDEFGH');
  await expect(notice).toHaveText('Only the first 6 letters are used.');
  await expect(page.getByRole('img', { name: 'Morph grid reading: A → B → C → D → E → F', exact: true })).toBeAttached();
  await field.fill('Ốườ');
  await expect(page.getByRole('img', { name: 'Morph grid reading: Ố → ư → ờ', exact: true })).toBeAttached();
  await expect(notice).toHaveText('');
});

test('Columns and Rows sliders stay within 1 to 6 from the keyboard', async ({ page }) => {
  await openMorphGrid(page);
  for (const name of ['Columns', 'Rows']) {
    const s = slider(page, name);
    await expect(s).toHaveValue('3');
    await s.focus();
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
    await expect(s).toHaveValue('6');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft');
    await expect(s).toHaveValue('1');
  }
});

test('a paused grid redraws at its new size and stays still', async ({ page }) => {
  await openMorphGrid(page);
  await zeroLags(page);
  await pause(page);
  await seek(page, 0); // every cell mid-hold: whole glyphs
  expect(await countGlyphGrid(page, { kind: 'live' })).toEqual({ cols: 3, rows: 3 });
  const before = await morphHash(page);
  await setGrid(page, 5, 2);
  const after = await morphHash(page);
  expect(after).not.toBe(before);
  expect(await countGlyphGrid(page, { kind: 'live' })).toEqual({ cols: 5, rows: 2 });
  await page.waitForTimeout(500);
  expect(await morphHash(page)).toBe(after);
  await expect(page.getByRole('button', { name: 'Play', exact: true }).first()).toBeVisible();
});

test('PNG export follows the chosen 4 × 2 grid', async ({ page }) => {
  await openMorphGrid(page);
  await zeroLags(page);
  await setGrid(page, 4, 2);
  await pause(page);
  await seek(page, 0);
  const png = await downloadPng(page);
  expect(pngSize(png)).toEqual([1080, 1350]);
  await saveEvidence('web_export_4x2.png', png);
  expect(await countGlyphGrid(page, { kind: 'png', data: png.toString('base64') })).toEqual({ cols: 4, rows: 2 });
});

test('the 6 × 6 grid loops seamlessly: t and t + loop give the same frame', async ({ page }) => {
  await openMorphGrid(page);
  await setGrid(page, 6, 6);
  await pause(page);
  for (const t of [1.25, 3.75]) {
    await seek(page, t);
    const a = await morphHash(page);
    await seek(page, t + LOOP_S);
    expect(await morphHash(page)).toBe(a);
  }
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('draws 3 × 3, 5 × 2, 1 × 1 and 6 × 6 with the right number of cells', async ({ page }) => {
    await openMorphGrid(page);
    expect(await countGlyphGrid(page, { kind: 'live' })).toEqual({ cols: 3, rows: 3 });
    for (const [cols, rows] of [[5, 2], [1, 1], [6, 6]]) {
      await setGrid(page, cols, rows);
      expect(await countGlyphGrid(page, { kind: 'live' })).toEqual({ cols, rows });
    }
    const lost = await morphCanvas(page).evaluate((c) => c.getContext('webgl2')?.isContextLost() ?? true);
    expect(lost).toBe(false);
  });
});

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
  test.describe(`mobile ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });

    test('panel, letters and grid sliders work by touch without sideways scroll', async ({ page }) => {
      await page.getByRole('button', { name: 'Show controls', exact: true }).first().tap();
      await openMorphGrid(page, true);
      const field = page.getByLabel('Letters in the loop', { exact: true });
      await field.tap();
      await field.fill('Ốườ');
      await expect(page.getByRole('img', { name: 'Morph grid reading: Ố → ư → ờ', exact: true })).toBeAttached();
      for (const name of ['Columns', 'Rows']) {
        const s = slider(page, name);
        await s.scrollIntoViewIfNeeded();
        const box = await s.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
        await s.tap({ position: { x: box.width - 3, y: box.height / 2 } });
        await expect(s).toHaveValue('6');
      }
      await expect(morphCanvas(page)).toHaveAttribute('aria-description', '6 × 6 grid');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await saveEvidence(`web_mobile_${viewport.width}x${viewport.height}_6x6.png`, await page.screenshot());
    });
  });
}
