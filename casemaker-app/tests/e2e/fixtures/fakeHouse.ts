/**
 * #1180 S2 — ONE HOUSE, SERVED FROM THE TEST.
 *
 * The web e2e build has no house service (the real one is the desktop app's embedded Rust
 * service), so a spec answers `/api/v1/*` itself. Nine e2e specs each grew their own copy of the
 * same handler — health, tools, inventory, stock, defaults, `/location`, a 404 tail — with small
 * differences in what a write answered and which documents were served. This is the one handler.
 *
 * What it serves, and only when asked:
 *   - `GET /location`             the `location` option (a spec's view of the shared location
 *                                 fixture, `tests/unit/fixtures/location-doc.json`);
 *   - `GET /health`, `/tools`     the same-named option; `/tools` defaults to `[]`;
 *   - `GET /feeds`                the `feeds` option (unserved by default — most tests never ask);
 *   - `GET /inventory`, `/stock`,
 *     `/defaults`                 the same-named option, or with `fromSharedDocument` the shared
 *                                 location fixture's own section;
 *   - a write                     `writes`: 'reject' (404, the default), 'ok' (200 `{ok:true}`),
 *                                 'accepted' (204, empty — the service's own write success), or
 *                                 'applied' (a machine/accessory PUT or accessory DELETE changes
 *                                 the served document, so a later GET is what the app would read
 *                                 from a real service);
 *   - anything else               404, or `route.continue()` with `unserved: 'continue'` (the dev
 *                                 server then answers, as it did for the first version of this
 *                                 fixture — no made-up document).
 *
 * The location ETag is fixed at `"e1"` unless `movingEtag`: the real service's ETag is the hash of
 * the served document, and a fake that keeps one ETag while its bytes change promises "same
 * document" and the write never reaches the card (#1123-12).
 *
 * `BITS_INVENTORY` is the first version's five owned bits (#1172A) — the document Manage › Tools
 * counts. A spec that wants them passes it as `inventory`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { flatEndMill } from '../../../src/engine/cnc/tool';

export type Json = Record<string, unknown>;

/** The shared location fixture, as this fixture reads it. */
export interface LocationDoc {
  kind: string;
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  migratedFrom?: string | null;
  machines: Json[];
  accessories: Json[];
  inventory?: unknown;
  stock?: unknown;
  defaults?: Record<string, unknown>;
}

const LOCATION_FIXTURE = fileURLToPath(new URL('../../unit/fixtures/location-doc.json', import.meta.url));

/** A fresh copy of the shared location fixture: a spec may change it without reaching another. */
export function locationDocument(): LocationDoc {
  return JSON.parse(readFileSync(LOCATION_FIXTURE, 'utf8')) as LocationDoc;
}

/**
 * The location as `/location` answers it: the document's machine and accessory lists, without the
 * sections that have their own endpoints. `defaults` is included only when asked — the copies this
 * replaces differed on it, and each keeps its own answer.
 */
export function locationView(doc: LocationDoc, opts: { defaults?: boolean } = {}): Json {
  const view: Json = {
    kind: doc.kind,
    schemaVersion: doc.schemaVersion,
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    migratedFrom: doc.migratedFrom ?? null,
    machines: doc.machines,
    accessories: doc.accessories,
  };
  if (opts.defaults === true) view.defaults = doc.defaults ?? {};
  return view;
}

