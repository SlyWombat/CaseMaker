// Scratch QA for issue #155 — the stacking-toolbox archetype, driven in a real
// browser rather than asserted in jsdom.
//
// The unit suite already pins the geometry through Manifold. What it cannot
// show is that the archetype is REACHABLE: that the welcome card loads it, that
// the rail offers its own panel, that the panel's controls actually move the
// compiled mesh, and that the export path does not bill a toolbox for shell
// screws it does not have. That is what this script is for.
//
// Not part of the test suite — run by hand, delete after.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = './qa-155-out';
mkdirSync(OUT, { recursive: true });
const URL = process.env.QA_URL ?? 'http://127.0.0.1:5173/';

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
// 1440 wide: past ContextPanel's 1366 compact breakpoint, so the panel is a
// rail beside the viewport rather than a drawer that would need opening first.
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${String(e).split('\n')[0]}`));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 300)}`);
});

const idle = () => page.evaluate(async () => { await window.__caseMaker?.waitForIdle?.(); });

/** What the engine actually built: ids, sizes, and whether a node is loose. */
const graph = () =>
  page.evaluate(() => {
    const g = window.__caseMaker?.getSceneGraph?.() ?? [];
    return g.map((n) => ({
      id: n.id,
      tris: n.triangleCount,
      comps: n.componentCount,
      size: [0, 1, 2].map((i) => Number((n.bbox.max[i] - n.bbox.min[i]).toFixed(3))),
      minZ: Number(n.bbox.min[2].toFixed(4)),
    }));
  });

const has = (sel) => page.locator(sel).count().then((n) => n > 0);

const report = { steps: [], errors: errs };
const step = async (name, fn) => {
  const before = errs.length;
  let info = null;
  try {
    info = await fn();
  } catch (e) {
    errs.push(`step ${name}: ${String(e).split('\n')[0]}`);
  }
  await page.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {});
  report.steps.push({ name, newErrors: errs.length - before, info });
};

await step('01-welcome', async () => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__caseMaker?.apiVersion === 1), undefined, {
    timeout: 30_000,
  });
  await page.waitForLoadState('networkidle', { timeout: 30_000 });
  return {
    apiUp: await page.evaluate(() => window.__caseMaker?.isTestMode?.() ?? false),
    toolboxCard: await has('[data-testid="welcome-template-toolbox"]'),
  };
});

await step('02-load-template', async () => {
  await page.getByTestId('welcome-template-toolbox').click();
  await idle();
  const project = await page.evaluate(() => {
    const p = window.__caseMaker?.getProject?.();
    return { toolbox: p?.case?.toolbox ?? null, schemaVersion: p?.schemaVersion };
  });
  return { project, graph: await graph() };
});

