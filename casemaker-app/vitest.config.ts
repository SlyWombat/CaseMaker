import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { globSync, readFileSync } from 'node:fs';

/**
 * #1180 S1 — THE TIERS, RE-CUT BY THE ANALYST'S MEASUREMENT (S0, 2026-11-10).
 *
 * Two projects, not four: the measured time is in the acceptance / bench / card specs, which are
 * 18 files and 2,055 s of the 3,785 s total. Everything else is `fast` — about 1,730 s of file
 * time, roughly four minutes of wall-clock at 8 workers — so every ordinary change runs it.
 * A bare `vitest run` (the land gate) runs both, so nothing is skipped and no test leaves the
 * suite.
 *
 *   acceptance  the 18 measured files: the 12 env-gated card files, benchTypicalJobs, pickTray858,
 *               pickCounters857, and the three *.acceptance walks.
 *   fast        every other spec.
 *
 * The sets are names, computed once here; the union is checked below and throws if any spec would
 * be missed. (There is deliberately no print or CNC tier: the measurement showed the whole print
 * side costs 29 s and the #1023-family clusters 19 s — a tier for those saves nothing.)
 */
const ROOT = process.cwd();
const SPEC_GLOB = 'tests/unit/**/*.spec.{ts,tsx}';

/** The 18 files S0 measured in the acceptance / bench / card group. */
const ACCEPTANCE_FILES = new Set([
  // The 12 env-gated card files.
  'opsAcceptance959.spec.ts',
  'featureAcceptance958.spec.ts',
  'figureAcceptance965.spec.ts',
  'pocketShadowElephant970.spec.ts',
  'pocketShadowInvariant970.spec.ts',
  'trayReachGate1037.spec.ts',
  'rimOpenLoop962.spec.ts',
  'seamProgress1038.spec.ts',
  'finishClOrganizer960.spec.ts',
  'skinWallFoot1135.spec.ts',
  'goalEdgeBreakTray.spec.ts',
  'triangleBins960.spec.ts',
  // The bench / acceptance walks (#1180 S0's 2,055 s group).
  'benchTypicalJobs.spec.ts',
  'pickTray858.spec.ts',
  'pickCounters857.spec.ts',
  'flipMouldShell.acceptance.spec.ts',
  'rotaryReliefAcceptance.spec.ts',
  'rotaryFluidity.acceptance.spec.ts',
  // #1175 — the house/browser parity walk generated the tray twice: 964 s on k3. It needs the
  // same licensed fixture the card files need, so it belongs to the tier the land gate and
  // nightly run, not to `fast`.
  'houseParity1175.spec.ts',
]);

function classifySpecs(): { acceptance: string[]; fast: string[] } {
  const files = globSync(SPEC_GLOB, { cwd: ROOT });
  const acceptance: string[] = [];
  const fast: string[] = [];
  for (const file of files) {
    const base = file.split('/').pop() ?? file;
    if (ACCEPTANCE_FILES.has(base)) acceptance.push(file);
    else fast.push(file);
  }
  if (acceptance.length + fast.length !== files.length) {
    throw new Error(`#1180: ${acceptance.length + fast.length} specs classified of ${files.length}`);
  }
  // A typo in the list would silently shrink the tier: every named file must exist.
  const assigned = new Set(acceptance.map((f) => f.split('/').pop()));
  for (const name of ACCEPTANCE_FILES) {
    if (!assigned.has(name)) throw new Error(`#1180: acceptance file not found: ${name}`);
  }
  return { acceptance, fast };
}

const tiers = classifySpecs();

/** Shared project options: both tiers run the same way, only the file set differs. */
const project = (name: string, include: string[]) => ({
  extends: true as const,
  test: { name, include },
});

export default defineConfig({
  // #181 — the unit tests run the web target, matching the default build. Without this the
  // `__BUILD_TARGET__` reference in src/platform/capabilities.ts would be an undeclared global.
  //
  // The other two are the same story, found the same way: `__APP_VERSION__` is read by `StatusBar`,
  // and `__DONATE_URL__`/`__DEPLOY_TARGET__` are read by the panels beside it — so any spec that
  // renders the app shell rather than one panel would meet an undefined global rather than a bug.
  // The values are deliberately inert: nothing here asserts on a version or a donate link.
  define: {
    __FEATURE_SIM__: 'true',
    __BUILD_TARGET__: JSON.stringify('web'),
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __BUILD_COMMIT__: JSON.stringify('testcommit'),
    __DEPLOY_TARGET__: JSON.stringify(''),
    __DONATE_URL__: JSON.stringify(''),
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    // These are geometry tests: most of them build real solids through the
    // Manifold WASM kernel, and a full rack is seconds of CSG. Vitest's 5 s
    // default is simply the wrong scale for that — 15 rack tests were running
    // on it and failing whenever the machine was busy, which reads as a
    // regression and is not one. The tests that already pass an explicit
    // 180000 were doing one at a time what belongs in one place.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Seeds the bundled-font cache from the TTFs on disk (issue #180) — specs typeset labels
    // synchronously and have no `fetch` seam, so the six faces must be pre-parsed.
    setupFiles: ['./tests/setup/fonts.ts'],
    globals: false,
    coverage: { reporter: ['text', 'html'] },
    // #1180 S1 — the two tiers. `extends: true` inherits the options above; a bare
    // `vitest run` runs both, which is the land gate.
    projects: [project('acceptance', tiers.acceptance), project('fast', tiers.fast)],
  },
});
