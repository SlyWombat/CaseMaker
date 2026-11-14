// #1102 item 9 (ruling B) — THE TAPED ROW ON THE HOUSE APP, with the bracket on the pins. The
// wizard states the 2026-11-07 tray hold (taped, the bracket's corner at anchor 1, no board under)
// and the three held-by states plus the bracket row are photographed as baselines.
//
// The bed has nothing on the pins and the thin bracket fitted at anchor 1; the desktop-mode dev
// server answers the step-1 check through the fake controller, as in holdingMatrix1104.spec.ts.
import type { Page } from '@playwright/test';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect, openSomethingElse, stockNext } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';
import { locationDocument, locationView, serveHouse, type Json } from './fixtures/fakeHouse';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(180_000);

/** The shared location with the bed empty and the thin bracket at anchor 1, tape and boards in. */
function houseWithBracket(): Json {
  const doc = locationDocument();
  const machine = doc.machines[0] as {
    bedProfiles: Array<{ placements: Array<Record<string, unknown>>; consumables: unknown }>;
  };
  machine.bedProfiles[0]!.placements = [
    {
      id: 'pl-bracket',
      fixture: 'fx-bracket-thin',
      where: { kind: 'anchor', anchor: 1, pins: null },
      count: null,
      seed: null,
      frame: null,
      provenance: {},
    },
  ];
  machine.bedProfiles[0]!.consumables = {
    tape: { widthMm: 20, thicknessMm: 0.2, provenance: 'typed' },
    boards: [{ material: 'MDF', size: [100, 100, 2], count: 4 }],
  };
  return locationView(doc);
}

async function reachHolding(page: Page, cm: { ready(): Promise<void> }): Promise<void> {
  await serveHouse(page, { location: houseWithBracket(), fromSharedDocument: true });
  await installFakeConsole(page, { steps: 4 });
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  await openSomethingElse(page);
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill('100');
  await page.getByTestId('start-wizard-make-width').fill('60');
  await page.getByTestId('start-wizard-make-thickness').fill('6');
  await stockNext(page);
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
}

/** The job the wizard has written so far, read from the store the page runs. */
async function jobHolding(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const mod = await import('/src/store/engraveJobStore.ts' as string);
    return mod.useEngraveJobStore.getState().job.workholding as Record<string, unknown>;
  });
}

test('#1102 — the tray hold is stated from the wizard: taped, the bracket’s corner at anchor 1', async ({ cm, page }) => {
  await reachHolding(page, cm);
  // A 6 mm plate opens on the bracket; the tape row is the operator's choice.
  await page.getByTestId('engrave-setup-mount-bed-tape').click();
  const fields = page.getByTestId('engrave-setup-bed-fields-bed-tape');
  await expect(fields).toBeVisible();

  // The bracket is on the pins, so the corner at its anchor is the default.
  await expect(page.getByTestId('engrave-setup-tape-located-corner-1')).toBeChecked();
  const held = (await jobHolding(page)) as { kind: string; tape?: Record<string, unknown> };
  expect(held.kind).toBe('tape');
  expect(held.tape).toMatchObject({
    where: null,
    squareTo: 'fence',
    fence: { kind: 'bracket', anchor: 1, variant: 'thin', edges: 'corner' },
  });
  await expect(fields).toHaveScreenshot('1102-held-corner.png');

  // The bed's front edge: tape, no fence.
  await page.getByTestId('engrave-setup-tape-located-front').click();
  await expect(fields).toHaveScreenshot('1102-held-front.png');
  const front = (await jobHolding(page)) as { kind: string; tape?: Record<string, unknown> };
  expect(front.tape).toMatchObject({ squareTo: 'front' });

  // Tape on a board under it — sacrificial.under gains the board, tape-attached.
  await page.getByTestId('engrave-setup-tape-on-board').click();
  await expect(fields).toHaveScreenshot('1102-held-board.png');

  // The bracket row states its datum as a fact.
  await page.getByTestId('engrave-setup-tape-on-blank').click();
  await page.getByTestId('engrave-setup-mount-bed-bracket').click();
  const bracketFields = page.getByTestId('engrave-setup-bed-fields-bed-bracket');
  await expect(bracketFields).toContainText('Located against');
  await expect(page.getByTestId('engrave-setup-bracket-located')).toContainText(
    'the bracket’s corner at anchor 1',
  );
  await expect(bracketFields).toHaveScreenshot('1102-held-bracket.png');
});
