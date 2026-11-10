// #930 — THE DEFAULT JOB IS ONE THE GATE ACCEPTS.
//
// On main 5bcc5a88 a first operator who kept every default got a 1.5 mm plate sized from the text,
// a Holding step that disabled the ledge and selected nothing, and a Generate that drove the facing
// pass into the moving jaw. #930 replaces the proposal with the house's stock — a 36 × 36 × 100 mm
// hardwood stick worked on its 36 × 100 face — so both default walks (engrave and pocket) reach the
// four ticks.
//
// THE LOCATION IS FAKED, the way bedWizard.spec.ts fakes it: the committed location document's
// machine (with its measured vise) is served from `page.route`, and `/tools` answers [] so the
// built-in cutter is the recommendation — serving the fixture's own two cutters picks the ⌀3.175
// and the oracle under-cuts by 0.0223 mm² (a separate finding, reported to the manager).
//
// The acceptance is asserted in the walk: the house-stock sentence, the Block form pressed, the
// three sizes, the Block mount checked with no unblock sentence, four ticks, and no code token or
// over-long float in the wizard's or the run's operator text.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

import { test, expect } from './fixtures/caseMaker';

test.setTimeout(300_000);

type Json = Record<string, unknown>;
type Doc = {
  kind: string;
  id: string;
  name: string;
  createdAt: string;
  machines: Json[];
  inventory: Json[];
  stock: Json[];
  defaults: Json;
  accessories: Json[];
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
};

/** The shipped location, served read-only: its machine (the measured vise) and nothing else. */
async function fakeLocation(page: Page): Promise<void> {
  const view = {
    kind: DOC.kind,
    schemaVersion: 1,
    id: DOC.id,
    name: DOC.name,
    createdAt: DOC.createdAt,
    migratedFrom: null,
    machines: DOC.machines,
    // The house owns its vise (`fx-vise-1`); without it the Holding step calls every vise mount
    // "not owned" and the default walk cannot select the block.
    accessories: DOC.accessories,
  };
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^.*\/api\/v1/, '');
    const json = (body: unknown): Promise<void> =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: { etag: '"e1"' }, body: JSON.stringify(body) });
    if (path === '/health') return json(HEALTH);
    if (path === '/tools') return json([]);
    if (path === '/inventory') return json(DOC.inventory ?? []);
    if (path === '/stock') return json(DOC.stock ?? []);
    if (path === '/defaults') return json(DOC.defaults ?? {});
    if (path === '/location' && req.method() === 'GET') return json(view);
    if (req.method() !== 'GET') return json({ ok: true });
    return route.fulfill({ status: 404, body: '' });
  });
}

/** The default-job walk's operator text may carry no code token and no long float. */
function expectCleanText(where: string, text: string): void {
  const CODE =
    /#\d+|\b(?:cat|inv|bp):|\blbl-|\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:default|refused)\b|\b(?:flat|ball|bull|chamfer|engraver|drill|thread)-\d[\w.]*|\bvise-[a-z-]+/g;
  const FLOAT = /\d+\.\d{4,}/g;
  const hits = [...text.matchAll(CODE), ...text.matchAll(FLOAT)].map((m) => m[0]);
  expect(hits, `${where}: developer text in the operator's sentence`).toEqual([]);
}

const TICKS = ['engrave-run-toolpath', 'engrave-run-verified', 'engrave-run-simulated', 'engrave-run-oracle'];

/**
 * Door → the wizard's defaults → Generate's four ticks. `pocket` is the second walk (no text
 * field); everything else is the same.
 */
