// Issue #134 — measure EVERY section panel at phone width.
// The maintainer's open item: "the panels at phone width remain unmeasured —
// they belonged to other slots in batch 7 and are free now."
//
// For each sidebar section: open the drawer, tap the section, then report
//   - the context-panel box,
//   - panel scrollWidth - clientWidth (horizontal overflow of the scroller),
//   - every descendant whose right edge pokes past the panel's right edge
//     (clipped controls), and every element with scrollW > clientW.
// Screenshots land in ./qa-134-out/.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = './qa-134-out';
mkdirSync(OUT, { recursive: true });
const URL = process.env.QA_URL ?? 'http://127.0.0.1:5199/';
const W = Number(process.env.QA_W ?? 390);
const H = Number(process.env.QA_H ?? 844);
const TAG = process.env.QA_TAG ?? 'phone';

const SECTIONS = ['board', 'case', 'ports', 'hats', 'features', 'assets', 'export'];

const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
  isMobile: W < 900,
  hasTouch: W < 900,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(600);

// --- enter the workspace off a real board -----------------------------------
await page.getByTestId('welcome-search').fill('sht31');
await page.getByTestId('welcome-board-adafruit-sht31d').click();
await page.getByTestId('welcome-generate').click();
await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
await page.evaluate(async () => { await window.__caseMaker?.waitForIdle?.(); });
await page.waitForTimeout(600);

/** Horizontal overflow + clipped controls inside the context panel. */
const probe = () => page.evaluate(() => {
  const panel = document.querySelector('[data-testid="context-panel"]');
  if (!panel) return { missing: true };
  const pr = panel.getBoundingClientRect();
  const bad = [];
  for (const el of panel.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const overRight = r.right - pr.right;
    const own = el.scrollWidth - el.clientWidth;
    if (overRight > 1 || own > 1) {
      bad.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 40)) || '',
        testid: el.getAttribute('data-testid') || '',
        text: (el.textContent || '').trim().slice(0, 24),
        overRight: +overRight.toFixed(1),
        scrollOver: own,
        w: +r.width.toFixed(1),
      });
    }
  }
  // Deduplicate near-identical rows (wrapper + child both flagged).
  const seen = new Set();
  const uniq = bad.filter((x) => {
    const k = `${x.tag}|${x.cls}|${x.overRight}|${x.scrollOver}|${x.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    panel: { x: +pr.x.toFixed(1), w: +pr.width.toFixed(1), h: +pr.height.toFixed(1) },
    scrollOver: panel.scrollWidth - panel.clientWidth,
    issues: uniq.slice(0, 25),
    total: uniq.length,
  };
});

const report = {};
// State on entry: is the context drawer already covering the whole phone?
report.__entry = await page.evaluate(() => {
  const p = document.querySelector('[data-testid="context-panel"]');
  const v = document.querySelector('.viewport-pane');
  const r = p?.getBoundingClientRect();
  return {
    panelClass: p?.className,
    panelW: r ? +r.width.toFixed(1) : null,
    panelX: r ? +r.x.toFixed(1) : null,
    viewportVisibleW: v ? +v.getBoundingClientRect().width.toFixed(1) : null,
  };
});

// At phone width the open context drawer is width:100% and covers the rail
// handle, and both handles are translated off-screen when closed — so drive
// the toggles with DOM clicks instead of Playwright's actionability click.
const domClick = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  el.click();
  return true;
}, sel);

for (const id of SECTIONS) {
  await domClick('.context-panel__close');           // put the editor away
  await page.waitForTimeout(400);
  const sideX = (await page.getByTestId('sidebar').boundingBox())?.x ?? -1;
  if (sideX < 0) { await domClick('[data-testid="sidebar-handle"]'); await page.waitForTimeout(400); }
  await domClick(`[data-testid="sidebar-button-${id}"]`);
  await page.waitForTimeout(700);
  const r = await probe();
  report[id] = r;
  await page.screenshot({ path: `${OUT}/${TAG}-panel-${id}.png`, fullPage: false });
  // Scroll the panel to the bottom and re-probe (tables/clip further down).
  await page.evaluate(() => {
    const p = document.querySelector('[data-testid="context-panel"]');
    if (p) p.scrollTop = p.scrollHeight;
  });
  await page.waitForTimeout(250);
  const r2 = await probe();
  report[id].bottom = { scrollOver: r2.scrollOver, total: r2.total, issues: r2.issues.slice(0, 10) };
  await page.screenshot({ path: `${OUT}/${TAG}-panel-${id}-bottom.png`, fullPage: false });
  await page.evaluate(() => {
    const p = document.querySelector('[data-testid="context-panel"]');
    if (p) p.scrollTop = 0;
  });
}

console.log(JSON.stringify(report, null, 1));
console.log('ERRORS', JSON.stringify(errs.slice(0, 20), null, 1));
await b.close();
