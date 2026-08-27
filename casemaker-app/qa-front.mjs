import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = './qa-front-out'; mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
await page.goto(process.env.QA_URL ?? 'https://electricrv.ca/casemaker/', { waitUntil: 'networkidle', timeout: 60000 });
await page.locator('[data-testid="welcome-template-mini-rack-10in"]').click();
await page.waitForTimeout(15000);
const tb = page.locator('.viewport-toolbar button, [data-testid="viewport-toolbar"] button');
await tb.filter({ hasText: /^Complete$/i }).first().click();
await page.waitForTimeout(3000);
for (const view of ['Front', 'Side', 'Top']) {
  await tb.filter({ hasText: new RegExp(`^${view}$`, 'i') }).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${view.toLowerCase()}.png` });
  console.log(`captured ${view}`);
}
// Zoom into the front-left screw column with the scroll wheel.
await tb.filter({ hasText: /^Front$/i }).first().click();
await page.waitForTimeout(2000);
const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
await page.mouse.move(box.x + box.width * 0.36, box.y + box.height * 0.5);
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(250); }
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/front-zoom.png` });
console.log('captured front-zoom');
await b.close();
