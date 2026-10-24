// @vitest-environment jsdom
// The depth margins' move out of browser storage into the shop defaults (#447, `locationStore.ts`'s
// `settleMargins` and write-through). The fake serves `/location`, its guarded machine PUT and the
// guarded `/defaults` section, seeded from the shared fixture.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARGIN_DEFAULTS, type MarginSettings } from '@/engine/cnc/engrave/depthBounds';
import { HOUSE_SCHEMA_VERSION, setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import type { MachineRecord } from '@/platform/locationClient';
import type { ShopDefault } from '@/platform/defaultsClient';
import {
  clearStoredBaseline,
  mergeMachine,
  reconcileLocation,
  resetLocationStore,
  startLocationSync,
  useLocationStore,
} from '@/store/locationStore';
import { MARGINS_MOVED_KEY, MARGINS_PENDING_KEY } from '@/store/shopMargins';
import { resetShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  defaults: Record<string, ShopDefault>;
};

const USER: MarginSettings = { ...MARGIN_DEFAULTS, boundaryMargin: 0.3, minFloor: 0, source: 'user' };

function recordWith(margins: MarginSettings | null): MachineRecord {
  const { record } = mergeMachine(
    { fixtures: {}, margins: margins ?? MARGIN_DEFAULTS, calibration: undefined, observation: null },
    null,
    null,
    '2026-10-15T09:00:00.000Z',
  );
  return { ...record, id: 'machine-1', margins };
}

function fakeService(
  opts: {
    machines?: MachineRecord[];
    defaults?: boolean;
    refuseKey?: string;
    defaultsFail?: () => boolean;
    refuseWrites?: () => boolean;
    failMachinePuts?: () => boolean;
  } = {},
) {
  const machines: MachineRecord[] = (opts.machines ?? []).map((m) => JSON.parse(JSON.stringify(m)) as MachineRecord);
  const defaults: Record<string, ShopDefault> = JSON.parse(JSON.stringify(FIXTURE.defaults)) as Record<string, ShopDefault>;
  let loc = 1;
  let def = 1;
  const defaultWrites: string[] = [];
  const machinePuts: MachineRecord[] = [];
  const view = () =>
    JSON.stringify({
      kind: 'casemaker-location',
      schemaVersion: 1,
      id: 'loc-test',
      name: 'My shop',
      createdAt: '2026-10-15T00:00:00.000Z',
      migratedFrom: null,
      machines,
    });
  const client: HouseClient = {
    probe: async () => ({
      kind: 'present',
      base: '',
      health: {
        ok: true,
        schemaVersion: HOUSE_SCHEMA_VERSION,
        build: 'v-test',
        hasCatalogue: false,
        feedRows: 0,
        materialSpecRows: 0,
        catalogueSyncedAt: null,
        lastSync: null,
        problems: [],
        warnings: [],
      },
    }),
    tools: async () => ({ kind: 'ok', etag: '"t"', entries: [] }),
    feeds: async () => ({ kind: 'absent', reason: 'none' }),
    inventory: async () => ({ kind: 'ok', etag: '"i"', items: [] }),
    call: async (method, path, body, o): Promise<HouseCall> => {
      if (method === 'GET' && path === '/location') return { kind: 'ok', text: view(), etag: `"loc-${loc}"` };
      if (method === 'PUT' && path.startsWith('/location/machines/')) {
        if (opts.failMachinePuts?.()) return { kind: 'refused', status: 500, message: 'the service could not write the location' };
        if (o?.ifMatch !== `"loc-${loc}"`) return { kind: 'refused', status: 412, message: 'stale' };
        const record = JSON.parse(JSON.stringify(body)) as MachineRecord;
        machinePuts.push(record);
        const i = machines.findIndex((m) => m.id === record.id);
        if (i === -1) machines.push(record);
        else machines[i] = record;
        loc += 1;
        return { kind: 'ok', text: '' };
      }
      if (path === '/defaults' || path.startsWith('/defaults/')) {
        if (opts.defaults === false) return { kind: 'refused', status: 404, message: 'no defaults section here' };
        if (opts.defaultsFail?.()) return { kind: 'refused', status: 500, message: 'the service could not read the defaults' };
        if (method === 'GET') return { kind: 'ok', text: JSON.stringify(defaults), etag: `"def-${def}"` };
        if (o?.ifMatch !== `"def-${def}"`) return { kind: 'refused', status: 412, message: 'stale' };
        const key = decodeURIComponent(path.slice('/defaults/'.length));
        if (opts.refuseWrites?.()) return { kind: 'refused', status: 500, message: 'the service could not write the defaults' };
        if (key === opts.refuseKey) return { kind: 'refused', status: 400, message: `${key} is refused here` };
        if (method === 'PUT') defaults[key] = JSON.parse(JSON.stringify(body)) as ShopDefault;
        else defaults[key] = JSON.parse(JSON.stringify(FIXTURE.defaults[key])) as ShopDefault;
        defaultWrites.push(`${method} ${key}`);
        def += 1;
        return { kind: 'ok', text: '' };
      }
      return { kind: 'refused', status: 404, message: `${method} ${path} is not served here` };
    },
  };
  setHouseClientLoader(async () => client);
  return { machines: () => machines, defaults, defaultWrites, machinePuts };
}

/** The hosted web build: nothing answers. */
const NO_SERVICE = {
  probe: async () => ({ kind: 'absent', reason: 'no house service' }),
  call: async (): Promise<HouseCall> => ({ kind: 'absent', reason: 'no house service' }),
} as unknown as HouseClient;

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  resetLocationStore();
  resetShopDefaultsStore();
  clearStoredBaseline();
  localStorage.removeItem(MARGINS_MOVED_KEY);
  localStorage.removeItem(MARGINS_PENDING_KEY);
  useSettingsStore.setState({ fixtures: {}, margins: { ...MARGIN_DEFAULTS }, machineCalibration: undefined });
  useMachineStore.setState({ machine: null });
});

