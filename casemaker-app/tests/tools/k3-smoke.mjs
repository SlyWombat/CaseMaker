// #943 wave 2 — THE OFF-BENCH SMOKE WALK, one command, no Playwright runner.
//
//   node tests/tools/k3-smoke.mjs <url> [--out <dir>] [--to cut|register] [--timeout <ms>] [--headed]
//
// Drives a headless Chromium (Playwright, over CDP) through the first-job flow on a RUNNING
// instance: the door → the wizard's default engrave job → Generate (the four ticks, or the refusal
// sentence) → Cut (step 1's summary, then step 2 Register with no machine). One line per step with
// pass/fail and the sentence it read; screenshots to --out; exit non-zero on any failure.
//
// The selectors are the firstJob acceptance e2e's (`tests/e2e/firstJob.acceptance.spec.ts`); this
// script adds no testids and reads only what that walk already asserts. `--to register` is the T4
// dry-walk variant: it stops one step further, inside the Register step's body, before any
// registration control is pressed.
//
// The manager's runs: the k3 house server at http://192.168.10.38:8000 (the sha under test) and a
// local `npm run dev` on this checkout's own CASEMAKER_PORT.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const USAGE =
  'usage: node tests/tools/k3-smoke.mjs <url> [--out <dir>] [--to cut|register] [--timeout <ms>] [--headed]';

