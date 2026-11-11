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

// #1180 A1 — THE E2E TIERS. Selection is by FILE, not by title tag, so no test's name changes and
// nothing is skipped: `--project smoke` / `--project nightly` select; a bare `playwright test`
// (the land gate) still runs every spec once across the projects.
//
// @smoke — the 12 files the review named: a boot, the front door, the wizard, a first job, the CNC
// mode, the run states, a simulation, the sim worker, an export, the board picker, the templates
// and the phone workspace.
const SMOKE_DESKTOP = [
  'boot.spec.ts',
  'welcomeFrontDoor878.spec.ts',
  'startWizard.spec.ts',
  'firstJob.acceptance.spec.ts',
  'cncMode.spec.ts',
  'runStates.spec.ts',
  'simulation.spec.ts',
  'sim-worker.spec.ts',
  'export.spec.ts',
  'board-picker.spec.ts',
  'templates-smoke.spec.ts',
];
const SMOKE_MOBILE = 'mobile/mobileWorkspace.spec.ts';
// @nightly — the two walks the review measured at ~17–20 minutes on every run.
const NIGHTLY = ['saveAllPrograms.spec.ts', 'flipMouldShell.spec.ts'];
/** A project's testMatch/testIgnore entries are globs relative to `testDir`. */
const asGlobs = (files: string[]): string[] => files.map((file) => `**/${file}`);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // #1180 — FOUR WORKERS LOCALLY, ONE ON CI. The suite ran serially since 2026-04-27
  // (9a33d96bc) to dodge dev-server restarts caused by the app's server-port setting; #372 removed
  // that setting from the browser build (settings.spec.ts asserts its absence), and every test
  // gets its own browser context, so nothing mutable is shared between workers. Measured on
  // land18 2026-11-10: full suite 30.1 min serial → 10.3 min quiet / 14.3 min under a loaded box,
  // identical results, zero flaky; smoke tier 1.1 min. A spec that flakes only under load is
  // marked serial (its own file/describe or project) — the suite is never dropped back to one
  // worker. CI keeps 1 until CI has run at all.
  workers: isCI ? 1 : 4,
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
      // viewports live here rather than in a per-file `test.use`. The smoke and
      // nightly files have projects of their own (#1180 A1), so they are ignored
      // here — every spec runs exactly once across the projects.
      testIgnore: [/mobile\/|tablet\//, ...asGlobs([...SMOKE_DESKTOP, ...NIGHTLY])],
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
      // #1180 A1 — the phone smoke file runs in `smoke-mobile`, not here.
      testIgnore: '**/mobile/mobileWorkspace.spec.ts',
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
    {
      // #1180 A1 — THE SMOKE TIER: twelve files, the fastest honest walk of the app (see
      // SMOKE_DESKTOP above). `npm run test:e2e:smoke` selects this and `smoke-mobile`.
      name: 'smoke',
      testMatch: asGlobs(SMOKE_DESKTOP),
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
      // #1180 A1 — the phone member of the smoke tier, at the same phone profile as
      // `mobile-chromium` so the workspace check is the real one.
      name: 'smoke-mobile',
      testMatch: asGlobs([SMOKE_MOBILE]),
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
      // #1180 A1 — THE NIGHTLY TIER: the two long walks (saveAllPrograms ~17 min by its own
      // comment; flipMouldShell's 20-min timeout). `npm run test:e2e:nightly` selects this; the
      // land gate (`playwright test`, no --project) still runs them.
      name: 'nightly',
      testMatch: asGlobs(NIGHTLY),
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
