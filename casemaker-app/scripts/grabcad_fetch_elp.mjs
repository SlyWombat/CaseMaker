// Logs into GrabCAD with credentials from .env (GRABCAD_USER/GRABCAD_PASSWORD),
// opens the ELP-USBGS1200P01-H120 model page, and dumps:
//   - the full description text
//   - the file list (names + download URLs)
//   - any visible dimension callouts in the markup
// Output goes to scripts/grabcad-elp-out/.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ now lives under casemaker-app/, so repo root is two levels up
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'grabcad-elp-out');

async function loadEnv() {
  const text = await fs.readFile(path.join(REPO_ROOT, '.env'), 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return env;
}

const MODEL_URL = 'https://grabcad.com/library/elp-usbgs1200p01-h120-1';
const FILES_URL = MODEL_URL + '/files';

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const env = await loadEnv();
  if (!env.GRABCAD_USER || !env.GRABCAD_PASSWORD) {
    throw new Error('GRABCAD_USER / GRABCAD_PASSWORD missing from .env');
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    acceptDownloads: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  console.log('→ navigating to login');
  await page.goto('https://grabcad.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  await fs.writeFile(path.join(OUT_DIR, 'login-page.html'), await page.content());

  // Try multiple possible field selectors
  const emailLocator = page
    .locator('input[type="email"], input[name="user[email]"], input[name="email"], #user_email')
    .first();
  const passLocator = page
    .locator('input[type="password"], input[name="user[password]"], input[name="password"], #user_password')
    .first();
  try {
    await emailLocator.waitFor({ timeout: 20000 });
  } catch (e) {
    console.error('login form did not render — saved login-page.html for inspection');
    throw e;
  }
  await emailLocator.fill(env.GRABCAD_USER);
  await passLocator.fill(env.GRABCAD_PASSWORD);

  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
    submit.click(),
  ]);
  await page.waitForTimeout(2500);

  console.log('→ logged in, navigating to model page');
  await page.goto(MODEL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const pageHtml = await page.content();
  await fs.writeFile(path.join(OUT_DIR, 'model-page.html'), pageHtml);

  const descText = await page.locator('main, body').first().innerText().catch(() => '');
  await fs.writeFile(path.join(OUT_DIR, 'model-page.txt'), descText);

  console.log('→ navigating to files page');
  await page.goto(FILES_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const filesHtml = await page.content();
  await fs.writeFile(path.join(OUT_DIR, 'files-page.html'), filesHtml);
  const filesText = await page.locator('main, body').first().innerText().catch(() => '');
  await fs.writeFile(path.join(OUT_DIR, 'files-page.txt'), filesText);

  // The filetree's per-row dropdown-toggle is invisible until row hover (CSS
  // .row:hover reveals it). Reach into the Angular scope instead and pull
  // each file's download_url directly — much more reliable than UI hover-
  // hunting. Then fetch via the authenticated browser context.
  const fileMeta = await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    const scope = window.angular
      ? window.angular.element(document.querySelector('.fileTable'))?.scope?.()
      : null;
    if (!scope || !scope.fileTree || !Array.isArray(scope.fileTree.files)) return [];
    return scope.fileTree.files.map((f) => ({
      name: f.name,
      url: f.download_url,
      size: f.size,
    }));
  });
  await fs.writeFile(
    path.join(OUT_DIR, 'links.json'),
    JSON.stringify(fileMeta, null, 2),
  );
  console.log(`→ extracted ${fileMeta.length} file URLs from Angular scope`);

  // Use the page's request context so cookies/CSRF carry over.
  const apiCtx = page.context();
  for (const f of fileMeta) {
    if (!f.url) {
      console.log(`   ${f.name}: no download_url, skipping`);
      continue;
    }
    try {
      // GrabCAD's API returns JSON `{ "url": "<signed S3 URL>" }` instead
      // of a HTTP redirect — fetch that wrapper, then GET the inner URL.
      let resp = await apiCtx.request.get(f.url, { timeout: 60000 });
      if (!resp.ok()) {
        console.log(`   ${f.name}: HTTP ${resp.status()}`);
        continue;
      }
      const ct = resp.headers()['content-type'] || '';
      if (ct.includes('application/json')) {
        const json = await resp.json();
        if (!json.url) {
          console.log(`   ${f.name}: JSON had no url field`);
          continue;
        }
        resp = await apiCtx.request.get(json.url, { timeout: 120000 });
        if (!resp.ok()) {
          console.log(`   ${f.name}: signed-url HTTP ${resp.status()}`);
          continue;
        }
      }
      const buf = await resp.body();
      const target = path.join(OUT_DIR, f.name);
      await fs.writeFile(target, buf);
      console.log(`   saved ${f.name} (${buf.length} bytes)`);
    } catch (e) {
      console.log(`   ${f.name}: ${e.message}`);
    }
  }

  await browser.close();
  console.log(`\nWrote outputs to ${OUT_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
