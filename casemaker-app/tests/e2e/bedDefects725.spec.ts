// #725 — the bed-mount defects, in a real browser (the off-bench exercise's scenarios, on the
// committed fixture).
//
// The dev server serves the WEB target, which has no house service, so the location and the shop
// defaults are answered here by `page.route('**/api/v1/**')` from `tests/unit/fixtures/location-doc.json`
// — the exercise's own fake-house pattern: the app's client, schema and stores read it exactly as
// they read the service.
//
// Two walks:
//   1. B4 + W1 — a bracket job whose Tray runs under a clamp: Generate refuses in the VERIFIER's
//      own sentence at the button, and its Fix opens Holding (it used to read "2 errors outstanding."
//      with no sentence and no Fix). The panel's Hold line is the bracket's, not the vise's.
//   2. B7 + W11 — a through cut taped on the wasteboard GENERATES (the bed facts reach the panel
//      and the worker); on a bare bed with no board, the blocker says the design's sentence.
//
// #934 hid these entries (the code stayed in src, the UI entry and the planner acceptance were
// removed): `engrave-setup-mount-bed-tape`, `engrave-setup-mount-bed-bracket`,
// `engrave-setups-use-typed-seat`, `engrave-setup-seat-<n>`, `engrave-registration-g32`,
// `engrave-release-facing-note`, and the disc re-seat block (`engrave-centre-find` and its
// siblings). EVERY walk in this file drives a BED MOUNT, and that hide was lifted by the
// maintainer's rule ("we test using the program", the dated run of 2026-11-08 — C3), so the file
// runs again. The other #934 entries above stay hidden behind their own issues; a walk that ever
// reaches one must be skipped with that reason, not this one.

import type { Page } from '@playwright/test';
import { test, expect, openSomethingElse } from './fixtures/caseMaker';
import { locationDocument, locationView, serveHouse } from './fixtures/fakeHouse';

test.setTimeout(300_000);

const BARE_SURFACE = {
  kind: 'bare-bed',
  material: null,
  length: null,
  width: null,
  thickness: null,
  position: null,
  provenance: {},
  scars: [],
  lastResurfacedAt: null,
};

const BOARDS_AND_TAPE = {
  tape: { widthMm: 20, thicknessMm: 0.2, provenance: 'typed' },
  boards: [{ material: 'MDF', size: [100, 100, 2], count: 4 }],
};

/** The house owns the 4th axis too: the rotary row must have its Change the machine… on offer. */
const ROTARY_FX = {
  id: 'fx-rotary-1',
  kind: 'rotary-module',
  product: 'makera-4th-axis',
  variant: null,
  constants: {},
  unit: {},
  provenance: {},
  whereabouts: { kind: 'box' },
  history: [],
};

/**
 * The fixture's machine with nothing on the pins, the bed's wasteboard measured (or bare), and the
 * bracket at anchor 1 when `anchor` — the same shapes the unit fixtures seed.
 */
function defectsView(opts: { anchor: boolean; bare?: boolean }): unknown {
  const doc = locationDocument();
  const machine = doc.machines[0]!;
  const profile = (machine.bedProfiles as Array<Record<string, unknown>>)[0]!;
  profile.placements = (profile.placements as unknown[]).filter(
    (pl) => ((pl as { where?: { kind?: string } }).where?.kind ?? '') !== 'pins',
  );
  if (opts.anchor) {
    (profile.placements as unknown[]).push({
      id: 'pl-bracket',
      fixture: 'fx-bracket-thin',
      where: { kind: 'anchor', anchor: 1, pins: null },
      count: null,
      frame: null,
      provenance: {},
    });
  }
  profile.surface = opts.bare === true
    ? { ...BARE_SURFACE }
    : { ...(profile.surface as object), length: 300, width: 200, position: { frontLeft: [20, 30], frame: 'machine' } };
  profile.consumables = BOARDS_AND_TAPE;
  doc.accessories = [...doc.accessories, ROTARY_FX];
  return locationView(doc);
}

/** The house for one walk: the view above, and the fixture's own lists beside it. */
async function fakeHouse(page: Page, opts: { anchor: boolean; bare?: boolean }): Promise<void> {
  await serveHouse(page, { location: defectsView(opts), fromSharedDocument: true });
}

