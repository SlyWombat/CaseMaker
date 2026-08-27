// Reproduce the reported crash path: one-piece export on, then cycle every
// mounting option. Any duplicate-ArrayBuffer failure surfaces as a page error.
import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
await page.goto(process.env.QA_URL ?? 'http://localhost:4182/', { waitUntil: 'networkidle', timeout: 60000 });
await page.locator('[data-testid="welcome-template-mini-rack-10in"]').click();
await page.waitForTimeout(15000);
await page.locator('[data-testid="sidebar-button-rack"]').click();
await page.waitForTimeout(800);
// Widen to 294 like the report (bbox came out 350 with ears).
const w = page.locator('[data-testid="rack-width"]');
await w.fill('294'); await w.blur();
await page.waitForTimeout(8000);
const cb = page.locator('[data-testid="rack-assembled-export"]');
if (await cb.count()) { await cb.scrollIntoViewIfNeeded(); await cb.check(); await page.waitForTimeout(12000); console.log('one-piece export ON'); }
for (const mount of ['ears', 'cleat', 'keyhole', 'none']) {
  await page.locator('[data-testid="rack-wall-mount"]').selectOption(mount);
  await page.waitForTimeout(11000);
  const status = await page.locator('.statusbar, [class*="status"]').first().textContent();
  const m = status?.replace(/\s+/g, ' ').match(/tris: [\d]+.*?ms/);
  console.log(`  mount=${mount.padEnd(8)} ${m?.[0] ?? 'no status'}`);
}
console.log(`\npage/console errors: ${errs.length ? errs.slice(0, 3).join(' | ') : '(none)'}`);
await b.close();
process.exit(errs.length ? 1 : 0);
