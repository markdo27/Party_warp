import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const STICKER = 'Animated sticker reading:';
let consoleErrors = [];

/** Decodes a PNG in the page and returns the share of each sticker colour. */
function colourShares(page, png) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    const counts = { red: 0, pink: 0, white: 0, lime: 0, clear: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a < 10) counts.clear += 1;
      else if (r > 220 && g < 40 && b < 40) counts.red += 1;
      else if (r > 235 && g > 180 && g < 220 && b > 225) counts.pink += 1;
      else if (r > 220 && g > 220 && b > 220) counts.white += 1;
      else if (r > 170 && r < 230 && g > 220 && b < 60) counts.lime += 1;
    }
    const total = data.length / 4;
    return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / total]));
  }, png.toString('base64'));
}

/** Screenshot of the stage with UI chrome (logo, toolbar, panel, toasts) blacked out. */
const stageShot = (page) =>
  page.screenshot({
    mask: [
      page.locator('header'),
      page.getByRole('toolbar').locator('xpath=..'),
      page.getByRole('complementary'),
      page.getByRole('status'),
    ],
    maskColor: '#000000',
  });

/**
 * Pixels that change visibly (> 24/255 in any channel) between two screenshots. Redrawn
 * WebGL frames can jitter by a few levels in the compositor, so exact byte equality is
 * only meaningful when nothing is redrawing at all.
 */
function visibleChange(page, a, b) {
  return page.evaluate(
    async ([a64, b64]) => {
      const load = async (s) => {
        const img = new Image();
        img.src = `data:image/png;base64,${s}`;
        await img.decode();
        const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height).data;
      };
      const [A, B] = await Promise.all([load(a64), load(b64)]);
      let changed = 0;
      for (let i = 0; i < A.length; i += 4) {
        if (Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) > 24) changed += 1;
      }
      return changed;
    },
    [a.toString('base64'), b.toString('base64')],
  );
}

/** Screenshots the stage twice, `ms` apart, and counts visibly changed pixels. */
async function changeOver(page, ms = 700) {
  const a = await stageShot(page);
  await page.waitForTimeout(ms);
  return visibleChange(page, a, await stageShot(page));
}

async function drawCallsPerSecond(page, ms = 1000) {
  const before = await page.evaluate(() => window.__draws);
  await page.waitForTimeout(ms);
  const after = await page.evaluate(() => window.__draws);
  return ((after - before) * 1000) / ms;
}

