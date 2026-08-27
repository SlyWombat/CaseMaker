import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = './qa-notch-out'; mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(process.env.QA_URL ?? 'http://localhost:4181/', { waitUntil: 'networkidle', timeout: 60000 });
await page.locator('[data-testid="welcome-template-mini-rack-10in"]').click();
await page.waitForTimeout(15000);
await page.locator('[data-testid="sidebar-button-rack"]').click();
await page.waitForTimeout(800);
const cb = page.locator('[data-testid="rack-notches-enable"]');
await cb.scrollIntoViewIfNeeded();
await cb.check();
await page.waitForTimeout(9000);
await page.locator('[data-testid="rack-notches-plate"]').selectOption('both');
await page.waitForTimeout(9000);
await page.locator('[data-testid="rack-notches-count"]').fill('3');
await page.locator('[data-testid="rack-notches-count"]').blur();
await page.waitForTimeout(9000);
console.log('notches: enabled, both plates, count 3');
// Orbit to see the rear underside.
const box = await page.locator('canvas').first().boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx, cy); await page.mouse.down();
for (let i = 0; i < 26; i++) { await page.mouse.move(cx + i * 13, cy - i * 2); await page.waitForTimeout(20); }
await page.mouse.up();
await page.waitForTimeout(2500);
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(200); }
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/notches.png` });
console.log(`page errors: ${errs.length ? errs.join(' | ') : '(none)'}`);
await b.close();
