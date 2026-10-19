#!/usr/bin/env node
// Issue #81 — production deploy script for the Case Maker SPA.
//
// Reads .env from the repo root (same one git ignores) and uploads the built
// `dist/` to a cPanel-hosted directory using cPanel's UAPI Fileman::upload_files
// endpoint over HTTPS with token auth. No FTP, no SSH key needed.
//
// .env required keys:
//   CPANEL_HOST   cPanel server hostname (e.g. cpanel.example.com)
//   CPANEL_PORT   usually 2083 (HTTPS) — defaults to 2083 if missing
//   CPANEL_USER   cPanel account username
//   CPANEL_TOKEN  cPanel API token (generate in cPanel → Manage API Tokens)
//   WEB_ROOT      remote absolute path under public_html
//                 (e.g. /home/USER/public_html/casemaker)
//
// Usage:
//   npm run deploy        # build + upload + prune old builds
//   npm run deploy -- --skip-build   # upload existing dist/ as-is
//   npm run deploy -- --dry-run      # walk + log; what WOULD upload and delete
//   npm run deploy -- --dry-run --prune-fixture <file.json>
//                                    # exercise the prune plan fully offline
//                                    # (no host call at all) against a sample
//                                    # listing — see PRUNE FIXTURE below.
//
// Issue #546 — after each deploy the host must hold only the current build and
// the previous one (v-1). This script:
//   * never uploads `*.map` (source maps; ~900 MB of the old bloat), and
//   * after uploading, deletes every file in `assets/` that neither the new
//     build nor the previous build references. It records each build's asset
//     list on the host (`assets/build-manifest.json`) so the next deploy knows
//     what v-1 is, and deletes PERMANENTLY (not a move to `.trash`, which frees
//     no quota) via cPanel API2 Fileman::fileop op=unlink.
//
// PRUNE FIXTURE (--prune-fixture): a JSON file
//   { "prevRecord": { "assets": ["index-V1.js", ...] },
//     "remoteAssets": [ { "name": "index-V0.js", "size": 1234 }, ... ] }
// lets --dry-run compute and print the exact prune plan without touching the
// host. prevRecord is the v-1 build record; remoteAssets is a listing of
// assets/ (as Fileman::list_files would return it).
//
// CHANGELOG: every successful deploy logs the version + git sha to
// `dist/VERSION.txt` so you can confirm what's live.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BUILD_RECORD_NAME,
  isSourceMap,
  assetBasenames,
  buildRecord,
  assetsFromRecord,
  computePrune,
} from './deploy-prune.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const APP_DIR = resolve(__dirname, '..');
const DIST_DIR = join(APP_DIR, 'dist');
// CASEMAKER_ENV lets a dry run point at a throwaway .env (same override the
// quota script accepts) without disturbing the real credentials file.
const ENV_PATH = process.env.CASEMAKER_ENV ?? join(REPO_ROOT, '.env');

// ---------- env loader (no dotenv dep) ----------
function loadEnv(path) {
  if (!existsSync(path)) {
    console.error(`error: .env not found at ${path}`);
    process.exit(1);
  }
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}
import { readFileSync } from 'node:fs';

// ---------- args ----------
const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
// --prune-fixture <path>: supply a sample { prevRecord, remoteAssets } so the
// prune plan can be computed and printed with no host call (dry-run only).
const fixtureIdx = args.indexOf('--prune-fixture');
const PRUNE_FIXTURE = fixtureIdx >= 0 ? args[fixtureIdx + 1] : null;

// ---------- main ----------
const env = loadEnv(ENV_PATH);
for (const k of ['CPANEL_HOST', 'CPANEL_USER', 'CPANEL_TOKEN', 'WEB_ROOT']) {
  if (!env[k]) {
    console.error(`error: ${k} missing from .env`);
    process.exit(1);
  }
}
// Safety guard — refuse to deploy directly into the site root. Always require
// a subdirectory so we can't accidentally write VERSION.txt + 20 asset chunks
// next to the user's existing index.html.
const SITE_ROOT_TAILS = new Set(['public_html', 'www', 'htdocs', 'html']);
const tail = env.WEB_ROOT.replace(/\/+$/, '').split('/').pop() ?? '';
if (SITE_ROOT_TAILS.has(tail)) {
  console.error(
    `error: WEB_ROOT (${env.WEB_ROOT}) looks like the site root.\n` +
    `       Use a subdirectory like ${env.WEB_ROOT}/casemaker so the deploy\n` +
    `       can't overwrite the rest of your site. Update .env and rerun.`,
  );
  process.exit(2);
}
const PORT = env.CPANEL_PORT || '2083';

