import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = './qa-rear-out'; mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
await page.goto(process.env.QA_URL ?? 'https://electricrv.ca/casemaker/', { waitUntil: 'networkidle', timeout: 60000 });
await page.locator('[data-testid="welcome-template-mini-rack-10in"]').click();
await page.waitForTimeout(15000);
await page.locator('[data-testid="sidebar-button-rack"]').click();
await page.waitForTimeout(800);
// Set the first shelf (accessory 3) to full depth.
const sel = page.locator('select[aria-label="Accessory 3 shelf depth"]');
await sel.scrollIntoViewIfNeeded();
await sel.selectOption('full');
console.log('set accessory 3 to full depth');
await page.waitForTimeout(12000);
const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
// Assembled, then orbit round to look along the LEFT side panel from outside,
// near its rear — the angle in the report.
const tb = page.locator('.viewport-toolbar button, [data-testid="viewport-toolbar"] button');
await tb.filter({ hasText: /^Complete$/i }).first().click();
await page.waitForTimeout(3000);
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 0; i < 22; i++) { await page.mouse.move(cx - i * 12, cy + i * 1.2); await page.waitForTimeout(25); }
await page.mouse.up();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/side.png` });
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(200); }
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/side-zoom.png` });
console.log('captured rear + rear-zoom');
await b.close();
