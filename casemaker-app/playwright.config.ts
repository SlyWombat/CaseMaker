import { defineConfig, devices } from '@playwright/test';
import { devServerPort, lanServerPort } from './scripts/e2ePort';

const isCI = !!process.env.CI;
// #704 — the port belongs to THIS checkout (derived from its path), so two worktrees' runs rarely
// meet on one dev server. An explicit CASEMAKER_PORT still wins; CI keeps 5173. A hand-started
// `npm run dev` stays on Vite's 5173 (see `scripts/e2ePort.ts`). Because 100 derived ports can still
// collide, `tests/e2e/globalSetup.ts` asks a reused server which checkout it serves and refuses a
// stranger's (#728).
const PORT = devServerPort();
const BASE = `http://127.0.0.1:${PORT}`;
// #816/#821/#867 — the machine console is reachable only in a bundle that carries the bridge, so
// the specs that drive a fake controller get a second server serving the DESKTOP bundle to a plain
// browser beside the ordinary web one — the same page a local install's headless server gives a LAN
// browser. Same checkout-derived band; the checkout tag judges both servers.
const LAN_PORT = lanServerPort();
const LAN_BASE = `http://127.0.0.1:${LAN_PORT}`;

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
  globalSetup: './tests/e2e/globalSetup.ts',
  webServer: [
    {
      command: `npm run dev -- --port ${PORT} --strictPort`,
      url: BASE,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: { VITE_E2E: '1', CASEMAKER_PORT: String(PORT) },
    },
    {
      // #816/#821/#867 — THE DESKTOP BUNDLE SERVED HEADLESS, for the machine-console specs
      // (`runStates.spec.ts` and its neighbours set their baseURL to this). `--mode desktop` is
      // what makes `canReachMachine` true, which lets the page open a console at all; with no Tauri
      // runtime in a plain browser it then uses the instance's HTTP relay (`httpTransport`), which
      // the specs' fakes serve — the k3 path itself.
      command: `npm run dev:desktop -- --port ${LAN_PORT} --strictPort`,
      url: LAN_BASE,
      reuseExistingServer: !isCI,
      timeout: 120_000,
      env: { VITE_E2E: '1', CASEMAKER_PORT: String(LAN_PORT) },
    },
  ],
});