afterEach(() => {
  setHouseClientLoader(null);
});

describe('moving the depth margins into the shop defaults (#447)', () => {
  it('moves the machine record’s margins in, chosen with a note, then empties the record’s copy', async () => {
    const service = fakeService({ machines: [recordWith(USER)] });
    await reconcileLocation();

    expect(service.defaults['margins.boundaryMarginMm']).toMatchObject({ value: 0.3, source: 'chosen' });
    expect(service.defaults['margins.boundaryMarginMm']?.note).toContain("machine record's depth margins");
    // An edge value (0) moves in as it was.
    expect(service.defaults['margins.minFloorMm']).toMatchObject({ value: 0, source: 'chosen' });
    // Untouched numbers stay seeds.
    expect(service.defaults['margins.edgeMarginMm']?.source).toBe('seeded');
    // One home: the record's copy is gone.
    expect(service.machines()[0]?.margins).toBeNull();
    expect(useLocationStore.getState().marginsHome).toBe('defaults');
    // Every reader still sees the same numbers, through the projection.
    expect(useSettingsStore.getState().margins).toMatchObject({ boundaryMargin: 0.3, minFloor: 0, source: 'user' });
    expect(useSettingsStore.getState().margins.measuredThicknessTolerance).toBe(0.05);
  });

  it('a browser with no machine record moves its own margins, once', async () => {
    const service = fakeService();
    useSettingsStore.setState({ margins: { ...USER } });
    await reconcileLocation();
    expect(service.defaults['margins.boundaryMarginMm']).toMatchObject({ value: 0.3, source: 'chosen' });
    expect(service.defaults['margins.boundaryMarginMm']?.note).toContain("this browser's saved depth margins");
    // Margins in the shop defaults are no reason to record a machine.
    expect(service.machines()).toHaveLength(0);
    expect(localStorage.getItem(MARGINS_MOVED_KEY)).toBe('loc-test');
  });

  it('a reset to the seed is not undone by the old copy on the next start', async () => {
    const service = fakeService({ machines: [recordWith(USER)] });
    await reconcileLocation();
    const stop = startLocationSync();
    try {
      useSettingsStore.getState().setMargins({ ...MARGIN_DEFAULTS }); // "Restore the shipped margins"
      await settle();
      expect(service.defaults['margins.boundaryMarginMm']?.source).toBe('seeded');
      expect(service.defaults['margins.minFloorMm']?.source).toBe('seeded');
      expect(useSettingsStore.getState().margins.source).toBe('default');
    } finally {
      stop();
    }
    // A restart: this browser's storage still holds the old user set as its cache.
    resetLocationStore();
    resetShopDefaultsStore();
    useSettingsStore.setState({ margins: { ...USER } });
    const before = service.defaultWrites.length;
    await reconcileLocation();
    expect(service.defaultWrites.length).toBe(before);
    expect(useSettingsStore.getState().margins).toMatchObject({ boundaryMargin: 0.2, source: 'default' });
  });

  it('an edit in the Settings menu is written to the shop, and another window’s change is taken in', async () => {
    const service = fakeService({ machines: [recordWith(null)] });
    await reconcileLocation();
    const stop = startLocationSync();
    try {
      useSettingsStore.getState().setMargins({ ...useSettingsStore.getState().margins, edgeMargin: 2.5 });
      await settle();
      expect(service.defaults['margins.edgeMarginMm']).toMatchObject({ value: 2.5, source: 'chosen' });
      // The machine record is not where margins go any more.
      expect(service.machines()[0]?.margins).toBeNull();
      // Another window sets the Z tolerance; this one re-reads and projects it.
      service.defaults['margins.zToleranceMm'] = { value: 0.09, source: 'chosen', setAt: 'x', unit: 'mm', note: null };
      await reconcileLocation();
      // A Z tolerance set on its own leaves the boundary following the layer: still `default`.
      expect(useSettingsStore.getState().margins).toMatchObject({ edgeMargin: 2.5, zTolerance: 0.09, source: 'default' });
    } finally {
      stop();
    }
  });

  it('a refused move loses nothing: the record keeps its margins and the card says why', async () => {
    const service = fakeService({ machines: [recordWith(USER)], refuseKey: 'margins.minFloorMm' });
    await reconcileLocation();
    expect(useLocationStore.getState().marginsHome).toBe('record');
    expect(useLocationStore.getState().writeNote).toContain('could not be moved');
    expect(service.machines()[0]?.margins).toMatchObject({ boundaryMargin: 0.3, minFloor: 0 });
    expect(useSettingsStore.getState().margins).toMatchObject({ boundaryMargin: 0.3, minFloor: 0, source: 'user' });
    expect(localStorage.getItem(MARGINS_MOVED_KEY)).toBeNull();
  });

  it('a service with no defaults section keeps #412’s record path', async () => {
    const service = fakeService({ machines: [recordWith(USER)], defaults: false });
    await reconcileLocation();
    expect(useLocationStore.getState().marginsHome).toBe('record');
    expect(service.machines()[0]?.margins).toMatchObject({ boundaryMargin: 0.3 });
    expect(useSettingsStore.getState().margins.boundaryMargin).toBe(0.3);
  });

  it('a section that fails to read after the move never puts the cache back on the record', async () => {
    let fail = false;
    const service = fakeService({ machines: [recordWith(USER)], defaultsFail: () => fail });
    await reconcileLocation();
    expect(service.machines()[0]?.margins).toBeNull();
    // A restart while the section errors: the cache holds the projected user set.
    fail = true;
    resetLocationStore();
    resetShopDefaultsStore();
    const putsBefore = service.machinePuts.length;
    await reconcileLocation();
    expect(useLocationStore.getState().marginsHome).toBe('defaults');
    expect(service.machinePuts.slice(putsBefore).every((m) => m.margins === null)).toBe(true);
    expect(service.machines()[0]?.margins).toBeNull();
    // Nothing projected from the fallbacks: the cache is left as it was.
    expect(useSettingsStore.getState().margins).toMatchObject({ boundaryMargin: 0.3, source: 'user' });
  });

  it('margins put back on a moved record win over this browser’s cache, not the other way', async () => {
    const service = fakeService({ machines: [recordWith(USER)] });
    await reconcileLocation();
    // An older build writes its own margins back onto the record; this browser's base says null.
    const theirs: MarginSettings = { ...MARGIN_DEFAULTS, edgeMargin: 4, source: 'default' };
    service.machines()[0]!.margins = theirs;
    resetLocationStore();
    resetShopDefaultsStore();
    await reconcileLocation();
    expect(service.defaults['margins.edgeMarginMm']).toMatchObject({ value: 4, source: 'chosen' });
    // The cache's boundary pin was the shop's already; nothing of the cache was written over theirs.
    expect(service.defaults['margins.boundaryMarginMm']).toMatchObject({ value: 0.3, source: 'chosen' });
    expect(service.machines()[0]?.margins).toBeNull();
  });

  it('a failed null-out leaves the move unmarked, and the replay keeps a later shop edit (#447 review)', async () => {
    let failPuts = true;
    const service = fakeService({ machines: [recordWith(USER)], failMachinePuts: () => failPuts });
    await reconcileLocation();
    // The values moved, but the record still carries its copy: the move is not done.
    expect(service.defaults['margins.boundaryMarginMm']).toMatchObject({ value: 0.3, source: 'chosen' });
    expect(service.machines()[0]?.margins).not.toBeNull();
    expect(localStorage.getItem(MARGINS_MOVED_KEY)).toBeNull();
    // Another window raises the boundary margin after the copy was written.
    service.defaults['margins.boundaryMarginMm'] = {
      value: 0.5,
      source: 'chosen',
      setAt: '2026-10-16T20:00:00.000Z',
      unit: 'mm',
      note: null,
    };
    failPuts = false;
    resetLocationStore();
    resetShopDefaultsStore();
    await reconcileLocation();
    // The old 0.3 is not replayed over the later 0.5, the record is emptied, and only now is it marked.
    expect(service.defaults['margins.boundaryMarginMm']?.value).toBe(0.5);
    expect(useSettingsStore.getState().margins.boundaryMargin).toBe(0.5);
    expect(service.machines()[0]?.margins).toBeNull();
    expect(localStorage.getItem(MARGINS_MOVED_KEY)).toBe('loc-test');
  });

  it('a default-source record off its seed keeps its Z tolerance through the move (#447 review)', async () => {
    const service = fakeService({ machines: [recordWith({ ...MARGIN_DEFAULTS, zTolerance: 0.07, source: 'default' })] });
    await reconcileLocation();
    expect(service.defaults['margins.zToleranceMm']).toMatchObject({ value: 0.07, source: 'chosen' });
    expect(service.defaults['margins.boundaryMarginMm']?.source).toBe('seeded');
    expect(useSettingsStore.getState().margins).toMatchObject({ zTolerance: 0.07, source: 'default' });
  });

  it('a refused margins edit survives a restart and is sent on the next connect (#447 review)', async () => {
    let refuse = false;
    const service = fakeService({ machines: [recordWith(null)], refuseWrites: () => refuse });
    await reconcileLocation();
    const stop = startLocationSync();
    try {
      refuse = true;
      useSettingsStore.getState().setMargins({ ...useSettingsStore.getState().margins, minFloor: 2.2 });
      await settle();
      expect(service.defaults['margins.minFloorMm']?.source).toBe('seeded');
      expect(localStorage.getItem(MARGINS_PENDING_KEY)).toContain('2.2');
    } finally {
      stop();
    }
    // A restart: the window starts from the shipped numbers; the edit is only in the pending store.
    resetLocationStore();
    resetShopDefaultsStore();
    useSettingsStore.setState({ margins: { ...MARGIN_DEFAULTS } });
    refuse = false;
    await reconcileLocation();
    expect(service.defaults['margins.minFloorMm']).toMatchObject({ value: 2.2, source: 'chosen' });
    expect(useSettingsStore.getState().margins.minFloor).toBe(2.2);
    expect(localStorage.getItem(MARGINS_PENDING_KEY)).toBeNull();
  });

  it('a pending edit still refused stays in the window, not projected over', async () => {
    const service = fakeService({ machines: [recordWith(null)], refuseWrites: () => true });
    localStorage.setItem(
      MARGINS_PENDING_KEY,
      JSON.stringify({ locationId: 'loc-test', margins: { ...MARGIN_DEFAULTS, edgeMargin: 3 }, at: '2026-10-16T12:00:00.000Z' }),
    );
    await reconcileLocation();
    expect(service.defaults['margins.edgeMarginMm']?.source).toBe('seeded');
    expect(useSettingsStore.getState().margins.edgeMargin).toBe(3);
    expect(useLocationStore.getState().writeNote).toContain('earlier session');
  });

  it('with no service the margins stay this browser’s own', async () => {
    setHouseClientLoader(async () => NO_SERVICE);
    useSettingsStore.setState({ margins: { ...USER } });
    useToolRegistryStore.setState({ status: 'absent' });
    await reconcileLocation();
    expect(useLocationStore.getState().marginsHome).toBe('browser');
    expect(useSettingsStore.getState().margins).toEqual(USER);
  });
});
