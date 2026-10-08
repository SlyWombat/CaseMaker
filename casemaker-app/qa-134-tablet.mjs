// #134 — the tablet band (641–900 px) the phone pass did not cover.
// The maintainer's finding: "the toolbar is 814 px of content in an 800 px
// scroller" and the settings popover is clipped by the header box. Measures
// the header across the band and checks whether each header popover escapes
// the header's box.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = './qa-134-out';
mkdirSync(OUT, { recursive: true });
const URL = process.env.QA_URL ?? 'http://127.0.0.1:5199/';
const WIDTHS = [641, 700, 768, 820, 848, 900, 1024];

const b = await chromium.launch();
const report = {};

for (const W of WIDTHS) {
  const ctx = await b.newContext({ viewport: { width: W, height: 900 }, deviceScaleFactor: 1, hasTouch: W < 900 });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(400);

  const header = await page.evaluate(() => {
    const h = document.querySelector('.app-header');
    const hr = h.getBoundingClientRect();
    const kids = [...h.querySelectorAll('button, select, a')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.getAttribute('data-testid') || (el.textContent || '').trim().slice(0, 14),
        x: +r.x.toFixed(0), right: +r.right.toFixed(0), visible: r.right <= hr.right + 0.5 && r.x >= hr.x - 0.5,
      };
    });
    return {
      clientW: h.clientWidth, scrollW: h.scrollWidth,
      overflow: h.scrollWidth - h.clientWidth,
      hidden: kids.filter((k) => !k.visible).map((k) => k.id),
      first: kids.length ? kids[0] : null, last: kids.length ? kids[kids.length - 1] : null,
    };
  });

  // Popovers: do they escape the header's box (a scroll container clips them)?
  const popovers = {};
  for (const [name, toggle, panel] of [
    ['parts', '[data-testid="parts-menu-toggle"]', '.parts-menu-panel'],
    ['settings', '[data-testid="settings-open"]', '[data-testid="settings-menu"]'],
  ]) {
    const t = page.locator(toggle);
    if (!(await t.count())) { popovers[name] = { skipped: 'no toggle' }; continue; }
    await page.evaluate((s) => document.querySelector(s)?.click(), toggle);
    await page.waitForTimeout(350);
    popovers[name] = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return { missing: true };
      const r = el.getBoundingClientRect();
      const h = document.querySelector('.app-header').getBoundingClientRect();
      return {
        x: +r.x.toFixed(0), right: +r.right.toFixed(0), w: +r.width.toFixed(0), h: +r.height.toFixed(0),
        inWindow: r.x >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5,
        boxH: +r.height.toFixed(0),
        clippedByHeaderBox: r.height > 0 && h.height < 60 && r.top >= h.top - 1 && r.bottom > h.bottom + 1 ? 'below header bottom' : false,
      };
    }, panel);
    await page.evaluate((s) => document.querySelector(s)?.click(), toggle);
    await page.waitForTimeout(200);
  }

  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  report[W] = { header, popovers, pageOverflow };
  await page.screenshot({ path: `${OUT}/tablet-${W}.png` });
  await ctx.close();
}

console.log(JSON.stringify(report, null, 1));
await b.close();
