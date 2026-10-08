// Scratch QA: drive the Simulate .nc panel the way a user would — open a file, run it,
// look at the result. Uses the same test API the e2e suite uses.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = './qa-ui-out';
mkdirSync(OUT, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(here, 'tests/e2e/fixtures', n), 'utf8');

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${String(e).split('\n')[0]}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 200)}`); });

await page.goto(process.env.QA_URL ?? 'http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.evaluate(async () => { await window.__caseMaker.loadBuiltinBoard('rpi-4b'); });
await page.getByTestId('sidebar-button-cnc-sim').click();
await page.waitForTimeout(500);

const run = async (name, file) => {
  await page.evaluate(({ n, t }) => window.__caseMaker.simOpenText(n, t), { n: name, t: file });
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => window.__caseMaker.getSimState());
  await page.getByTestId('sim-simulate').click();
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < 120000) {
    await page.waitForTimeout(1000);
    st = await page.evaluate(() => window.__caseMaker.getSimState());
    // A fast run can finish inside one poll, so "ready" is only the answer once the
    // result is not byte-for-byte the one that was on screen before the click.
    const same = st && before && st.status === 'ready' && before.status === 'ready'
      && st.removedVolume === before.removedVolume && st.count === before.count;
    if (st && !same && (st.status === 'ready' || st.status === 'refused' || st.status === 'error')) break;
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/40-sim-${name}.png` });
  return { name, status: st?.status, seconds: Math.round((Date.now() - t0) / 1000), before, state: st };
};

const clean = await run('clean', fx('three-strokes.nc'));
const gouge = await run('gouge', fx('three-strokes-gouge.nc'));

const panelText = async (t) => (await page.getByTestId(t).first().innerText().catch(() => '')).slice(0, 700);
console.log(JSON.stringify({
  clean: { status: clean.status, seconds: clean.seconds },
  gouge: { status: gouge.status, seconds: gouge.seconds },
  cleanState: clean.state,
  gougeRefusal: gouge.state?.refusal ?? gouge.state?.diagnostics ?? null,
  panelNow: await panelText('sim-panel'),
  errors: [...new Set(errs)].slice(0, 20),
}, null, 1));
await b.close();
