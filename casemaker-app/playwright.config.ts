import { defineConfig, devices } from '@playwright/test';
import { devServerPort } from './scripts/e2ePort';

const isCI = !!process.env.CI;
// #704 — the port belongs to THIS checkout (derived from its path), so two worktrees' runs cannot
// attach to each other's dev server. An explicit CASEMAKER_PORT still wins; CI keeps 5173. The same
// derivation is in vite.config.ts, so a hand-started server agrees. See `scripts/e2ePort.ts`.
const PORT = devServerPort();
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,
  reporter: isCI ? [['html', { open: 'never' }], ['github']] : 'list',
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.005 },
  },
  use: {
    baseURL: BASE,
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // The phone and tablet specs get their own projects (#134) so their
      // viewports live here rather than in a per-file `test.use`.
      testIgnore: /mobile\/|tablet\//,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1024, height: 768 },
        deviceScaleFactor: 1,
        launchOptions: {
          args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
    {
      // Issue #134 — the mobile profile, matching the `mobile/` spec directory.
      // iPhone-13-class: 390×844 at dpr 2 with touch, so phone-width
      // regressions surface in CI instead of on a real handset.
      name: 'mobile-chromium',
      testMatch: /mobile\/.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        launchOptions: {
          args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
    {
      // Issue #134 — the tablet band, 641–900px, where the full toolbar does
      // not fit but the window is too wide to be a phone. 768×1024 is the iPad
      // portrait case; the spec sweeps 641 and 900 on top of it.
      name: 'tablet-chromium',
      testMatch: /tablet\/.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 768, height: 1024 },
        deviceScaleFactor: 1,
        hasTouch: true,
        launchOptions: {
          args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    env: { VITE_E2E: '1', CASEMAKER_PORT: String(PORT) },
  },
});
