import { defineConfig, devices } from '@playwright/test'

/**
 * Real-browser regression tests (see e2e/). Each test gets a fresh browser context,
 * so IndexedDB/localStorage are isolated per test and nothing depends on your profile.
 *
 * Browser selection (portable by default):
 *   - default: Playwright's bundled Chromium  ->  `npm run test:e2e:install` once
 *   - PW_CHANNEL=msedge | chrome               ->  use a browser already installed on this machine
 *   - E2E_PORT=NNNN                            ->  dev-server port (default 5199)
 */
const port = Number(process.env.E2E_PORT ?? 5199)
const baseURL = `http://127.0.0.1:${port}`
const channel = process.env.PW_CHANNEL || undefined

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // Traces/screenshots of failures only; this directory is git-ignored.
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel, viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
