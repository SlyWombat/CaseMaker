// #227 slot 5 — closeout visual QA for #196/#197 (Simulate panel + viewport) and #205/#211
// (Engrave panel + preview). This spec exists to take screenshots for eye comparison against
// the approved #195 mockup (`docs/assets/cnc-mockup-*.png`); it asserts only that the surface
// is on screen, never that pixels match. Remove or fold into #199/#206 once committed.
//
// Run (Playwright starts its own dev server, #226):
//   npx playwright test tests/e2e/slot5-closeout-qa.spec.ts
//
// The captures go to `test-results/` (Playwright's own output dir, gitignored). The ten
// `docs/assets/slot5-*.png` are DOCUMENTATION, not test output: a fresh capture is byte-different
// from the committed one, so writing them on every run left the tree dirty with unreviewed image
// changes for a commit sweep or a deploy to carry along (#370). To refresh the docs on purpose:
//   UPDATE_DOC_SHOTS=1 npx playwright test tests/e2e/slot5-closeout-qa.spec.ts

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

const CLEAN = 'three-strokes.nc';
const readFixture = (testInfo: TestInfo, name: string): string =>
  readFileSync(join(dirname(testInfo.file), 'fixtures', name), 'utf8');
/** A vendor file from `reference-gcode/` — never committed (#186); null when absent. */
const readVendor = (testInfo: TestInfo, rel: string): string | null => {
  try {
    return readFileSync(join(dirname(testInfo.file), '..', '..', 'reference-gcode', rel), 'utf8');
  } catch {
    return null;
  }
};
/**
 * Where a capture goes. A routine run writes to Playwright's per-test output dir under the
 * gitignored `test-results/`; `UPDATE_DOC_SHOTS=1` — the deliberate docs refresh — is the only
 * thing that rewrites the ten TRACKED files under `docs/assets/` (#370).
 */
const DOC_SHOTS = process.env.UPDATE_DOC_SHOTS === '1';
const shot = (testInfo: TestInfo, name: string): string =>
  DOC_SHOTS ? join(process.cwd(), '..', 'docs', 'assets', name) : testInfo.outputPath(name);

test.use({ viewport: { width: 1440, height: 900 } });
// The vendor sim and the engrave preview both run the wasm worker under swiftshader; a full
// run takes tens of seconds, and longer under a loaded multi-session machine.
test.setTimeout(240_000);

async function loadBoardAndSection(page: Page, section: string): Promise<void> {
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
  });
  await page.getByTestId(`sidebar-button-${section}`).click();
}

test('visual QA: Simulate panel — idle, then ready with stock, path and diagnostics', async ({ cm, page }, testInfo) => {
  await cm.ready();
  await loadBoardAndSection(page, 'cnc-sim');
  await expect(page.getByTestId('sim-panel')).toBeVisible();

  // Idle — "Open .nc…" and the drop hint, nothing else (mockup state B1).
  await expect(page.getByTestId('sim-open')).toBeVisible();
  await expect(page.getByTestId('sim-drop-hint')).toBeVisible();
  await page.screenshot({ path: shot(testInfo, 'slot5-sim-idle.png') });

  // Ready — load our authored fixture and run it (mockup states B4 + C + D).
  await page.evaluate(
    ({ n, t }) => window.__caseMaker!.simOpenText(n, t),
    { n: CLEAN, t: readFixture(testInfo, CLEAN) },
  );
  await expect(page.getByTestId('sim-tool')).toHaveValue('flat-3.175x12-metal');
  await page.evaluate(() => window.__caseMaker!.simRun());
  await expect(page.getByTestId('sim-result')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('sim-disclaimer')).toContainText('rigid, ideal machine');
  await expect(page.getByTestId('sim-transport')).toBeVisible();
  await page.screenshot({ path: shot(testInfo, 'slot5-sim-ready.png') });

  // #197 addition: the camera presets and Fit frame the SIM scene, not the case.
  await page.getByTestId('viewport-camera-top').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: shot(testInfo, 'slot5-sim-top.png') });
  await page.getByTestId('viewport-zoom-out').click();
  await page.getByTestId('viewport-zoom-out').click();
  await page.getByTestId('viewport-fit').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: shot(testInfo, 'slot5-sim-fit.png') });
});

