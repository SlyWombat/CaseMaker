// #744 end to end, in a real browser — the RUN GATE sees EVERY program, not only the one the
// single-file adapter names.
//
// The job is a facing pass plus a rectangle pocket: TWO files in cut order, the face file first.
// The facing cutter is the largest flat on the fake bench, and it is given a 0.1 mm shoulder — so
// the skim the generator posts is deeper than the cutter's stated shoulder. The GENERATOR never
// simulates the facing pass (it is only measured inside a rest pair), so generation succeeds; the
// app's own run sweep is the one that catches it. Before #744 the app loaded `generated.nc` — the
// ENGRAVING file — and never swept the face file, so Save was enabled on a job whose face pass
// would rub. Now every program is swept in cut order and the failing one blocks Save by name.
//
// (A rest pair cannot show this: the generator pre-measures its second program and refuses the run
// with `setup-rest-unavailable` before any app-side sweep happens — the rows stay "not simulated".
// The facing pass is the program only the app-side walk ever judges.)

import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { flatEndMill } from '@/engine/cnc/tool';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(240_000);

/**
 * The facing cutter: 3.175 mm — larger than the built-in `flat-1.0` and the only other 3.175 mm
 * flat is Makera's metal line, which the facing pick never takes on a softwood blank — with a
 * shoulder shorter than the skim. 3.175 is also a diameter the starting feed table covers; 6 mm
 * is not, and a facing pass with no cutting parameters is withheld.
 */
const SHORT: ToolLibraryEntry = {
  key: 'user:744-short-flat',
  provenance: 'typed here for the #744 blocked-save check',
  tool: flatEndMill(3.175, {
    name: '3.175 mm flat end (0.1 mm shoulder)',
    shoulderLength: 0.1,
    fluteLength: 12,
  }),
};

/** The skim the job takes, mm — deeper than the facing cutter's stated shoulder. */
const FACE_DEPTH = 0.5;

/** Everything `HouseHealthSchema` requires; nothing has been imported on this fake machine. */
const HEALTH = {
  ok: true,
  schemaVersion: 1,
  hasCatalogue: false,
  feedRows: 0,
  materialSpecRows: 0,
  catalogueSyncedAt: null,
  lastSync: null,
  problems: [],
  warnings: [],
};

test('#744 — a later program’s cutter collision blocks Save, naming that program', async ({ cm, page }) => {
  // A real house service is not running in this web build; answer it as the app's own schemas read
  // it (#489's specs do the same) so the custom facing cutter is on the bench.
  await page.route('**/api/v1/health**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HEALTH) }),
  );
  await page.route('**/api/v1/tools**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { etag: '"tools-744"' },
      body: JSON.stringify([SHORT]),
    }),
  );
  await page.route('**/api/v1/feeds**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('**/api/v1/inventory**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await cm.ready();
  await page.evaluate(async () => {
    await window.__caseMaker!.loadBuiltinBoard('rpi-4b');
    window.__caseMaker!.engraveReset();
  });
  await page.getByTestId('sidebar-button-cnc-engrave').click();
  await expect(page.getByTestId('engrave-panel')).toBeVisible();

  // A region pocket on the default job's cutter (`flat-1.0`, lengths unstated), so program 1 of the
  // engraving pair is not what this test is about.
  await page.getByTestId('engrave-add-summary').click();
  await page.getByTestId('engrave-add-rect').click();
  await expect(page.getByTestId('engrave-shape-row-0')).toBeVisible();

  // The skim: a second PROGRAM posted first, with the facing pick's own cutter.
  const facingEditor = page.getByTestId('engrave-facing-editor');
  if ((await facingEditor.getAttribute('open')) === null) {
    await page.getByTestId('engrave-facing-line').click();
  }
  await page.getByTestId('engrave-facing-on').click();
  await expect(page.getByTestId('engrave-facing-state')).toHaveText('facing on');
  await page.getByTestId('engrave-facing-depth').fill(String(FACE_DEPTH));

  await page.getByTestId('engrave-generate').click();

  // TWO programs were generated (the face file and the pocket) and BOTH swept in cut order. The
  // face file's own sweep fails: its skim is deeper than its cutter's stated shoulder.
  await expect(page.getByTestId('engrave-run-simulated')).toHaveAttribute('data-state', 'cross', {
    timeout: 180_000,
  });
  await expect(page.getByTestId('engrave-save')).toBeDisabled();
  const blocked = page.getByTestId('engrave-save-blocked');
  await expect(blocked).toContainText('the facing pass (user:744-short-flat)');
  await expect(blocked).toContainText('shoulder length of 0.1');

  const state = await page.evaluate(() => window.__caseMaker!.getEngraveRunState());
  expect(state.programs).toBe(2);
  expect(state.canSave).toBe(false);
  expect(state.saveReason).toContain('the facing pass (user:744-short-flat)');
  expect(state.saveReason).toContain('shoulder length of 0.1');
  // The same sentence is what Upload and Release would state: their gates all begin at `saveBlocker`.
});
