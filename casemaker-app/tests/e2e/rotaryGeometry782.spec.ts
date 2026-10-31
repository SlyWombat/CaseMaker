// #782 — the Z1 4th-axis module drawn as it is: the T-slot extrusion on both pins, the L-shaped
// headstock with its motor out front, the four-jaw self-centring chuck facing +X, the tailstock
// on its rail with its dead-centre cone.
//
// The eyeball half, as the issue asks: the Machines card's bed scene at the module's place, and
// the Holding step's rotary front view for a rod, compared by eye with the manual's figures
// (`wiki.makera.com/z1-4th-axis-1.png` and `-4.png`, the clamped module). The numbers themselves
// are pinned in `tests/unit/drawnRotary.spec.ts` and `bedScene.spec.ts`.
//
// Run (WSL, this checkout):
//   CASEMAKER_PORT=5402 npx playwright test tests/e2e/rotaryGeometry782.spec.ts

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(240_000);

type Json = Record<string, unknown>;
type Doc = {
  kind: string;
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  machines: Json[];
  accessories: Json[];
  defaults?: Record<string, unknown>;
  inventory?: unknown;
  stock?: unknown;
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

const NOW = '2026-10-30T10:00:00.000Z';

/** The house with the module on the pins and the bed's axis datum read at machine (−155, −135, −40). */
async function fakeHouse(page: Page): Promise<void> {
  const raw = JSON.parse(JSON.stringify(DOC)) as Doc;
  const machine = raw.machines[0]!;
  machine.bedProfiles = [
    {
      id: 'bp-rotary-measured',
      name: '4th axis on the pins, bare bed',
      createdAt: NOW,
      basedOn: null,
      surface: {
        kind: 'bare-bed',
        material: null,
        length: null,
        width: null,
        thickness: null,
        position: null,
        provenance: {},
        scars: [],
        lastResurfacedAt: null,
      },
      datums: {
        surfaceTopZ: null,
        viseJawTopZ: null,
        bracketSeatZ: null,
        rotaryAxis: { value: -40, measuredAt: NOW, by: 'wired-probe', at: [-155, -135] },
      },
      placements: [
        {
          id: 'pl-rotary',
          fixture: 'fx-rotary',
          where: { kind: 'pins', pins: 'rotary', anchor: null },
          count: null,
          frame: null,
          provenance: {},
        },
      ],
      preferredMounting: [],
      consumables: null,
      history: [{ at: NOW, what: 'the 4th-axis module went on the pins' }],
    },
  ];
  machine.activeBedProfileId = 'bp-rotary-measured';
  raw.accessories = [
    {
      id: 'fx-rotary',
      kind: 'rotary-module',
      product: 'makera-4th-axis',
      variant: null,
      constants: {},
      unit: {},
      provenance: {},
      whereabouts: { kind: 'machine', machineId: 'machine-1a2b3c', since: NOW },
      history: [],
    },
  ];
  const view = {
    kind: raw.kind,
    schemaVersion: 1,
    id: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    migratedFrom: null,
    machines: [machine],
    accessories: raw.accessories,
    defaults: raw.defaults ?? {},
  };

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^.*\/api\/v1/, '');
    const json = (body: unknown): Promise<void> =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { etag: '"e1"' },
        body: JSON.stringify(body),
      });
    if (path === '/health') return json(HEALTH);
    if (path === '/tools') return json([]);
    if (path === '/inventory') return json(raw.inventory ?? []);
    if (path === '/stock') return json(raw.stock ?? []);
    if (path === '/defaults') return json(raw.defaults ?? {});
    if (path === '/location' && req.method() === 'GET') return json(view);
    return route.fulfill({ status: 404, body: '' });
  });
}

const shot = (testInfo: TestInfo, name: string): string => testInfo.outputPath(name);

test('#782 the bed scene draws the module at its axis reading', async ({ cm, page }, testInfo) => {
  await fakeHouse(page);
  await cm.ready();
  await page.evaluate(() => window.__caseMaker!.openManage('machines'));
  await expect(page.getByTestId('manage-bed')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('manage-bed-summary')).toContainText('4th axis on the pins', { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: shot(testInfo, '782-bed-scene.png'), fullPage: true });
});

test('#782 the Holding front view shows the module and a rod in the four-jaw chuck', async ({ cm, page }, testInfo) => {
  await fakeHouse(page);
  await cm.ready();
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  await page.getByTestId('start-wizard-form-rod').click();
  await page.getByTestId('start-wizard-make-diameter').fill('20');
  await page.getByTestId('start-wizard-make-length').fill('100');
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible({ timeout: 30_000 });
  // A round rod on a machine that carries the rotary: the chuck is the recommended mount.
  await expect(page.getByTestId('engrave-setup-mount-rotary')).toBeChecked();
  const slot = page.getByTestId('engrave-setup-holding-picture-slot');
  await expect(slot).toBeVisible();
  // The picture names the rod, the grip, the stick-out, the tailstock and the axis.
  const svg = page.getByTestId('engrave-setup-holding-picture');
  await expect(svg).toContainText('rod ⌀20');
  await expect(svg).toContainText('tailstock');
  await expect(svg).toContainText('A turns the rod about X');
  await slot.screenshot({ path: shot(testInfo, '782-rotary-front-view.png') });
});
