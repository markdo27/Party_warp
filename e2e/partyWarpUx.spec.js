import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// One colour system for every layout, and the clearer panel (spec: party-warp-ux-spec.md).
const EVIDENCE_DIR = process.env.UX_EVIDENCE_DIR ?? path.resolve(process.cwd(), '..', 'party-warp-ux-impl-evidence');
const REFERENCE_BG = '#fefefe';
const COSMIC = { bg: '#05010d', sil: '#6b2bff' };
let consoleErrors = [];

const morphCanvas = (page) => page.getByRole('img', { name: /^Morph grid reading:/ });
const tab = (page, name) => page.getByRole('tab', { name, exact: true });
const chip = (page, name) => page.getByRole('button', { name, exact: true });
const nextFrames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
const pause = (page) => page.getByRole('button', { name: 'Pause', exact: true }).first().click();
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function seek(page, seconds) {
  await page.evaluate((s) => window.__rswSeek(s), seconds);
  await nextFrames(page);
}

/**
 * Reads the Morph grid (live canvas or an exported PNG): the corner colour and the share of
 * pixels within a small distance of `target`.
 */
function sampleMorph(page, source, target) {
  return page.evaluate(async ({ src, hex }) => {
    let image = document.querySelector('canvas[role="img"][aria-label^="Morph grid reading:"]');
    if (src.kind === 'png') {
      image = new Image();
      image.src = `data:image/png;base64,${src.data}`;
      await image.decode();
    }
    const c = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height });
    const ctx = c.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const t = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    let hits = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 16) {
      total += 1;
      if (Math.hypot(data[i] - t[0], data[i + 1] - t[1], data[i + 2] - t[2]) < 40) hits += 1;
    }
    const corner = Array.from(data.slice(0, 3)).map((v) => v.toString(16).padStart(2, '0')).join('');
    return { corner: `#${corner}`, share: hits / total };
  }, { src: source, hex: target });
}

async function openMorphGrid(page, tap = false) {
  const radio = page.getByRole('radio', { name: 'Morph grid', exact: true });
  await (tap ? radio.tap() : radio.click());
  await expect(morphCanvas(page)).toBeAttached();
  await expect.poll(() => sampleMorph(page, { kind: 'live' }, '#000000').then((s) => s.share < 0.99), { timeout: 20_000 }).toBe(true);
}

async function downloadPng(page) {
  await tab(page, 'Export').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'PNG', exact: true }).click(),
  ]);
  return readFile(await download.path());
}

async function evidence(page, name) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(path.join(EVIDENCE_DIR, name), await page.screenshot());
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

