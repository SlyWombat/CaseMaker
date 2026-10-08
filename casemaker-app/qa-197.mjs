// Issue #197 — visual sanity check of the CNC toolbar. Not a test; a one-shot look.
// Run from the Windows side (node_modules is the Windows install), with the dev server up.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

mkdirSync('./qa-197-out', { recursive: true });
const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(`console: ${m.text()}`);
});

const url = process.env.QA_URL ?? 'http://localhost:5199/';
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

// A case needs to exist before the sidebar appears.
const tpl = page.locator('[data-testid^="welcome-template-"]').first();
if (await tpl.count()) {
  await tpl.click();
  await page.waitForTimeout(9000);
}

const readToolbar = async () => {
  const t = page.locator('[data-testid="viewport-toolbar"]');
  const ids = await t.locator('[data-testid]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  return ids.join(', ');
};

console.log('CASE MODE toolbar:', await readToolbar());
await page.screenshot({ path: './qa-197-out/case-mode.png' });

const cnc = page.locator('[data-testid="sidebar-button-cnc-sim"]');
console.log('CNC sidebar button present:', (await cnc.count()) > 0);
if (await cnc.count()) {
  await cnc.click();
  await page.waitForTimeout(1500);
  console.log('CNC MODE toolbar:', await readToolbar());
  await page.screenshot({ path: './qa-197-out/cnc-mode.png' });
}
console.log(`page errors: ${errs.length ? errs.join(' | ') : '(none)'}`);
await b.close();
