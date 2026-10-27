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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(300_000);

type Doc = {
  kind: string;
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  migratedFrom?: string | null;
  machines: Array<Record<string, unknown> & { bedProfiles?: Array<Record<string, unknown>> }>;
  accessories: Array<Record<string, unknown>>;
  stock?: unknown;
  inventory?: unknown;
  defaults?: Record<string, unknown>;
};

const DOC = JSON.parse(
  readFileSync(fileURLToPath(new URL('../unit/fixtures/location-doc.json', import.meta.url)), 'utf8'),
) as Doc;

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
function locationView(opts: { anchor: boolean; bare?: boolean }): unknown {
  const doc = JSON.parse(JSON.stringify(DOC)) as Doc;
  const machine = doc.machines[0]!;
  const profile = machine.bedProfiles![0]!;
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
  return {
    kind: doc.kind,
    schemaVersion: doc.schemaVersion,
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    migratedFrom: doc.migratedFrom ?? null,
    machines: doc.machines,
    accessories: [...doc.accessories, ROTARY_FX],
  };
}

/** The exercise's fake house: health, the catalogue lists, the defaults and the location. */
async function fakeHouse(page: Page, view: unknown): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/v1/, '');
    const json = (body: unknown): Promise<void> =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { etag: '"e1"' },
        body: JSON.stringify(body),
      });
    if (path === '/health') return json(HEALTH);
    if (path === '/tools') return json([]);
    if (path === '/inventory') return json(DOC.inventory ?? []);
    if (path === '/stock') return json(DOC.stock ?? []);
    if (path === '/defaults') return json(DOC.defaults ?? {});
    if (path === '/location') return json(view);
    return route.fulfill({ status: 404, body: '' });
  });
}

/** Door → stock, typed: the operator's own plate. Leaves the wizard on the Holding step. */
async function typePlate(page: Page, dims: [number, number, number]): Promise<void> {
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
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
  await fakeHouse(page, locationView({ anchor: true }));
  await cm.ready();
  await typePlate(page, [100, 60, 6]);

  // The bed's default mount for a 6 mm plate on a bed carrying the bracket: the bracket.
  await expect(page.getByTestId('engrave-setup-mount-bed-bracket')).toBeChecked();
  await page.getByTestId('engrave-setup-next').click();
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByRole('button', { name: /Create the job/ }).click();

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
  await expect(page.getByTestId('engrave-run-errors')).toContainText('(+1 more error)');
  await expect(page.getByTestId('engrave-run-blocker-fix')).toBeVisible();

  await page.getByTestId('engrave-run-blocker-fix').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Holding');
  await expect(page.getByTestId('engrave-setup-holding-picture-clamp').first()).toBeVisible();
});

test('#725 B7/W11 — a through cut taped on the wasteboard generates; a bare bed says the design’s sentence', async ({ cm, page }) => {
  await fakeHouse(page, locationView({ anchor: false }));
  await cm.ready();
  await typePlate(page, [80, 60, 2]);

  // The taped default is written on arrival, with the wasteboard as what is under it.
  await expect(page.getByTestId('engrave-setup-mount-bed-tape')).toBeChecked();
  await expect(page.getByTestId('engrave-setup-bed-fields-bed-tape')).toContainText('wasteboard');
  await page.getByTestId('engrave-setup-next').click();
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByRole('button', { name: /Create the job/ }).click();

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

test('#725 B6 — hovering a mount row previews it without moving the wizard’s controls', async ({ cm, page }) => {
  await fakeHouse(page, locationView({ anchor: true }));
  await cm.ready();
  await typePlate(page, [100, 60, 6]);

  // A 6 mm plate on a bed carrying the bracket takes the bracket; hovering the TAPE row previews
  // the (shorter) taped picture. Before #725 B6 the picture's height resized the centred wizard
  // and the control under the pointer was pushed out from under it — a hover/reflow loop.
  await expect(page.getByTestId('engrave-setup-holding-picture')).toHaveAttribute('data-mount', 'bed-bracket');
  const next = page.getByTestId('engrave-setup-next');
  const before = await next.boundingBox();
  await page.getByTestId('engrave-setup-mount-row-bed-tape').hover();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('engrave-setup-holding-picture')).toHaveAttribute('data-mount', 'bed-tape');
  const after = await next.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
  expect(Math.abs(after!.x - before!.x)).toBeLessThan(1);
});

test('#725 W11 — a bare bed with no board under it says what to put there', async ({ cm, page }) => {
  await fakeHouse(page, locationView({ anchor: false, bare: true }));
  await cm.ready();
  await typePlate(page, [80, 60, 2]);

  // The bare bed is what it says; the wizard's job has no through cut yet, so no board is offered
  // there and none is under the part.
  await expect(page.getByTestId('engrave-setup-bed-fields-bed-tape')).toContainText('bare bed');
  await page.getByTestId('engrave-setup-next').click();
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByRole('button', { name: /Create the job/ }).click();

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