function args(argv) {
  const out = { url: null, out: 'test-results/k3-smoke', to: 'cut', timeout: 180_000, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i] ?? out.out;
    else if (a === '--to') out.to = argv[++i] ?? out.to;
    else if (a === '--timeout') out.timeout = Number(argv[++i] ?? out.timeout);
    else if (a === '--headed') out.headed = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag ${a}\n${USAGE}`);
    else if (out.url === null) out.url = a;
    else throw new Error(`unexpected argument ${a}\n${USAGE}`);
  }
  if (out.url === null) throw new Error(USAGE);
  if (out.to !== 'cut' && out.to !== 'register') throw new Error(`--to must be cut or register\n${USAGE}`);
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) throw new Error(`--timeout must be milliseconds\n${USAGE}`);
  return out;
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 400);
const slug = (s) => s.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();

const TICKS = ['engrave-run-toolpath', 'engrave-run-verified', 'engrave-run-simulated', 'engrave-run-oracle'];

async function main() {
  const opts = args(process.argv.slice(2));
  fs.mkdirSync(opts.out, { recursive: true });
  const browser = await chromium.launch({
    headless: !opts.headed,
    // The same GL pair playwright.config.ts gives the e2e run, so the 3D preview renders headless.
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const steps = [];

  const textOf = async (testid) => {
    const el = page.getByTestId(testid);
    if ((await el.count()) === 0) throw new Error(`no ${testid} on screen`);
    return oneLine(await el.innerText());
  };
  const visible = (testid) => page.getByTestId(testid).waitFor({ state: 'visible', timeout: opts.timeout });
  const tap = (testid) => page.getByTestId(testid).click({ timeout: opts.timeout });
  const shot = async (name) => {
    await page.screenshot({ path: path.join(opts.out, `${String(steps.length).padStart(2, '0')}-${slug(name)}.png`), fullPage: true });
  };
  const waitState = (testid, want) =>
    page.waitForFunction(
      ([id, state]) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-state') === state,
      [testid, want],
      { timeout: opts.timeout, polling: 200 },
    );

  /** Run one step; print PASS/FAIL with the sentence it read, and stop the walk on a failure. */
  const step = async (name, fn) => {
    try {
      const sentence = oneLine(await fn());
      steps.push({ name, ok: true, sentence });
      console.log(`PASS  ${name} — ${sentence}`);
      await shot(name);
      return true;
    } catch (e) {
      const sentence = e instanceof Error ? e.message : String(e);
      steps.push({ name, ok: false, sentence });
      console.log(`FAIL  ${name} — ${oneLine(sentence)}`);
      await shot(`fail-${name}`).catch(() => {});
      return false;
    }
  };

  try {
    const walk = [
      ['door', async () => {
        await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
        await visible('welcome-overlay');
        return await textOf('welcome-overlay');
      }],
      ['wizard-machine', async () => {
        await tap('welcome-start-cnc');
        await visible('start-wizard');
        const progress = await textOf('start-wizard-progress');
        if (!progress.includes('Step 1 of 4')) throw new Error(`expected step 1 of 4, read "${progress}"`);
        return `${progress} · ${await textOf('start-wizard-next')}`;
      }],
      ['wizard-what', async () => {
        await tap('start-wizard-next');
        await page.getByTestId('start-wizard-progress').filter({ hasText: 'Step 2 of 4' }).waitFor({ timeout: opts.timeout });
        await tap('engrave-setup-what-engrave');
        await page.getByTestId('start-wizard-op-text').fill('Zoomba');
        const sentence = await textOf('start-wizard-progress');
        await tap('start-wizard-operation-next');
        return `${sentence} · text "Zoomba"`;
      }],
      ['wizard-stock', async () => {
        await page.getByTestId('start-wizard-progress').filter({ hasText: 'Step 3 of 4' }).waitFor({ timeout: opts.timeout });
        // #1263 — a job that states no material is ASKED for one; the walk answers with hardwood.
        if ((await page.getByTestId('start-wizard-stock-ask').count()) > 0) {
          await page.getByTestId('start-wizard-stock-material').selectOption('hardwood');
        }
        const material = await page.getByTestId('start-wizard-stock-material').inputValue();
        const length = await page.getByTestId('start-wizard-make-length').inputValue();
        const width = await page.getByTestId('start-wizard-make-width').inputValue();
        const thickness = await page.getByTestId('start-wizard-make-thickness').inputValue();
        await tap('start-wizard-stock-next');
        return `defaults kept (material asked, hardwood chosen) · ${material} ${length} × ${width} × ${thickness} mm`;
      }],
      ['wizard-holding', async () => {
        await page.getByTestId('start-wizard-progress').filter({ hasText: 'Step 4 of 4' }).waitFor({ timeout: opts.timeout });
        const sentence = await textOf('start-wizard-progress');
        await tap('engrave-setup-next');
        await visible('engrave-panel');
        return `${sentence} · job created`;
      }],
      ['generate', async () => {
        await page.getByTestId('engrave-generate').and(page.locator(':enabled')).waitFor({ timeout: opts.timeout });
        await tap('engrave-generate');
        const handle = await page.waitForFunction(
          (ids) => {
            const rows = ids.map((id) => document.querySelector(`[data-testid="${id}"]`));
            if (rows.some((r) => r === null)) return null;
            const states = rows.map((r) => r.getAttribute('data-state'));
            if (states.every((s) => s === 'tick')) return 'ticks';
            if (states.some((s) => s === 'cross')) return 'cross';
            return null;
          },
          TICKS,
          { timeout: opts.timeout, polling: 250 },
        );
        const outcome = await handle.jsonValue();
        if (outcome === 'cross') {
          const failed = await Promise.all(
            TICKS.map(async (id) => {
              const row = page.getByTestId(id);
              return (await row.getAttribute('data-state')) === 'cross' ? oneLine(await row.innerText()) : null;
            }),
          );
          const errors = (await page.getByTestId('engrave-run-errors').count()) > 0 ? await textOf('engrave-run-errors') : null;
          throw new Error(errors ?? failed.filter(Boolean).join(' · ') ?? 'a tick went cross');
        }
        await page.getByTestId('engrave-generate').filter({ hasText: 'Cut…' }).waitFor({ timeout: opts.timeout });
        return `${TICKS.length} ticks · ${await textOf('engrave-run-time').catch(() => 'time not shown')}`;
      }],
      ['cut-step-1', async () => {
        await tap('cnc-mode-cut');
        await visible('engrave-cut-surface');
        await waitState('engrave-package', 'current');
        const summary = await textOf('engrave-cut-step-1-summary');
        if (!/matches the design/i.test(summary)) throw new Error(`step 1 does not claim the design: "${summary}"`);
        return summary;
      }],
      ['cut-step-2-register', async () => {
        const step2 = page.getByTestId('engrave-cut-step-2');
        if (!(await step2.evaluate((el) => el.open))) {
          await tap('engrave-cut-step-2-summary');
        }
        const summary = await textOf('engrave-cut-step-2-summary');
        const noMachine = await textOf('engrave-registration-no-machine');
        return `step 2 "${summary}" · ${noMachine}`;
      }],
    ];

    if (opts.to === 'register') {
      walk.push(['register-body', async () => {
        await page.getByTestId('engrave-registration').waitFor({ state: 'visible', timeout: opts.timeout });
        await page.getByTestId('engrave-registration').scrollIntoViewIfNeeded();
        return await textOf('engrave-registration');
      }]);
    }

    for (const [name, fn] of walk) {
      if (!(await step(name, fn))) break;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const failed = steps.filter((s) => !s.ok).length;
  console.log(
    failed === 0
      ? `SMOKE PASS ${steps.length}/${steps.length} — ${opts.url}`
      : `SMOKE FAIL ${failed}/${steps.length} — ${opts.url}`,
  );
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`FAIL  ${oneLine(e instanceof Error ? e.message : String(e))}`);
    process.exit(2);
  });