async function setRange(page, label, value) {
  await page.getByLabel(label, { exact: true }).evaluate((input, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

const pause = (page) => page.getByRole('button', { name: 'Pause', exact: true }).first().click();

/** Freezes the warp and grain so any change between frames can only come from stretch or scroll. */
async function freezeWarp(page) {
  await setRange(page, 'Wobble', 0);
  await setRange(page, 'Breathing', 0);
  await setRange(page, 'Grain', 0);
}

/** A real font file: the Archivo Black woff2 that Google Fonts serves to this page. */
async function fetchFontFile(page) {
  const b64 = await page.evaluate(async () => {
    const css = await (await fetch('https://fonts.googleapis.com/css2?family=Archivo+Black')).text();
    const url = css.match(/url\((https:[^)]+\.woff2)\)/)[1];
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
  });
  return { name: 'MyDisplay.woff2', mimeType: 'font/woff2', buffer: Buffer.from(b64, 'base64') };
}

test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  // Transient network resets (e.g. Google Fonts under parallel load) aren't app errors; HTTP errors still are.
  page.on('console', (m) => m.type() === 'error' && !/net::ERR_/.test(m.text()) && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  // Count WebGL draw calls so frame pacing can be asserted.
  await page.addInitScript(() => {
    const proto = WebGL2RenderingContext.prototype;
    const drawArrays = proto.drawArrays;
    window.__draws = 0;
    proto.drawArrays = function countedDrawArrays(...args) {
      window.__draws += 1;
      return drawArrays.apply(this, args);
    };
  });
  await page.goto('/');
  await expect(page.getByRole('img', { name: `${STICKER} UNIDENTIFIED DANCING OBJECTS` })).toBeAttached();
  // Frame comparisons need the real face, not a fallback that gets swapped mid-test.
  await page.waitForFunction(() => document.fonts.check('64px "Archivo Black"'), null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__draws > 20);
  await page.waitForTimeout(250);
});

test.afterEach(() => {
  expect(consoleErrors).toEqual([]);
});

test('renders glyphs, silhouette and outer stroke', async ({ page }) => {
  // Grain nudges pixel colours; switch it off so the shares measure the shapes, not noise.
  await setRange(page, 'Grain', 0);
  await page.waitForTimeout(150);
  const shares = await colourShares(page, await stageShot(page));
  expect(shares.red).toBeGreaterThan(0.05);
  expect(shares.pink).toBeGreaterThan(0.012); // a thin outline: about 2% of the stage by default
  expect(shares.white).toBeGreaterThan(0.05);
});

test('animates every frame and freezes when paused', async ({ page }) => {
  expect(await drawCallsPerSecond(page)).toBeGreaterThan(50);
  await pause(page);
  await expect(page.getByText('sticker · paused')).toBeVisible();
  await page.waitForTimeout(200);
  expect(await drawCallsPerSecond(page, 600)).toBeLessThan(5);
  const a = await page.locator('canvas').screenshot();
  await page.waitForTimeout(300);
  expect(a.equals(await page.locator('canvas').screenshot())).toBe(true);
});

test('boil mode steps the animation at the chosen frame rate', async ({ page }) => {
  const smooth = await drawCallsPerSecond(page);
  await page.getByRole('button', { name: /Boil mode/ }).click();
  await expect(page.getByText('boil · 10 fps')).toBeVisible();
  await page.waitForTimeout(200);
  const boil = await drawCallsPerSecond(page, 2000);
  // Two passes (warp + composite) per stepped frame, so ~20 draw calls per second.
  expect(boil).toBeGreaterThan(14);
  expect(boil).toBeLessThan(28);
  expect(boil).toBeLessThan(smooth / 2.5);
});

test('typing on the sticker edits the lockup and shows a caret', async ({ page }) => {
  await page.getByLabel('Type on the sticker').click({ position: { x: 400, y: 400 } });
  await expect(page.locator('.rsw-caret')).toBeAttached();
  await expect(page.getByText('Typing — Enter adds a line')).toBeVisible();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('hello\nworld');
  await expect(page.getByRole('img', { name: `${STICKER} HELLO WORLD` })).toBeAttached();
  await expect(page.getByLabel('Sticker text')).toHaveValue('hello\nworld');
  await page.keyboard.press('Escape');
  await expect(page.locator('.rsw-caret')).toHaveCount(0);
});

test('caps stickers at six lines', async ({ page }) => {
  const editor = page.getByLabel('Sticker text');
  await editor.fill('1\n2\n3\n4\n5\n6');
  await editor.press('Control+End');
  await editor.press('Enter');
  await expect(page.getByText(/top out at 6 lines/)).toBeVisible();
  await expect(editor).toHaveValue('1\n2\n3\n4\n5\n6');
});

test('refuses over-limit edits without losing text or moving the caret', async ({ page }) => {
  const editor = page.getByLabel('Sticker text');
  await editor.fill('AB\nCD\nEF');
  await editor.evaluate((el) => el.setSelectionRange(1, 1));
  await page.keyboard.insertText('\n1\n2\n3\n4');
  await expect(editor).toHaveValue('AB\nCD\nEF');
  await expect(page.getByText(/top out at 6 lines/)).toBeVisible();
  expect(await editor.evaluate((el) => el.selectionStart)).toBe(1);

  // At the character limit, typing mid-text must not eat the end of the text.
  const full = 'X'.repeat(120);
  await editor.fill(full);
  await editor.evaluate((el) => el.setSelectionRange(10, 10));
  await page.keyboard.type('Y');
  await expect(editor).toHaveValue(full);
});

test('highlights a selection made on the sticker', async ({ page }) => {
  await page.getByLabel('Type on the sticker').click({ position: { x: 400, y: 400 } });
  await page.keyboard.press('Control+A');
  await expect(page.locator('.rsw-caret')).toHaveCount(0);
  const boxes = page.locator('[class*="bg-[#ffc8f8]/35"]');
  await expect(boxes).toHaveCount(3);
});

test('arrow keys move through radio groups', async ({ page }) => {
  const zigzag = page.getByRole('radio', { name: 'Zigzag' });
  await zigzag.focus();
  await page.keyboard.press('ArrowRight');
  const left = page.getByRole('radio', { name: 'Align left' });
  await expect(left).toBeChecked();
  await expect(left).toBeFocused();
  await expect(zigzag).toHaveAttribute('tabindex', '-1');
});

test('closing the panel hands focus back to the toolbar', async ({ page }) => {
  await page.getByRole('complementary', { name: 'Sticker controls' }).getByRole('button', { name: 'Hide controls' }).click();
  await expect(page.getByRole('complementary', { name: 'Sticker controls' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show controls' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: 'Sticker controls' }).getByRole('button', { name: 'Hide controls' })).toBeFocused();
});

test('clearing the text shows the empty state', async ({ page }) => {
  await page.getByRole('button', { name: 'Clear text' }).click();
  await expect(page.getByRole('img', { name: `${STICKER} empty` })).toBeAttached();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Nothing here yet')).toBeVisible();
  const shares = await colourShares(page, await stageShot(page));
  expect(shares.red).toBeLessThan(0.001);
});

test('silhouette slider grows the red body', async ({ page }) => {
  await pause(page);
  const before = await colourShares(page, await stageShot(page));
  await setRange(page, 'Background padding', 0.4);
  await page.waitForTimeout(150);
  const after = await colourShares(page, await stageShot(page));
  expect(after.red).toBeGreaterThan(before.red * 1.2);
});

test('downloads opaque and transparent PNG snapshots', async ({ page }) => {
  await page.getByRole('tab', { name: 'Export', exact: true }).click();
  for (const transparent of [false, true]) {
    if (transparent) await page.getByRole('switch', { name: 'Transparent background' }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download PNG' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('sticker-unidentified-dancing-objects.png');
    const png = await readFile(await download.path());
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBeGreaterThan(1000); // IHDR width
    const shares = await colourShares(page, png);
    expect(shares.red).toBeGreaterThan(0.1);
    if (transparent) expect(shares.clear).toBeGreaterThan(0.1);
    else expect(shares.clear).toBe(0);
  }
  await expect(page.getByText('PNG downloaded')).toBeVisible();
});

test('copies a PNG to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy PNG' }).first().click();
  await expect(page.getByText('PNG copied to clipboard')).toBeVisible();
  const types = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((item) => item.types));
  expect(types).toContain('image/png');
});

test('turns the sticker body and outline off and on', async ({ page }) => {
  const toggle = page.getByRole('button', { name: 'Sticker body' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('tab', { name: 'Style', exact: true }).click();
  await page.getByText('Outline settings', { exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Sticker body & outline' })).toHaveAttribute('aria-checked', 'false');
  await page.waitForTimeout(150);
  const off = await colourShares(page, await stageShot(page));
  expect(off.red).toBeLessThan(0.002);
  expect(off.pink).toBeLessThan(0.002);
  expect(off.white).toBeGreaterThan(0.05);
  await toggle.click();
  await page.waitForTimeout(150);
  expect((await colourShares(page, await stageShot(page))).red).toBeGreaterThan(0.05);
});

test('letters stretch over time only when Stretch is on', async ({ page }) => {
  await freezeWarp(page);
  await setRange(page, 'Letter tilt', 0);
  await setRange(page, 'Stretch', 0);
  await page.waitForTimeout(200);
  expect(await changeOver(page)).toBeLessThan(20);
  await setRange(page, 'Stretch', 1);
  await page.waitForTimeout(200);
  expect(await changeOver(page)).toBeGreaterThan(500);
});

test('ships Archivo Black only and accepts uploaded fonts', async ({ page }) => {
  await page.getByRole('button', { name: 'Advanced type', exact: true }).click();
  const typefaces = page.getByRole('radiogroup', { name: 'Typeface' }).getByRole('radio');
  await expect(typefaces).toHaveCount(1);
  await expect(typefaces.first()).toHaveAccessibleName(/Archivo Black/);

  const input = page.getByLabel('Upload a font file');
  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByText(/Use a \.ttf, \.otf, \.woff or \.woff2/)).toBeVisible();
  await expect(typefaces).toHaveCount(1);

  await input.setInputFiles(await fetchFontFile(page));
  const uploaded = page.getByRole('radio', { name: /MyDisplay/ });
  await expect(uploaded).toBeChecked();
  await expect(page.getByText('Using “MyDisplay”')).toBeVisible();

  await page.getByRole('button', { name: 'Remove MyDisplay' }).click();
  await expect(typefaces).toHaveCount(1);
  await expect(typefaces.first()).toBeChecked();
});

test('marquee variation tiles scrolling bands with a tagline', async ({ page }) => {
  await page.getByRole('radio', { name: 'Marquee' }).click();
  await expect(page.getByRole('img', { name: /Scrolling marquee reading: UNIDENTIFIED DANCING OBJECTS — 29 — 31 august 2026/ })).toBeAttached();
  await expect(page.getByRole('radio', { name: 'Marquee' })).toBeChecked();

  const tagline = page.getByLabel('Tagline', { exact: true });
  await tagline.fill('open air\n2026');
  await expect(page.getByRole('img', { name: /— open air 2026$/ })).toBeAttached();
  await page.waitForTimeout(400);
  const shares = await colourShares(page, await stageShot(page));
  expect(shares.lime).toBeGreaterThan(0.1);
  expect(shares.red).toBeGreaterThan(0.1);

  // With warp, stretch and italic frozen, frames still differ because the bands scroll.
  await freezeWarp(page);
  await setRange(page, 'Stretch', 0);
  await setRange(page, 'Letter tilt', 0);
  await page.waitForTimeout(200);
  expect(await changeOver(page, 500)).toBeGreaterThan(500);
  await setRange(page, 'Scroll', 0);
  await page.waitForTimeout(200);
  expect(await changeOver(page, 500)).toBeLessThan(20);
});

test('marquee exports the whole poster at 2×', async ({ page }) => {
  await page.getByRole('radio', { name: 'Marquee' }).click();
  await page.waitForTimeout(600);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download PNG' }).click(),
  ]);
  const png = await readFile(await download.path());
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([2560, 1600]);
  const shares = await colourShares(page, png);
  expect(shares.clear).toBe(0);
  expect(shares.lime).toBeGreaterThan(0.1);
});

/** Downloads whatever `click` triggers and returns [suggested filename, bytes]. */
async function downloadFrom(page, click) {
  await page.getByRole('tab', { name: 'Export', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), click()]);
  return [download.suggestedFilename(), await readFile(await download.path())];
}

/** Parses an SVG string in the page: its viewBox and the path count per group id. */
const svgSummary = (page, svg) =>
  page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    const groups = Object.fromEntries(
      [...root.querySelectorAll('g')].map((g) => [g.id, g.querySelectorAll('path, rect').length]),
    );
    return { tag: root.tagName, error: doc.querySelector('parsererror') !== null, viewBox: root.getAttribute('viewBox'), groups };
  }, svg);

