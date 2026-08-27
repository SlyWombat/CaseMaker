// Verifies the showSaveFilePicker branch of exportTrigger.ts on production —
// the path real Chrome/Edge users take, which the anchor-fallback QA skipped.
// Stubs the picker to record its args then reject with AbortError (the code
// treats that as "user cancelled" and must return cleanly).
import { chromium } from 'playwright';

const URL = process.env.QA_URL ?? 'https://electricrv.ca/casemaker/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });

await ctx.addInitScript(() => {
  window.__pickerCalls = [];
  window.showSaveFilePicker = (opts) => {
    window.__pickerCalls.push(opts);
    return Promise.reject(new DOMException('cancelled', 'AbortError'));
  };
});

const page = await ctx.newPage();
const consoleErrors = [], pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });
await page.locator('[data-testid="welcome-template-mini-rack-10in"]').click();
await page.waitForTimeout(15000);
await page.locator('[data-testid="sidebar-button-export"]').click();
await page.waitForTimeout(600);
await page.locator('[data-testid="export-open"]').click();
await page.waitForTimeout(2500);

const btn = page.locator('.export-modal [data-testid^="export-save-"]').first();
const which = await btn.getAttribute('data-testid');
await btn.click();
await page.waitForTimeout(4000);

const calls = await page.evaluate(() => window.__pickerCalls);
console.log(`▸ Clicked ${which}`);
console.log(`▸ showSaveFilePicker invocations: ${calls.length}`);
console.log(`▸ args: ${JSON.stringify(calls[0] ?? null)}`);

// After an AbortError the UI must be usable again — the Save button must not
// be stuck in its busy state.
const label = await btn.textContent();
const disabled = await btn.isDisabled();
console.log(`▸ Button after cancel: label="${label?.trim()}" disabled=${disabled}`);

console.log(`▸ console errors: ${consoleErrors.length ? consoleErrors.slice(0,5).join(' | ') : '(none)'}`);
console.log(`▸ page errors: ${pageErrors.length ? pageErrors.slice(0,5).join(' | ') : '(none)'}`);

const ok = calls.length === 1 && !disabled && pageErrors.length === 0;
console.log(ok ? '\n✓ picker branch OK' : '\n✗ picker branch PROBLEM');
await browser.close();
process.exit(ok ? 0 : 1);
