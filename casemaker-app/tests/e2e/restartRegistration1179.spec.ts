// #1179 B — RESTARTING A JOB ON A BLANK THAT HAS BEEN CUT, in the real UI against the fake machine.
//
// Today's tray is the UNKNOWN-CUTS case: the machine's finished hashes are not in the current
// package (the plan was regenerated), so the check points sit outside today's footprint at d = 0
// and the record says the earlier cuts are not recorded. The top is the highest implied level two
// touches agree on; a hidden floor under one candidate is out-voted, and a chip above three tops
// is named and not used. The origin is written from the accepted top.
//
// Screenshots: /mnt/house/casemaker/qa/2026-11-10/1179/.
import fs, { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { lanServerPort } from '../../scripts/e2ePort';
import { test, expect } from './fixtures/caseMaker';
import { installFakeConsole, type FakeConsole } from './fixtures/fakeConsole';

test.use({ baseURL: `http://127.0.0.1:${lanServerPort()}` });
test.setTimeout(420_000);

const OUT = '/mnt/house/casemaker/qa/2026-11-10/1179';
const SEAT_Z = -85.788;
const STOCK_MM = 25;
const TOP_Z = -60.788; // the plan's expected top: the seat + the job's stated 25 mm
const TOP_READING = -60.788;

type Doc = {
  kind: string;
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  machines: Array<Record<string, unknown> & { finishedPrograms?: string[]; bedProfiles?: Array<Record<string, unknown>> }>;
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

/**
 * The bench's location: the machine has a finished program that is NOT in the package (the
 * unknown-cuts case), the active profile carries the measured seat, the bracket sits at anchor 1,
 * and the surface tolerance is the live shop's 0.7 (the fixture seeds 0.4).
 */
function locationView(): unknown {
  const doc = JSON.parse(JSON.stringify(DOC)) as Doc;
  const machine = doc.machines[0]!;
  machine.finishedPrograms = ['fake-finished-1'];
  const profile = machine.bedProfiles![0]! as {
    placements?: Array<{ where?: { kind?: string } }>;
    datums: Record<string, unknown>;
  };
  profile.datums['bracketSeatZ'] = {
    value: SEAT_Z,
    measuredAt: '2026-11-09T17:55:01.000Z',
    by: 'fx-probe-1',
    at: [-175, -35],
    restsOnStock: true,
  };
  profile.placements = (profile.placements ?? []).filter(
    (pl) => ((pl as { where?: { kind?: string } }).where?.kind ?? '') !== 'pins',
  );
  profile.placements.push({
    id: 'pl-bracket',
    fixture: 'fx-bracket-thin',
    where: { kind: 'anchor', anchor: 1, pins: null },
    count: null,
    frame: null,
    provenance: {},
  } as never);
  return {
    kind: doc.kind,
    schemaVersion: doc.schemaVersion,
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    machines: doc.machines,
    accessories: doc.accessories,
  };
}

async function fakeHouse(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^.*\/api\/v1/, '');
    const json = (body: unknown): Promise<void> =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: { etag: '"e1"' }, body: JSON.stringify(body) });
    if (p === '/health') return json(HEALTH);
    if (p === '/tools') return json([]);
    if (p === '/inventory') return json(DOC.inventory ?? []);
    if (p === '/stock') return json(DOC.stock ?? []);
    if (p === '/defaults') {
      const defaults = JSON.parse(JSON.stringify(DOC.defaults ?? {})) as Record<string, unknown>;
      // The live shop's tolerance (chosen 2026-10-23); the fixture seeds 0.4.
      defaults['registration.surfaceToleranceMm'] = { value: 0.7, source: 'chosen', setAt: '2026-10-23', unit: 'mm' };
      return json(defaults);
    }
    if (p === '/location') return json(locationView());
    return route.fulfill({ status: 404, body: '' });
  });
}

const STATUS = '<Idle|MPos:0,0,0|WPos:0,0,0|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>';

async function rememberMachine(page: Page): Promise<void> {
  await page.evaluate((line) => {
    window.__caseMaker!.setMachine(
      {
        name: 'QA Z1',
        host: '192.0.2.10',
        port: 2222,
        busy: false,
        ip: null,
        mac: null,
        status: line,
        profileId: 'Z1',
        observedAt: '2026-10-25T00:00:00.000Z',
        notes: [],
      },
      line,
    );
  }, STATUS);
}