test('letters lean into random italics when Italic is on', async ({ page }) => {
  await freezeWarp(page);
  await setRange(page, 'Stretch', 0);
  await setRange(page, 'Letter tilt', 0);
  await page.waitForTimeout(200);
  expect(await changeOver(page)).toBeLessThan(20);
  await setRange(page, 'Letter tilt', 1);
  await page.waitForTimeout(200);
  expect(await changeOver(page)).toBeGreaterThan(500);
});

test('exports an editable layered SVG of the sticker', async ({ page }) => {
  const [name, bytes] = await downloadFrom(page, () => page.getByRole('button', { name: 'SVG', exact: true }).click());
  expect(name).toBe('sticker-unidentified-dancing-objects.svg');
  const summary = await svgSummary(page, bytes.toString('utf8'));
  expect(summary.error).toBe(false);
  expect(summary.tag).toBe('svg');
  expect(summary.viewBox).toMatch(/^0 0 \d+ \d+$/);
  ['stroke', 'silhouette', 'letters'].forEach((id) => expect(summary.groups[id]).toBeGreaterThan(0));
  await expect(page.getByText('SVG downloaded')).toBeVisible();
});

test('exports a single marquee line as tileable PNG and SVG', async ({ page }) => {
  await page.getByRole('radio', { name: 'Marquee' }).click();
  await page.getByRole('tab', { name: 'Export', exact: true }).click();
  await page.getByRole('radio', { name: 'Single line' }).click();
  await page.getByRole('radio', { name: 'Colourway 2' }).click();
  await setRange(page, 'Repeats', 3);
  await page.waitForTimeout(500);
  const [pngName, png] = await downloadFrom(page, () => page.getByRole('button', { name: 'PNG', exact: true }).click());
  expect(pngName).toBe('sticker-unidentified-dancing-objects-marquee-line.png');
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  expect(w / h).toBeGreaterThan(6);
  const [, svg] = await downloadFrom(page, () => page.getByRole('button', { name: 'SVG', exact: true }).click());
  const summary = await svgSummary(page, svg.toString('utf8'));
  expect(summary.groups.band).toBe(1);
  expect(summary.groups.letters).toBeGreaterThan(0);
  expect(summary.groups.tagline).toBeGreaterThan(0);
});

