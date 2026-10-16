// @vitest-environment jsdom
// The "my machine" half of the location migration, and the write-through after it (#412,
// `store/locationStore.ts`). The client is the seam: a `HouseClient` fake whose `call` serves
// `GET /location`, `PUT /location/machines/:id` (guarded, as the service is) and `POST /import`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARGIN_DEFAULTS } from '@/engine/cnc/engrave/depthBounds';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import {
  HOUSE_SCHEMA_VERSION,
  setHouseClientLoader,
  type HouseCall,
  type HouseClient,
} from '@/platform/houseClient';
import type { MachineObservation } from '@/platform/machineProbe';
import type { MachineRecord } from '@/platform/locationClient';
import {
  localMachine,
  mergeMachine,
  observationApplies,
  pushMachine,
  reconcileLocation,
  resetLocationStore,
  sameRecord,
  startLocationSync,
  useLocationStore,
} from '@/store/locationStore';
import { resetHouseStore, useHouseStore } from '@/store/houseStore';
import { useMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_TEXT = readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8');

const VISE = {
  stockProud: 1.5,
  fixedJawThickness: 10,
  movingJawThickness: 10,
  jawLength: 100,
  jawStartY: -10,
  source: 'measured' as const,
  uncertainty: 0.1,
  measuredAt: '2026-10-13T12:00:00.000Z',
};

const CALIBRATION: MachineCalibration = {
  machineId: 'Z1',
  frame: {
    anchor1: [-190.89, -193.83],
    anchor2Offset: [90, 45],
    toolrackOffset: [181, 1],
    clearanceXY: [-9.89, -12.83],
    clearanceZ: -3,
    toolrackZ: -100,
  },
  softEndstop: { enabled: true, xMin: -200, yMin: -200, zMin: -100, source: 'config-get sd' },
  source: 'config-get sd on 192.0.2.10',
  measuredAt: '2026-10-07T10:00:00.000Z',
};

const OBSERVATION: MachineObservation = {
  name: 'Makera_Z1_000000',
  host: '192.0.2.10',
  port: 2222,
  busy: false,
  ip: '192.0.2.10',
  mac: null,
  status: '<Idle>',
  profileId: 'Z1',
  observedAt: '2026-10-15T08:00:00.000Z',
  notes: [],
};

/** The service's location, held in the fake: machines plus a validator that moves on every write. */
function fakeService(initial: MachineRecord[] = [], hooks: { afterPut?: (machines: unknown[]) => void } = {}) {
  let machines: unknown[] = initial.map((m) => JSON.parse(JSON.stringify(m)));
  let version = 1;
  const puts: MachineRecord[] = [];
  const etag = () => `"loc-${version}"`;
  const view = () =>
    JSON.stringify({
      kind: 'casemaker-location',
      schemaVersion: 1,
      id: 'loc-test',
      name: 'My shop',
      createdAt: '2026-10-15T00:00:00.000Z',
      migratedFrom: 'house.json, moved into this location on 2026-10-15T00:00:00.000Z',
      machines,
    });
  const client: HouseClient = {
    probe: async () => ({
      kind: 'present',
      base: '',
      health: {
        ok: true,
        schemaVersion: HOUSE_SCHEMA_VERSION,
        hasCatalogue: false,
        feedRows: 0,
        catalogueSyncedAt: null,
        lastSync: null,
        problems: [],
        warnings: [],
      },
    }),
    tools: async () => ({ kind: 'ok', etag: '"t"', entries: [] }),
    feeds: async () => ({ kind: 'absent', reason: 'none' }),
    inventory: async () => ({ kind: 'ok', etag: '"i"', items: [] }),
    call: async (method, path, body, opts): Promise<HouseCall> => {
      if (method === 'GET' && path === '/location') return { kind: 'ok', text: view(), etag: etag() };
      if (method === 'PUT' && path.startsWith('/location/machines/')) {
        if (opts?.ifMatch !== etag()) {
          return { kind: 'refused', status: opts?.ifMatch ? 412 : 428, message: 'the location changed since you read it' };
        }
        const record = body as MachineRecord;
        puts.push(record);
        // Through JSON with sorted keys, as `serde_json` would store and serve it.
        const sorted = JSON.parse(
          JSON.stringify(record, (_k, v: unknown) =>
            v && typeof v === 'object' && !Array.isArray(v)
              ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
              : v,
          ),
        ) as unknown;
        const i = machines.findIndex((m) => (m as { id: string }).id === record.id);
        if (i === -1) machines.push(sorted);
        else machines[i] = sorted;
        version += 1;
        if (hooks.afterPut) {
          hooks.afterPut(machines);
          version += 1;
        }
        return { kind: 'ok', text: '' };
      }
      if (method === 'POST' && path === '/import') {
        const doc = JSON.parse(body as string) as { kind: string; machines?: unknown[] };
        if (doc.kind === 'casemaker-location') machines = doc.machines ?? [];
        version += 1;
        return { kind: 'ok', text: '' };
      }
      return { kind: 'refused', status: 404, message: `${method} ${path} is not served here` };
    },
  };
  setHouseClientLoader(async () => client);
  return {
    puts,
    machines: () => machines as MachineRecord[],
    /** Another window wrote — changing `patch`'s sections of machine 0 — so this one's validator is stale. */
    writeElsewhere: (patch: Partial<MachineRecord>) => {
      machines[0] = { ...(machines[0] as MachineRecord), ...patch, updatedAt: '2026-10-15T23:00:00.000Z' };
      version += 1;
    },
  };
}

function setLocal(opts: { vise?: boolean; calibration?: boolean; observed?: boolean; margins?: 'user' }) {
  useSettingsStore.setState({
    fixtures: opts.vise ? { vise: { ...VISE } } : {},
    margins: opts.margins ? { ...MARGIN_DEFAULTS, boundaryMargin: 0.3, source: 'user' } : { ...MARGIN_DEFAULTS },
    machineCalibration: opts.calibration ? CALIBRATION : undefined,
  });
  useMachineStore.setState({ machine: opts.observed ? OBSERVATION : null });
}

beforeEach(() => {
  resetLocationStore();
  resetHouseStore();
  setLocal({});
});

afterEach(() => {
  setHouseClientLoader(null);
});

describe('the "my machine" migration into the location (#412)', () => {
  it('seeds the machine record from this window’s saved setup and last check', async () => {
    const service = fakeService();
    setLocal({ vise: true, calibration: true, observed: true, margins: 'user' });

    await reconcileLocation();

    expect(service.puts).toHaveLength(1);
    const m = service.machines()[0]!;
    expect(m.profileId).toBe('Z1');
    expect(m.name).toBe('Makera_Z1_000000');
    expect(m.address).toEqual({ host: '192.0.2.10', port: 2222 });
    expect(m.serial).toBeNull();
    expect(m.firmware).toBeNull();
    expect(m.fixtures).toEqual({ vise: VISE });
    expect(m.calibration).toEqual(CALIBRATION);
    expect(m.margins?.source).toBe('user');
    // What the location now serves is what this window holds — nothing left to write.
    await pushMachine();
    expect(service.puts).toHaveLength(1);
  });

  it('does not seed over a machine record this build cannot read (#412 review)', async () => {
    const unreadable = { id: 'machine-x', updatedAt: '2026-10-15T00:00:00.000Z', margins: { source: 'guessed' } };
    const service = fakeService([unreadable as unknown as MachineRecord]);
    setLocal({ vise: true });
    await reconcileLocation();
    expect(useLocationStore.getState().location?.unreadableMachines).toHaveLength(1);
    expect(service.puts).toHaveLength(0);
  });

  it('checks a machine record against the read schema before the PUT (#412 review)', async () => {
    const service = fakeService();
    await reconcileLocation();
    const bad = { ...mergeMachine(localMachine(), null, null, 'now').record, margins: { source: 'guessed' } };
    const outcome = await useLocationStore.getState().saveMachine(bad as unknown as MachineRecord);
    expect(outcome).toBe('failed');
    expect(useLocationStore.getState().writeNote).toContain('would not read back');
    expect(service.puts).toHaveLength(0);
  });

  it('records no machine for a window that has nothing to migrate', async () => {
    const service = fakeService();
    await reconcileLocation();
    expect(useLocationStore.getState().status).toBe('present');
    expect(service.puts).toHaveLength(0);
  });

  it('lets an existing record win on connect, and writes nothing back', async () => {
    const { record: theirs } = mergeMachine(
      {
        fixtures: { vise: { ...VISE } },
        margins: { ...MARGIN_DEFAULTS, zTolerance: 0.07, source: 'user' },
        calibration: CALIBRATION,
        observation: OBSERVATION,
      },
      null,
      null,
      '2026-10-15T09:00:00.000Z',
    );
    const service = fakeService([theirs]);
    setLocal({}); // this window's storage holds nothing

    await reconcileLocation();

    const s = useSettingsStore.getState();
    expect(s.fixtures.vise).toEqual(VISE);
    expect(s.margins.zTolerance).toBe(0.07);
    expect(s.machineCalibration).toEqual(CALIBRATION);
    expect(service.puts).toHaveLength(0);
  });

  it('writes a settings change through, guarded on the location’s validator', async () => {
    const service = fakeService();
    setLocal({ vise: true });
    const stop = startLocationSync();
    try {
      useToolRegistryStore.setState({ status: 'present' });
      // Let the connect's reconcile land.
      await vi_waitFor(() => service.puts.length === 1);

      useSettingsStore.getState().setMargins({ ...MARGIN_DEFAULTS, edgeMargin: 0.9, source: 'user' });
      await pushMachine();
      await vi_waitFor(() => service.puts.length === 2);
      expect(service.machines()[0]!.margins?.edgeMargin).toBe(0.9);
      expect(service.machines()).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('a stale window does not put back a section another window changed — it takes it (#412 review)', async () => {
    const service = fakeService();
    setLocal({ vise: true });
    await reconcileLocation();
    expect(service.puts).toHaveLength(1);

    // The LAN browser saves new margins; this window has not re-read since.
    const theirs = { ...MARGIN_DEFAULTS, minFloor: 0.25, source: 'user' as const };
    service.writeElsewhere({ margins: theirs });
    // This window edits a DIFFERENT section with its stale validator.
    useSettingsStore.setState({ fixtures: { vise: { ...VISE, stockProud: 2.2 } } });
    await pushMachine();

    // Refused once (412), re-read, merged, written: both changes survive.
    expect(service.puts).toHaveLength(2);
    const m = service.machines()[0]!;
    expect(m.margins).toEqual(theirs);
    expect(m.fixtures?.vise?.stockProud).toBe(2.2);
    // And this window now holds the other window's margins.
    expect(useSettingsStore.getState().margins).toEqual(theirs);
    expect(useLocationStore.getState().writeNote).toBeNull();

    // A later edit from this window does not undo them either.
    useSettingsStore.setState({ fixtures: { vise: { ...VISE, stockProud: 2.4 } } });
    await pushMachine();
    expect(service.machines()[0]!.margins).toEqual(theirs);
    expect(service.machines()[0]!.fixtures?.vise?.stockProud).toBe(2.4);
  });

  it('takes the record it WROTE as the merge base, not the re-read (re-review)', async () => {
    // Another window writes new margins between this window's PUT and its re-read.
    const theirs = { ...MARGIN_DEFAULTS, breakthrough: 0.4, source: 'user' as const };
    let once = true;
    const service = fakeService([], {
      afterPut: (machines) => {
        if (!once) return;
        once = false;
        machines[0] = { ...(machines[0] as MachineRecord), margins: theirs };
      },
    });
    setLocal({ vise: true });
    await reconcileLocation(); // seeds; the re-read already carries their margins
    expect(service.puts).toHaveLength(1);

    // This window's next push sees margins changed ELSEWHERE and takes them, rather than writing
    // its own old ones back (which it would if the re-read had become its base).
    await pushMachine();
    expect(useSettingsStore.getState().margins).toEqual(theirs);
    expect(service.machines()[0]!.margins).toEqual(theirs);
  });

  it('compares records by content, not key order', () => {
    setLocal({ vise: true, calibration: true });
    const { record: mine } = mergeMachine(localMachine(), null, null, '2026-10-15T00:00:00.000Z');
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(mine).reverse()))) as MachineRecord;
    expect(sameRecord(reordered, mine)).toBe(true);
    expect(sameRecord({ ...reordered, margins: { ...MARGIN_DEFAULTS, minFloor: 9, source: 'user' } }, mine)).toBe(false);
  });

  it('a forgotten check does not erase the machine’s address from the record', () => {
    setLocal({ observed: true });
    const { record: before } = mergeMachine(localMachine(), null, null, '2026-10-15T07:00:00.000Z');
    useMachineStore.setState({ machine: null });
    const { record: after } = mergeMachine(localMachine(), before, before, '2026-10-15T09:00:00.000Z');
    expect(after.address).toEqual({ host: '192.0.2.10', port: 2222 });
    expect(after.id).toBe(before.id);
  });
});

describe('which machine check may move the record (#412 review)', () => {
  const record = (over: Partial<MachineRecord> = {}): MachineRecord => ({
    id: 'machine-1',
    profileId: 'Z1',
    name: 'Makera_Z1_000000',
    serial: null,
    firmware: null,
    address: { host: '192.0.2.10', port: 2222 },
    calibration: null,
    fixtures: {},
    margins: null,
    updatedAt: '2026-10-15T08:30:00.000Z',
    ...over,
  });
  const check = (over: Partial<MachineObservation> = {}): MachineObservation => ({
    ...OBSERVATION,
    observedAt: '2026-10-15T09:00:00.000Z',
    host: '192.0.2.99',
    ...over,
  });

  it('a newer check of the same machine moves the address', () => {
    expect(observationApplies(check(), record())).toBe(true);
  });

  it('an older check never wins — last week’s address stays out', () => {
    expect(observationApplies(check({ observedAt: '2026-10-08T09:00:00.000Z' }), record())).toBe(false);
    setLocal({});
    useMachineStore.setState({ machine: check({ observedAt: '2026-10-08T09:00:00.000Z' }) });
    const { record: merged } = mergeMachine(localMachine(), record(), record(), '2026-10-15T10:00:00.000Z');
    expect(merged.address).toEqual({ host: '192.0.2.10', port: 2222 });
  });

  it('a different machine is not written into this one', () => {
    expect(observationApplies(check({ name: 'Makera_Z1_999999' }), record())).toBe(false);
    // A typed address has no name: the profile decides.
    expect(observationApplies(check({ name: null, profileId: 'Carvera' }), record())).toBe(false);
    expect(observationApplies(check({ name: null }), record())).toBe(true);
  });

  it('a typed-address check to a new host does not keep the old broadcast name', () => {
    setLocal({});
    useMachineStore.setState({ machine: check({ name: null }) });
    const { record: merged } = mergeMachine(localMachine(), record(), record(), '2026-10-15T10:00:00.000Z');
    expect(merged.address?.host).toBe('192.0.2.99');
    expect(merged.name).toBeNull();
  });
});

describe('importing a location file (#412)', () => {
  it('applies the imported machine to this window’s settings, with no echo write', async () => {
    const service = fakeService();
    await reconcileLocation();
    useToolRegistryStore.setState({ status: 'present' });
    const stop = startLocationSync();
    try {
      expect(await useHouseStore.getState().importHouse(FIXTURE_TEXT)).toBe(true);
      expect(useHouseStore.getState().notice?.text).toBe('Loaded the location file.');
      const s = useSettingsStore.getState();
      expect(s.fixtures.vise?.source).toBe('measured');
      expect(s.margins.source).toBe('user');
      expect(s.machineCalibration?.source).toBe('config-get sd on 192.0.2.10');
      await pushMachine();
      expect(service.puts).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it('a location imported with no machine is not re-seeded from this window', async () => {
    const service = fakeService();
    setLocal({ vise: true });
    await reconcileLocation();
    expect(service.machines()).toHaveLength(1);
    const empty = JSON.parse(FIXTURE_TEXT) as { machines: unknown[] };
    empty.machines = [];
    expect(await useHouseStore.getState().importHouse(JSON.stringify(empty))).toBe(true);
    expect(service.machines()).toHaveLength(0);
    useSettingsStore.setState({ fixtures: { vise: { ...VISE, stockProud: 3 } } });
    await pushMachine();
    expect(service.machines()).toHaveLength(0);
  });

  it('refuses a location file this build could not read back, before sending it', async () => {
    const service = fakeService();
    const broken = JSON.parse(FIXTURE_TEXT) as { machines: Array<{ margins: Record<string, unknown> }> };
    broken.machines[0]!.margins.source = 'guessed';
    expect(await useHouseStore.getState().importHouse(JSON.stringify(broken))).toBe(false);
    expect(useHouseStore.getState().notice?.kind).toBe('refused');
    expect(service.machines()).toHaveLength(0);
  });
});

/** Poll a condition across microtasks — the write-through is fire-and-forget by design. */
async function vi_waitFor(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('the condition never held');
}