/** The house's own health line: no catalogue, no feed rows, nothing wrong. */
export const HOUSE_HEALTH = {
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

/** The health line with this build's or this catalogue's facts over it. */
export function houseHealth(overrides: Json = {}): Json {
  return { ...HOUSE_HEALTH, ...overrides };
}

export interface HouseOptions {
  /** `GET /location`. Unserved when absent (falls through to the 404 tail). */
  location?: unknown;
  /** `GET /health`. Default: `HOUSE_HEALTH`. */
  health?: unknown;
  /** `GET /tools`. Default: `[]`. */
  tools?: unknown;
  /** `GET /feeds`. Unserved when absent. */
  feeds?: unknown;
  /** `GET /inventory`. Unset: the shared document's, with `fromSharedDocument`; else unserved. */
  inventory?: unknown;
  /** `GET /stock`. As `inventory`. */
  stock?: unknown;
  /** `GET /defaults`. As `inventory`. */
  defaults?: unknown;
  /** Answer unset `/inventory`, `/stock`, `/defaults` from the shared location fixture. */
  fromSharedDocument?: boolean;
  /** What every write answers. Default 'reject' (404). */
  writes?: 'reject' | 'ok' | 'accepted' | 'applied';
  /** Bump the location ETag on every applied write (#1123-12). Default false (a fixed `"e1"`). */
  movingEtag?: boolean;
  /** What an unserved request does. Default: a 404 fulfilled; 'continue': the dev server answers. */
  unserved?: 'not-found' | 'continue';
}

/** What a spec can read back from the served document (mostly the wizard's applied writes). */
export interface House {
  location(): Json;
  machine(): Json & { bedProfiles?: Json[]; activeBedProfileId?: string };
  accessories(): Json[];
}

/** Answer the house's reads and writes for this page. Install BEFORE the page loads. */
export async function serveHouse(page: Page, options: HouseOptions = {}): Promise<House> {
  const shared = options.fromSharedDocument === true ? locationDocument() : null;
  const section = (given: unknown, key: 'inventory' | 'stock' | 'defaults'): unknown =>
    given !== undefined ? given : shared === null ? undefined : shared[key];
  const inventory = section(options.inventory, 'inventory');
  const stock = section(options.stock, 'stock');
  // #1201 — a defaults PUT under `writes: 'applied'` lands in this copy, so a measurement whose
  // write path also moves a shop default (the seat tap) can complete and then re-read.
  let defaults = section(options.defaults, 'defaults') as Record<string, unknown> | undefined;

  const served = (options.location ?? null) as { machines?: Json[]; accessories?: Json[] } | null;
  let etag = 1;

  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/v1/, '');
    const json = (payload: unknown): Promise<void> =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { etag: `"e${etag}"` },
        body: JSON.stringify(payload),
      });

    if (request.method() === 'GET') {
      if (path === '/health') return json(options.health ?? HOUSE_HEALTH);
      if (path === '/tools') return json(options.tools ?? []);
      if (path === '/feeds' && options.feeds !== undefined) return json(options.feeds);
      if (path === '/inventory' && inventory !== undefined) return json(inventory);
      if (path === '/stock' && stock !== undefined) return json(stock);
      if (path === '/defaults' && defaults !== undefined) return json(defaults);
      if (path === '/location' && served !== null) return json(served);
      if (options.unserved === 'continue') return route.continue();
      return route.fulfill({ status: 404, body: '' });
    }

    if (options.writes === 'accepted') {
      // The service's own success: an empty 204.
      return route.fulfill({ status: 204, body: '' });
    }
    if (options.writes === 'ok') return json({ ok: true });
    if (options.writes === 'applied' && served !== null) {
      const bump = (): void => {
        if (options.movingEtag === true) etag += 1;
      };
      const machinePath = /^\/location\/machines\/(.+)$/.exec(path);
      if (machinePath !== null && request.method() === 'PUT') {
        const record = request.postDataJSON() as Json;
        served.machines = (served.machines ?? []).map((m) => (m.id === record.id ? record : m));
        bump();
        return json({ ok: true });
      }
      const accessoryPath = /^\/location\/accessories\/(.+)$/.exec(path);
      if (accessoryPath !== null && request.method() === 'PUT') {
        const record = request.postDataJSON() as Json;
        served.accessories = [...(served.accessories ?? []).filter((a) => a.id !== record.id), record];
        bump();
        return json({ ok: true });
      }
      if (accessoryPath !== null && request.method() === 'DELETE') {
        const id = decodeURIComponent(accessoryPath[1]!);
        served.accessories = (served.accessories ?? []).filter((a) => a.id !== id);
        bump();
        return json({ ok: true });
      }
      // #1201 — one shop default, as `PUT /defaults/<key>`: the seat tap moves the seat default
      // after its datum write, and this keeps that path whole instead of a partial failure.
      const defaultPath = /^\/defaults\/(.+)$/.exec(path);
      if (defaultPath !== null && request.method() === 'PUT' && defaults !== undefined) {
        defaults = { ...defaults, [decodeURIComponent(defaultPath[1]!)]: request.postDataJSON() };
        bump();
        return json({ ok: true });
      }
    }
    return route.fulfill({ status: 404, body: '' });
  });

  return {
    location: () => (served ?? {}) as Json,
    machine: () => ((served?.machines ?? [])[0] ?? {}) as Json & {
      bedProfiles?: Json[];
      activeBedProfileId?: string;
    },
    accessories: () => served?.accessories ?? [],
  };
}

