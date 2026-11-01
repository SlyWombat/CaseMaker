// A house whose machine carries the 4th-axis module on its pins, with the bed's axis datum read —
// so the Holding step offers the rotary chuck and its fields (the neck for parting among them).
// The same house #782's geometry spec builds; kept here so a spec can borrow it without importing
// another spec's tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

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
  readFileSync(fileURLToPath(new URL('../../unit/fixtures/location-doc.json', import.meta.url)), 'utf8'),
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
export async function fakeRotaryHouse(page: Page): Promise<void> {
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