/** Door → stock, typed: the operator's own plate. Leaves the wizard on the Holding step. */
async function typePlate(page: Page, dims: [number, number, number]): Promise<void> {
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  // #897 — the question comes before the blank; a pocket is the item these walks then cut.
  await openSomethingElse(page);
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill(String(dims[0]));
  await page.getByTestId('start-wizard-make-width').fill(String(dims[1]));
  await page.getByTestId('start-wizard-make-thickness').fill(String(dims[2]));
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
}

/** The four ticks and the run rows' generation state; the store answers what the panel shows. */
async function runPhase(page: Page): Promise<{ phase: string; stage: string | null; verifyErrors: number }> {
  return page.evaluate(() => {
    const state = window.__caseMaker!.getEngraveRunState();
    return { phase: state.phase, stage: state.stage, verifyErrors: state.verifyErrors };
  });
}

test('#725 B4/W1 — a clamp in the Tray’s path is named at Generate, and its Fix opens Holding', async ({ cm, page }) => {
  await fakeHouse(page, { anchor: true });
  await cm.ready();
  await typePlate(page, [100, 60, 6]);

  // The bed's default mount for a 6 mm plate on a bed carrying the bracket: the bracket.
  await expect(page.getByTestId('engrave-setup-mount-bed-bracket')).toBeChecked();
  // The last step's button is the create (#897); the pocket was the answer at step 2.
  await page.getByTestId('engrave-setup-next').click();

  // W1 — the panel's Hold line is the mount's (§3.7), not "Vise — shipped".
  await expect(page.getByTestId('engrave-group-hold')).toContainText(
    'Bracket at anchor 1 · 2 clamps on the back edge, 12 mm tall · X 0 Y 0 at its corner',
  );
  await expect(page.getByTestId('engrave-vise-card')).toHaveCount(0);

  // The Tray the exercise used: 70 × 30 at (50, 40), 2 mm deep — its far edge runs under the
  // back clamps' noses.
  await page.getByTestId('engrave-shape-name-0').fill('Tray');
  await page.getByTestId('engrave-shape-width-0').fill('70');
  await page.getByTestId('engrave-shape-height-0').fill('30');
  await page.getByTestId('engrave-shape-x-0').fill('50');
  await page.getByTestId('engrave-shape-y-0').fill('40');
  await page.getByTestId('engrave-shape-depth-0').fill('2');
  await page.waitForTimeout(1500);

  await page.getByTestId('engrave-generate').click();
  // The verifier writes the sentence (#724 B2's row); the footer used to show only a count, and
  // #725 B4 puts the Fix that resolves it beside it.
  await expect(page.getByTestId('engrave-run-errors')).toContainText(
    'runs under the clamp on the back edge, 15 mm in from the left-hand corner',
    { timeout: 240_000 },
  );
  // The bracket mount carries TWO back clamps, and the Tray's far edge runs under both noses: the
  // run states two clamp-in-path errors plus the verifier's, so the count is three (the walk was
  // written for one clamp, when the bracket's second clamp was not yet planned). #1070 C3.
  await expect(page.getByTestId('engrave-run-errors')).toContainText('(+2 more errors)');
  await expect(page.getByTestId('engrave-run-blocker-fix')).toBeVisible();

  await page.getByTestId('engrave-run-blocker-fix').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · Holding');
  await expect(page.getByTestId('engrave-setup-holding-picture-clamp').first()).toBeVisible();
});