console.log(`Deploying to ${env.CPANEL_USER}@${env.CPANEL_HOST}:${PORT}`);
console.log(`Remote path: ${env.WEB_ROOT}`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${SKIP_BUILD ? ' (skip build)' : ''}`);
console.log();

// ---------- 1. build ----------
// Issue #82 — derive the public URL prefix from WEB_ROOT so vite emits
// /casemaker/assets/... in index.html instead of root-absolute /assets/....
// `/home/USER/public_html/casemaker` → '/casemaker/'.
const PUB_HTML_RE = /\/public_html(\/.*)?$/;
const m = env.WEB_ROOT.match(PUB_HTML_RE);
const sub = (m?.[1] ?? '').replace(/\/+$/, '');
const DEPLOY_BASE = sub ? `${sub}/` : '/';
console.log(`▸ Vite base for this deploy: ${DEPLOY_BASE}`);

// Issue #72 — pass DEPLOY_TARGET + DONATE_URL into the build env so the
// production-only Donate button gets wired up. Empty values keep the button
// hidden in dev / Tauri / GitHub Pages builds.
const DEPLOY_TARGET = 'electricrv';
const DONATE_URL = env.DONATE_URL ?? '';
if (DONATE_URL) {
  console.log(`▸ Donate button enabled: ${DONATE_URL}`);
} else {
  console.warn('▸ DONATE_URL not set in .env — Donate button will be hidden.');
}

if (!SKIP_BUILD) {
  console.log('▸ Building dist/...');
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: APP_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DEPLOY_BASE, DEPLOY_TARGET, DONATE_URL },
  });
  if (result.status !== 0) {
    console.error('error: build failed');
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(DIST_DIR)) {
  console.error(`error: ${DIST_DIR} doesn't exist — run with build first`);
  process.exit(1);
}

// Stamp the build with version + git sha for visible confirmation in production.
const pkg = JSON.parse(await readFile(join(APP_DIR, 'package.json'), 'utf8'));
let gitSha = 'nogit';
try {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP_DIR });
  gitSha = (r.stdout?.toString() ?? '').trim() || gitSha;
} catch { /* */ }
const buildStamp = `${pkg.version}+${gitSha}\n${new Date().toISOString()}\n`;
await writeFile(join(DIST_DIR, 'VERSION.txt'), buildStamp);
console.log(`▸ Stamped: ${buildStamp.split('\n')[0]}`);

// ---------- 2. walk dist/ ----------
async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else if (entry.isFile()) {
      const rel = relative(base, full);
      const size = (await stat(full)).size;
      out.push({ full, rel, size });
    }
  }
  return out;
}

const walked = await walk(DIST_DIR);

// #546 — never upload source maps. They are ~7.7 MB each, never needed to serve
// the app, and were ~900 MB of the accumulated bloat. Excluding them here means
// they also never enter any build's KEEP set, so the prune step clears every
// `*.map` already on the host.
const files = walked.filter((f) => !isSourceMap(f.rel));
const maps = walked.filter((f) => isSourceMap(f.rel));
const totalBytes = files.reduce((a, f) => a + f.size, 0);
const mapBytes = maps.reduce((a, f) => a + f.size, 0);
console.log(`▸ Found ${files.length} files to upload, ${mib(totalBytes)} MB`);
console.log(`▸ Excluding ${maps.length} source maps (${mib(mapBytes)} MB) — not uploaded (#546)`);

// The NEW build's complete asset file list (entry + css + every lazy chunk +
// workers + wasm + fonts), taken from what is physically in dist/assets. This
// is what the deploy records on the host as the current build, and what the
// NEXT deploy reads back as v-1.
const newAssetNames = assetBasenames(files);