test('exports a PNG sequence as a zip of frames', async ({ page }) => {
  await page.getByRole('tab', { name: 'Export', exact: true }).click();
  await page.getByText('Save an animation', { exact: true }).click();
  await page.getByRole('radio', { name: '2s' }).click();
  await page.getByRole('radio', { name: '30', exact: true }).click();
  const [name, zip] = await downloadFrom(page, () => page.getByRole('button', { name: 'PNG sequence' }).click());
  expect(name).toBe('sticker-unidentified-dancing-objects-frames.zip');
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(60); // entries in the central directory
  expect(zip.subarray(30, 44).toString()).toBe('frame_0001.png');
});

test('records a video of the animation', async ({ page }) => {
  await page.getByRole('tab', { name: 'Export', exact: true }).click();
  await page.getByText('Save an animation', { exact: true }).click();
  await page.getByRole('radio', { name: '2s' }).click();
  const [name, video] = await downloadFrom(page, () => page.getByRole('button', { name: 'Video', exact: true }).click());
  expect(name).toMatch(/^sticker-unidentified-dancing-objects\.(mp4|webm)$/);
  expect(video.length).toBeGreaterThan(20_000);
  await expect(page.getByText(/Video downloaded/)).toBeVisible();
});

// Minimum stage share of the wallpaper signature colour.
for (const [design, label, colour, share] of [
  ['Wallpaper', 'Wallpaper design', 'red', 0.03],
]) {
  test(`renders the ${design} variation`, async ({ page }) => {
    await page.getByRole('radio', { name: design }).click();
    await expect(page.getByRole('img', { name: new RegExp(`^${label} reading:`) })).toBeAttached();
    await page.waitForTimeout(600);
    const shares = await colourShares(page, await stageShot(page));
    expect(shares[colour]).toBeGreaterThan(share);
    const [, svg] = await downloadFrom(page, () => page.getByRole('button', { name: 'SVG', exact: true }).click());
    const summary = await svgSummary(page, svg.toString('utf8'));
    expect(summary.error).toBe(false);
    expect(Object.values(summary.groups).reduce((a, b) => a + b, 0)).toBeGreaterThan(3);
  });
}

