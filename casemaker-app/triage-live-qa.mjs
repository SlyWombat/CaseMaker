// One-shot visual QA against the live deploy at electricrv.ca/casemaker.
// Loads the page headless, captures console errors, and screenshots the
// welcome screen + main viewport. Run from casemaker-app/:
//   node triage-live-qa.mjs
// Outputs PNGs into ./triage-live-qa-out/.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'https://electricrv.ca/casemaker/';
const BOARD_ID = process.env.CASEMAKER_BOARD ?? 'arduino-giga-r1-wifi';
const OUT = './triage-live-qa-out';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err)));

console.log(`▸ Loading ${URL}`);
await page.goto(URL, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForTimeout(2000);

await page.screenshot({ path: join(OUT, '01-landing.png'), fullPage: false });
console.log('▸ Captured 01-landing.png');

const welcomeVisible = await page
  .locator('[data-testid="welcome-modal"], [class*="welcome"]')
  .first()
  .isVisible()
  .catch(() => false);
console.log(`▸ Welcome screen visible: ${welcomeVisible}`);

// Pick the Arduino Giga board, dismiss into the workspace, then add the
// DMX shield to confirm the live-print fixes render without errors.
const boardSelect = page.locator('[data-testid="welcome-board-select"]');
if (await boardSelect.isVisible().catch(() => false)) {
  await boardSelect.selectOption(BOARD_ID);
  await page.locator('[data-testid="welcome-board-go"]').click();
  await page.waitForTimeout(2000);
  console.log(`▸ Selected ${BOARD_ID} board, dismissed welcome`);
}

await page.screenshot({ path: join(OUT, '02-after-dismiss.png'), fullPage: false });

const canvas = page.locator('[data-testid="viewport-canvas"], canvas').first();
const canvasVisible = await canvas.isVisible().catch(() => false);
console.log(`▸ Viewport canvas visible: ${canvasVisible}`);

// Read deploy version stamp if present
const version = await page
  .evaluate(() => {
    const el = document.querySelector('[data-testid="version-stamp"], [class*="version"]');
    return el ? el.textContent : null;
  })
  .catch(() => null);
console.log(`▸ Version stamp: ${version}`);

await page.screenshot({ path: join(OUT, '03-final.png'), fullPage: false });

// Open Case parameters and switch to screw-down to see if the locator
// stub hint surfaces as expected for the default 3.2mm-mount-hole giga.
const caseBtn = page.locator('button:has-text("Case parameters"), button:has-text("Case Parameters")').first();
if (await caseBtn.isVisible().catch(() => false)) {
  await caseBtn.click();
  await page.waitForTimeout(500);
  // Pick the Screw-down joint to expose the boss insert + locator hint.
  const screwBtn = page.locator('input[name="case-joint"][value="screw-down"], input[type="radio"][value="screw-down"]').first();
  if (await screwBtn.isVisible().catch(() => false)) {
    await screwBtn.click();
    await page.waitForTimeout(800);
  }
  const hint = page.locator('[data-testid="locator-stub-hint"]');
  if (await hint.isVisible().catch(() => false)) {
    const text = await hint.textContent();
    console.log(`▸ Locator stub hint: ${text}`);
  } else {
    console.log('▸ Locator stub hint: not visible');
  }
  await page.screenshot({ path: join(OUT, '04-case-panel.png'), fullPage: false });
}

console.log('---');
console.log(`Console errors (${consoleErrors.length}):`);
for (const e of consoleErrors) console.log(`  • ${e}`);
console.log(`Page errors (${pageErrors.length}):`);
for (const e of pageErrors) console.log(`  • ${e}`);
console.log('---');
console.log(`Screenshots in ${OUT}/`);

await browser.close();