function mib(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

// ---------- 3. host helpers (cPanel UAPI + API2) ----------
const baseUrl = `https://${env.CPANEL_HOST}:${PORT}`;
const auth = `cpanel ${env.CPANEL_USER}:${env.CPANEL_TOKEN}`;
const ASSETS_DIR = `${env.WEB_ROOT}/assets`;
// The public site base, used only to read back the previous build record.
// `cpanel.example.com` → `https://example.com/casemaker/`. PUBLIC_URL overrides.
const PUBLIC_URL = env.PUBLIC_URL ?? `https://${env.CPANEL_HOST.replace(/^cpanel\./, '')}${DEPLOY_BASE}`;

// cPanel API2 Fileman::fileop wants sourcefiles relative to the account home.
function relToHome(abs) {
  const home = `/home/${env.CPANEL_USER}`;
  return abs.startsWith(`${home}/`) ? abs.slice(home.length + 1) : abs.replace(/^\/+/, '');
}

async function ensureDir(remoteDir) {
  // cPanel UAPI Fileman::mkdir is the canonical create-dir call. Best-effort —
  // ignore "already exists" errors.
  const url = new URL('/execute/Fileman/mkdir', baseUrl);
  url.searchParams.set('path', dirname(remoteDir));
  url.searchParams.set('name', remoteDir.split('/').pop() ?? '');
  const r = await fetch(url, { headers: { Authorization: auth } });
  if (!r.ok && VERBOSE) {
    console.warn(`mkdir ${remoteDir}: HTTP ${r.status}`);
  }
}

async function uploadOne(localPath, remoteDir, name) {
  const buf = await readFile(localPath);
  const fd = new FormData();
  fd.append('dir', remoteDir);
  // overwrite=1 is required for re-deploys; without it the second deploy
  // fails on every file already in place (index.html, .htaccess, etc.).
  fd.append('overwrite', '1');
  fd.append('file-1', new Blob([buf]), name);
  const url = new URL('/execute/Fileman/upload_files', baseUrl);
  const r = await fetch(url, { method: 'POST', headers: { Authorization: auth }, body: fd });
  if (!r.ok) {
    throw new Error(`upload ${name}: HTTP ${r.status} ${await r.text()}`);
  }
  const body = await r.json();
  if (body.errors && body.errors.length) {
    throw new Error(`upload ${name}: ${JSON.stringify(body.errors)}`);
  }
}

// --- #546 prune helpers -------------------------------------------------------

// List the files currently in assets/ (read-only). UAPI Fileman::list_files.
async function remoteListAssets() {
  const url = new URL('/execute/Fileman/list_files', baseUrl);
  url.searchParams.set('dir', ASSETS_DIR);
  url.searchParams.set('types', 'file');
  const r = await fetch(url, { headers: { Authorization: auth } });
  if (!r.ok) throw new Error(`list_files: HTTP ${r.status} ${await r.text()}`);
  const body = await r.json();
  const rows = body?.data ?? [];
  return rows
    .filter((x) => x.type === 'file')
    .map((x) => ({ name: x.file, size: Number(x.size) || 0 }));
}

// Read back the previous build's record over the public site (read-only). A
// miss (first pruned run, or the record not yet present) is treated as "no
// previous build known" — the prune then keeps only the new build.
async function readPrevRecord() {
  const url = `${PUBLIC_URL}assets/${BUILD_RECORD_NAME}`;
  try {
    const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    if (!r.ok) {
      if (VERBOSE) console.warn(`prev record: HTTP ${r.status} (treating as first pruned run)`);
      return null;
    }
    return await r.json();
  } catch (e) {
    if (VERBOSE) console.warn(`prev record: ${e.message} (treating as first pruned run)`);
    return null;
  }
}

// PERMANENT delete (NOT a move to .trash — that frees no quota). cPanel API2
// Fileman::fileop op=unlink, one file per call for clear error reporting.
//
// ⚠ FLAG FOR OWNER CONFIRMATION: cPanel's API2 docs describe op=unlink tersely
// as "removes a symlink" and expose no UAPI equivalent; in practice it is the
// call the File Manager's "Skip the trash" delete uses to permanently remove
// regular files. Confirm against the live host (on a throwaway file first)
// before trusting it in anger.
async function deletePermanent(names) {
  let n = 0;
  for (const name of names) {
    const url = new URL('/json-api/cpanel', baseUrl);
    url.searchParams.set('cpanel_jsonapi_user', env.CPANEL_USER);
    url.searchParams.set('cpanel_jsonapi_module', 'Fileman');
    url.searchParams.set('cpanel_jsonapi_func', 'fileop');
    url.searchParams.set('cpanel_jsonapi_apiversion', '2');
    url.searchParams.set('op', 'unlink');
    url.searchParams.set('sourcefiles', relToHome(`${ASSETS_DIR}/${name}`));
    url.searchParams.set('doubledecode', '0');
    const r = await fetch(url, { method: 'POST', headers: { Authorization: auth } });
    if (!r.ok) throw new Error(`delete ${name}: HTTP ${r.status} ${await r.text()}`);
    const body = await r.json().catch(() => null);
    if (body?.cpanelresult?.error) throw new Error(`delete ${name}: ${body.cpanelresult.error}`);
    n++;
    if (n % 10 === 0 || n === names.length) process.stdout.write(`\r  ${n}/${names.length}`);
  }
  process.stdout.write('\n');
}

function printUnlinkEndpoint() {
  console.log('  Permanent delete uses (one call per file), API2 token auth:');
  console.log(`    POST ${baseUrl}/json-api/cpanel`);
  console.log('      ?cpanel_jsonapi_user=<user>&cpanel_jsonapi_module=Fileman'
    + '&cpanel_jsonapi_func=fileop&cpanel_jsonapi_apiversion=2');
  console.log('      &op=unlink&sourcefiles=<assets-path-relative-to-home>&doubledecode=0');
  console.log('    Header: Authorization: cpanel <user>:<token>   [⚠ confirm op=unlink — see script]');
}

function printPrunePlan(plan, prevAssetNames, source) {
  console.log(`\n▸ Prune plan (v-1 from ${source}):`);
  console.log(`  current build: ${newAssetNames.length} assets; v-1 build: ${prevAssetNames.length} assets`);
  console.log(`  KEEP ${plan.keepNames.length} files (${mib(plan.keepBytes)} MB), `
    + `DELETE ${plan.deleteList.length} files (${mib(plan.deleteBytes)} MB)`);
  for (const d of plan.deleteList) console.log(`  - assets/${d.name} (${d.size} B)`);
  console.log(`  → would free ${mib(plan.deleteBytes)} MB`);
}

// ---------- 4. DRY RUN: log what WOULD upload + delete, touch nothing ----------
if (DRY_RUN) {
  console.log('\nWould upload:');
  for (const f of files) console.log(`  + ${f.rel} (${f.size} B)`);
  console.log(`  + assets/${BUILD_RECORD_NAME}  (new build record, ${newAssetNames.length} assets)`);

  if (PRUNE_FIXTURE) {
    const fx = JSON.parse(await readFile(PRUNE_FIXTURE, 'utf8'));
    const prevAssetNames = assetsFromRecord(fx.prevRecord);
    const remoteAssets = fx.remoteAssets ?? [];
    const plan = computePrune({ newAssetNames, prevAssetNames, remoteAssets });
    printPrunePlan(plan, prevAssetNames, `fixture ${PRUNE_FIXTURE}`);
    printUnlinkEndpoint();
  } else {
    console.log('\n▸ Prune plan not computed: pass --prune-fixture <file.json> to compute it');
    console.log('  offline, or run a live (non-dry) deploy. A live dry run would read the host');
    console.log(`  (UAPI Fileman::list_files on ${ASSETS_DIR}) read-only to list deletions.`);
  }
  console.log('\nDRY RUN complete — nothing uploaded, nothing deleted.');
  process.exit(0);
}

// ---------- 5. LIVE: capture v-1 BEFORE overwriting, then upload -------------
// Read the previous build's file set and the current assets/ listing NOW, so
// the prune below knows what v-1 is before this deploy's record overwrites it.
console.log('▸ Reading previous build record + current assets/ listing...');
const prevRecord = await readPrevRecord();
const prevAssetNames = assetsFromRecord(prevRecord);
const remoteAssetsBefore = await remoteListAssets();
console.log(`  v-1 build: ${prevAssetNames.length} assets; host assets/: ${remoteAssetsBefore.length} files`);

// Pre-create all unique remote subdirectories.
const remoteDirs = new Set([env.WEB_ROOT]);
for (const f of files) {
  const sub = dirname(f.rel);
  if (sub && sub !== '.') remoteDirs.add(`${env.WEB_ROOT}/${sub.replace(/\\/g, '/')}`);
}
console.log(`▸ Ensuring ${remoteDirs.size} remote directories...`);
for (const d of remoteDirs) await ensureDir(d);

// Upload files one at a time. cPanel's upload_files endpoint accepts
// multiple files per call, but per-file gives clearer error reporting.
console.log(`▸ Uploading ${files.length} files...`);
let done = 0;
for (const f of files) {
  const sub = dirname(f.rel).replace(/\\/g, '/');
  const remoteDir = sub === '.' ? env.WEB_ROOT : `${env.WEB_ROOT}/${sub}`;
  const name = f.rel.split(/[\\/]/).pop() ?? '';
  await uploadOne(f.full, remoteDir, name);
  done++;
  if (done % 10 === 0 || done === files.length) {
    process.stdout.write(`\r  ${done}/${files.length}`);
  }
}
process.stdout.write('\n');

// ---------- 4. .htaccess for .wasm MIME + caching (issue #71) ----------
// Issue #71 — .htaccess for cPanel-style shared Apache. Defensive about
// optional modules so a missing mod_headers / mod_mime / mod_deflate doesn't
// 500 the entire site. Wrapping in <IfModule> is the standard cPanel guard.
const htaccess = `# Auto-generated by casemaker-app/scripts/deploy-cpanel.mjs
# Reference: src/docs/deployment.md, GitHub issue #71

# --- WASM MIME type (browser refuses to instantiate without this) ---
<IfModule mod_mime.c>
  AddType application/wasm .wasm
</IfModule>

# --- Long cache for hashed static assets (vite emits content-hashed names) ---
<IfModule mod_headers.c>
  <FilesMatch "\\.(js|wasm|css|map)$">
    Header set Cache-Control "max-age=31536000, immutable"
  </FilesMatch>
  # index.html and .htaccess itself must NOT be cached aggressively, so the
  # client always pulls the latest references to hashed assets after a deploy.
  <FilesMatch "\\.html$">
    Header set Cache-Control "no-cache, must-revalidate"
  </FilesMatch>
</IfModule>

# --- gzip / brotli compression for the JS / WASM bundle ---
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE application/javascript text/css application/wasm application/json image/svg+xml
</IfModule>

# --- SPA fallback (no client routes today; uncomment when added) ---
# <IfModule mod_rewrite.c>
#   RewriteEngine On
#   RewriteBase /casemaker/
#   RewriteCond %{REQUEST_FILENAME} !-f
#   RewriteCond %{REQUEST_FILENAME} !-d
#   RewriteRule ^ index.html [L]
# </IfModule>
`;
const tmpHt = join(DIST_DIR, '.htaccess');
await writeFile(tmpHt, htaccess);
await uploadOne(tmpHt, env.WEB_ROOT, '.htaccess');

// ---------- 6. record this build, then prune assets/ to current + v-1 --------
// Record the new build's asset list on the host so the NEXT deploy knows what
// v-1 is. Uploaded AFTER the capture above, so it overwrites the previous one.
const recPath = join(DIST_DIR, BUILD_RECORD_NAME);
await writeFile(
  recPath,
  JSON.stringify(buildRecord({ version: pkg.version, sha: gitSha, assetNames: newAssetNames }), null, 2),
);
await uploadOne(recPath, ASSETS_DIR, BUILD_RECORD_NAME);
console.log(`▸ Recorded current build as assets/${BUILD_RECORD_NAME} (${newAssetNames.length} assets)`);

// Prune: keep current ∪ v-1 (∪ the record), delete the rest permanently.
const plan = computePrune({ newAssetNames, prevAssetNames, remoteAssets: remoteAssetsBefore });
if (plan.deleteList.length === 0) {
  console.log('▸ Prune: nothing to delete — assets/ already holds only current + v-1.');
} else {
  console.log(`▸ Pruning ${plan.deleteList.length} old files (${mib(plan.deleteBytes)} MB) permanently...`);
  await deletePermanent(plan.deleteList.map((d) => d.name));
  console.log(`  freed ~${mib(plan.deleteBytes)} MB`);
}

console.log(`\n✓ Deploy complete. Live at https://${env.CPANEL_HOST.replace(/^cpanel\./, '')}/casemaker`);
console.log(`  Version: ${pkg.version}+${gitSha}`);
