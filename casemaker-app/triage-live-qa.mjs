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

  // Enable ventilation and switch to chevron — confirms the new pattern
  // wires through compile and renders without errors.
  const ventToggle = page.locator('[data-testid="ventilation-toggle"]');
  if (await ventToggle.isVisible().catch(() => false)) {
    if (!(await ventToggle.isChecked().catch(() => true))) {
      await ventToggle.check();
      await page.waitForTimeout(800);
    }
    const chevron = page.locator('[data-testid="vent-pattern-chevron"]');
    if (await chevron.isVisible().catch(() => false)) {
      await chevron.click();
      await page.waitForTimeout(800);
      console.log('▸ Chevron pattern selected');
      // Switch to the TOP surface (lid) — visible from the default camera
      // angle, so we can confirm cuts actually emit. Uncheck back, check top.
      const top = page.locator('[data-testid="vent-surface-top"]');
      const back = page.locator('[data-testid="vent-surface-back"]');
      if (await back.isChecked().catch(() => false)) await back.uncheck();
      if (!(await top.isChecked().catch(() => true))) await top.check();
      // Max out coverage so cuts are unambiguously visible.
      const coverage = page.locator('[data-testid="vent-coverage"]');
      if (await coverage.isVisible().catch(() => false)) {
        await coverage.evaluate((el) => {
          const input = el;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, '1');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
      await page.waitForTimeout(2000);
      console.log('▸ Vent surface=top, coverage=1 — looking for chevron cuts on lid');
      await page.screenshot({ path: join(OUT, '05-chevron-on-lid.png'), fullPage: false });
      // Also rotate the camera up a bit so we look down at the lid.
      // The viewport listens for orbit drag on the canvas.
      const canv = page.locator('[data-testid="viewport-canvas"], canvas').first();
      const box = await canv.boundingBox();
      if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down({ button: 'left' });
        await page.mouse.move(cx, cy - 200, { steps: 20 });
        await page.mouse.up({ button: 'left' });
        await page.waitForTimeout(500);
      }
      await page.screenshot({ path: join(OUT, '06-chevron-from-above.png'), fullPage: false });
      // Switch the viewport camera to TOP — flatten and look straight down
      // at the lid where the chevron cuts should be unambiguous.
      const topView = page.locator('button:has-text("TOP")').first();
      if (await topView.isVisible().catch(() => false)) {
        await topView.click();
        await page.waitForTimeout(800);
      }
      await page.screenshot({ path: join(OUT, '07-chevron-top-view.png'), fullPage: false });
    } else {
      console.log('▸ Chevron radio not found (deploy may not include chevron yet)');
    }
  }
}

console.log('---');
console.log(`Console errors (${consoleErrors.length}):`);
for (const e of consoleErrors) console.log(`  • ${e}`);
console.log(`Page errors (${pageErrors.length}):`);
for (const e of pageErrors) console.log(`  • ${e}`);
console.log('---');
console.log(`Screenshots in ${OUT}/`);

await browser.close();
