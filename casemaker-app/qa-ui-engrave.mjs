// Scratch QA: take the engrave panel all the way through the pipeline and see whether
// Save and the run sheet actually come alive. Slow on purpose — the sweep is the long pole.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = './qa-ui-out';
mkdirSync(OUT, { recursive: true });
const URL = process.env.QA_URL ?? 'http://127.0.0.1:5173/';

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${String(e).split('\n')[0]}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 200)}`); });

const t0 = Date.now();
await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByTestId('welcome-search').fill('sht31');
await page.waitForTimeout(400);
await page.getByTestId('welcome-board-adafruit-sht31d').click();
await page.getByTestId('welcome-generate').click();
await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
await page.evaluate(async () => { await window.__caseMaker?.waitForIdle?.(); });

await page.getByTestId('sidebar-button-cnc-engrave').click();
await page.waitForTimeout(600);

await page.getByTestId('engrave-generate').click();
// The pipeline is generate → verify → simulate. Poll for the save gate instead of guessing.
let waited = 0;
while (waited < 180000) {
  await page.waitForTimeout(3000);
  waited += 3000;
  const blocked = await page.getByTestId('engrave-save-blocked').count();
  const ask = await page.getByTestId('engrave-ack').count();
  const err = await page.getByTestId('engrave-run-error').allTextContents();
  if (err.length && err.join('').trim()) { console.log('RUN ERROR:', err.join(' | ')); break; }
  if (blocked === 0) break;   // the blocker line is gone → save is live
  if (ask) { /* ack checkbox appeared; keep waiting for the sim to finish */ }
}
console.log(`pipeline settled after ~${Math.round((Date.now() - t0) / 1000)}s (waited ${waited / 1000}s)`);

const ack = page.getByTestId('engrave-ack');
if (await ack.count()) { await ack.check().catch(() => {}); await page.waitForTimeout(400); }

const state = {
  saveDisabled: await page.getByTestId('engrave-save').isDisabled().catch(() => null),
  blockedText: await page.getByTestId('engrave-save-blocked').allTextContents().catch(() => []),
  runRows: await page.getByTestId('engrave-run-rows').innerText().catch(() => ''),
  coverage: await page.getByTestId('engrave-sim-coverage').innerText().catch(() => ''),
  findings: await page.locator('[data-testid^="engrave-finding-"]').allTextContents().catch(() => []),
};
await page.screenshot({ path: `${OUT}/30-engrave-done.png`, fullPage: false });
await page.getByTestId('engrave-panel').evaluate((el) => { el.scrollTop = el.scrollHeight; });
await page.screenshot({ path: `${OUT}/31-engrave-done-bottom.png`, fullPage: false });

// The run sheet overlay.
const sheetBtn = page.getByTestId('engrave-run-sheet');
if (await sheetBtn.count() && !(await sheetBtn.isDisabled().catch(() => true))) {
  await sheetBtn.click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/32-run-sheet.png`, fullPage: false });
  state.runSheetText = (await page.locator('body').innerText()).slice(0, 1200);
}

state.errors = [...new Set(errs)].slice(0, 30);
console.log(JSON.stringify(state, null, 1));
await b.close();