test('#725 B7/W11 — a through cut taped on the wasteboard generates; a bare bed says the design’s sentence', async ({ cm, page }) => {
  await fakeHouse(page, { anchor: false });
  await cm.ready();
  await typePlate(page, [80, 60, 2]);

  // The taped default is written on arrival, with the wasteboard as what is under it.
  await expect(page.getByTestId('engrave-setup-mount-bed-tape')).toBeChecked();
  await expect(page.getByTestId('engrave-setup-bed-fields-bed-tape')).toContainText('wasteboard');

  // #1101 — UNDER TAPE THE FOLD SPEAKS THE BED'S WORDS: one "Which way round" fold, hold cards
  // reading left to right / front to back, and no jaw in the cards.
  const holdFold = page.getByTestId('engrave-setup-hold-fold');
  await expect(holdFold.locator('summary')).toContainText('Which way round');
  await holdFold.locator('summary').click();
  const holdCards = page.getByTestId('engrave-setup-orientation-holds');
  await expect(holdCards).toContainText('left to right');
  await expect(holdCards).not.toContainText('jaw');
  await page.screenshot({ path: 'test-results/1101-holding-tape.png' });
  // The last step's button is the create (#897); the pocket was the answer at step 2.
  await page.getByTestId('engrave-setup-next').click();

  // A 40 × 30 cut-out through the 2 mm sheet, INSIDE the blank (design fixture 2c).
  await page.getByTestId('engrave-shape-name-0').fill('Tag');
  await page.getByTestId('engrave-shape-width-0').fill('40');
  await page.getByTestId('engrave-shape-height-0').fill('30');
  await page.getByTestId('engrave-shape-x-0').fill('40');
  await page.getByTestId('engrave-shape-y-0').fill('30');
  await page.getByTestId('engrave-shape-through-0').check();
  await page.waitForTimeout(1500);

  // No through-needs-board: the wasteboard is the board under, and the button is open.
  await expect(page.getByTestId('engrave-generate-blocker')).toHaveCount(0);
  await expect(page.getByTestId('engrave-generate')).toBeEnabled();

  await page.getByTestId('engrave-generate').click();
  await page.waitForFunction(
    () => {
      const s = window.__caseMaker!.getEngraveRunState();
      return s.phase === 'ready' || s.phase === 'blocked';
    },
    undefined,
    { timeout: 240_000 },
  );
  const done = await runPhase(page);
  expect(done.phase).toBe('ready');
  expect(done.verifyErrors).toBe(0);
  await expect(page.getByTestId('engrave-run-errors')).toHaveCount(0);
});

test('#725 B6 — a hovered mount row does not preview; the picture follows the SELECTION (#1104)', async ({ cm, page }) => {
  await fakeHouse(page, { anchor: true });
  await cm.ready();
  await typePlate(page, [100, 60, 6]);

  // A 6 mm plate on a bed carrying the bracket takes the bracket. #1104 — THE PICTURE FOLLOWS THE
  // SELECTION: a row under the pointer or focus no longer redraws it, so hovering/focusing the
  // TAPE row leaves the bracket picture (the old hover preview was the #725 B6 reflow defect: the
  // shorter taped picture resized the centred wizard and pushed the control out from under the
  // pointer). The no-reflow guard stays; SELECTING tape is what moves the picture.
  const picture = page.getByTestId('engrave-setup-holding-picture');
  await expect(picture).toHaveAttribute('data-mount', 'bed-bracket');
  const next = page.getByTestId('engrave-setup-next');
  const before = await next.boundingBox();
  await page.getByTestId('engrave-setup-mount-row-bed-tape').hover();
  await page.waitForTimeout(500);
  await expect(picture).toHaveAttribute('data-mount', 'bed-bracket');
  await page.getByTestId('engrave-setup-mount-bed-tape').focus();
  await page.waitForTimeout(200);
  await expect(picture).toHaveAttribute('data-mount', 'bed-bracket');
  const after = await next.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
  expect(Math.abs(after!.x - before!.x)).toBeLessThan(1);

  // The selection is the one thing that moves it.
  await page.getByTestId('engrave-setup-mount-bed-tape').check();
  await expect(picture).toHaveAttribute('data-mount', 'bed-tape');
});

test('#725 W11 — a bare bed with no board under it says what to put there', async ({ cm, page }) => {
  await fakeHouse(page, { anchor: false, bare: true });
  await cm.ready();
  await typePlate(page, [80, 60, 2]);

  // The bare bed is what it says; the wizard's job has no through cut yet, so no board is offered
  // there and none is under the part.
  await expect(page.getByTestId('engrave-setup-bed-fields-bed-tape')).toContainText('bare bed');
  // The last step's button is the create (#897); the pocket was the answer at step 2.
  await page.getByTestId('engrave-setup-next').click();

  await page.getByTestId('engrave-shape-name-0').fill('Tag');
  await page.getByTestId('engrave-shape-width-0').fill('40');
  await page.getByTestId('engrave-shape-height-0').fill('30');
  await page.getByTestId('engrave-shape-x-0').fill('40');
  await page.getByTestId('engrave-shape-y-0').fill('30');
  await page.getByTestId('engrave-shape-through-0').check();
  await page.waitForTimeout(1500);

  await expect(page.getByTestId('engrave-generate-blocker')).toContainText(
    'and only the bed is under it — put a 2 mm MDF board under it, or tape it on the wasteboard',
  );
  await expect(page.getByTestId('engrave-generate')).toBeDisabled();
});
