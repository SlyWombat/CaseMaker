// #1104 item 10 — THE HOLDING STEP ON THE HOUSE APP, three machine states. A location with a Z1 and
// the house's accessories is served; the wizard walks to Holding on the DESKTOP-mode dev server
// (the build that can drive a machine), where a fake controller answers the step-1 check.
//
// Nothing on the pins: the vise row says what to do and carries "Change the machine…", and pressing
// it opens the machine-change wizard. With the vise on the pins its seats are rows to choose; with
// the rotary on the pins the three vise rows collapse to one literal row with its action. Each
// state's row list is a baseline (`holdingMatrix1104.spec.ts-snapshots/`).
import type { Page } from '@playwright/test';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect, openSomethingElse, stockNext } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';
import { locationDocument, locationView, serveHouse, type Json } from './fixtures/fakeHouse';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(180_000);

type Pins = 'nothing' | 'vise' | 'rotary';

/** The shared location fixture with its Z1 carrying `pins`, and a rotary module the house owns. */
function houseWith(pins: Pins): Json {
  const doc = locationDocument();
  const machine = doc.machines[0] as { bedProfiles: Array<{ placements: Array<Record<string, unknown>> }> };
  const base = machine.bedProfiles[0]!.placements[0]!;
  if (pins === 'nothing') machine.bedProfiles[0]!.placements = [];
  if (pins === 'rotary') {
    machine.bedProfiles[0]!.placements = [{ ...base, id: 'pl-rotary', where: { kind: 'pins', pins: 'rotary', anchor: null } }];
  }
  doc.accessories = [
    ...doc.accessories,
    {
      id: 'fx-rotary-1',
      kind: 'rotary-module',
      product: 'makera-4th-axis',
      variant: null,
      constants: {},
      unit: {},
      provenance: {},
      whereabouts: { kind: 'box' },
      history: [],
    },
  ];
  return locationView(doc);
}

async function reachHolding(page: Page): Promise<void> {
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

async function openHoldingWith(page: Page, pins: Pins, cm: { ready(): Promise<void> }): Promise<void> {
  await serveHouse(page, { location: houseWith(pins), fromSharedDocument: true });
  await installFakeConsole(page, { steps: 4 });
  await cm.ready();
  await reachHolding(page);
}

test('#1104 — nothing on the pins: the vise row carries its action in place, and the press opens the machine change', async ({
  cm,
  page,
}) => {
  await openHoldingWith(page, 'nothing', cm);
  const rows = page.getByTestId('engrave-setup-holding-vise');
  await expect(rows).toContainText('Put the vise on the pins');
  const change = rows.getByRole('button', { name: 'Change the machine…' }).first();
  await expect(change).toBeVisible();
  await expect(rows).toHaveScreenshot('holding-nothing-on-the-pins.png');
  await change.click();
  await expect(page.getByTestId('machine-change')).toBeVisible();
});

test('#1104 — the vise on the pins: its three seats are rows to choose, the bed rows carry their action', async ({ cm, page }) => {
  await openHoldingWith(page, 'vise', cm);
  const rows = page.getByTestId('engrave-setup-holding-vise');
  await expect(page.getByTestId('engrave-setup-mount-ledge')).toBeEnabled();
  await expect(rows).toContainText('Take the vise off the pins');
  await expect(rows).toHaveScreenshot('holding-vise-on-the-pins.png');
});

test('#1104 — the rotary on the pins: the vise seats collapse to one row that says what to do', async ({ cm, page }) => {
  await openHoldingWith(page, 'rotary', cm);
  const rows = page.getByTestId('engrave-setup-holding-vise');
  await expect(rows).toContainText('In the vise, …');
  await expect(rows).toContainText('Take the rotary off the pins');
  await expect(rows).toHaveScreenshot('holding-rotary-on-the-pins.png');
});
