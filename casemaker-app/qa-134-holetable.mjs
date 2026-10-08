// #134 — the mounting-hole table at phone width: is the X input actually
// clipping its value, and do the candidate CSS fixes resolve it without
// breaking the desktop rail? Measures real text widths, then re-measures with
// each candidate rule injected.
import { chromium } from 'playwright';

const URL = process.env.QA_URL ?? 'http://127.0.0.1:5199/';
const W = Number(process.env.QA_W ?? 390);
const H = Number(process.env.QA_H ?? 844);

const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 2,
  isMobile: W < 900, hasTouch: W < 900,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.getByTestId('welcome-search').fill('sht31');
await page.getByTestId('welcome-board-adafruit-sht31d').click();
await page.getByTestId('welcome-generate').click();
await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
await page.evaluate(async () => { await window.__caseMaker?.waitForIdle?.(); });
await page.waitForTimeout(500);

// Open the Board panel.
const domClick = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); }, sel);
await domClick('[data-testid="sidebar-handle"]');
await page.waitForTimeout(400);
await domClick('[data-testid="sidebar-button-board"]');
await page.waitForTimeout(700);

const measure = () => page.evaluate(() => {
  const canvas = document.createElement('canvas');
  const c = canvas.getContext('2d');
  const rows = [...document.querySelectorAll('.hole-table tbody tr')].map((tr) => {
    const inputs = [...tr.querySelectorAll('input')];
    return {
      name: tr.querySelector('.cell-label__row')?.textContent,
      cells: [...tr.querySelectorAll('td')].map((td) => +td.getBoundingClientRect().width.toFixed(1)),
      inputs: inputs.map((i) => {
        const cs = getComputedStyle(i);
        c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const needed = c.measureText(i.value || '').width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2;
        return { v: i.value, boxW: +i.getBoundingClientRect().width.toFixed(1), needed: +needed.toFixed(1), clipped: needed > i.getBoundingClientRect().width + 0.5 };
      }),
    };
  });
  const t = document.querySelector('.hole-table');
  const panel = document.querySelector('[data-testid="context-panel"]');
  return { rows, table: { w: +t.getBoundingClientRect().width.toFixed(1), scrollW: t.scrollWidth }, panelOverflow: panel.scrollWidth - panel.clientWidth };
});

console.log('BEFORE', JSON.stringify(await measure(), null, 1));

const CANDIDATES = {
  A_rowOnOwnLine: `.hole-table .cell-label { flex-wrap: wrap; } .hole-table .cell-label__row { flex-basis: 100%; margin-right: 0; }`,
  B_minInput: `.hole-table .cell-label > input { min-width: 52px; }`,
  C_fixedLayout: `.hole-table { table-layout: fixed; } .hole-table th:nth-child(1), .hole-table td:nth-child(1) { width: 46%; } .hole-table th:nth-child(2), .hole-table td:nth-child(2), .hole-table th:nth-child(3), .hole-table td:nth-child(3) { width: 22%; } .hole-table th:nth-child(4), .hole-table td:nth-child(4) { width: 10%; }`,
  D_widthsOnly: `.hole-table .cell-label { flex-wrap: wrap; } .hole-table .cell-label__row { flex-basis: 100%; }`,
};

const openPanel = async () => {
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.getByTestId('welcome-search').fill('sht31');
  await page.getByTestId('welcome-board-adafruit-sht31d').click();
  await page.getByTestId('welcome-generate').click();
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
  await page.evaluate(async () => { await window.__caseMaker?.waitForIdle?.(); });
  await page.waitForTimeout(400);
  await domClick('[data-testid="sidebar-handle"]');
  await page.waitForTimeout(300);
  await domClick('[data-testid="sidebar-button-board"]');
  await page.waitForTimeout(600);
};

console.log('BEFORE', JSON.stringify(await measure(), null, 1));

for (const [name, css] of Object.entries(CANDIDATES)) {
  await openPanel();
  await page.addStyleTag({ content: `@media (max-width: 640px) { ${css} }` });
  await page.waitForTimeout(200);
  console.log(`\nAFTER ${name}`, JSON.stringify(await measure(), null, 1));
  await page.screenshot({ path: `./qa-134-out/phone-holetable-${name}.png` });
}

await b.close();