await step('03-panel-default', async () => {
  const rail = await page
    .locator('[data-testid^="sidebar-button-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('sidebar-button-', '')));
  // A freshly loaded archetype leaves the rail with no section open (the same
  // as the rack: the reset only redirects a section that no longer applies).
  const beforeClick = await has('[data-testid="toolbox-panel"]');
  await page.getByTestId('sidebar-button-toolbox').click();
  return {
    rail,
    beforeClick,
    panel: await has('[data-testid="toolbox-panel"]'),
    summary: (await page.getByTestId('toolbox-summary').textContent().catch(() => null))?.trim(),
    problem: await has('[data-testid="toolbox-problem"]'),
    width: await page.getByTestId('toolbox-width').inputValue().catch(() => null),
    height: await page.getByTestId('toolbox-height').inputValue().catch(() => null),
    fitIssue: await has('[data-testid="toolbox-fit-issue"]'),
    graph: await graph(),
  };
});

await step('04-height-ladder', async () => {
  const before = await graph();
  await page.getByTestId('toolbox-height-210').click();
  await idle();
  return { before: before.find((n) => n.id === 'toolbox-bin'), after: (await graph()).find((n) => n.id === 'toolbox-bin') };
});

await step('05-grid-toggle', async () => {
  const before = (await graph()).find((n) => n.id === 'toolbox-bin');
  await page.getByTestId('toolbox-grid').click();
  await idle();
  const after = (await graph()).find((n) => n.id === 'toolbox-bin');
  return {
    gridChecked: await page.getByTestId('toolbox-grid').isChecked(),
    summary: (await page.getByTestId('toolbox-summary').textContent().catch(() => null))?.trim(),
    trisBefore: before?.tris,
    trisAfter: after?.tris,
  };
});

await step('06-footprint', async () => {
  await page.getByTestId('toolbox-width').fill('240');
  await page.getByTestId('toolbox-depth').fill('160');
  await idle();
  return { graph: await graph(), summary: (await page.getByTestId('toolbox-summary').textContent().catch(() => null))?.trim() };
});

await step('07-unbuildable', async () => {
  // A height with no body above the foot must say why rather than go blank.
  await page.getByTestId('toolbox-height').fill('10');
  await idle();
  return {
    problem: (await page.getByTestId('toolbox-problem').textContent().catch(() => null))?.trim(),
    summaryPresent: await has('[data-testid="toolbox-summary"]'),
    // The compiler falls through to the shell, as badge and blank do — so it is
    // worth saying WHICH nodes appear, not just how many.
    graph: await graph(),
  };
});

/** Open the export modal and read what it bills. */
async function readExport() {
  await page.getByTestId('sidebar-button-export').click();
  await page.getByTestId('export-open').click({ timeout: 10_000 });
  await page.getByTestId('export-modal-format').waitFor({ timeout: 10_000 });
  const hardware = await page
    .getByTestId('export-hardware-list')
    .textContent()
    .catch(() => null);
  const parts = (await page.locator('.export-modal').textContent()).replace(/\s+/g, ' ').trim();
  await page.getByTestId('export-modal-close').click();
  return {
    hardwareLines: hardware === null ? [] : hardware.split('\n').map((s) => s.trim()).filter(Boolean),
    parts: parts.slice(0, 700),
  };
}

await step('08-parts-and-hardware', async () => {
  await page.getByTestId('toolbox-height').fill('110');
  await page.getByTestId('toolbox-width').fill('300');
  await page.getByTestId('toolbox-depth').fill('200');
  await page.getByTestId('toolbox-grid').click();
  await idle();
  return await readExport();
});

await step('09-hardware-control', async () => {
  // The CONTROL for the check above: if a shell project's export showed no
  // hardware either, then "no hardware" would prove nothing about the toolbox's
  // `if (kind === 'toolbox') return items` early-return. Run it on a FRESH page
  // so the toolbox's own state cannot leak into it.
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => errs.push(`pageerror(shell): ${String(e).split('\n')[0]}`));
  await p2.goto(URL, { waitUntil: 'domcontentloaded' });
  await p2.waitForFunction(() => Boolean(window.__caseMaker?.apiVersion === 1), undefined, { timeout: 30_000 });
  await p2.waitForLoadState('networkidle', { timeout: 30_000 });
  await p2.getByTestId('welcome-template-pi-server-tray').click();
  await p2.evaluate(async () => { await window.__caseMaker?.waitForIdle?.(); });
  await p2.getByTestId('sidebar-button-export').click();
  await p2.getByTestId('export-open').click({ timeout: 10_000 });
  await p2.getByTestId('export-modal-format').waitFor({ timeout: 10_000 });
  const hardware = await p2.getByTestId('export-hardware-list').textContent().catch(() => null);
  await p2.screenshot({ path: `${OUT}/09-shell-export.png` });
  await p2.close();
  return {
    hardwareLines: hardware === null ? [] : hardware.split('\n').map((s) => s.trim()).filter(Boolean),
  };
});

report.errors = errs;
console.log(JSON.stringify(report, null, 2));
await b.close();
process.exit(errs.length > 0 ? 1 : 0);
