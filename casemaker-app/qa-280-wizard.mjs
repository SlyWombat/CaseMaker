// Issue #280 — the startup wizard, driven in a real browser.
//
// Walks welcome → machine check → job type → blank, screenshotting each state, and checks the two
// things a screenshot alone would not settle: the scene graph (one 'blank' node, no placeholder
// PCB) and the hardware list (no shell screws for a board-less blank).
//
// The machine step is exercised in all four of its honest answers. Three of them exist in the web
// build; the 'found' one needs a socket, so the page's own module is patched through the dev
// server's module graph — the same `setMachineProbeLoader` seam the unit tests use.
//
// Run from Windows:  node qa-280-wizard.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = './qa-280-out';
mkdirSync(OUT, { recursive: true });
const URL = process.env.QA_URL ?? 'http://127.0.0.1:5173/';

const errs = [];
const shots = [];

const b = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

async function run({ width, height, tag }) {
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(`[${tag}] pageerror: ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(`[${tag}] console: ${m.text()}`);
  });

  const shot = async (name) => {
    const file = `${OUT}/${tag}-${name}.png`;
    await page.screenshot({ path: file });
    shots.push(file);
  };

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(600);
  await shot('01-welcome');

  await page.getByTestId('welcome-start-cnc').click();
  await page.waitForSelector('[data-testid="start-wizard"]');
  await shot('02-machine-untouched');

  // --- the four answers ------------------------------------------------------
  // The patch must reach the SAME module instance the app holds. Vite rewrites that specifier with
  // a `?t=` stamp whenever the file is edited (or an importer is), and a bare path then resolves to
  // a second instance whose loader nobody reads — which is exactly what "the patch stopped working"
  // looks like. So import the URL the page actually fetched.
  const patch = (client) =>
    page.evaluate(async (src) => {
      const seen = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => n.includes('/src/platform/machineProbe.ts'));
      if (seen.length === 0) throw new Error('the probe module was never loaded by the page');
      const mod = await import(/* @vite-ignore */ seen[seen.length - 1]);
      mod.setMachineProbeLoader(async () => new Function(`return (${src})`)());
    }, client);

  await page.getByTestId('start-wizard-check').click();
  await page.waitForSelector('[data-testid="start-wizard-machine-state"]');
  await shot('03-unavailable');
  const unavailable = await page.getByTestId('start-wizard-machine-state').innerText();

  await patch(`({
    discover: async () => [],
    identify: async () => ({ ip: '', mac: '' }),
    status: async () => ({ ok: true, text: '' }),
  })`);
  await page.getByTestId('start-wizard-check').click();
  await page.waitForTimeout(400);
  await shot('04-not-found');
  const notFound = await page.getByTestId('start-wizard-machine-state').innerText();

  await patch(`({
    discover: async () => [{ name: 'Makera_Z1_010290', host: '192.168.10.43', port: 2222, busy: false }],
    identify: async () => ({ ip: '192.168.10.43', mac: 'aa:bb:cc:dd:ee:ff' }),
    status: async () => ({ ok: true, text: 'Idle' }),
  })`);
  await page.getByTestId('start-wizard-check').click();
  await page.waitForTimeout(400);
  await shot('05-found-z1');
  const found = await page.getByTestId('start-wizard-machine-state').innerText();

  await patch(`({
    discover: async () => [{ name: 'SomeLaser_9000', host: '10.0.0.5', port: 2222, busy: true }],
    identify: async () => ({ ip: '10.0.0.5', mac: 'de:ad:be:ef:00:01' }),
    status: async () => ({ ok: true, text: 'Busy' }),
  })`);
  await page.getByTestId('start-wizard-check').click();
  await page.waitForTimeout(400);
  await shot('06-found-unknown');
  const unknown = await page.getByTestId('start-wizard-machine-state').innerText();

  // --- job type → blank → setup ---------------------------------------------
  await page.getByTestId('start-wizard-next').click();
  await page.waitForSelector('[data-testid="start-wizard-step-job"]');
  await shot('07-job-types');

  await page.getByTestId('start-wizard-job-blank').click();
  await page.waitForSelector('[data-testid="engrave-setup-flow"]');
  await page.waitForTimeout(600);
  await shot('08-setup-flow');

  await page.getByTestId('engrave-setup-close').click();
  await page.waitForTimeout(800);
  await shot('09-engrave-panel');

  // Read the rail's drawer state on entry, BEFORE anything is clicked by hand: the wizard's
  // promise is "land in the panel", and a compact viewport must not land on a shut drawer.
  const drawerOpenOnEntry = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="context-panel"]');
    return p ? p.className : null;
  });

  const stock = await page.evaluate(() =>
    ['length', 'width', 'thickness'].map((k) => {
      const el = document.querySelector(`[data-testid="engrave-stock-${k}"]`);
      return [k, el ? el.value : null];
    }),
  );
  const rail = await page.$$eval('[data-testid^="sidebar-button-"]', (els) =>
    els.map((e) => e.getAttribute('data-testid').replace('sidebar-button-', '')),
  );

  await page.evaluate(async () => {
    await window.__caseMaker?.waitForIdle?.();
  });
  const graph = await page.evaluate(() => window.__caseMaker.getSceneGraph().map((n) => n.id));

  // The hardware list: a blank has no shell, so it must not list shell screws.
  const hardware = await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="sidebar-button-export"]');
    if (el) el.click();
    await new Promise((r) => setTimeout(r, 400));
    const panel = document.querySelector('[data-testid="context-section-export"]');
    return panel ? panel.innerText.slice(0, 1200) : '(no export panel text)';
  });
  await shot('10-export-panel');

  // The blank's own rail at the breakpoint, with the panel shut, so the plate is visible whole.
  await page.evaluate(() => {
    const h = document.querySelector('[data-testid="context-panel-handle"]');
    if (h) h.click();
  });
  await page.waitForTimeout(400);
  await shot('11-blank-whole');

  await ctx.close();
  return {
    unavailable,
    notFound,
    found,
    unknown,
    stock,
    rail,
    graph,
    drawerOpenOnEntry,
    hardwareHasScrew: /m2|m3|screw|bolt/i.test(hardware),
    hardwareHead: hardware.slice(0, 300),
  };
}

const wide = await run({ width: 1440, height: 900, tag: 'wide' });
const compact = await run({ width: 1024, height: 768, tag: 'compact' });

await b.close();
console.log(JSON.stringify({ wide, compact, shots, errs }, null, 2));