async function typePlate(page: Page, dims: [number, number, number]): Promise<void> {
  await page.getByTestId('welcome-start-cnc').click();
  await page.getByTestId('start-wizard-next').click();
  await page.getByTestId('engrave-setup-what-pocket').click();
  await page.getByTestId('start-wizard-operation-next').click();
  await page.getByTestId('start-wizard-form-plate').click();
  await page.getByTestId('start-wizard-make-length').fill(String(dims[0]));
  await page.getByTestId('start-wizard-make-width').fill(String(dims[1]));
  await page.getByTestId('start-wizard-make-thickness').fill(String(dims[2]));
  await page.getByTestId('start-wizard-stock-next').click();
  await expect(page.getByTestId('engrave-setup-step-holding')).toBeVisible();
}

/** The shared walk up to the Register press, with the pocket centred and Generate green. */
async function prepare(page: Page, fake: FakeConsole): Promise<void> {
  await fakeHouse(page);
  await rememberMachine(page);
  fake.setFeature({ kind: 'boss', radiusMm: 400, centre: { x: -140, y: -163 }, topZ: TOP_READING });

  await typePlate(page, [100, 60, STOCK_MM]);
  await expect(page.getByTestId('engrave-setup-mount-bed-bracket')).toBeChecked();
  await page.getByTestId('engrave-setup-next').click();
  await page.getByTestId('engrave-shape-name-0').fill('Tray');
  await page.getByTestId('engrave-shape-width-0').fill('40');
  await page.getByTestId('engrave-shape-height-0').fill('30');
  await page.getByTestId('engrave-shape-x-0').fill('50');
  await page.getByTestId('engrave-shape-y-0').fill('30');
  await page.getByTestId('engrave-shape-depth-0').fill('2');
  await page.waitForTimeout(1500);
  await page.getByTestId('engrave-generate').click();
  await expect(page.getByTestId('engrave-run-oracle')).toHaveAttribute('data-state', 'tick', { timeout: 300_000 });

  await page.getByTestId('cnc-mode-cut').click();
  await expect(page.getByTestId('engrave-cut-surface')).toBeVisible();
  const step1 = page.getByTestId('engrave-cut-step-1');
  if (!(await step1.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-1-summary').click();
  }
  await page.getByTestId('engrave-ack').check();
  const step2 = page.getByTestId('engrave-cut-step-2');
  if (!(await step2.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('engrave-cut-step-2-summary').click();
  }
  await expect(page.getByTestId('engrave-registration-proposal-line')).toContainText('then the top');
  await page.getByTestId('engrave-registration-approve-start').click();
  // The seek path keeps the #427 clamp confirm; the checks move nothing sideways from it.
  await page.getByTestId('engrave-registration-continue').click();
}

async function writeOriginAndExpect(page: Page, fake: FakeConsole, z: string): Promise<void> {
  await page.getByTestId('engrave-registration-write').click();
  await page.getByTestId('engrave-registration-continue').click();
  await expect.poll(() => fake.lines().find((l) => l.startsWith('G10 L2 P1')) ?? null, { timeout: 60_000 }).not.toBeNull();
  expect(fake.lines().find((l) => l.startsWith('G10 L2 P1'))).toContain(`Z${z}`);
}

test('#1179 B — a hidden floor under one check is out-voted; the top and the origin come from the agreeing touches', async ({
  cm,
  page,
}) => {
  const fake = await installFakeConsole(page);
  fake.setProbeOffsets([-0.6, 0, 0]); // the first check sits on an unrecorded floor, 0.6 low
  await cm.ready();
  await prepare(page, fake);

  await expect(page.getByTestId('engrave-registration-notes')).toContainText('the top was measured on a cut blank', {
    timeout: 120_000,
  });
  await expect(page.getByTestId('engrave-registration-notes')).toContainText('earlier plan’s cuts are not recorded');
  await expect(page.getByTestId('engrave-registration-notes')).toContainText('implied top');
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'hidden-floor-result.png') });
  await writeOriginAndExpect(page, fake, String(TOP_Z));
});

test('#1179 B — a chip above three agreeing tops is out-voted, named, and not used', async ({ cm, page }) => {
  const fake = await installFakeConsole(page);
  fake.setProbeOffsets([0.38, 0, 0, 0]); // the first check reads 0.38 high (inside the live band)
  await cm.ready();
  await prepare(page, fake);

  await expect(page.getByTestId('engrave-registration-notes')).toContainText('was not used', { timeout: 120_000 });
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'chip-result.png') });
  await writeOriginAndExpect(page, fake, String(TOP_Z));
});
