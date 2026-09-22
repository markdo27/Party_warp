import { defineConfig } from '@playwright/test';

const PORT = 5178;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // Every page drives the real GPU at 60 fps; more parallel Chromes than this starve it.
  workers: 4,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Uses the locally installed Chrome; set PW_CHANNEL=chromium after `npx playwright install chromium`.
    channel: process.env.PW_CHANNEL ?? 'chrome',
    viewport: { width: 1280, height: 800 },
    launchOptions: { args: ['--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
