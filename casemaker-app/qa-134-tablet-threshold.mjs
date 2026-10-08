// #134 — what SHOULD the tablet breakpoint be? Measures the header's content
// width with and without the wordmark, so the collapse threshold is a measured
// number rather than a guess.
import { chromium } from 'playwright';

const URL = process.env.QA_URL ?? 'http://127.0.0.1:5199/';
const W = 1400; // wide enough that nothing collapses

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: W, height: 900 } });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(500);

const wide = await page.evaluate(() => {
  const h = document.querySelector('.app-header');
  const logo = document.querySelector('.app-header__logo');
  const toolbar = h.querySelector('.toolbar') || h.querySelector('.toolbar-buttons') || h.lastElementChild;
  const box = (el) => el ? +el.getBoundingClientRect().width.toFixed(1) : null;
  const scrollOf = (el) => el ? el.scrollWidth : null;
  // Measure the toolbar's own row at its natural size.
  const kids = toolbar ? [...toolbar.children].map((c) => ({
    id: c.getAttribute('data-testid') || (c.className || '').toString().slice(0, 24),
    w: +c.getBoundingClientRect().width.toFixed(1),
  })) : [];
  return {
    headerScrollW: h.scrollWidth,
    logoW: box(logo),
    toolbarTag: toolbar?.className,
    toolbarW: box(toolbar),
    toolbarScrollW: scrollOf(toolbar),
    headerPadding: getComputedStyle(h).paddingLeft,
    kids,
    sum: +kids.reduce((a, k) => a + k.w, 0).toFixed(1),
  };
});
console.log(JSON.stringify(wide, null, 1));

// Now with the wordmark hidden: how wide does the header want to be?
await page.addStyleTag({ content: '.app-header__logo{display:none!important}' });
await page.waitForTimeout(200);
console.log('NO LOGO', JSON.stringify(await page.evaluate(() => {
  const h = document.querySelector('.app-header');
  return { headerScrollW: h.scrollWidth, clientW: h.clientWidth };
})));
await b.close();
