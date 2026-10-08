// #181 — prove the default web bundle carries no desktop-only code.
//
// `__BUILD_TARGET__` is 'web' unless a build asks for 'desktop' (vite.config.ts). The seam's rule
// is that desktop-only modules live under src/platform/desktop/ and are reached ONLY through an
// `await import()` inside a `canX` guard — so the bundler deletes them from the web build. This
// builds the web target into a temp outDir and asserts the desktop module's marker string is
// absent from every emitted file. It exits non-zero and names the offending file otherwise.
//
// It also builds the desktop target and reports whether the marker made it in. That half is
// informational, but it is no longer vacuous: `machineProbe.ts` (#280) and `machineUpload.ts`
// (#255) both call `loadMachineBridge()`, so the desktop build should carry the marker and the web
// build must not. The web half is the one that gates — it fails the moment a top-level (unguarded)
// import leaks the module into the web bundle.
//
// Not wired into `npm test`: a production build is slow. Run it with `npm run check:platform-gate`.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'casemaker-desktop-bridge-v1';
const MODULE_FILE = join(APP_ROOT, 'src', 'platform', 'desktop', 'machineBridge.ts');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Build with the given Vite `mode` (which vite.config.ts maps to BUILD_TARGET) and return the files. */
async function buildTarget(mode) {
  const outDir = mkdtempSync(join(tmpdir(), `casemaker-platform-gate-${mode}-`));
  try {
    await build({
      root: APP_ROOT,
      configFile: join(APP_ROOT, 'vite.config.ts'),
      mode,
      logLevel: 'warn',
      build: { outDir, emptyOutDir: true },
    });
    return { outDir, files: walk(outDir) };
  } catch (err) {
    rmSync(outDir, { recursive: true, force: true });
    throw err;
  }
}

function filesContaining(files, needle) {
  const offenders = [];
  for (const file of files) {
    if (file.endsWith('.map')) continue; // sourcemaps mention every source path on purpose
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // binary asset
    }
    if (text.includes(needle)) offenders.push(file);
  }
  return offenders;
}

// Sanity: the marker must actually exist where we think it does, or "absent from the web build"
// would be meaningless.
if (!existsSync(MODULE_FILE) || !readFileSync(MODULE_FILE, 'utf8').includes(MARKER)) {
  console.error(`check:platform-gate FAILED — ${relative(APP_ROOT, MODULE_FILE)} does not contain "${MARKER}".`);
  process.exit(1);
}

let web;
try {
  web = await buildTarget('production'); // default target → web
  const offenders = filesContaining(web.files, MARKER);
  if (offenders.length > 0) {
    console.error('\ncheck:platform-gate FAILED — the web build leaked desktop-only code:');
    for (const offender of offenders) console.error(`  ${relative(web.outDir, offender)}  (contains "${MARKER}")`);
    console.error('\nDesktop-only modules must be reached only through an `await import()` inside a');
    console.error('`canX` guard (src/platform/capabilities.ts, #181) — never imported at the top level.');
    process.exit(1);
  }
  console.log(`check:platform-gate ok — no "${MARKER}" in the web build (${web.files.length} emitted files)`);
} finally {
  if (web) rmSync(web.outDir, { recursive: true, force: true });
}

// Informational: does the desktop build carry it? (Not a failure if not — see the header note.)
let desktop;
try {
  desktop = await buildTarget('desktop');
  const present = filesContaining(desktop.files, MARKER).length > 0;
  console.log(
    present
      ? `check:platform-gate — desktop build carries "${MARKER}" (boundary exercised)`
      : `check:platform-gate — NOTE: desktop build does not carry "${MARKER}". That is not a failure ` +
        '(every caller may legitimately be behind a guard the desktop build also folds away), but it ' +
        'does mean the informational half proved nothing this run.',
  );
} finally {
  if (desktop) rmSync(desktop.outDir, { recursive: true, force: true });
}
