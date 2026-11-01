// #607 — THE ROTARY AXIS FROM THE MODULE'S CARD, end to end on the desktop bundle served headless (#821/#867: the build
// that can reach a machine). The 4th-axis module is checked out to the Z1; its card in Manage ›
// Accessories runs the shared tap against the fake console's chuck — a 40 mm body about the axis
// Y −180, Z −50 — shows the measured Y, Z and R beside the check chord's residual, and writes the
// reading to the active bed profile's `rotaryAxis` datum. Screenshot under
// docs/bench/img/2026-10-31-rotary-tap/.
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';
import { installFakeConsole } from './fixtures/fakeConsole';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(180_000);

const OUT = path.join(path.resolve(process.cwd(), '..'), 'docs', 'bench', 'img', '2026-10-31-rotary-tap');

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

const NOW = '2026-10-31T00:00:00.000Z';

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

interface House {
  /** The machine record the service now holds (the latest machine PUT). */
  machine(): Json & { bedProfiles?: Json[]; activeBedProfileId?: string };
}

/**
 * A one-machine house: the fixture's Z1 with a read frame and an ACTIVE bed profile whose surface
 * top is measured, a measured 3D probe checked out to it, and the 4th-axis module checked out to it.
 * Every handler keeps the served document current, so the tap's PUT is what a later read sees.
 */
async function fakeHouse(page: Page): Promise<House> {
  const raw = JSON.parse(JSON.stringify(DOC)) as Doc;
  const machine = raw.machines[0]!;
  machine.address = { host: '192.0.2.10', port: 2222 };
  machine.fixtures = null;
  machine.wasteboard = null;
  machine.activeBedProfileId = 'bed-e2e';
  machine.bedProfiles = [
    {
      id: 'bed-e2e',
      name: 'QA bed',
      createdAt: NOW,
      basedOn: null,
      surface: { kind: 'bare-bed' },
      datums: {
        surfaceTopZ: { value: -76, measuredAt: NOW, by: 'fx-probe-3d', at: null },
        viseJawTopZ: null,
        bracketSeatZ: null,
        rotaryAxis: null,
      },
      placements: [],
      preferredMounting: [],
      consumables: null,
      history: [],
    },
  ];
  const probe = {
    id: 'fx-probe-3d',
    kind: 'probe',
    product: 'Makera 3D Probe',
    variant: '3d',
    unit: { tipDiameterMm: 2, rimOffsetMm: 0.875, rimOffsetUncertaintyMm: 0.01 },
    whereabouts: { kind: 'machine', machineId: machine.id, since: NOW },
    provenance: {},
    history: [],
  };
  const module = {
    id: 'e2e-rotary',
    kind: 'rotary-module',
    product: 'Makera 4th-axis module',
    variant: null,
    constants: {},
    unit: { axisXMm: -150 },
    provenance: {},
    whereabouts: { kind: 'machine', machineId: machine.id, since: NOW },
    history: [],
  };
  const view: { kind: string; schemaVersion: number; id: string; name: string; createdAt: string; migratedFrom: null; machines: Json[]; accessories: Json[] } = {
    kind: raw.kind,
    schemaVersion: 1,
    id: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    migratedFrom: null,
    machines: [machine],
    accessories: [probe, module],
  };

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname.replace(/^.*\/api\/v1/, '');
    const json = (body: unknown): Promise<void> =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { etag: '"e1"' },
        body: JSON.stringify(body),
      });

    if (pathname === '/health') return json(HEALTH);
    if (pathname === '/tools') return json([]);
    if (pathname === '/inventory') return json(raw.inventory ?? []);
    if (pathname === '/stock') return json(raw.stock ?? []);
    if (pathname === '/defaults') return json(raw.defaults ?? {});
    if (pathname === '/location' && req.method() === 'GET') return json(view);

    const machinePath = /^\/location\/machines\/(.+)$/.exec(pathname);
    if (machinePath !== null && req.method() === 'PUT') {
      const record = req.postDataJSON() as Json;
      view.machines = view.machines.map((m) => (m.id === record.id ? record : m));
      return json({ ok: true });
    }
    const accessoryPath = /^\/location\/accessories\/(.+)$/.exec(pathname);
    if (accessoryPath !== null && req.method() === 'PUT') {
      const record = req.postDataJSON() as Json;
      view.accessories = [...view.accessories.filter((a) => a.id !== record.id), record];
      return json({ ok: true });
    }
    return route.fulfill({ status: 404, body: '' });
  });

  return { machine: () => view.machines[0] as Json & { bedProfiles?: Json[]; activeBedProfileId?: string } };
}

