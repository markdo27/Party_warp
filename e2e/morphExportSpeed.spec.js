import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// Keep these full-resolution export cases on one worker without skipping later cases on failure.
test.describe.configure({ mode: 'default' });

function storedPngs(zip) {
  const files = [];
  let at = 0;
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const length = zip.readUInt32LE(at + 18);
    const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
    files.push(zip.subarray(start, start + length).toString('base64'));
    at = start + length;
  }
  return files;
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function waitForInk(canvas) {
  await expect.poll(() => canvas.evaluate((source) => {
    const c = Object.assign(document.createElement('canvas'), { width: 108, height: 135 });
    const ctx = c.getContext('2d');
    ctx.drawImage(source, 0, 0, c.width, c.height);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 200 && Math.max(data[i], data[i + 1], data[i + 2]) < 90) return true;
    }
    return false;
  }), { timeout: 20_000 }).toBe(true);
}

for (const speed of [0.5, 1.4, 0]) {
  test(`Morph PNG sequence completes one cycle at speed ${speed}`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors = [];
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.getByRole('radio', { name: 'Morph grid', exact: true }).click();
    const canvas = page.getByRole('img', { name: /^Morph grid reading:/ });
    await expect(canvas).toBeAttached();
    await waitForInk(canvas);
    await page.getByRole('button', { name: 'Pause', exact: true }).first().click();
    await page.getByLabel('Letters in the loop', { exact: true }).fill('AB');
    await page.getByRole('slider', { name: 'Hold each letter', exact: true }).fill('0.3');
    await page.getByRole('slider', { name: 'Melting time', exact: true }).fill('0.2');
    await page.getByRole('slider', { name: 'Columns', exact: true }).fill('4');
    await page.getByRole('slider', { name: 'Rows', exact: true }).fill('2');
    await expect(canvas).toHaveAttribute('aria-label', 'Morph grid reading: A → B');
    await expect(page.getByText('Full loop: 1.00s.', { exact: false })).toBeVisible();
    await settle(page);
    await waitForInk(canvas);
    await page.getByRole('tab', { name: 'Motion', exact: true }).click();
    await page.getByRole('slider', { name: 'Speed', exact: true }).fill(String(speed));
    await page.evaluate(() => window.__rswSeek(0));
    await settle(page);
    await waitForInk(canvas);
    await page.getByRole('tab', { name: 'Export', exact: true }).click();
    await page.getByText('Save an animation', { exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 100_000 }),
      page.getByRole('button', { name: 'PNG sequence', exact: true }).click(),
    ]);
    const pngs = storedPngs(await readFile(await download.path()));
    // Two letters at 0.3s hold + 0.2s melt form a one-second phase cycle.
    const frames = Math.round(30 / (speed || 1));
    expect(pngs).toHaveLength(frames);
    const index = Math.floor(frames * 0.6);
    await page.evaluate((phase) => window.__rswSeek(phase), speed > 0 ? index / frames : 0);
    await settle(page);
    const [snapshot] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'PNG', exact: true }).click(),
    ]);
    const expected = (await readFile(await snapshot.path())).toString('base64');
    const diffs = await page.evaluate(async ({ pngs, expected, index }) => {
      const decode = async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const c = Object.assign(document.createElement('canvas'), { width: 108, height: 135 });
        const ctx = c.getContext('2d');
        ctx.drawImage(image, 0, 0, c.width, c.height);
        return ctx.getImageData(0, 0, c.width, c.height).data;
      };
      const pixels = [];
      for (const png of pngs) pixels.push(await decode(png));
      const target = await decode(expected);
      const diff = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
      return {
        expectedPhase: diff(pixels[index], target),
        seam: diff(pixels.at(-1), pixels[0]),
        maxAdjacent: Math.max(...pixels.slice(1).map((p, i) => diff(p, pixels[i]))),
      };
    }, { pngs, expected, index });
    expect(diffs.expectedPhase).toBe(0);
    expect(diffs.seam).toBeLessThanOrEqual(diffs.maxAdjacent + 0.5);
    expect(errors).toEqual([]);
  });
}
