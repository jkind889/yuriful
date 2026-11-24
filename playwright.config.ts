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
    // The browser tests written before paper (Slice 5) create text boxes with the Text tool and check
    // the sizes and places of bare ones: in every test's browser a new text box is bare, as it was when
    // they were written (BARE_NEW_TEXT_KEY in src/editor/Editor.ts, read by development builds only).
    // e2e/paper.spec.ts starts from an empty storage state to test paper itself.
    storageState: { cookies: [], origins: [{ origin: baseURL, localStorage: [{ name: 'yuriful:test:bare-new-text', value: '1' }] }] },
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
