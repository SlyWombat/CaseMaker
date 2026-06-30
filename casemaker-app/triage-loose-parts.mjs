// Render each template; check floaters-banner for loose parts.
// Then switch joint to snap-fit and re-check. Outputs PNGs + JSON summary.
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_URL = process.env.TARGET_URL || 'https://electricrv.ca/casemaker/';
const OUT_DIR = resolve(__dirname, 'triage-live-qa-out', 'loose-parts');
fs.mkdirSync(OUT_DIR, { recursive: true });

const TEMPLATES = [
  'pi-server-tray',
  'pi-poe-stack',
  'pi-zero-tablet',
  'arduino-dmx',
  'giga-dmx-controller',
  'esp32-dev-tray',
  'snap-fit-test',
  'protective-case',
  'large-box-200',
];

const PER_TEMPLATE_TIMEOUT_MS = 60000;
const REBUILD_TIMEOUT_MS = 30000;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

const consoleEvents = [];
page.on('console', (m) => consoleEvents.push({ type: m.type(), text: m.text() }));
page.on('pageerror', (e) => consoleEvents.push({ type: 'pageerror', text: e.message }));

async function gotoFresh() {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-testid="welcome-overlay"]', { timeout: 30000 });
}

async function ensureWelcome() {
  const haveOverlay = await page.$('[data-testid="welcome-overlay"]');
  if (haveOverlay) return;
  const newBtn = await page.$('[data-testid="new-project"]');
  if (newBtn) {
    await newBtn.click();
    try {
      await page.waitForSelector('[data-testid="welcome-overlay"]', { timeout: 5000 });
      return;
    } catch {}
  }
  await gotoFresh();
}

async function waitIdle(timeout = REBUILD_TIMEOUT_MS) {
  // Status bar transitions through 'rebuilding' → 'idle' (or 'error'). After
  // a click that triggers a rebuild we want to first see it leave 'idle' OR
  // accept that the rebuild was synchronous; either way we wait until it's
  // back to a settled state.
  try {
    await page.waitForFunction(
      () => {
        const bar = document.querySelector('[data-testid="status-bar"]');
        const ds = bar?.getAttribute('data-status');
        return ds === 'idle' || ds === 'error' || ds === 'failed';
      },
      { timeout },
    );
  } catch {
    /* fall through with whatever state we're in */
  }
  await page.waitForTimeout(600);
}

async function readFloaters() {
  return await page.evaluate(() => {
    const banner = document.querySelector('[data-testid="floaters-banner"]');
    if (!banner) return null;
    const items = Array.from(banner.querySelectorAll('li')).map((li) => {
      const code = li.querySelector('code')?.textContent || '';
      const m = li.textContent?.match(/has\s+(\d+)\s+disconnected/);
      return { id: code, count: m ? Number(m[1]) : null };
    });
    return { items };
  });
}

async function readStatus() {
  return await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="status-bar"]');
    return {
      attr: bar?.getAttribute('data-status') || '',
      text: bar?.textContent?.slice(0, 200) || '',
    };
  });
}

async function switchJointToSnap() {
  // Open the Case section in the right rail.
  const caseBtn = await page.$('[data-testid="sidebar-button-case"]');
  if (!caseBtn) return { ok: false, reason: 'no sidebar-button-case' };
  await caseBtn.click();
  await page.waitForTimeout(200);
  const snap = await page.$('[data-testid="joint-snap-fit"]');
  if (!snap) return { ok: false, reason: 'no joint-snap-fit input' };
  // Already selected? Skip the click so we don't no-op a non-event.
  const checked = await snap.evaluate((el) => el.checked);
  if (checked) return { ok: true, alreadySnap: true };
  await snap.click();
  return { ok: true };
}

async function runTemplate(id) {
  const tStart = Date.now();
  await ensureWelcome();
  const tplBtn = await page.$(`[data-testid="welcome-template-${id}"]`);
  if (!tplBtn) return { id, error: `template button not found` };
  await tplBtn.click();
  await waitIdle();

  const status1 = await readStatus();
  const floaters1 = await readFloaters();
  const screenshot1 = resolve(OUT_DIR, `${id}__default.png`);
  await page.screenshot({ path: screenshot1, fullPage: false });

  // Switch joint → snap-fit, wait for rebuild, recapture.
  const switchRes = await switchJointToSnap();
  let status2 = null;
  let floaters2 = null;
  let screenshot2 = null;
  if (switchRes.ok) {
    await waitIdle();
    status2 = await readStatus();
    floaters2 = await readFloaters();
    screenshot2 = resolve(OUT_DIR, `${id}__snap.png`);
    await page.screenshot({ path: screenshot2, fullPage: false });
  }

  return {
    id,
    durationMs: Date.now() - tStart,
    default: {
      statusAttr: status1.attr,
      floaters: floaters1,
      screenshot: screenshot1,
    },
    snap: switchRes.ok
      ? {
          alreadySnap: switchRes.alreadySnap || false,
          statusAttr: status2.attr,
          floaters: floaters2,
          screenshot: screenshot2,
        }
      : { error: switchRes.reason },
  };
}

await gotoFresh();
console.log('initial welcome overlay loaded against', TARGET_URL);

const results = [];
for (const id of TEMPLATES) {
  console.log(`\n=== ${id} ===`);
  try {
    const r = await runTemplate(id);
    console.log(
      `  default floaters: ${r.default.floaters ? r.default.floaters.items.map((i) => i.id + '×' + i.count).join(', ') : 'none'} (${r.default.statusAttr})`,
    );
    if (r.snap.error) {
      console.log(`  snap: ERROR ${r.snap.error}`);
    } else {
      console.log(
        `  snap floaters:    ${r.snap.floaters ? r.snap.floaters.items.map((i) => i.id + '×' + i.count).join(', ') : 'none'} (${r.snap.statusAttr}${r.snap.alreadySnap ? ', already snap' : ''})`,
      );
    }
    results.push(r);
  } catch (e) {
    console.log('  CRASH:', e.message);
    results.push({ id, crash: e.message });
    try {
      await gotoFresh();
    } catch {}
  }
}

await browser.close();

const outBlob = { startedAt: new Date().toISOString(), target: TARGET_URL, results };
const outPath = resolve(OUT_DIR, 'results.json');
fs.writeFileSync(outPath, JSON.stringify(outBlob, null, 2));
console.log('\nresults json ->', outPath);

console.log('\n=== SUMMARY ===');
console.log('TEMPLATE'.padEnd(22), 'DEFAULT'.padEnd(40), 'SNAP');
for (const r of results) {
  if (r.crash) {
    console.log(r.id.padEnd(22), 'CRASH: ' + r.crash);
    continue;
  }
  const d = r.default.floaters?.items.map((i) => `${i.id}×${i.count}`).join(',') || 'clean';
  const s = r.snap.error
    ? `ERR ${r.snap.error}`
    : r.snap.floaters?.items.map((i) => `${i.id}×${i.count}`).join(',') || (r.snap.alreadySnap ? 'clean (already)' : 'clean');
  console.log(r.id.padEnd(22), d.padEnd(40), s);
}
