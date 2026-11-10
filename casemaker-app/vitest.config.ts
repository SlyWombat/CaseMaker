import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { globSync, readFileSync } from 'node:fs';

/**
 * #1180 A4 — THE TIERS. Four Vitest projects so a change can run the slice it touches; a bare
 * `vitest run` (the land gate) still runs all four, so nothing is skipped and no test is moved
 * out of the suite.
 *
 *   cards      the 12 env-gated acceptance files (the ones that silently skipped without the
 *              real-part variables); run them explicitly when the cards are armed.
 *   cnc-heavy  the CNC engine and simulation specs — planning, CAM, sweeping and the stores
 *              around them; the wall-clock of a full run is here.
 *   print      the 3D-print side (#1180 A2): compiler, library, export and the print-side
 *              geometry, and nothing from the CNC engine. These never need to run for a CNC
 *              change, and nightly/land runs still include them.
 *   unit-fast  everything else, including `@/engine/import/*` (the CNC door uses the importers,
 *              so those specs stay in the fast tier and always run).
 *
 * The classification is COMPUTED from each spec's import lines at config load: one rule, no
 * hand-maintained file list to drift. Every file lands in exactly one project (the union is
 * checked below and throws if a file would be missed or doubled).
 */
const ROOT = process.cwd();
const SPEC_GLOB = 'tests/unit/**/*.spec.{ts,tsx}';

/** The A3 card files, by name — they are only meaningful with the licensed parts armed. */
const CARD_FILES = new Set(
  [
    'opsAcceptance959',
    'featureAcceptance958',
    'figureAcceptance965',
    'pocketShadowElephant970',
    'pocketShadowInvariant970',
    'trayReachGate1037',
    'rimOpenLoop962',
    'seamProgress1038',
    'finishClOrganizer960',
    'skinWallFoot1135',
    'goalEdgeBreakTray',
    'triangleBins960',
  ].map((name) => `${name}.spec.ts`),
);

/** The CNC engine and the stores that drive it. */
const CNC_IMPORT = /from\s+['"]@\/(engine\/cnc|engine\/cam|workers\/sim|store\/(engraveJobStore|engraveRunStore|engraveReleaseStore|machineRunStore|machineConsoleStore|machineFilesStore|simStore))/;
/** The print side — A2's rule: compiler / library / export / print geometry. */
const PRINT_IMPORT = /from\s+['"]@\/(engine\/compiler|library|workers\/export|workers\/geometry)\//;

function classifySpecs(): { cards: string[]; cnc: string[]; print: string[]; fast: string[] } {
  const files = globSync(SPEC_GLOB, { cwd: ROOT });
  const cards: string[] = [];
  const cnc: string[] = [];
  const print: string[] = [];
  const fast: string[] = [];
  for (const file of files) {
    const base = file.split('/').pop() ?? file;
    // Read only the head of the file: every spec's imports are at the top, and a heavy spec's
    // body is never parsed here.
    const head = readFileSync(path.join(ROOT, file), 'utf8').slice(0, 8_000);
    if (CARD_FILES.has(base)) cards.push(file);
    else if (CNC_IMPORT.test(head)) cnc.push(file);
    else if (PRINT_IMPORT.test(head)) print.push(file);
    else fast.push(file);
  }
  const total = files.length;
  const assigned = cards.length + cnc.length + print.length + fast.length;
  if (assigned !== total) {
    throw new Error(`#1180: ${assigned} specs classified of ${total} — a spec matched two tiers`);
  }
  return { cards, cnc, print, fast };
}

const tiers = classifySpecs();

/** Shared project options: every tier runs the same way, only the file set differs. */
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
    // #1180 A4 — the four tiers. `extends: true` inherits the options above; a bare
    // `vitest run` runs every project, which is the land gate.
    projects: [
      project('unit-fast', tiers.fast),
      project('cnc-heavy', tiers.cnc),
      project('print', tiers.print),
      project('cards', tiers.cards),
    ],
  },
});
