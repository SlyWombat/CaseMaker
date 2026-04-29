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
//   npm run deploy        # build + upload
//   npm run deploy -- --skip-build   # upload existing dist/ as-is
//   npm run deploy -- --dry-run      # walk + log without uploading
//
// CHANGELOG: every successful deploy logs the version + git sha to
// `dist/VERSION.txt` so you can confirm what's live.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const APP_DIR = resolve(__dirname, '..');
const DIST_DIR = join(APP_DIR, 'dist');
const ENV_PATH = join(REPO_ROOT, '.env');

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

const files = await walk(DIST_DIR);
const totalBytes = files.reduce((a, f) => a + f.size, 0);
console.log(`▸ Found ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

if (DRY_RUN) {
  for (const f of files) {
    console.log(`  ${f.rel} (${f.size} B)`);
  }
  console.log('\nDRY RUN complete — nothing uploaded.');
  process.exit(0);
}

// ---------- 3. upload via cPanel UAPI ----------
const baseUrl = `https://${env.CPANEL_HOST}:${PORT}`;
const auth = `cpanel ${env.CPANEL_USER}:${env.CPANEL_TOKEN}`;

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

console.log(`\n✓ Deploy complete. Live at https://${env.CPANEL_HOST.replace(/^cpanel\./, '')}/casemaker`);
console.log(`  Version: ${pkg.version}+${gitSha}`);