// ── #1172A — the five owned bits Manage › Tools lists ────────────────────────────────────────────

const ADDED = '2026-11-01T09:00:00.000Z';

type Condition = 'new' | 'used' | 'worn' | 'broken' | 'lost' | null;

function copy(id: string, condition: Condition, colour?: string) {
  return {
    id,
    condition,
    whereabouts:
      colour === undefined
        ? { kind: 'box', case: null }
        : { kind: 'box', case: { colour, label: `${colour} base, clear tube` } },
    runtimeWarnMinutes: null,
    notes: null,
    runtimeMinutes: null,
  };
}

function item(opts: {
  id: string;
  tool: ReturnType<typeof flatEndMill>;
  quantity: number;
  copies: ReturnType<typeof copy>[];
  notes: string | null;
  code: string;
}) {
  return {
    id: opts.id,
    tool: opts.tool,
    origin: null,
    quantity: opts.quantity,
    codes: [{ symbology: 'qr', value: opts.code }],
    addedAt: ADDED,
    notes: opts.notes,
    copies: opts.copies,
    colletFits: null,
  };
}

/** Five owned bits, in the mockup's own kinds: two corn, a ball, a metal flat and a lost long flat. */
export const BITS_INVENTORY = [
  item({
    id: 'bits-corn-06',
    tool: flatEndMill(0.6, { name: '0.6 mm corn', typeText: 'Corn Bit' }),
    quantity: 2,
    copies: [copy('bits-corn-06-1', 'new', 'yellow'), copy('bits-corn-06-2', 'used', 'yellow')],
    notes: 'box A · row 2',
    code: 'C1-BIT-CORN-0-6',
  }),
  item({
    id: 'bits-corn-09',
    tool: flatEndMill(0.9, { name: '0.9 mm corn', typeText: 'Corn Bit' }),
    quantity: 2,
    copies: [copy('bits-corn-09-1', 'used', 'red'), copy('bits-corn-09-2', 'broken', 'red')],
    notes: 'box B · row 2',
    code: 'C1-BIT-CORN-0-9',
  }),
  item({
    id: 'bits-ball-1',
    tool: flatEndMill(1, { name: '1 mm ball', typeText: 'Ball Nose', shape: 'ball' }),
    quantity: 2,
    copies: [copy('bits-ball-1-1', 'new', 'yellow'), copy('bits-ball-1-2', 'new', 'yellow')],
    notes: 'box A · row 1',
    code: 'C1-BIT-BALL-1-0',
  }),
  item({
    id: 'bits-flat-metal-1',
    tool: flatEndMill(1, { name: '1 mm flat, metal', typeText: 'Single Flute Bit for Metal' }),
    quantity: 1,
    copies: [copy('bits-flat-metal-1-1', 'worn', 'green')],
    notes: 'box A · row 5',
    code: 'C1-BIT-FLAT-1-0-M',
  }),
  item({
    id: 'bits-flat-3175-long',
    tool: flatEndMill(3.175, { name: '3.175 mm flat, long' }),
    quantity: 1,
    copies: [copy('bits-flat-3175-long-1', 'lost', 'yellow')],
    notes: 'box A · row 3',
    code: 'C1-BIT-FLAT-3-175-L',
  }),
];