test('#607 — the module card measures the axis and writes rotaryAxis', async ({ cm, page }) => {
  const house = await fakeHouse(page);
  // The bench chuck: a 40 mm body about the axis Y −180, machine Z −50.
  const fake = await installFakeConsole(page);
  fake.setChuck({ axisY: -180, axisZ: -50, radiusMm: 40 });
  await cm.ready();

  await page.evaluate(() => window.__caseMaker!.openManage('accessories'));
  await expect(page.getByTestId('manage-mode')).toBeVisible();
  await expect(page.getByTestId('manage-accessories-table')).toBeVisible();
  await page.getByTestId('manage-accessories-pick-e2e-rotary').click();

  const tap = page.getByTestId('manage-acc-rotary-tap');
  await expect(tap).toBeVisible();
  // The nominal axis the card starts from until one has been measured.
  await expect(page.getByTestId('manage-acc-rotary-tap-x')).toHaveValue('-150');
  await expect(page.getByTestId('manage-acc-rotary-tap-y')).toHaveValue('-180');
  await expect(page.getByTestId('manage-acc-rotary-tap-z')).toHaveValue('-50');
  await expect(page.getByTestId('manage-acc-rotary-tap-r')).toHaveValue('40');

  await page.getByTestId('manage-acc-rotary-tap-measure').click();
  await page.getByTestId('manage-acc-rotary-tap-continue').click(); // fit the 3D probe
  await expect(page.getByTestId('manage-acc-rotary-tap-result')).toBeVisible({ timeout: 60_000 });

  // The measured axis, and the check chord's residual against the fitted circle.
  await expect(page.getByTestId('manage-acc-rotary-tap-measured')).toContainText('Y -180');
  await expect(page.getByTestId('manage-acc-rotary-tap-measured')).toContainText('Z -50');
  await expect(page.getByTestId('manage-acc-rotary-tap-measured')).toContainText('R 40');
  await expect(page.getByTestId('manage-acc-rotary-tap-residual')).toContainText('matches the fitted circle');
  await expect(page.getByTestId('manage-acc-rotary-tap-note')).toContainText('the axis is recorded');

  // The datum on the served record: axis Z in `value`, the axis line's Y in `at`, R beside it.
  const profiles = house.machine().bedProfiles ?? [];
  const bed = profiles.find((p) => (p as Json).id === 'bed-e2e') as Json | undefined;
  const datum = ((bed?.datums ?? {}) as Json).rotaryAxis as { value: number; at: number[]; radiusMm: number } | null;
  expect(datum, 'the axis datum landed').not.toBeNull();
  expect(datum!.value).toBeCloseTo(-50, 1);
  expect(datum!.at[0]).toBe(-150);
  expect(datum!.at[1]).toBeCloseTo(-180, 1);
  expect(datum!.radiusMm).toBeCloseTo(40, 1);

  // The touches went out as machine-coordinate probing, with the supply bracket and the crown.
  const lines = fake.lines();
  expect(lines.some((l) => l.startsWith('G53 G0 X-150 Y-230'))).toBe(true);
  expect(lines.filter((l) => l.startsWith('G38.3 Y')).length).toBeGreaterThanOrEqual(4); // two chords, two sides
  expect(lines).toContain('M831');
  expect(lines).toContain('M832');

  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'axis-measured.png') });
});
