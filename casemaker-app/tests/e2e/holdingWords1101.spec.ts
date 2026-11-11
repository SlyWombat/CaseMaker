// #1101 item 7 — THE HOLDING STEP SPEAKS ITS MOUNT, on the house app. One walk per mount (vise,
// tape, rotary): exactly one "Which way round" fold, the selected row + the fold + the picture free
// of the other mounts' words, and a baseline of the step under each.
import type { Page } from '@playwright/test';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect, openSomethingElse } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';
import { locationDocument, locationView, serveHouse, type Json } from './fixtures/fakeHouse';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(180_000);

type Pins = 'vise' | 'nothing' | 'rotary';

/** The shared location with its Z1 carrying `pins`; nothing-on-the-pins also gets the bracket. */
function houseWith(pins: Pins): Json {
  const doc = locationDocument();
  const machine = doc.machines[0] as {
    bedProfiles: Array<{ placements: Array<Record<string, unknown>>; consumables: unknown }>;
  };
  const base = machine.bedProfiles[0]!.placements[0]!;
  if (pins === 'nothing') {
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
  }
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
      // On the machine for the rotary walk, so the question step offers its On a rod intents.
      whereabouts:
        pins === 'rotary'
          ? { kind: 'machine', machineId: 'makera-z1-1a2b3c', since: '2026-10-27T09:00:00.000Z' }
          : { kind: 'box' },
      history: [],
    },
  ];
  return locationView(doc);
}

async function reachHolding(page: Page, cm: { ready(): Promise<void> }, pins: Pins): Promise<void> {
  await serveHouse(page, { location: houseWith(pins), fromSharedDocument: true });
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
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
}

/** The selected row, the one fold and the picture — the three places a mount's words live. */
async function scopedText(page: Page, mount: string): Promise<string> {
  return page.evaluate((m) => {
    const row = document.querySelector(`[data-testid="engrave-setup-mount-row-${m}"]`);
    const fold = document.querySelector('[data-testid="engrave-setup-hold-fold"]');
    const picture = document.querySelector('[data-testid="engrave-setup-holding-picture"]');
    return [row?.textContent ?? '', fold?.textContent ?? '', picture?.textContent ?? ''].join(' ');
  }, mount);
}

test('#1101 — the vise: its jaw words, one fold, and no chuck or anchor', async ({ cm, page }) => {
  await reachHolding(page, cm, 'vise');
  await expect(page.locator('summary', { hasText: 'Which way round' })).toHaveCount(1);
  const text = await scopedText(page, 'ledge');
  expect(text).toMatch(/jaw/i);
  expect(text).not.toMatch(/chuck/i);
  // The fold's own contents are the subject: open it before the shot.
  await page.getByTestId('engrave-setup-hold-fold').evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
  await expect(page.getByTestId('engrave-setup-step-holding')).toHaveScreenshot('1101-holding-vise.png');
});

test('#1101 — the tape: no jaw, no proud, no shipped dimensions; one fold', async ({ cm, page }) => {
  await reachHolding(page, cm, 'nothing');
  await page.getByTestId('engrave-setup-mount-bed-tape').click();
  await expect(page.getByTestId('engrave-setup-bed-fields-bed-tape')).toBeVisible();
  await expect(page.locator('summary', { hasText: 'Which way round' })).toHaveCount(1);
  const text = await scopedText(page, 'bed-tape');
  expect(text).not.toMatch(/jaw/i);
  expect(text).not.toMatch(/proud/i);
  expect(text).not.toMatch(/shipped/i);
  await page.getByTestId('engrave-setup-hold-fold').evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
  await expect(page.getByTestId('engrave-setup-step-holding')).toHaveScreenshot('1101-holding-tape.png');
});

test('#1101 — the rotary: Chuck end and Text reads, no hold cards, no fixed jaw', async ({ cm, page }) => {
  // The rod path: on the pins, the On a rod intents appear; Name on a dowel makes the rod job.
  await serveHouse(page, { location: houseWith('rotary'), fromSharedDocument: true });
  await installFakeConsole(page, { steps: 4 });
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await expect(page.getByTestId('start-wizard')).toBeVisible();
  await page.getByTestId('start-wizard-next').click();
  await expect(page.getByTestId('start-wizard-rotary-intents')).toBeVisible();
  await page.getByTestId('start-wizard-rotary-intent-dowel').click();
  await page.getByTestId('start-wizard-op-text').fill('Hello');
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-mount-rotary')).toBeChecked();
  await expect(page.getByTestId('engrave-setup-hold-fold')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-orientation-holds')).toHaveCount(0);
  await expect(page.getByTestId('engrave-setup-rotary-chuck-end')).toContainText('Chuck end');
  const text = await scopedText(page, 'rotary');
  expect(text).not.toMatch(/fixed jaw/i);
  await page.getByTestId('engrave-setup-hold-fold').evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
  await expect(page.getByTestId('engrave-setup-rotary-chuck-end')).toBeVisible();
  await expect(page.getByTestId('engrave-setup-step-holding')).toHaveScreenshot('1101-holding-rotary.png');
});
