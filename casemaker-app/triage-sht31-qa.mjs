// QA the new adafruit-sht31d board + sht31-sensor-pod template.
// Checks: board appears in pick-a-board select, template button renders a case
// with no console/page errors, geometry screenshots from several angles.
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:5199/';
const OUT_DIR = process.env.OUT_DIR || resolve(__dirname, 'local-docs');
fs.mkdirSync(OUT_DIR, { recursive: true });
const shot = (name) => resolve(OUT_DIR, `sht31-qa-${name}.png`);

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('dialog', (d) => d.accept().catch(() => {}));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('worker', (w) =>
  w.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push('[worker] ' + m.text());
  }),
);

await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-testid="welcome-overlay"]', { timeout: 30000 });

// 1. Board present in the pick-a-board select?
const boardOptions = await page.$$eval('[data-testid="welcome-board-select"] option', (os) =>
  os.map((o) => o.value),
);
const boardListed = boardOptions.includes('adafruit-sht31d');
console.log('board in pick-a-board select:', boardListed);

// 2. Pick-a-board flow: select the SHT31 and Go — should apply the template.
await page.selectOption('[data-testid="welcome-board-select"]', 'adafruit-sht31d');
await page.click('[data-testid="welcome-board-go"]');
const waitIdle = () =>
  page.waitForFunction(
    () => {
      const bar = document.querySelector('[data-testid="status-bar"]');
      const ds = bar && bar.getAttribute('data-status');
      return ds === 'idle' || ds === 'error' || ds === 'failed';
    },
    { timeout: 30000 },
  );
await waitIdle();
const statusAttr = await page.$eval('[data-testid="status-bar"]', (b) => b.getAttribute('data-status'));
const statusText = await page.$eval('[data-testid="status-bar"]', (b) => b.textContent);
console.log('pick-a-board status:', statusAttr);
console.log('status bar:', statusText.trim().replace(/\s+/g, ' '));
await page.screenshot({ path: shot('01-pick-a-board') });

// 3. Geometry views.
const clickToolbar = async (testid) => {
  const btn = await page.$(`[data-testid="${testid}"]`);
  if (btn) {
    await btn.click();
    await page.waitForTimeout(700);
    return true;
  }
  console.log(`toolbar button not found: ${testid}`);
  return false;
};
const zoomIn = async (clicks = 8) => {
  await page.mouse.move(680, 460);
  for (let i = 0; i < clicks; i++) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);
};
if (await clickToolbar('viewport-camera-top')) {
  await zoomIn();
  await page.screenshot({ path: shot('02-top') });
}
if (await clickToolbar('viewport-camera-side')) {
  await zoomIn();
  await page.screenshot({ path: shot('03-side') });
}
if (await clickToolbar('viewport-camera-front')) {
  await zoomIn();
  await page.screenshot({ path: shot('04-front') });
}
await clickToolbar('viewport-camera-perspective');
if (await clickToolbar('viewport-view-exploded')) {
  await zoomIn();
  await page.screenshot({ path: shot('05-exploded') });
}
if (await clickToolbar('viewport-view-base-only')) {
  await zoomIn(4);
  await page.screenshot({ path: shot('06-base-only') });
}
if (await clickToolbar('viewport-view-lid-only')) {
  await page.screenshot({ path: shot('07-lid-only') });
}

// Loose-shell detector: the floaters banner must be absent.
const floaters = await page.$('[data-testid="floaters-banner"]');
console.log('floaters banner present:', !!floaters);
if (floaters) console.log('floaters text:', await floaters.textContent());

console.log('console errors:', JSON.stringify(consoleErrors, null, 2));
console.log('page errors:', JSON.stringify(pageErrors, null, 2));
await browser.close();