test('shows the controls as a bottom sheet on phones', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.getByRole('complementary', { name: 'Sticker controls' });
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Show controls' }).click();
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box.y).toBeGreaterThan(300);
  expect(box.width).toBeGreaterThan(360);
});

/** Share of pixels whose every channel sits within 8 of 0 or 255: a two-level palette. */
function twoLevelShare(page, png) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    let flat = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ([data[i], data[i + 1], data[i + 2]].every((v) => v <= 8 || v >= 247)) flat += 1;
    }
    return flat / (data.length / 4);
  }, png.toString('base64'));
}

test('film grain speckles the stage, re-rolls over time and holds when paused', async ({ page }) => {
  await freezeWarp(page);
  await setRange(page, 'Letter tilt', 0);
  await setRange(page, 'Stretch', 0);
  await page.waitForTimeout(200);
  expect(await changeOver(page)).toBeLessThan(20);
  await setRange(page, 'Grain', 1);
  await page.waitForTimeout(200);
  expect(await changeOver(page)).toBeGreaterThan(500);
  await pause(page);
  await page.waitForTimeout(200);
  expect(await changeOver(page)).toBeLessThan(20);
});

test('halftone prints the colours as a dot screen while SVG stays clean', async ({ page }) => {
  await freezeWarp(page);
  await pause(page);
  await page.waitForTimeout(150);
  const flat = await colourShares(page, await stageShot(page));
  await setRange(page, 'Halftone', 1);
  await page.waitForTimeout(150);
  const dots = await colourShares(page, await stageShot(page));
  expect(dots.red).toBeLessThan(flat.red * 0.8); // deep tone shows between the dots
  expect(dots.red).toBeGreaterThan(flat.red * 0.2);
  const [, svg] = await downloadFrom(page, () => page.getByRole('button', { name: 'SVG', exact: true }).click());
  const summary = await svgSummary(page, svg.toString('utf8'));
  expect(summary.error).toBe(false);
  expect(summary.groups.silhouette).toBeGreaterThan(0);
});

test('dither posterises the stage and the PNG export', async ({ page }) => {
  await freezeWarp(page);
  await pause(page);
  await setRange(page, 'Dither', 1);
  await setRange(page, 'Dither levels', 2);
  await page.waitForTimeout(150);
  expect(await twoLevelShare(page, await stageShot(page))).toBeGreaterThan(0.98);
  const [, png] = await downloadFrom(page, () => page.getByRole('button', { name: 'Download PNG' }).click());
  expect(await twoLevelShare(page, png)).toBeGreaterThan(0.98);
});

/** Connected white shapes (4-neighbour, over 30 px) in a screenshot: letters or melted words. */
function whiteShapes(page, png) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const { width: w, height: h } = img;
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    const ink = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) ink[i] = data[4 * i] > 200 && data[4 * i + 1] > 200 && data[4 * i + 2] > 200 ? 1 : 0;
    let shapes = 0;
    const stack = [];
    for (let start = 0; start < w * h; start++) {
      if (!ink[start]) continue;
      let area = 0;
      ink[start] = 0;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop();
        area += 1;
        const x = i % w;
        for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
          if (j >= 0 && j < w * h && ink[j]) {
            ink[j] = 0;
            stack.push(j);
          }
        }
      }
      if (area > 30) shapes += 1;
    }
    return shapes;
  }, png.toString('base64'));
}

