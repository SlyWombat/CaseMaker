// Render every template; capture errors per-template.
// Outputs: local-docs/template-render-<id>.png + a JSON results blob to stdout.
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_URL = process.env.TARGET_URL || 'http://127.0.0.1:8088/';
const screenshotPath = (id) => resolve(__dirname, 'local-docs', `template-render-${id}.png`);

const TEMPLATES = [
  'pi-server-tray',
  'pi-poe-stack',
  'pi-zero-tablet',
  'arduino-dmx',
  'giga-dmx-controller',
  'esp32-dev-tray',
  'snap-fit-test',
  'protective-case',
  'large-box-200',
];

const HARD_TIMEOUT_MS = 9 * 60 * 1000; // 9 min hard cap leaving 1 min headroom
const PER_TEMPLATE_TIMEOUT_MS = 30000;

const results = [];
const startedAt = Date.now();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();

// Per-template buffers reset before each click.
let consoleEvents = [];
let pageErrors = [];

page.on('dialog', (d) => d.accept().catch(() => {}));
page.on('console', (m) => {
  consoleEvents.push({ type: m.type(), text: m.text() });
});
page.on('pageerror', (e) => {
  pageErrors.push({ message: e.message, stack: e.stack });
});
page.on('worker', (worker) => {
  worker.on('console', (m) => {
    consoleEvents.push({ type: m.type(), text: m.text(), source: 'worker' });
  });
});

async function gotoFresh() {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-testid="welcome-overlay"]', { timeout: 30000 });
}

await gotoFresh();
console.log('initial welcome overlay loaded');

async function ensureWelcome() {
  // If welcome overlay is visible, we're good.
  const haveOverlay = await page.$('[data-testid="welcome-overlay"]');
  if (haveOverlay) return;
  // Otherwise, click New project to bring it back.
  const newBtn = await page.$('[data-testid="new-project"]');
  if (newBtn) {
    await newBtn.click();
    try {
      await page.waitForSelector('[data-testid="welcome-overlay"]', { timeout: 5000 });
      return;
    } catch {}
  }
  // Hard reload as fallback.
  console.log('  reload fallback to recover welcome');
  await gotoFresh();
}

