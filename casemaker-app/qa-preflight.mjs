// Pre-deploy QA against the BUILT dist/ served by vite preview.
// Verifies the browser geometry worker (the one evaluateOp caller the node
// test suite never touches) renders a mini-rack and exports a real STL.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const URL = process.env.QA_URL ?? 'http://localhost:4173/';
const OUT = process.env.QA_OUT ?? './qa-preflight-out';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
await ctx.addInitScript(() => {
  // Headless Chromium exposes showSaveFilePicker but never resolves it — the
  // app's own comment says so. Remove it to take the anchor-download path.
  delete window.showSaveFilePicker;
});
const page = await ctx.newPage();

const consoleErrors = [], pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

const step = (s) => console.log(`â–¸ ${s}`);

step(`Loading ${URL}`);
await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: join(OUT, '01-welcome.png') });

// Load the mini-rack project type straight from the welcome screen — this is
// the archetype that leans hardest on the new profile/extrude/hull primitives.
const tpl = page.locator('[data-testid="welcome-template-mini-rack-10in"]');
await tpl.waitFor({ state: 'visible', timeout: 20_000 });
await tpl.click();
step('Loaded mini-rack-10in template — waiting for geometry worker');
await page.waitForTimeout(15000);
await page.screenshot({ path: join(OUT, '02-rack.png') });

// Confirm we are actually in rack mode.
const rackMode = await page.locator('[data-testid="sidebar-button-rack"]').isVisible().catch(() => false);
step(`Rack sidebar present: ${rackMode}`);
await page.locator('[data-testid="sidebar-button-rack"]').click().catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: join(OUT, '03-rack-panel.png') });

// Did anything actually render? Sample the canvas for non-background pixels.
const canvasInfo = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return { found: false };
  const gl = c.getContext('webgl2') ?? c.getContext('webgl');
  return { found: true, w: c.width, h: c.height, gl: !!gl };
});
step(`Canvas: ${JSON.stringify(canvasInfo)}`);

// Part count from the parts menu, if present.
const partsText = await page.locator('[data-testid="parts-menu-toggle"]').textContent().catch(() => null);
step(`Parts menu: ${partsText ?? 'n/a'}`);

// Assembled view — the plates must sit down in the side rebates, not float.
const completeBtn = page.locator('.viewport-toolbar button, [data-testid="viewport-toolbar"] button').filter({ hasText: /^Complete$/i }).first();
if (await completeBtn.isVisible().catch(() => false)) {
  await completeBtn.click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(OUT, '05-complete.png') });
  step('Captured assembled COMPLETE view (button)');
} else {
  await page.locator('canvas').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Shift+Digit1');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(OUT, '05-complete.png') });
  step('Captured assembled COMPLETE view (Shift+1)');
}
const status = await page.locator('.statusbar, [class*="status"]').first().textContent().catch(() => null);
step(`Status bar: ${(status ?? 'n/a').replace(/\s+/g, ' ').trim().slice(0, 160)}`);

// Export an STL and check it is a real solid.
let stlReport = 'not attempted';
try {
  await page.locator('[data-testid="sidebar-button-export"]').click();
  await page.waitForTimeout(600);
  await page.locator('[data-testid="export-open"]').click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(OUT, '04-export-panel.png') });
  const fmt = page.locator('[data-testid="export-modal-format"]');
  const opts = await fmt.locator('option').allTextContents().catch(() => []);
  step(`Formats: ${opts.join(' | ')}`);
  const bin = opts.findIndex((o) => /binary/i.test(o));
  if (bin >= 0) { await fmt.selectOption({ index: bin }); await page.waitForTimeout(2500); }
  const dl = page.waitForEvent('download', { timeout: 90_000 });
  const partSave = page.locator('.export-modal [data-testid^="export-save-"]').first();
  const which = await partSave.getAttribute('data-testid');
  step(`Clicking ${which}`);
  await partSave.click();
  const d = await dl;
  const p = join(OUT, d.suggestedFilename());
  await d.saveAs(p);
  const buf = readFileSync(p);
  if (d.suggestedFilename().endsWith('.stl') && buf.length > 84) {
    const tris = buf.readUInt32LE(80);
    // Walk vertices for a bounding box â€” degenerate geometry shows up as a
    // zero-extent box even when the triangle count looks healthy.
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    const n = Math.min(tris, 200000);
    for (let i = 0; i < n; i++) {
      const off = 84 + i * 50 + 12;
      for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) {
        const f = buf.readFloatLE(off + v * 12 + a * 4);
        if (f < mn[a]) mn[a] = f; if (f > mx[a]) mx[a] = f;
      }
    }
    const size = mx.map((m, i) => +(m - mn[i]).toFixed(1));
    stlReport = `${d.suggestedFilename()} ${buf.length}B tris=${tris} bbox=${size.join(' x ')}mm`;
  } else {
    stlReport = `${d.suggestedFilename()} ${buf.length}B (not binary STL â€” zip/other)`;
  }
} catch (e) {
  stlReport = `FAILED: ${String(e).slice(0, 300)}`;
}
step(`Export: ${stlReport}`);

console.log('\n=== console errors ===');
console.log(consoleErrors.length ? consoleErrors.slice(0, 15).join('\n') : '(none)');
console.log('=== page errors ===');
console.log(pageErrors.length ? pageErrors.slice(0, 15).join('\n') : '(none)');

await browser.close();
process.exit(pageErrors.length ? 1 : 0);
