// Bisect protective-case snap-fit floaters.
import { chromium } from 'playwright';
const TARGET_URL = process.env.TARGET_URL || 'https://electricrv.ca/casemaker/';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

async function gotoFresh() {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-testid="welcome-overlay"]', { timeout: 30000 });
}
async function waitIdle(timeout = 30000) {
  try {
    await page.waitForFunction(
      () => {
        const ds = document
          .querySelector('[data-testid="status-bar"]')
          ?.getAttribute('data-status');
        return ds === 'idle' || ds === 'error' || ds === 'failed';
      },
      { timeout },
    );
  } catch {}
  await page.waitForTimeout(500);
}
async function readFloaters() {
  return await page.evaluate(() => {
    const banner = document.querySelector('[data-testid="floaters-banner"]');
    if (!banner) return null;
    return Array.from(banner.querySelectorAll('li')).map((li) => {
      const code = li.querySelector('code')?.textContent || '';
      const m = li.textContent?.match(/has\s+(\d+)\s+disconnected/);
      return `${code}×${m ? m[1] : '?'}`;
    });
  });
}
async function openCaseSection() {
  const btn = await page.$('[data-testid="sidebar-button-case"]');
  if (btn) {
    const open = await page.$('[data-testid="ventilation-toggle"]');
    if (!open) {
      await btn.click();
      await page.waitForTimeout(200);
    }
  }
}
async function setJoint(value) {
  await openCaseSection();
  const r = await page.$(`[data-testid="joint-${value}"]`);
  if (!r) return false;
  const checked = await r.evaluate((el) => el.checked);
  if (!checked) await r.click();
  return true;
}
async function setHingeStyle(value) {
  await openCaseSection();
  const sel = await page.$('[data-testid="hinge-style-dropdown"]');
  if (!sel) return false;
  await sel.selectOption(value);
  return true;
}

await gotoFresh();
const tplBtn = await page.$('[data-testid="welcome-template-protective-case"]');
await tplBtn.click();
await waitIdle();
console.log('protective-case default:           ', await readFloaters());

await setJoint('snap-fit');
await waitIdle();
console.log('+ snap-fit:                        ', await readFloaters());

await setHingeStyle('none');
await waitIdle();
console.log('+ hinge=none:                      ', await readFloaters());

await setHingeStyle('piano-segmented');
await waitIdle();
console.log('+ hinge=piano-segmented:           ', await readFloaters());

await browser.close();
