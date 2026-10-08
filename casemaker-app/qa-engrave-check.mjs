// Scratch — why does engrave.spec.ts's Simulate row go 'cross'?
//
// The e2e batch failed 5/5 in engrave.spec.ts with `run.simStatus === 'error'`, while the same
// pipeline is green in node (the full unit suite passed). That difference is either a browser-only
// fault or a module graph the dev server is serving stale. This reads the error the app actually
// reports instead of guessing which.
//
// Run from Windows:  node qa-engrave-check.mjs
import { chromium } from 'playwright';

const URL = process.env.QA_URL ?? 'http://127.0.0.1:5173/';

const b = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(`console: ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle', timeout: 120_000 });
await page.waitForTimeout(1000);

await page.evaluate(async () => {
  await window.__caseMaker.loadBuiltinBoard('rpi-4b');
  window.__caseMaker.engraveReset();
});
await page.getByTestId('sidebar-button-cnc-engrave').click();
await page.waitForSelector('[data-testid="engrave-panel"]');

await page.getByTestId('engrave-generate').click();

// Wait for the run to settle: either the oracle ticks or the pipeline stops.
const settled = await page
  .waitForFunction(
    () => {
      const s = window.__caseMaker.getEngraveRunState();
      // Settled = the SIMULATION has finished one way or the other. `stage` alone is not enough:
      // it reads 'done' for the generation stage while the sweep is still running.
      return s.simStatus !== null || s.error !== null;
    },
    null,
    { timeout: 200_000, polling: 1000 },
  )
  .then(() => true)
  .catch(() => false);

const run = await page.evaluate(() => window.__caseMaker.getEngraveRunState());
const sim = await page.evaluate(() => window.__caseMaker.getSimState());
const rowText = await page.getByTestId('engrave-run-simulated').innerText();
const rowState = await page.getByTestId('engrave-run-simulated').getAttribute('data-state');

console.log(
  JSON.stringify({ settled, run, sim, rowText, rowState, errors: errs }, null, 2),
);

await b.close();
