/**
 * #1141 — the PRODUCTION-bundle run (the build k3 serves): `vite build --mode desktop` (with
 * VITE_E2E=1 for the test API) + `vite preview`, no dev servers, no webServer/globalSetup.
 * The spec's own `test.use({ baseURL: lanServerPort() })` points at the preview.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  reporter: 'list',
  timeout: 420_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.005 } },
  use: {
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1024, height: 768 },
        deviceScaleFactor: 1,
        launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] },
      },
    },
  ],
});
