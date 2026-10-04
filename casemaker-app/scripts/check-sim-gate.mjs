// #193 — prove the electricrv.ca bundle carries no simulation code.
//
// `__FEATURE_SIM__` is false only when DEPLOY_TARGET === 'electricrv' (vite.config.ts), and
// nothing had verified the worker actually stays out of that build. This builds with that
// target into a temp outDir and asserts:
//
//   - no emitted file NAME contains `sim.worker`
//   - no emitted `.js` contains the string `simLoad`
//
// It exits non-zero and prints the offending file otherwise. The check is trivially true until
// a component imports the store — #196 must RE-RUN it. Not wired into `npm test`: a production
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

let offenders;
try {
  await build({
    root: APP_ROOT,
    configFile: join(APP_ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
  });
  offenders = [];
  for (const file of walk(outDir)) {
    const name = relative(outDir, file).split('\\').join('/');
    if (name.includes('sim.worker')) {
      offenders.push(`${name}  (file name contains "sim.worker")`);
    } else if (name.endsWith('.js') && readFileSync(file, 'utf8').includes('simLoad')) {
      offenders.push(`${name}  (contains the string "simLoad")`);
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (offenders.length > 0) {
  console.error('\ncheck:sim-gate FAILED — the electricrv.ca build leaked simulation code:');
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error('\nThe sim worker/client must stay behind `__FEATURE_SIM__` and reach the');
  console.error('bundle only through a lazy import that is dead when the flag is false (#193).');
  process.exit(1);
}

console.log('check:sim-gate ok — no sim.worker chunk and no "simLoad" in the electricrv.ca build');