async function runTemplate(id) {
  const tStart = Date.now();
  consoleEvents = [];
  pageErrors = [];

  let status = 'unknown';
  let errorSummary = null;
  let statusBarText = '';
  let statusAttr = '';
  let qaBanner = null;
  let notManifold = false;
  let crashRecovered = false;

  try {
    await ensureWelcome();
  } catch (e) {
    return { id, status: 'error', errorSummary: 'failed to reach welcome: ' + e.message, statusBarText, statusAttr, qaBanner, notManifold };
  }

  const sel = `[data-testid="welcome-template-${id}"]`;
  const tplEl = await page.$(sel);
  if (!tplEl) {
    return { id, status: 'error', errorSummary: `template button not found: ${sel}`, statusBarText, statusAttr, qaBanner, notManifold };
  }

  try {
    await tplEl.click();
  } catch (e) {
    return { id, status: 'error', errorSummary: 'click failed: ' + e.message, statusBarText, statusAttr, qaBanner, notManifold };
  }

  // Wait for status-bar's data-status to land on idle / error (or 30s).
  let waitOutcome = 'timeout';
  try {
    await page.waitForFunction(
      () => {
        const bar = document.querySelector('[data-testid="status-bar"]');
        if (!bar) return false;
        const ds = bar.getAttribute('data-status');
        if (!ds) return false;
        return ds === 'idle' || ds === 'error' || ds === 'failed';
      },
      { timeout: PER_TEMPLATE_TIMEOUT_MS },
    );
    waitOutcome = 'reached';
  } catch (e) {
    waitOutcome = 'timeout';
  }

  // Settle async logs.
  await page.waitForTimeout(800);

  try {
    statusAttr = await page.evaluate(() => document.querySelector('[data-testid="status-bar"]')?.getAttribute('data-status') || '');
    statusBarText = await page.evaluate(() => document.querySelector('[data-testid="status-bar"]')?.textContent || '');
    qaBanner = await page.evaluate(() => {
      const tids = ['qa-banner', 'floaters-banner', 'placement-banner', 'loose-pieces-banner'];
      for (const t of tids) {
        const el = document.querySelector(`[data-testid="${t}"]`);
        if (el) return { testid: t, text: el.textContent };
      }
      return null;
    });
  } catch (e) {
    // page may have crashed; try recovery by reloading.
    crashRecovered = true;
    try { await gotoFresh(); } catch {}
  }

  // Aggregate errors.
  const errs = consoleEvents.filter((e) => e.type === 'error');
  const manifoldHits = consoleEvents.filter((e) => /not\s*manifold|isn't manifold|isnt manifold/i.test(e.text));
  notManifold = manifoldHits.length > 0;

  if (waitOutcome === 'timeout' && statusAttr !== 'idle' && statusAttr !== 'error') {
    status = 'timeout';
    errorSummary = `compile did not finish in ${PER_TEMPLATE_TIMEOUT_MS}ms (status=${statusAttr || '?'})`;
  } else if (statusAttr === 'error' || statusAttr === 'failed' || pageErrors.length > 0 || errs.length > 0 || notManifold) {
    status = 'error';
    const parts = [];
    if (statusAttr === 'error' || statusAttr === 'failed') parts.push(`status=${statusAttr}`);
    if (notManifold) parts.push(`Not manifold (${manifoldHits.length})`);
    if (pageErrors.length > 0) parts.push(`pageerror: ${pageErrors[0].message}`);
    if (errs.length > 0) {
      const first = errs[0].text.slice(0, 240);
      parts.push(`console.error: ${first}`);
    }
    errorSummary = parts.join(' | ');
  } else {
    status = 'ok';
  }

  // Screenshot.
  let screenshot = null;
  try {
    const sp = screenshotPath(id);
    await page.screenshot({ path: sp, fullPage: false });
    screenshot = sp;
  } catch (e) {
    screenshot = `screenshot failed: ${e.message}`;
  }

  // Capture sample of all error texts for diagnosis.
  const errSamples = errs.slice(0, 5).map((e) => e.text.slice(0, 400));
  const manifoldSamples = manifoldHits.slice(0, 5).map((e) => e.text.slice(0, 400));
  const pageErrSamples = pageErrors.slice(0, 5).map((e) => e.message.slice(0, 400));

  return {
    id,
    status,
    errorSummary,
    statusAttr,
    statusBarText: statusBarText.slice(0, 120),
    qaBanner,
    notManifold,
    consoleErrorCount: errs.length,
    pageErrorCount: pageErrors.length,
    waitOutcome,
    crashRecovered,
    durationMs: Date.now() - tStart,
    screenshot,
    errSamples,
    manifoldSamples,
    pageErrSamples,
  };
}

for (const id of TEMPLATES) {
  if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
    console.log('hard timeout reached, stopping at', id);
    results.push({ id, status: 'skipped', errorSummary: 'hard timeout reached' });
    continue;
  }
  console.log('=== running template', id, '===');
  const res = await runTemplate(id);
  console.log('  ->', res.status, res.errorSummary || '', `(status=${res.statusAttr})`);
  results.push(res);
}

await browser.close();

const outBlob = { startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, results };
const outPath = resolve(__dirname, 'local-docs', 'template-render-results.json');
fs.writeFileSync(outPath, JSON.stringify(outBlob, null, 2));
console.log('\nresults json ->', outPath);

// Also print a readable summary to stdout.
console.log('\n=== SUMMARY ===');
for (const r of results) {
  console.log(`${r.id.padEnd(22)} ${r.status.padEnd(8)} ${r.errorSummary || ''}`);
}
console.log('done.');
