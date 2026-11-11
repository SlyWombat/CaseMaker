// #181/#821/#867 — prove the RELAY-LESS web bundle carries no machine code, and that the ONE
// machine-carrying bundle does. #867 is one package: the desktop bundle is both the Tauri app and
// the page a local install serves to LAN browsers, so it must carry the bridge; the static web
// deploy has no relay, so it must not. The web half gates a leak; the desktop half gates the
// opposite mistake (a split that compiles the bridge out of the bundle a LAN browser is served).
//
// `__BUILD_TARGET__` is 'web' unless a build asks for 'desktop' (vite.config.ts). The seam's rule
// is that desktop-only modules live under src/platform/desktop/ and are reached ONLY through an
// `await import()` inside a `canX` guard — so the bundler deletes them from the web build. This
// builds the web target into a temp outDir and asserts the desktop module's marker string is
// absent from every emitted file. It exits non-zero and names the offending file otherwise.
//
// #1198 — THE WEB HALF ALSO FAILS ON ANY TAURI RUNTIME CODE, not only the bridge's marker. A
// desktop module guarded through the IMPORTED `BUILD_TARGET` const kept its dynamic import in the
// web graph even though the branch could never run, and the web dist shipped an orphan `core-*.js`
// (the `@tauri-apps/api` invoke shim, marked by `__TAURI_INTERNALS__`) that nothing referenced.
// Guarding on the vite define INLINE folds the branch and the chunk is not emitted at all.
//
// It then builds the desktop target and FAILS if the marker is absent: that single bundle is what
// the app window, the headless server and a LAN browser all run, and it must be able to drive the
// machine through the app's socket or the instance's relay.
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
  // #1198 — no Tauri runtime at all in the web bundle. The desktop build carries this marker
  // legitimately, so the check is the WEB half's alone.
  const tauri = filesContaining(web.files, '__TAURI_INTERNALS__');
  if (tauri.length > 0) {
    console.error('\ncheck:platform-gate FAILED — the web build carries Tauri runtime code:');
    for (const offender of tauri) console.error(`  ${relative(web.outDir, offender)}  (contains "__TAURI_INTERNALS__")`);
    console.error('\nA desktop-only import survived the build as an orphan chunk. Guard it by reading');
    console.error('the vite define INLINE (`__BUILD_TARGET__`), not the imported `BUILD_TARGET` const (#1196, #1198).');
    process.exit(1);
  }
  console.log(
    `check:platform-gate ok — no "${MARKER}" and no Tauri runtime in the web build (${web.files.length} emitted files)`,
  );
} finally {
  if (web) rmSync(web.outDir, { recursive: true, force: true });
}

// #867 — the desktop build is the ONE machine-carrying bundle and MUST carry it.
let desktop;
try {
  desktop = await buildTarget('desktop');
  const present = filesContaining(desktop.files, MARKER).length > 0;
  if (!present) {
    console.error(
      '\ncheck:platform-gate FAILED — the desktop build does not carry the machine bridge.\n' +
        '  One package (#867): this bundle is the app window, the headless server and the page a\n' +
        '  LAN browser is served. `canReachMachine` must be true for the desktop target and the\n' +
        '  bridge must be in the bundle.',
    );
    process.exit(1);
  }
  console.log(`check:platform-gate — desktop build carries "${MARKER}" (the relay-served bundle can drive a machine)`);
} finally {
  if (desktop) rmSync(desktop.outDir, { recursive: true, force: true });
}
