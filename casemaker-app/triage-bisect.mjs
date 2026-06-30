// Bisect what's causing the 5-component shell on pi-server-tray.
// Open the template, then toggle individual settings and re-read floaters.
import { chromium } from 'playwright';

const TARGET_URL = process.env.TARGET_URL || 'https://electricrv.ca/casemaker/';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

async function gotoFresh() {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-testid="welcome-overlay"]', { timeout: 30000 });
}
async function waitIdle() {
  try {
    await page.waitForFunction(
      () => {
        const ds = document
          .querySelector('[data-testid="status-bar"]')
          ?.getAttribute('data-status');
        return ds === 'idle' || ds === 'error' || ds === 'failed';
      },
      { timeout: 30000 },
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
async function toggleVent(enabled) {
  await openCaseSection();
  const cb = await page.$('[data-testid="ventilation-toggle"]');
  if (!cb) return false;
  const isOn = await cb.evaluate((el) => el.checked);
  if (isOn !== enabled) await cb.click();
  return true;
}
async function setBossPosition(value) {
  await openCaseSection();
  const r = await page.$(`[data-testid="boss-position-${value}"]`);
  if (!r) return false;
  await r.click();
  return true;
}
async function setJoint(value) {
  await openCaseSection();
  const r = await page.$(`[data-testid="joint-${value}"]`);
  if (!r) return false;
  const checked = await r.evaluate((el) => el.checked);
  if (!checked) await r.click();
  return true;
}

async function pickTemplate(id) {
  await page.waitForSelector('[data-testid="welcome-overlay"]', { timeout: 30000 });
  const btn = await page.$(`[data-testid="welcome-template-${id}"]`);
  if (!btn) throw new Error(`template button not found: ${id}`);
  await btn.click();
  await waitIdle();
}
async function newProject() {
  const newBtn = await page.$('[data-testid="new-project"]');
  if (newBtn) {
    await newBtn.click();
    await page.waitForSelector('[data-testid="welcome-overlay"]', { timeout: 5000 });
  }
}

await gotoFresh();
console.log('--- pi-server-tray bisect ---');

// Baseline
await pickTemplate('pi-server-tray');
console.log('baseline:                  ', await readFloaters());

// Disable vent
await toggleVent(false);
await waitIdle();
console.log('vent disabled:             ', await readFloaters());

// Re-enable vent + change joint to flat-lid
await toggleVent(true);
await waitIdle();
console.log('vent re-enabled:           ', await readFloaters());
await setJoint('flat-lid');
await waitIdle();
console.log('flat-lid (vent on):        ', await readFloaters());

// Snap-fit
await setJoint('snap-fit');
await waitIdle();
console.log('snap-fit (vent on):        ', await readFloaters());

// Back to screw-down + disable bosses
await setJoint('screw-down');
await waitIdle();
console.log('back to screw-down:        ', await readFloaters());

// Try with no vent + screw-down
await toggleVent(false);
await waitIdle();
console.log('screw-down + no vent:      ', await readFloaters());

await browser.close();
