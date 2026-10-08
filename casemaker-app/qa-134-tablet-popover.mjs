// #134 — does the header's 641–900 px scroll container clip its popovers?
// Sits at the widths the maintainer called out and photographs each popover
// with the header's own box drawn on top of the measurement.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = './qa-134-out';
mkdirSync(OUT, { recursive: true });
const URL = process.env.QA_URL ?? 'http://127.0.0.1:5199/';

const b = await chromium.launch();
for (const W of [641, 700, 768, 820]) {
  const ctx = await b.newContext({ viewport: { width: W, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(400);

  const before = await page.evaluate(() => {
    const h = document.querySelector('.app-header');
    const cs = getComputedStyle(h);
    return { overflowX: cs.overflowX, overflowY: cs.overflowY, clientH: h.clientHeight, scrollH: h.scrollHeight, clientW: h.clientWidth, scrollW: h.scrollWidth };
  });

  await page.evaluate(() => document.querySelector('[data-testid="settings-open"]')?.click());
  await page.waitForTimeout(400);
  const withSettings = await page.evaluate(() => {
    const h = document.querySelector('.app-header');
    const p = document.querySelector('[data-testid="settings-menu"]');
    const hr = h.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    return {
      header: { clientH: h.clientHeight, scrollH: h.scrollHeight, scrollTop: h.scrollTop },
      popover: { top: +pr.top.toFixed(0), bottom: +pr.bottom.toFixed(0), left: +pr.left.toFixed(0), right: +pr.right.toFixed(0), h: +pr.height.toFixed(0) },
      headerBottom: +hr.bottom.toFixed(0),
      // How much of the popover lies below the header's own box.
      belowHeaderBox: +Math.max(0, pr.bottom - hr.bottom).toFixed(0),
    };
  });
  await page.screenshot({ path: `${OUT}/tablet-${W}-settings-open.png` });
  console.log(W, 'before', JSON.stringify(before));
  console.log(W, 'settings', JSON.stringify(withSettings));
  await ctx.close();
}
await b.close();
