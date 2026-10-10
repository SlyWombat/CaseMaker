// #193 / #343 — prove the electricrv.ca bundle keeps the simulation out of the ENTRY chunk, and
// carries it as a lazy chunk for the `?BETA=yes` switch to load.
//
// Until #343 `__FEATURE_SIM__` was read directly and the bundler deleted every CNC branch out of
// the public build, so this script asserted that no emitted file carried the worker at all. The
// switch is now `featureSim` (src/platform/features.ts), a runtime value that the page address can
// turn on, so the sim client and worker have to exist in the public build — but ONLY behind the
// lazy `import()` in the stores. This builds with DEPLOY_TARGET=electricrv into a temp outDir and
// asserts:
//
//   - the entry chunk (the module script index.html loads) contains neither the string `simLoad`
//     nor a `sim.worker` file name — a visit without the switch downloads no simulation code;
//   - some emitted `.js` DOES contain `simLoad`, and some emitted file IS named `sim.worker…` —
//     the switch has something to load.
//
// It exits non-zero and prints the offender otherwise. Not wired into `npm test`: a production
// build is slow.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const outDir = mkdtempSync(join(tmpdir(), 'casemaker-sim-gate-'));
// vite.config.ts reads this at load time; set it before the config is evaluated.
process.env.DEPLOY_TARGET = 'electricrv';

const problems = [];
try {
  await build({
    root: APP_ROOT,
    configFile: join(APP_ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
  });
  const files = walk(outDir).map((file) => ({
    file,
    name: relative(outDir, file).split('\\').join('/'),
  }));
  const html = readFileSync(join(outDir, 'index.html'), 'utf8');
  const entryMatch = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
  if (!entryMatch) {
    problems.push('index.html has no <script type="module" src=…> — cannot find the entry chunk');
  } else {
    const entryName = entryMatch[1].replace(/^.*?\/assets\//, 'assets/');
    const entry = files.find((f) => f.name === entryName);
    if (!entry) {
      problems.push(`entry chunk ${entryName} (from index.html) is not among the emitted files`);
    } else {
      const text = readFileSync(entry.file, 'utf8');
      if (text.includes('simLoad')) problems.push(`${entry.name}  (entry chunk contains the string "simLoad")`);
      if (text.includes('sim.worker')) problems.push(`${entry.name}  (entry chunk names a "sim.worker" file)`);
    }
  }
  const hasWorker = files.some((f) => f.name.includes('sim.worker'));
  const hasClient = files.some((f) => f.name.endsWith('.js') && readFileSync(f.file, 'utf8').includes('simLoad'));
  if (!hasWorker) problems.push('no emitted file is named "sim.worker…" — the ?BETA=yes switch would have no worker to load');
  if (!hasClient) problems.push('no emitted .js contains "simLoad" — the ?BETA=yes switch would have no sim client to load');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error('\ncheck:sim-gate FAILED — the electricrv.ca build is wrong about the simulation:');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nThe sim client and worker must reach the bundle only through the lazy import()');
  console.error('behind `featureSim` (#193, #343): out of the entry chunk, present as a lazy chunk.');
  process.exit(1);
}

console.log('check:sim-gate ok — the electricrv.ca entry chunk carries no simulation code, and the lazy sim chunk is there for ?BETA=yes');