async function walkToTicks(page: Page, kind: 'engrave' | 'pocket'): Promise<void> {
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();

  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 2 of 4 · What are you cutting?');
  await page.getByTestId(`engrave-setup-what-${kind}`).click();
  if (kind === 'engrave') await page.getByTestId('start-wizard-op-text').fill('Zoomba');
  await page.getByTestId('start-wizard-operation-next').click();

  // Step 3 — the house's stick, proposed for both kinds of work.
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 3 of 4 · Stock');
  await expect(page.getByTestId('engrave-setup-stock-provenance')).toHaveText(
    'The stock this workshop keeps: a 36 × 36 × 100 mm hardwood stick, worked on its 36 × 100 face.',
  );
  await expect(page.getByTestId('start-wizard-form-block')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('start-wizard-make-length')).toHaveValue('36');
  await expect(page.getByTestId('start-wizard-make-width')).toHaveValue('100');
  await expect(page.getByTestId('start-wizard-make-thickness')).toHaveValue('36');
  await expect(page.getByTestId('start-wizard-stock-unblock')).toHaveCount(0);
  expectCleanText(`${kind} stock`, await page.getByTestId('start-wizard-body').innerText());
  await page.getByTestId('start-wizard-stock-next').click();

  // Step 4 — the stick on the vise's body, and Create offered: no disabled hold left the flow with
  // nothing selected.
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · Holding');
  await expect(page.getByTestId('engrave-setup-mount-block')).toBeChecked();
  await expect(page.getByTestId('start-wizard-holding-unblock')).toHaveCount(0);
  await expect(page.getByTestId('start-wizard-holding-block')).toHaveCount(0);
  expectCleanText(`${kind} holding`, await page.getByTestId('start-wizard-body').innerText());
  await expect(page.getByTestId('engrave-setup-next')).toBeEnabled();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);

  // Generate — the four ticks, then the terminal "Cut…" word.
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
  await expect(page.getByTestId('engrave-generate')).toBeEnabled();
  await page.getByTestId('engrave-generate').click();
  for (const id of TICKS) {
    await expect(page.getByTestId(id), id).toHaveAttribute('data-state', 'tick', { timeout: 180_000 });
  }
  await expect(page.getByTestId('engrave-generate')).toHaveText('Cut…');
  expectCleanText(`${kind} run`, await page.getByTestId('engrave-panel').innerText());
}

test('#930 — the engrave default reaches four ticks on the house’s stick', async ({ cm, page }) => {
  await fakeLocation(page);
  await cm.ready();
  await walkToTicks(page, 'engrave');
});

test('#930 — the pocket default reaches four ticks on the same stick', async ({ cm, page }) => {
  await fakeLocation(page);
  await cm.ready();
  await walkToTicks(page, 'pocket');
});

// #930 — A DISABLED OPTION NEVER LEAVES NOTHING SELECTED. The old walk's saved ledge seat and a
// 1.5 mm plate left the ledge radio disabled with NO radio checked, and Create still wrote the job
// into that ledge. Now the step arrives in the mount the stock's numbers call for (the waste board),
// the ledge row still states its cost, and Create is live because a real mount is selected.
//
// The residual case — a setup the stock cannot sit in AND no arrival move — is the one where the
// step states the reason and keeps Create off until a mount is chosen; that is `holdingStep.spec.tsx`
// (#930: "a hold the stock cannot sit in disables Create with its reason") at the store seam.
test('#930 — a saved ledge the stock cannot sit in arrives on the waste board, with Create live', async ({ cm, page }) => {
  await fakeLocation(page);
  // The user's own saved vise: the measured numbers, seated on the ledge. Decision 28 puts it above
  // the machine's measured reading, so the wizard's new job starts in it.
  await page.addInitScript(() => {
    localStorage.setItem(
      'casemaker.settings.v1',
      JSON.stringify({
        fixtures: {
          vise: {
            stockProud: 1.5,
            fixedJawThickness: 10,
            movingJawThickness: 10,
            jawLength: 100,
            jawStartY: -10,
            source: 'saved',
            uncertainty: 0.1,
            measuredAt: '2026-10-13',
            seat: 'ledge',
          },
        },
      }),
    );
  });
  await cm.ready();

  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  await page.getByTestId('engrave-setup-what-engrave').click();
  await page.getByTestId('start-wizard-op-text').fill('Zoomba');
  await page.getByTestId('start-wizard-operation-next').click();

  // The blank the saved seat cannot take: a 1.5 mm plate whose top would sit below the jaw tops.
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill('60.3');
  await page.getByTestId('start-wizard-make-width').fill('20.1');
  await page.getByTestId('start-wizard-make-thickness').fill('1.5');
  await page.getByTestId('start-wizard-stock-next').click();

  // Step 4 — the board is selected, the ledge still states its cost, and Create is live.
  await expect(page.getByTestId('start-wizard-progress')).toHaveText('Step 4 of 4 · Holding');
  await expect(page.getByTestId('engrave-setup-mount-board')).toBeChecked();
  await expect(page.getByTestId('engrave-setup-mount-ledge')).toBeDisabled();
  await expect(page.getByTestId('engrave-setup-mount-ledge')).not.toBeChecked();
  await expect(page.getByTestId('engrave-setup-mount-row-ledge')).toContainText(
    'it would sit 1.6 mm below the jaw tops',
  );
  await expect(page.getByTestId('start-wizard-holding-unblock')).toHaveCount(0);
  await expect(page.getByTestId('engrave-setup-next')).toBeEnabled();
  await page.getByTestId('engrave-setup-next').click();
  await expect(page.getByTestId('start-wizard')).toHaveCount(0);
  await expect(page.getByTestId('engrave-panel')).toBeVisible();
});
