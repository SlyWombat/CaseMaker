// #512 — the first-run bed wizard, in a real browser.
//
// The dev server serves the WEB target, which has no house service, so the location is answered by
// `page.route('**/api/v1/**')` — the fake-house pattern `bedDefects725.spec.ts` uses — and the two
// writes the wizard makes (accessories, then the machine) are applied to the served document, so a
// later GET is what the app would read from a real service.
//
// THE NO-MACHINE-MOVES RULE IS THE WALK. The machine record is a first-run one (no bed profile, no
// legacy wasteboard or vise to migrate), and every step is completed with its measurement rows left
// unmeasured: nothing here clicks a probe, and the saved profile's four datums are all null.
//
// Three walks:
//   1. the Makera kit, S0 → S6, with a close-and-reopen proving the draft resumes, then the save;
//   2. the vise template plus the 4th-axis module — the shared-pins conflict stated with its fix,
//      the fix applied, and the vise-only bed saved;
//   3. the empty template with all five answer steps skipped — a bare bed saved with its name typed
//      at S6, and the draft cleared so the wizard starts at S0 again.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/caseMaker';

test.setTimeout(120_000);

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

interface House {
  /** The machine record the service now holds (the latest machine PUT, or the first-run one). */
  machine(): Json & { bedProfiles?: Json[]; activeBedProfileId?: string };
  accessories(): Json[];
}

/**
 * A first-run house: the fixture's machine with its bed keys removed, no legacy wasteboard or vise
 * (so the #510 migration has nothing to create and the bed stays "not described"), and no
 * accessories checked out. Every handler keeps the served document current.
 */
async function fakeHouse(page: Page): Promise<House> {
  const raw = JSON.parse(JSON.stringify(DOC)) as Doc;
  const machine = raw.machines[0]!;
  delete machine.bedProfiles;
  delete machine.activeBedProfileId;
  machine.fixtures = null;
  machine.wasteboard = null;
  const view = {
    kind: raw.kind,
    schemaVersion: 1,
    id: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    migratedFrom: null,
    machines: [machine],
    accessories: [] as Json[],
  };

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
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
    if (path === '/inventory') return json(raw.inventory ?? []);
    if (path === '/stock') return json(raw.stock ?? []);
    if (path === '/defaults') return json(raw.defaults ?? {});
    if (path === '/location' && req.method() === 'GET') return json(view);

    const machinePath = /^\/location\/machines\/(.+)$/.exec(path);
    if (machinePath !== null && req.method() === 'PUT') {
      const record = req.postDataJSON() as Json;
      view.machines = view.machines.map((m) => (m.id === record.id ? record : m));
      return json({ ok: true });
    }
    const accessoryPath = /^\/location\/accessories\/(.+)$/.exec(path);
    if (accessoryPath !== null && req.method() === 'PUT') {
      const record = req.postDataJSON() as Json;
      view.accessories = [...view.accessories.filter((a) => a.id !== record.id), record];
      return json({ ok: true });
    }
    if (accessoryPath !== null && req.method() === 'DELETE') {
      const id = decodeURIComponent(accessoryPath[1]!);
      view.accessories = view.accessories.filter((a) => a.id !== id);
      return json({ ok: true });
    }
    return route.fulfill({ status: 404, body: '' });
  });

  return {
    machine: () => view.machines[0] as Json & { bedProfiles?: Json[]; activeBedProfileId?: string },
    accessories: () => view.accessories,
  };
}

/** Open Manage › Machines (the Bed block lives on the location card). */
async function openManage(page: Page): Promise<void> {
  await page.evaluate(() => window.__caseMaker!.openManage('machines'));
  await expect(page.getByTestId('manage-mode')).toBeVisible();
  await expect(page.getByTestId('manage-bed')).toBeVisible();
}

