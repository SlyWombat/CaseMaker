// #134 — at which width does the full toolbar fit WITHOUT squeezing a label?
// A button whose scrollWidth exceeds its clientWidth is truncating or wrapping
// its text, which is what the 768 px screenshot shows ("Save as" clipped).
import { chromium } from 'playwright';

const URL = process.env.QA_URL ?? 'http://127.0.0.1:5199/';
const b = await chromium.launch();

for (const W of [820, 840, 848, 860, 880, 900, 940, 1024]) {
  const ctx = await b.newContext({ viewport: { width: W, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(350);
  const r = await page.evaluate(() => {
    const h = document.querySelector('.app-header');
    const btn = (el) => {
      const inner = el.querySelector('span, .toolbar-btn__label') || el;
      return {
        id: el.getAttribute('data-testid') || (el.textContent || '').trim().slice(0, 10),
        w: +el.getBoundingClientRect().width.toFixed(1),
        h: +el.getBoundingClientRect().height.toFixed(1),
        clippedX: el.scrollWidth - el.clientWidth,
        clippedY: el.scrollHeight - el.clientHeight,
        labelW: +inner.getBoundingClientRect().width.toFixed(1),
        labelClipped: inner.scrollWidth - inner.clientWidth,
      };
    };
    const kids = [...h.querySelectorAll('button, .parts-menu-wrap, .toolbar-settings-wrap')].map(btn);
    return {
      overflow: h.scrollWidth - h.clientWidth,
      tall: kids.filter((k) => k.h > 48).map((k) => k.id),
      clipped: kids.filter((k) => k.clippedX > 0 || k.clippedY > 0 || k.labelClipped > 0)
        .map((k) => `${k.id}(x${k.clippedX},y${k.clippedY},lbl${k.labelClipped})`),
      maxH: Math.max(...kids.map((k) => k.h)),
    };
  });
  console.log(W, JSON.stringify(r));
  await ctx.close();
}
await b.close();