test('goo melts the letters of each word together but keeps words apart', async ({ page }) => {
  await freezeWarp(page);
  await setRange(page, 'Stretch', 0);
  await setRange(page, 'Letter tilt', 0);
  await page.getByRole('tab', { name: 'Style', exact: true }).click();
  await page.getByText('Outline settings', { exact: true }).click();
  await page.getByRole('switch', { name: 'Sticker body & outline' }).click();
  await pause(page);
  const shapesAt = async (goo) => {
    await setRange(page, 'Goo', goo);
    await page.waitForTimeout(400);
    return whiteShapes(page, await stageShot(page));
  };
  const clean = await shapesAt(0);
  const gooey = await shapesAt(0.35);
  expect(clean).toBeGreaterThanOrEqual(24); // 27 letters, a couple touching at most
  expect(gooey).toBeLessThan(clean / 2);
  expect(gooey).toBeGreaterThanOrEqual(3); // three words never merge into one
});


test('beginner panel keeps essentials visible and supports keyboard navigation', async ({ page }) => {
  await expect(page.getByRole('radiogroup', { name: 'Design', exact: true }).getByRole('radio')).toHaveText(['Sticker', 'Marquee', 'Wallpaper', 'Oval']);
  await expect(page.getByRole('button', { name: 'Advanced type', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.getByLabel('Sticker text', { exact: true }).fill('KEEP IT GOOEY');
  await page.getByRole('tab', { name: 'Content', exact: true }).press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Style', exact: true })).toBeFocused();
  await expect(page.getByRole('slider', { name: 'Goo', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Grain', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Style', exact: true }).press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Motion', exact: true })).toBeFocused();
  await expect(page.getByRole('slider', { name: 'Wave detail', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Wild', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Speed', exact: true })).toHaveValue('1.4');
  await expect(page.getByRole('slider', { name: 'Wobble', exact: true })).toHaveValue('0.85');
  await page.getByRole('slider', { name: 'Speed', exact: true }).press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Wild', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('tab', { name: 'Motion', exact: true }).press('End');
  await expect(page.getByRole('tab', { name: 'Export', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'PNG', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Video', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Export', exact: true }).press('Home');
  await expect(page.getByLabel('Sticker text', { exact: true })).toHaveValue('KEEP IT GOOEY');
});

test('text shortcut returns to the message after changing marquee style', async ({ page }) => {
  await page.getByRole('radio', { name: 'Marquee', exact: true }).click();
  await page.getByRole('tab', { name: 'Style', exact: true }).click();
  await page.getByRole('button', { name: 'Type on sticker', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Content', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Sticker text', { exact: true })).toBeFocused();
});


const SVG_LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><defs><linearGradient id="ink"><stop stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><path fill="url(#ink)" fill-rule="evenodd" d="M10 10H110V70H10Z M40 25V55H80V25Z"/></svg>';
async function uploadSvg(page, source = SVG_LOGO, name = 'brand-mark.svg') {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('label').filter({ has: page.getByLabel('Upload SVG logo', { exact: true }) }).click(),
  ]);
  await chooser.setFiles({ name, mimeType: 'image/svg+xml', buffer: Buffer.from(source) });
}

test('SVG logo renders and exports while preserving the original text', async ({ page }) => {
  await page.getByLabel('Sticker text', { exact: true }).fill('MY ORIGINAL TEXT');
  await uploadSvg(page);
  await expect(page.getByRole('img', { name: /reading: brand-mark.svg$/ })).toBeAttached();
  await expect(page.getByLabel('Type on the sticker', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Logo size', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Motion', exact: true }).click();
  await page.getByText('Advanced motion', { exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Stretch', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Change logo', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Content', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Upload SVG logo', { exact: true })).toBeFocused();
  await page.waitForTimeout(300);
  const [pngName, png] = await downloadFrom(page, () => page.getByRole('button', { name: 'PNG', exact: true }).click());
  expect(pngName).toBe('sticker-brand-mark.png');
  expect((await colourShares(page, png)).white).toBeGreaterThan(0.05);
  const [svgName, svg] = await downloadFrom(page, () => page.getByRole('button', { name: 'SVG', exact: true }).click());
  expect(svgName).toBe('sticker-brand-mark.svg');
  const summary = await svgSummary(page, svg.toString('utf8'));
  expect(summary.error).toBe(false);
  expect(summary.groups.letters).toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'Content', exact: true }).click();
  await page.getByRole('button', { name: 'Use text instead', exact: true }).click();
  await expect(page.getByLabel('Sticker text', { exact: true })).toHaveValue('MY ORIGINAL TEXT');
  await expect(page.getByRole('img', { name: /reading: MY ORIGINAL TEXT$/ })).toBeAttached();
});

test('SVG replacements work in marquee and wallpaper layouts', async ({ page }) => {
  await uploadSvg(page);
  await expect(page.getByRole('img', { name: /reading: brand-mark.svg$/ })).toBeAttached();
  await page.getByRole('radio', { name: 'Marquee', exact: true }).click();
  await expect(page.getByRole('img', { name: /Scrolling marquee reading: brand-mark.svg/ })).toBeAttached();
  await page.waitForTimeout(300);
  expect((await colourShares(page, await stageShot(page))).lime).toBeGreaterThan(0.1);
  await page.getByRole('radio', { name: 'Wallpaper', exact: true }).click();
  await uploadSvg(page, SVG_LOGO.replace('M10 10H110V70H10Z M40 25V55H80V25Z', 'M60 0L120 80H0Z'), 'triangle.svg');
  await expect(page.getByRole('img', { name: /Wallpaper design reading: triangle.svg$/ })).toBeAttached();
  await page.waitForTimeout(300);
  expect((await colourShares(page, await stageShot(page))).red).toBeGreaterThan(0.03);
});

test('invalid SVG uploads keep the current logo and allow retrying', async ({ page }) => {
  await uploadSvg(page);
  await expect(page.getByRole('img', { name: /reading: brand-mark.svg$/ })).toBeAttached();
  const invalid = [
    ['not SVG', /not a valid SVG/],
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>', /no visible shapes/],
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text x="0" y="9">A</text></svg>', /text to outlines/],
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://example.com/logo.png"/></svg>', /static vector SVG/],
    ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="url(https://example.com/paint.svg)"/></svg>', /self-contained SVG/],
  ];
  for (const [source, message] of invalid) {
    await uploadSvg(page, source, 'invalid.svg');
    await expect(page.getByRole('alert')).toHaveText(message);
    await expect(page.getByRole('img', { name: /reading: brand-mark.svg$/ })).toBeAttached();
  }
  await uploadSvg(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Use text instead', exact: true })).toBeVisible();
});


test('oval layout frames editable text and exports transparent PNG and SVG', async ({ page }) => {
  await page.getByRole('radio', { name: 'Oval', exact: true }).click();
  await page.getByLabel('Sticker text', { exact: true }).fill('BLK');
  await pause(page);
  await expect(page.getByRole('img', { name: 'Oval design reading: BLK', exact: true })).toBeAttached();
  await page.getByRole('tab', { name: 'Export', exact: true }).click();
  await page.getByRole('switch', { name: 'Transparent background', exact: true }).click();
  const [name, png] = await downloadFrom(page, () => page.getByRole('button', { name: 'PNG', exact: true }).click());
  expect(name).toBe('sticker-blk-oval.png');
  expect(png.readUInt32BE(16) / png.readUInt32BE(20)).toBeGreaterThan(1.7);
  const shares = await colourShares(page, png);
  expect(shares.clear).toBeGreaterThan(0.1);
  expect(shares.white).toBeGreaterThan(0.05);
  expect(shares.red).toBeGreaterThan(0.05);
  expect(shares.pink).toBeGreaterThan(0.01);
  const [svgName, svg] = await downloadFrom(page, () => page.getByRole('button', { name: 'SVG', exact: true }).click());
  expect(svgName).toBe('sticker-blk-oval.svg');
  const summary = await svgSummary(page, svg.toString('utf8'));
  expect(summary.error).toBe(false);
  for (const group of ['letters', 'silhouette', 'stroke']) expect(summary.groups[group]).toBeGreaterThan(0);
  await page.getByLabel('Type on the sticker', { exact: true }).click({ position: { x: 400, y: 350 } });
  await page.keyboard.press('Control+A');
  await page.keyboard.type('LIVE');
  await expect(page.getByRole('img', { name: 'Oval design reading: LIVE', exact: true })).toBeAttached();
});

test('oval keeps its ring when empty and responds to frame controls', async ({ page }) => {
  await page.getByRole('radio', { name: 'Oval', exact: true }).click();
  await page.getByLabel('Sticker text', { exact: true }).fill('');
  await page.getByLabel('Sticker text', { exact: true }).press('Escape');
  await pause(page);
  await expect(page.getByText('Type inside your oval', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Style', exact: true }).click();
  await setRange(page, 'Ring thickness', 0.05);
  await page.waitForTimeout(200);
  const before = await colourShares(page, await stageShot(page));
  expect(before.pink).toBeGreaterThan(0.005);
  await setRange(page, 'Ring thickness', 0.3);
  await page.waitForTimeout(200);
  const after = await colourShares(page, await stageShot(page));
  expect(after.white).toBeGreaterThan(before.white * 1.4);
  await page.getByRole('radio', { name: 'Wide', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Wide', exact: true })).toBeChecked();
  await page.getByLabel('Type on the sticker', { exact: true }).click({ position: { x: 400, y: 350 } });
  await page.keyboard.type('HELLO');
  await expect(page.getByRole('img', { name: 'Oval design reading: HELLO', exact: true })).toBeAttached();
});

test('oval uses editable text and preserves a logo for other layouts', async ({ page }) => {
  await page.getByLabel('Sticker text', { exact: true }).fill('MY NAME');
  await uploadSvg(page);
  await expect(page.getByRole('img', { name: /reading: brand-mark.svg$/ })).toBeAttached();
  await page.getByRole('radio', { name: 'Oval', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Oval design reading: MY NAME', exact: true })).toBeAttached();
  await expect(page.getByLabel('Sticker text', { exact: true })).toHaveValue('MY NAME');
  await expect(page.getByLabel('Upload SVG logo', { exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Sticker', exact: true }).click();
  await expect(page.getByRole('img', { name: /reading: brand-mark.svg$/ })).toBeAttached();
});

test('the tagline takes its own typeface, including uploads', async ({ page }) => {
  await page.getByRole('radio', { name: 'Marquee' }).click();
  const tagFaces = page.getByRole('radiogroup', { name: 'Tagline typeface' }).getByRole('radio');
  await expect(tagFaces).toHaveCount(1);
  await expect(tagFaces.first()).toHaveAccessibleName(/Archivo/);
  await expect(tagFaces.first()).toBeChecked();
  await pause(page);
  await page.getByRole('button', { name: 'Advanced type', exact: true }).click();
  await page.waitForTimeout(300);
  const before = await stageShot(page);

  await page.getByLabel('Upload a tagline font file').setInputFiles(await fetchFontFile(page));
  await expect(page.getByText('Tagline uses “MyDisplay”')).toBeVisible();
  await expect(tagFaces).toHaveCount(2);
  await expect(page.getByRole('radiogroup', { name: 'Tagline typeface' }).getByRole('radio', { name: /MyDisplay/ })).toBeChecked();
  // The sticker keeps its own face, and the upload is offered there too.
  const faces = page.getByRole('radiogroup', { name: 'Typeface', exact: true }).getByRole('radio');
  await expect(faces).toHaveCount(2);
  await expect(faces.first()).toBeChecked();
  await page.waitForTimeout(400);
  expect(await visibleChange(page, before, await stageShot(page))).toBeGreaterThan(300);

  // Removing the upload hands the tagline back to Archivo.
  await page.getByRole('button', { name: 'Remove MyDisplay' }).click();
  await expect(tagFaces).toHaveCount(1);
  await expect(tagFaces.first()).toBeChecked();
});

/** Horizontal extent (px) of white ink in a screenshot. */
function whiteSpan(page, png) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    let [x0, x1] = [img.width, -1];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) {
        const x = (i / 4) % img.width;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
      }
    }
    return x1 - x0;
  }, png.toString('base64'));
}

test('melts from one message into the next', async ({ page }) => {
  await freezeWarp(page);
  await page.getByRole('switch', { name: 'Melt between messages' }).click();
  await page.getByLabel('Sticker text').fill('BLK');
  await page.getByPlaceholder('Type the next message…').fill('BLK46');
  await setRange(page, 'Hold each message', 1.5);
  await setRange(page, 'Melting time', 1);
  await expect(page.getByRole('img', { name: /BLK → BLK46/ })).toBeAttached();
  await page.getByRole('button', { name: 'Play from start' }).click();
  const start = Date.now();
  await page.waitForTimeout(700);
  const first = await whiteSpan(page, await stageShot(page));
  await page.waitForTimeout(Math.max(0, 3200 - (Date.now() - start)));
  const second = await whiteSpan(page, await stageShot(page));
  expect(first).toBeGreaterThan(50);
  expect(second).toBeGreaterThan(first * 1.3); // BLK46 is wider than BLK
});