test('C1-C3: header says Party Warp; Layout and Energy read in plain words', async ({ page }) => {
  await expect(page.getByText('Party Warp', { exact: true })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Layout', exact: true })).toBeVisible();
  await tab(page, 'Motion').click();
  const energy = page.getByRole('radiogroup', { name: 'Energy', exact: true });
  await expect(energy.getByRole('radio')).toHaveText(['Gentle', 'Liquid', 'Wild']);
  await energy.getByRole('radio', { name: 'Gentle', exact: true }).click();
  await expect(energy.getByRole('radio', { name: 'Gentle', exact: true })).toHaveAttribute('aria-checked', 'true');
  await energy.getByRole('radio', { name: 'Gentle', exact: true }).press('ArrowRight');
  await expect(energy.getByRole('radio', { name: 'Liquid', exact: true })).toBeFocused();
  await expect(energy.getByRole('radio', { name: 'Liquid', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Custom', { exact: true })).toHaveCount(0);
});

test('first Morph visit with default colours shows Reference; the Layout list folds to one row', async ({ page }) => {
  await openMorphGrid(page);
  const change = page.getByRole('button', { name: 'Change layout (now Morph grid)', exact: true });
  await tab(page, 'Style').click();
  await expect(chip(page, 'Reference')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'Disco')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('slider', { name: 'Ring size', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Goo', exact: true })).toHaveCount(0);
  expect((await sampleMorph(page, { kind: 'live' }, REFERENCE_BG)).corner).toBe(REFERENCE_BG);
  await tab(page, 'Content').click();
  await expect(change).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Layout', exact: true })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Ring size', exact: true })).toHaveCount(0);
  await change.click();
  await expect(page.getByRole('radiogroup', { name: 'Layout', exact: true })).toBeVisible();
});

test('A1/A2: a palette recolours the Morph preview and its PNG; Reference brings the original back', async ({ page }) => {
  test.setTimeout(90_000);
  await openMorphGrid(page);
  await pause(page);
  await seek(page, 1.25); // mid-melt: rings at full size
  await tab(page, 'Style').click();
  await chip(page, 'Cosmic').click();
  await expect(chip(page, 'Cosmic')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'Reference')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => sampleMorph(page, { kind: 'live' }, COSMIC.sil).then((s) => s.corner)).toBe(COSMIC.bg);
  expect((await sampleMorph(page, { kind: 'live' }, COSMIC.sil)).share).toBeGreaterThan(0.005);
  const png = await downloadPng(page);
  const fromPng = await sampleMorph(page, { kind: 'png', data: png.toString('base64') }, COSMIC.sil);
  expect(fromPng.corner).toBe(COSMIC.bg);
  expect(fromPng.share).toBeGreaterThan(0.005);
  await tab(page, 'Style').click();
  await chip(page, 'Reference').click();
  await expect.poll(() => sampleMorph(page, { kind: 'live' }, REFERENCE_BG).then((s) => s.corner)).toBe(REFERENCE_BG);
});

test('D1/D2: letters, grid, wave pattern, palette and the paused clock survive a layout round trip', async ({ page }) => {
  await openMorphGrid(page);
  await page.getByLabel('Letters in the loop', { exact: true }).fill('ABC');
  await page.getByRole('slider', { name: 'Columns', exact: true }).fill('4');
  await page.getByRole('slider', { name: 'Rows', exact: true }).fill('2');
  await tab(page, 'Style').click();
  await chip(page, 'Sunset').click();
  await tab(page, 'Motion').click();
  await page.getByRole('radio', { name: 'Swirl', exact: true }).click();
  await pause(page);
  await page.getByRole('button', { name: /^Design: Morph grid, switch to / }).click();
  await expect(morphCanvas(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Play', exact: true }).first()).toBeVisible();
  await tab(page, 'Content').click();
  await page.getByRole('radio', { name: 'Morph grid', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Morph grid reading: A → B → C', exact: true })).toBeAttached();
  await expect(morphCanvas(page)).toHaveAttribute('aria-description', '4 × 2 grid');
  await expect(page.getByRole('button', { name: 'Play', exact: true }).first()).toBeVisible();
  await tab(page, 'Style').click();
  await expect(chip(page, 'Sunset')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'Reference')).toHaveAttribute('aria-pressed', 'false');
  await tab(page, 'Motion').click();
  await expect(page.getByRole('radio', { name: 'Swirl', exact: true })).toHaveAttribute('aria-checked', 'true');
});

test('Reset settings on Morph grid returns to the Reference look', async ({ page }) => {
  await openMorphGrid(page);
  await tab(page, 'Style').click();
  await chip(page, 'Cosmic').click();
  await expect(chip(page, 'Reference')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Reset settings', exact: true }).click();
  await expect(chip(page, 'Reference')).toHaveAttribute('aria-pressed', 'true');
});

test('C4: the loop line follows Speed and says when Speed 0 pauses it', async ({ page }) => {
  await openMorphGrid(page);
  await tab(page, 'Motion').click();
  const line = page.getByTestId('morph-loop-line');
  await expect(line).toHaveText('Full loop: 6.60s at 1×.');
  await page.getByRole('slider', { name: 'Speed', exact: true }).fill('2');
  await expect(line).toHaveText('Full loop: 3.30s (Speed 2×).');
  await page.getByRole('slider', { name: 'Speed', exact: true }).fill('0');
  await expect(line).toHaveText('Paused by Speed 0.');
});

test('desktop evidence: Sticker and Morph grid at 1440 × 900', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const t of ['Content', 'Style', 'Motion']) {
    await tab(page, t).click();
    await evidence(page, `desktop_1440_sticker_${t.toLowerCase()}.png`);
  }
  await tab(page, 'Content').click();
  await openMorphGrid(page);
  for (const t of ['Content', 'Style', 'Motion']) {
    await tab(page, t).click();
    await evidence(page, `desktop_1440_morph_${t.toLowerCase()}.png`);
  }
  await tab(page, 'Style').click();
  await chip(page, 'Cosmic').click();
  await nextFrames(page);
  await evidence(page, 'desktop_1440_morph_style_cosmic.png');
});

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
  test.describe(`mobile ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });

    test('More actions holds the extra tools; Wave pattern shows without scrolling; no sideways scroll', async ({ page }) => {
      const tag = `${viewport.width}x${viewport.height}`;
      const more = page.getByRole('button', { name: 'More actions', exact: true });
      await expect(more).toBeVisible();
      await expect(page.getByRole('button', { name: 'Boil mode', exact: true })).toBeHidden();
      await more.tap();
      const menu = page.getByRole('group', { name: 'More actions', exact: true });
      await expect(menu.getByRole('button')).toHaveCount(4);
      for (const b of await menu.getByRole('button').all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await evidence(page, `mobile_${tag}_sticker_more.png`);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);

      await page.getByRole('button', { name: 'Show controls', exact: true }).first().tap();
      for (const t of ['Content', 'Style', 'Motion']) {
        await tab(page, t).tap();
        await evidence(page, `mobile_${tag}_sticker_${t.toLowerCase()}.png`);
      }
      await tab(page, 'Content').tap();
      await openMorphGrid(page, true);
      await expect(more).toHaveCount(0);
      for (const t of ['Content', 'Style']) {
        await tab(page, t).tap();
        await evidence(page, `mobile_${tag}_morph_${t.toLowerCase()}.png`);
      }
      await tab(page, 'Motion').tap();
      await expect(page.getByRole('radiogroup', { name: 'Wave pattern', exact: true })).toBeInViewport();
      await evidence(page, `mobile_${tag}_morph_motion.png`);
      expect(await overflowX(page)).toBeLessThanOrEqual(0);
    });

    // F1: same element set and box measurement as qa-unified-ux/qa-mobile.mjs (the box itself, not a hit-area pseudo).
    test('F1: every toolbar and panel target is at least 44 × 44 px (Sticker and Morph grid, all tabs)', async ({ page }) => {
      const tooSmall = (scope) => page.locator(scope).first().evaluate((root) => [...root.querySelectorAll('button,[role=radio],[role=tab],summary,input:not([type=range]):not([type=color]):not(.sr-only)')]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })
        .map((e) => { const r = e.getBoundingClientRect(); return { n: (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) }; })
        .filter((x) => x.w < 44 || x.h < 44));
      const found = {};
      const sweep = async (layout) => {
        await page.getByRole('button', { name: 'Hide controls', exact: true }).tap();
        found[`${layout} toolbar`] = await tooSmall('[role=toolbar]');
        await page.getByRole('button', { name: 'Show controls', exact: true }).first().tap();
        for (const t of ['Content', 'Style', 'Motion', 'Export']) {
          await tab(page, t).tap();
          found[`${layout} ${t}`] = await tooSmall('aside');
          expect(await overflowX(page)).toBeLessThanOrEqual(0);
        }
      };
      await page.getByRole('button', { name: 'Show controls', exact: true }).first().tap();
      await sweep('Sticker');
      await tab(page, 'Content').tap();
      await openMorphGrid(page, true);
      await sweep('Morph');
      expect(Object.fromEntries(Object.entries(found).filter(([, v]) => v.length))).toEqual({});
      await tab(page, 'Motion').tap();
      await expect(page.getByRole('radiogroup', { name: 'Wave pattern', exact: true })).toBeInViewport();
    });
  });
}