test('visual QA: Engrave panel — stock, labels, tool recommendation and depth-coloured preview', async ({ cm, page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await cm.ready();
  await loadBoardAndSection(page, 'cnc-engrave');
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await page.screenshot({ path: shot(testInfo, 'slot5-engrave-just-opened.png') });

  await expect(page.getByTestId('engrave-tool')).toBeVisible();
  // #211 acceptance 1: a fresh job opens with a selected tool AND a recommendation sentence.
  await expect(page.getByTestId('engrave-tool')).not.toHaveValue('');
  await page.waitForTimeout(4000);
  const recFresh = await page.getByTestId('engrave-recommendation').innerText().catch(() => '');
  console.log('DIAG #211 fresh selection=%j rec=%j', await page.getByTestId('engrave-tool').inputValue(), recFresh);
  expect(recFresh).toContain('Recommended');
  await page.screenshot({ path: shot(testInfo, 'slot5-engrave-after-4s.png') });
  const legendCount = await page.getByTestId('engrave-preview-legend').count();
  const loadingCount = await page.getByTestId('engrave-preview-loading').count();
  const errCount = await page.getByTestId('engrave-preview-error').count();
  console.log('DIAG legend=%d loading=%d err=%d errors=%j', legendCount, loadingCount, errCount, errors);
  await expect(page.getByTestId('engrave-preview-legend')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('engrave-preview-error')).toHaveCount(0);
  await page.screenshot({ path: shot(testInfo, 'slot5-engrave-editing.png') });

  // #211 acceptance 2: the user's own pick is kept when the recommendation changes.
  // `engrave-label-size-N` is the row's cap-height input (aria "cap"); shrinking it until
  // the selected cutter loses detail must move the recommendation TEXT, never the selection.
  //
  // #407 — the other built-in cutter, `flat-3.175x12-metal` (Makera's `(Metal)` flat), is
  // refused on this default softwood blank (`tool-metal-line`), so it can no longer stand in
  // as the pair this step selects. The 1.0 mm flat is the pair the recommendation still names
  // for this blank — the dev bench has no house catalogue, so these two are its only cutters,
  // and the metal-line refusal does not touch the non-metal one.
  await page.getByTestId('engrave-tool').selectOption('flat-1.0');
  const selBefore = await page.getByTestId('engrave-tool').inputValue();
  // The recommendation is the qualifying pick before the edit…
  await expect(page.getByTestId('engrave-recommendation')).toContainText('Largest cutter');
  const recBefore = await page.getByTestId('engrave-recommendation').innerText().catch(() => '(none)');
  // #411 — the cap-height field is in the row's body, which a job's rows arrive folded.
  await page.getByTestId('engrave-label-expand-0').click();
  await page.getByTestId('engrave-label-size-0').fill('4');
  // …and at a 4 mm cap height nothing qualifies, so the recommendation moves to the compromise
  // sentence while the picker keeps the user's selection.
  await expect(page.getByTestId('engrave-recommendation')).toContainText('No cutter you have can cut', { timeout: 30_000 });
  const selAfter = await page.getByTestId('engrave-tool').inputValue();
  const recAfter = await page.getByTestId('engrave-recommendation').innerText().catch(() => '(none)');
  console.log('DIAG #211 selBefore=%j selAfter=%j\n  recBefore=%j\n  recAfter=%j', selBefore, selAfter, recBefore, recAfter);
  expect(selAfter).toBe(selBefore);
  expect(recAfter).not.toBe(recBefore);
  // #407 — the pair is accepted by the refusal: no metal-line finding is raised for it.
  await expect(page.locator('[data-testid$="-tool-metal-line"]')).toHaveCount(0);

  // #197 addition: Top frames the ENGRAVE preview's stock, not the case. force: the engrave
  // preview canvas sits over the toolbar and intercepts pointer events (see #197 comment).
  await page.getByTestId('viewport-camera-top').click({ force: true });
  await page.waitForTimeout(700);
  await page.screenshot({ path: shot(testInfo, 'slot5-engrave-top.png') });

  // The Tool reason (#211) and the Vise / Cutting sections live below the fold.
  const reason = await page.getByTestId('engrave-recommendation').innerText().catch(() => '(none)');
  console.log('DIAG recommendation=%j', reason);
  await page.getByTestId('context-panel').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot(testInfo, 'slot5-engrave-scrolled.png') });
});

