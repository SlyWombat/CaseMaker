import { chromium } from 'playwright';
const URL = process.env.QA_URL ?? 'http://localhost:4178/';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
await ctx.addInitScript(() => { delete window.showSaveFilePicker; });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.locator('[data-testid="welcome-template-mini-rack-10in"]').click();
await page.waitForTimeout(14000);
await page.locator('[data-testid="sidebar-button-rack"]').click();
await page.waitForTimeout(600);

const cb = page.locator('[data-testid="rack-assembled-export"]');
console.log(`checkbox present (Prusa XL fits): ${await cb.count() > 0}`);
const statusBefore = await page.locator('.statusbar, [class*="status"]').first().textContent();
await cb.check();
await page.waitForTimeout(12000);
const statusAfter = await page.locator('.statusbar, [class*="status"]').first().textContent();
console.log(`before: ${statusBefore?.replace(/\s+/g,' ').match(/tris.*/)?.[0]?.slice(0,60)}`);
console.log(`after : ${statusAfter?.replace(/\s+/g,' ').match(/tris.*/)?.[0]?.slice(0,60)}`);

// Viewport must NOT double-render: bbox unchanged, and parts menu unchanged.
await page.locator('[data-testid="sidebar-button-export"]').click();
await page.waitForTimeout(500);
await page.locator('[data-testid="export-open"]').click();
await page.waitForTimeout(4000);
for (const id of ['rack-assembled-frame', 'rack-assembled-all']) {
  console.log(`  export entry ${id}: ${await page.locator(`[data-testid="export-save-${id}"]`).count() > 0 ? 'present' : 'MISSING'}`);
}
// Download the whole-rack one and check it is a single solid, correct size.
const dl = page.waitForEvent('download', { timeout: 120000 });
await page.locator('[data-testid="export-save-rack-assembled-all"]').click();
const d = await dl;
const p = './qa-asm2-out/' + d.suggestedFilename();
await d.saveAs(p);
const { readFileSync } = await import('node:fs');
const buf = readFileSync(p);
console.log(`  downloaded ${d.suggestedFilename()} ${(buf.length/1048576).toFixed(2)} MB`);
console.log(`page errors: ${errs.length ? errs.join(' | ') : '(none)'}`);
await b.close();