test('#512 — the first-run wizard walks S0 → S6 with every measurement skipped, and saves the kit bed', async ({ cm, page }) => {
  const house = await fakeHouse(page);
  await cm.ready();
  await openManage(page);

  // The machine's bed has never been described, and the wizard is the way in.
  await expect(page.getByTestId('manage-bed')).toContainText('not described');
  await page.getByTestId('manage-bed-wizard').click();
  await expect(page.getByTestId('bed-wizard')).toBeVisible();

  // S0 — the machine as the location holds it; nothing moves.
  await expect(page.getByTestId('bed-wizard-step-0')).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('bed-wizard-machine-address')).toContainText('192.0.2.10 : 2222');
  await expect(page.getByTestId('bed-wizard-machine-bed')).toContainText('not described yet');
  await expect(page.getByTestId('bed-wizard-no-moves')).toContainText('never moves the machine');
  await page.getByTestId('bed-wizard-next').click();

  // S1 — start from the Makera kit.
  await expect(page.getByTestId('bed-wizard-step-1')).toHaveAttribute('data-state', 'current');
  await page.getByTestId('bed-wizard-template-default:z1-makera-kit').check();
  await expect(page.getByTestId('bed-wizard-to-measure')).toContainText('surface top');
  await expect(page.getByTestId('bed-wizard-to-measure')).toContainText('bracket seat');

  // The draft resumes: close at S1, reopen, and the same step and template are back.
  await page.getByTestId('bed-wizard-close').click();
  await expect(page.getByTestId('bed-wizard')).toHaveCount(0);
  await page.getByTestId('manage-bed-wizard').click();
  await expect(page.getByTestId('bed-wizard-step-1')).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('bed-wizard-template-default:z1-makera-kit')).toBeChecked();

  // S2…S5 — skipped, including their measurement rows (this wizard never probes).
  await page.getByTestId('bed-wizard-next').click();
  await expect(page.getByTestId('bed-wizard-step-2')).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('bed-wizard-measure-surfaceTopZ')).toContainText('not measured');
  await page.getByTestId('bed-wizard-skip').click();
  await expect(page.getByTestId('bed-wizard-step-3')).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('bed-wizard-measure-bracketSeatZ')).toContainText('not measured');
  await page.getByTestId('bed-wizard-skip').click();
  await expect(page.getByTestId('bed-wizard-step-4')).toHaveAttribute('data-state', 'current');
  await page.getByTestId('bed-wizard-skip').click();
  await expect(page.getByTestId('bed-wizard-step-5')).toHaveAttribute('data-state', 'current');
  await page.getByTestId('bed-wizard-skip').click();

  // S6 — the review says what is unmeasured and what was skipped, and the save is one press.
  await expect(page.getByTestId('bed-wizard-step-6')).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('bed-wizard-skipped')).toContainText('The surface (S2)');
  await expect(page.getByTestId('bed-wizard-skipped')).toContainText('Consumables (S5)');
  await expect(page.getByTestId('bed-wizard-unmeasured')).toContainText('the surface top');
  await expect(page.getByTestId('bed-wizard-unmeasured')).toContainText('the bracket seat');
  await expect(page.getByTestId('bed-wizard-provenance')).toContainText('measured 0');
  await expect(page.getByTestId('bed-wizard-provenance')).toContainText('vendor 2');
  await page.getByTestId('bed-wizard-name').fill('Kit bed');
  await page.getByTestId('bed-wizard-save').click();
  await expect(page.getByTestId('bed-wizard-saved')).toContainText('Kit bed');
  await page.getByTestId('bed-wizard-done').click();

  // The Manage card describes the saved bed, and the service holds exactly one profile, active.
  await expect(page.getByTestId('manage-bed-summary')).toContainText('Kit bed');
  const saved = house.machine();
  expect(saved.bedProfiles).toHaveLength(1);
  const profile = saved.bedProfiles![0]! as {
    id: string;
    name: string;
    surface: { kind: string };
    datums: Record<string, unknown>;
    placements: Array<{ where: { kind: string } }>;
  };
  expect(profile.name).toBe('Kit bed');
  expect(profile.surface.kind).toBe('wasteboard');
  expect(profile.datums).toEqual({ surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null });
  expect(profile.placements.map((p) => p.where.kind).sort()).toEqual(['anchor', 'free']);
  expect(saved.activeBedProfileId).toBe(profile.id);
  // The bracket and the two clamps are the house's accessories, checked out to this machine.
  const held = house.accessories().filter((a) => (a.whereabouts as { kind: string }).kind === 'machine');
  expect(held.map((a) => a.kind).sort()).toEqual(['bracket', 'top-clamp']);
});

