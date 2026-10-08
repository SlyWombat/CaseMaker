import { chromium } from 'playwright';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle' });
await page.getByTestId('welcome-search').fill('sht31');
await page.getByTestId('welcome-board-adafruit-sht31d').click();
await page.getByTestId('welcome-generate').click();
await page.waitForSelector('[data-testid="sidebar"]');
await page.evaluate(async () => { await window.__caseMaker?.waitForIdle?.(); });
await page.evaluate(() => document.querySelector('[data-testid="sidebar-handle"]')?.click());
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('[data-testid="sidebar-button-case"]')?.click());
await page.waitForTimeout(600);
console.log(JSON.stringify(await page.evaluate(() => {
  const row = document.querySelector('.case-params-panel .slider-row, .panel .slider-row');
  const cs = getComputedStyle(row);
  return {
    row: { clientW: row.clientWidth, scrollW: row.scrollWidth, display: cs.display, gap: cs.gap, padding: cs.padding, boxSizing: cs.boxSizing },
    kids: [...row.children].map((c) => {
      const r = c.getBoundingClientRect();
      const k = getComputedStyle(c);
      return { tag: c.tagName.toLowerCase(), cls: c.className, x: +r.x.toFixed(1), w: +r.width.toFixed(1), clientW: c.clientWidth, scrollW: c.scrollWidth, pos: k.position, ml: k.marginLeft, mr: k.marginRight };
    }),
  };
}), null, 1));
await b.close();
