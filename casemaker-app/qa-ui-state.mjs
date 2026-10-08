// Scratch QA: what does the UI actually look like right now, and what is dead?
// Walks the welcome screen, the workspace, every sidebar section, and the two CNC
// sections; screenshots each, and reports console/page errors and disabled controls.
// Not part of the test suite — run by hand, delete after.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = './qa-ui-out';
mkdirSync(OUT, { recursive: true });
const URL = process.env.QA_URL ?? 'http://127.0.0.1:5173/';

const SECTIONS = [
  'board', 'case', 'ports', 'hats', 'features', 'assets', 'export', 'cnc-engrave', 'cnc-sim',
];

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await b.newContext({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
  acceptDownloads: true,
});
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${String(e).split('\n')[0]}`));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 200)}`);
});

const idle = () => page.evaluate(async () => { await window.__caseMaker?.waitForIdle?.(); });

/** What the context panel currently offers, and what is greyed out. */
const probe = () => page.evaluate(() => {
  const panel = document.querySelector('[data-testid="context-panel"]');
  if (!panel) return { missing: true };
  const controls = [...panel.querySelectorAll('button, input, select, textarea')];
  const disabled = controls.filter((c) => c.disabled);
  const label = (c) => (c.getAttribute('aria-label') || c.getAttribute('title') || c.textContent || c.type || '').trim().slice(0, 60);
  return {
    controls: controls.length,
    disabled: disabled.length,
    disabledLabels: disabled.map(label).filter(Boolean).slice(0, 12),
    headings: [...panel.querySelectorAll('h1,h2,h3,h4')].map((h) => h.textContent.trim().slice(0, 60)).slice(0, 20),
    comingSoon: (panel.textContent || '').match(/coming soon|not yet|TODO|unavailable/gi) ?? [],
  };
});

const report = { steps: [] };
const step = async (name, fn) => {
  const before = errs.length;
  const shot = `${OUT}/${name}.png`;
  let info = null;
  try {
    await fn();
    info = await probe().catch(() => null);
  } catch (e) {
    errs.push(`step ${name}: ${String(e).split('\n')[0]}`);
  }
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  report.steps.push({ name, shot, newErrors: errs.length - before, panel: info });
};

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(800);
await step('00-welcome', async () => { await page.waitForSelector('[data-testid="welcome-search"]'); });

await step('01-workspace', async () => {
  await page.getByTestId('welcome-search').fill('sht31');
  await page.waitForTimeout(400);
  await page.getByTestId('welcome-board-adafruit-sht31d').click();
  await page.getByTestId('welcome-generate').click();
  await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
  await idle();
  await page.waitForTimeout(600);
});

for (const s of SECTIONS) {
  await step(`10-${s}`, async () => {
    await page.getByTestId(`sidebar-button-${s}`).click();
    await page.waitForTimeout(500);
    await idle().catch(() => {});
    await page.waitForTimeout(300);
  });
}

// The engrave golden path: seed the default job and see whether Generate lights up.
await step('20-engrave-seeded', async () => {
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await page.waitForTimeout(400);
  const seed = page.getByTestId('engrave-seed-default');
  if (await seed.count()) { await seed.click(); await page.waitForTimeout(500); }
  await idle().catch(() => {});
  await page.waitForTimeout(500);
  report.engraveSaveDisabled = await page.getByTestId('engrave-save').isDisabled().catch(() => null);
  report.engraveGenerateDisabled = await page.getByTestId('engrave-generate').isDisabled().catch(() => null);
});

await step('21-engrave-generate', async () => {
  const gen = page.getByTestId('engrave-generate');
  if (await gen.count() && !(await gen.isDisabled())) {
    await gen.click();
    await page.waitForTimeout(1500);
    await idle().catch(() => {});
    await page.waitForTimeout(1500);
  }
  report.engraveSaveDisabledAfter = await page.getByTestId('engrave-save').isDisabled().catch(() => null);
  report.runSheetVisible = await page.getByTestId('run-sheet').count().catch(() => 0);
});

report.errors = [...new Set(errs)].slice(0, 40);
console.log(JSON.stringify(report, null, 1));
await b.close();
