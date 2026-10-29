// #716 R-UI-15 — THE ROTARY ACCEPTANCE WALK (docs/design/rotary-flow.md §7, items 1, 2 and 6).
//
// From the door: Name on a dowel → Holding shows the seeded ⌀20 × 100 rod in the rotary chuck →
// Engrave text "Zoomba" → Generate's four ticks and the oracle's "matches the design" on the map's
// columns → real screenshots of the turning stock and of Unroll → Cut's run refusal. The words are
// checked from the screens this walk itself drew: no issue numbers, no rotary codes, A always with
// °, lengths with mm, no decimal past three places, and the bench said in one sentence.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(300_000);
const OUT = path.join(process.cwd(), 'test-results', 'rotary-starter-acceptance');

/** Internal codes and issue numbers never reach an operator's screen (§7 item 6). */
const ROTARY_CODES =
  /#\d+|axis-crossing|wrap-into-clamp|rotary-rapid-engaged|rotary-y-off-axis|rotary-turn-in-stock|rotary-unsupported/;
const BENCH =
  "The rotary module has not been measured on this machine yet — this program can be checked and simulated, but saving its .nc and running it wait for the module's bench check.";

test('Name on a dowel: door to the four ticks, the views, and the run refusal (#716 §7 1, 2, 6)', async ({ cm, page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await cm.ready();
  await expect(page.getByTestId('welcome-overlay')).toBeVisible();

  // — 1. THE STARTER. One press puts the rod in the chuck and opens Holding on it.
  await page.getByTestId('welcome-starter-dowel').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Holding');
  const picture = page.getByTestId('engrave-setup-holding-picture');
  await expect(picture).toContainText('rod ⌀20');
  await expect(picture).toContainText('grip 15 mm');
  await expect(picture).toContainText('stick-out 85 mm');
  const holdingText = await page.getByTestId('start-wizard').innerText();
  expect(holdingText).not.toMatch(ROTARY_CODES);
  expect(holdingText).not.toMatch(/\.\d{4,}/);

  // The seeded job is a rod in the chuck — the Holding step's own default, not a starter's guess.
  const job = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('casemaker.engraveJob.v3') ?? '{}'),
  );
  expect(job.stock.shape).toBe('cylinder');
  expect(job.stock.length).toBe(100);
  expect(job.stock.width).toBe(20);
  expect(job.stock.thickness).toBe(20);
  expect(job.workholding.kind).toBe('rotary-chuck');
  expect(job.workholding.rotary.tailstock).toBe(true);

  // — 2. THE OPERATION. The wizard's step 2 rule applies: a starter seeds no items.
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · What are you cutting?');
  await page.getByTestId('start-wizard-op-text').fill('Zoomba');
  await expect(page.getByTestId('start-wizard-create')).toBeEnabled();
  await page.getByTestId('start-wizard-create').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  // — 3. THE FOUR TICKS, and the oracle's words (column space, item 1).
  await expect(page.getByTestId('engrave-generate')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('engrave-generate').click();
  for (const id of ['engrave-run-toolpath', 'engrave-run-verified', 'engrave-run-simulated', 'engrave-run-oracle']) {
    await expect(page.getByTestId(id)).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  }
  await expect(page.getByTestId('engrave-run-oracle')).toContainText('matches the design');

  // — 4. THE TURNING STOCK AND UNROLL, as real screenshots of a mid-program step.
  const max = Number(await page.getByTestId('sim-scrubber').getAttribute('max'));
  await page.evaluate((step) => window.__caseMaker!.simSetStep(step), Math.floor(max * 0.6));
  await page.waitForTimeout(800);
  await expect(page.getByTestId('sim-rotary-readout')).toBeVisible();
  await expect(page.getByTestId('sim-rotary-a')).toHaveText(/^A \d+(\.\d)?° · \d+ turns?$/);
  await expect(page.getByTestId('sim-rotary-above-axis')).toHaveText(/^above the axis \d+(\.\d)? mm$/);
  await page.screenshot({ path: path.join(OUT, 'turning.png') });

  await page.getByTestId('sim-view-unroll').click();
  await expect(page.getByTestId('sim-view-unroll')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('viewport-camera-top').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, 'unroll.png') });

  // — 5. CUT (item 2): lines 1–2 tick, line 3 is the registration step, line 4 carries the run
  // refusal in the gate's own sentence and offers no run — its only button connects a machine.
  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-step-1-title')).toContainText('✓ 1');
  await expect(page.getByTestId('engrave-cut-step-2-title')).toContainText('✓ 2');
  await expect(page.getByTestId('engrave-cut-step-3-title')).toContainText('3 Register the blank');
  await expect(page.getByTestId('engrave-cut-step-4-title')).toContainText('4 Run');
  // Line 4 opens to state the refusal; its summary already names the bench check.
  await expect(page.getByTestId('engrave-cut-step-4-summary')).toContainText("the rotary’s bench check first");
  await page.getByTestId('engrave-cut-step-4-summary').click();
  const bench = page.getByTestId('engrave-cut-rotary-bench');
  await expect(bench).toBeVisible();
  await expect(bench).toHaveText(BENCH);
  const step4Buttons = page.locator('[data-testid="engrave-cut-step-4"] button');
  await expect(step4Buttons).toHaveCount(1);
  await expect(step4Buttons.first()).toHaveAttribute('data-testid', 'engrave-cut-open-machines');
  await page.screenshot({ path: path.join(OUT, 'cut.png') });

  // The same gate sentence blocks Save on the Design side, and item 6 holds there too: the words
  // are the operator's, the decimals are three at most, and the bench is one sentence.
  await page.getByTestId('cnc-mode-design').click();
  await expect(page.getByTestId('engrave-save')).toBeDisabled();
  await expect(page.getByTestId('engrave-save-blocked')).toContainText(BENCH);
  const designText = await page.getByTestId('engrave-panel').innerText();
  expect(designText).not.toMatch(ROTARY_CODES);
  expect(designText).not.toMatch(/\.\d{4,}/);
  expect(designText.split(BENCH).length - 1).toBe(1);
});
