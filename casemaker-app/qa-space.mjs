import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('./qa-space-out', { recursive: true });
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(process.env.QA_URL ?? 'http://localhost:4184/', { waitUntil: 'networkidle', timeout: 60000 });
await page.locator('[data-testid="welcome-template-mini-rack-10in"]').click();
await page.waitForTimeout(15000);
await page.locator('[data-testid="sidebar-button-rack"]').click();
await page.waitForTimeout(1200);
for (let i = 0; i < 5; i++) {
  const el = page.locator(`[data-testid="rack-accessory-space-${i}"]`);
  if (await el.count()) {
    await el.first().scrollIntoViewIfNeeded();
    console.log(`  acc ${i}: ${(await el.first().textContent())?.replace(/\s+/g, ' ').trim().slice(0, 90)}`);
  } else {
    console.log(`  acc ${i}: (no readout — faceplate)`);
  }
}
await page.locator('[data-testid="rack-accessory-2"]').scrollIntoViewIfNeeded();
await page.screenshot({ path: './qa-space-out/panel.png' });
console.log(`page errors: ${errs.length ? errs.join(' | ') : '(none)'}`);
await b.close();