// #196's two still-unverified acceptance items, on the vendor corpus (#186: read-only, skipped
// when absent). Not the mockup compare — that is the two tests above.
test('acceptance #196: ACRYLIC-Balloon.nc simulates to a result; TopClamp.nc prefills from its header', async ({ cm, page }, testInfo) => {
  const balloonNc = readVendor(testInfo, 'LED/ACRYLIC-Balloon.nc');
  const topClampNc = readVendor(testInfo, 'Z1/TopClamp.nc');
  test.skip(balloonNc === null || topClampNc === null, 'reference-gcode/ corpus not present (#186)');
  // `test.skip(cond)` does not narrow the types, so bind non-null locals for the calls below.
  const balloon = balloonNc ?? '';
  const topClamp = topClampNc ?? '';

  await cm.ready();
  await loadBoardAndSection(page, 'cnc-sim');

  // Acceptance 2: a file with an MKR header prefills stock and tool from it.
  await page.evaluate(({ t }) => window.__caseMaker!.simOpenText('TopClamp.nc', t), { t: topClamp });
  const prefilled = await page.evaluate(() => ({
    len: (document.querySelector('[data-testid="sim-stock-length"]') as HTMLInputElement | null)?.value,
    wid: (document.querySelector('[data-testid="sim-stock-width"]') as HTMLInputElement | null)?.value,
    thk: (document.querySelector('[data-testid="sim-stock-thickness"]') as HTMLInputElement | null)?.value,
    tool: (document.querySelector('[data-testid="sim-tool"]') as HTMLSelectElement | null)?.value,
  }));
  console.log('DIAG #196 TopClamp prefill=%j', prefilled);
  expect(prefilled.tool).not.toBe('');
  expect(Number(prefilled.len)).toBeGreaterThan(0);

  // Acceptance 1: ACRYLIC-Balloon.nc runs to a result, with zero errors, quickly.
  // The LED file carries no tool record, so the user picks the 3.175 mm flat (the acceptance).
  await page.evaluate(({ t }) => window.__caseMaker!.simOpenText('ACRYLIC-Balloon.nc', t), { t: balloon });
  await page.getByTestId('sim-tool').selectOption('flat-3.175x12-metal');
  const t0 = Date.now();
  await page.evaluate(() => window.__caseMaker!.simRun());
  await expect(page.getByTestId('sim-result')).toBeVisible({ timeout: 30_000 });
  const elapsed = Date.now() - t0;
  await expect(page.getByTestId('sim-disclaimer')).toBeVisible();
  await expect(page.getByTestId('sim-refusal')).toHaveCount(0);
  const sim = await page.evaluate(() => window.__caseMaker!.getSimState());
  const diagText = await page.getByTestId('sim-diagnostics').innerText().catch(() => '(none)');
  console.log('DIAG #196 balloon elapsed=%dms status=%s count=%d removed=%d errorCodes=%j\n%s',
    elapsed, sim.status, sim.count, sim.removedVolume, sim.errorCodes, diagText);
  // #196 acceptance 1: a result, with ZERO errors. Fixed by decision (a) — the stub now fits
  // the work-frame extent inside the envelope (the panel's `buildSimSetup` → `stubSetup(..., Z1)`
  // places the 100 x 100 default stock at machine (-150, -150), so this file's ~147 mm of work
  // Y lands at machine Y ≈ -3.4 instead of +35). The result is still a real one (positive
  // removed volume), not a suppressed check.
  expect(sim.status).toBe('ready');
  expect(sim.removedVolume).toBeGreaterThan(0);
  expect(sim.errorCodes).toEqual([]);
  await page.screenshot({ path: shot(testInfo, 'slot5-sim-balloon.png') });
});
