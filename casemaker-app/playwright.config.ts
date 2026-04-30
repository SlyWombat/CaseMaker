import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
// Port 8000 is kernel-reserved on some WSL2 / Hyper-V hosts (and 8001/8002
// often follow). 5173 is Vite's standard dev port and is free on every
// host I've tested. CASEMAKER_PORT overrides for hosts where 5173 conflicts.
const PORT = Number(process.env.CASEMAKER_PORT ?? 5173);
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
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1024, height: 768 },
        deviceScaleFactor: 1,
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