test('#512 — the vise and the 4th-axis module share the pins: the conflict is stated with its fix', async ({ cm, page }) => {
  const house = await fakeHouse(page);
  await cm.ready();
  await openManage(page);
  await page.getByTestId('manage-bed-wizard').click();

  await page.getByTestId('bed-wizard-next').click();
  await page.getByTestId('bed-wizard-template-default:z1-vise').check();
  await page.getByTestId('bed-wizard-next').click(); // S2
  await page.getByTestId('bed-wizard-next').click(); // S3

  // Open question A, decided: both may be chosen, and the wizard says why they cannot both stay.
  await page.getByTestId('bed-wizard-add-rotary-module').click();
  const conflict = page.getByTestId('bed-wizard-conflict');
  await expect(conflict).toContainText('same two pins');
  await expect(conflict).toContainText('one bed carries one of them at a time');
  await expect(conflict).toContainText('Remove the low-profile vise to fit the 4th-axis module');

  // The fix the conflict names, in one press: the rotary module goes.
  await page.getByRole('button', { name: 'Remove 4th-axis module', exact: true }).click();
  await expect(page.getByTestId('bed-wizard-conflict')).toHaveCount(0);
  await expect(page.getByTestId('bed-wizard-placements')).toContainText('Low-profile vise');

  // The vise stays measurable-later, and the rest of the walk saves a vise-only bed.
  await expect(page.getByTestId('bed-wizard-measure-viseJawTopZ')).toContainText('not measured');
  await page.getByTestId('bed-wizard-skip').click();
  await page.getByTestId('bed-wizard-skip').click();
  await page.getByTestId('bed-wizard-skip').click();
  await expect(page.getByTestId('bed-wizard-step-6')).toHaveAttribute('data-state', 'current');
  await page.getByTestId('bed-wizard-save').click();
  await expect(page.getByTestId('bed-wizard-saved')).toBeVisible();
  await page.getByTestId('bed-wizard-done').click();

  const saved = house.machine();
  expect(saved.bedProfiles).toHaveLength(1);
  const profile = saved.bedProfiles![0]! as { placements: Array<{ where: { kind: string; pins: string | null } }> };
  expect(profile.placements).toHaveLength(1);
  expect(profile.placements[0]!.where).toMatchObject({ kind: 'pins', pins: 'vise' });
  expect(house.accessories().map((a) => a.kind)).toEqual(['vise']);
});

test('#512 — every answer step can be skipped: the bare bed saves with a name typed at S6', async ({ cm, page }) => {
  const house = await fakeHouse(page);
  await cm.ready();
  await openManage(page);
  await page.getByTestId('manage-bed-wizard').click();

  // S0 is a read; S1…S5 are all skipped, so no template and no answer is written.
  await page.getByTestId('bed-wizard-next').click();
  for (const step of [1, 2, 3, 4, 5]) {
    await expect(page.getByTestId(`bed-wizard-step-${step}`)).toHaveAttribute('data-state', 'current');
    await page.getByTestId('bed-wizard-skip').click();
  }
  await expect(page.getByTestId('bed-wizard-step-6')).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('bed-wizard-skipped')).toContainText('Start from (S1)');
  await expect(page.getByTestId('bed-wizard-skipped')).toContainText('How you hold stock (S4)');
  await expect(page.getByTestId('bed-wizard-unmeasured')).toContainText('the surface top');

  await page.getByTestId('bed-wizard-name').fill('Bare bed');
  await page.getByTestId('bed-wizard-save').click();
  await expect(page.getByTestId('bed-wizard-saved')).toContainText('Bare bed');
  await page.getByTestId('bed-wizard-done').click();

  const saved = house.machine();
  const profile = saved.bedProfiles![0]! as {
    basedOn: string | null;
    surface: { kind: string };
    placements: unknown[];
    preferredMounting: unknown[];
    consumables: unknown;
    datums: Record<string, unknown>;
  };
  expect(saved.bedProfiles).toHaveLength(1);
  expect(profile.basedOn).toBeNull();
  expect(profile.surface.kind).toBe('bare-bed');
  expect(profile.placements).toEqual([]);
  expect(profile.preferredMounting).toEqual([]);
  expect(profile.consumables).toBeNull();
  expect(Object.values(profile.datums).every((d) => d === null)).toBe(true);
  expect(house.accessories()).toEqual([]);

  // The saved draft is gone: reopening starts a new one at S0 with no name carried over.
  await page.getByTestId('manage-bed-wizard').click();
  await expect(page.getByTestId('bed-wizard-step-0')).toHaveAttribute('data-state', 'current');
  await page.getByTestId('bed-wizard-close').click();
});
