// @vitest-environment jsdom
// #595 — the mount tap's reading lands on the mount's OWN record (the unit checked out to the
// machine), and the planner's jaw-top check reads that record before the machine's bed copy. The
// seams are the real ones: `useLocationStore` with a seeded location and a fake house service that
// records the accessory writes, and the real `mountDatumFor` / `mountDatumMismatch` guards.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setHouseClientLoader, type HouseCall, type HouseClient, type HouseHealth, type HouseProbe } from '@/platform/houseClient';
import { LocationViewSchema, type FixtureRecord, type LocationView } from '@/platform/locationClient';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import {
  mountDatumFor,
  mountDatumMismatch,
  mountUnitReading,
  recordMountReading,
  type MountUnitReading,
} from '@/engine/cnc/registration/mountContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEW = LocationViewSchema.parse(JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')));
const MACHINE = VIEW.machines[0]!;

const HEALTH: HouseHealth = {
  ok: true,
  schemaVersion: 1,
  build: 'v-test',
  hasCatalogue: false,
  feedRows: 0,
  materialSpecRows: 0,
  catalogueSyncedAt: null,
  problems: [],
  warnings: [],
  lastSync: null,
};

function recordingClient(record: (body: FixtureRecord) => void): HouseClient {
  return {
    probe: async (): Promise<HouseProbe> => ({ kind: 'present', health: HEALTH, base: '' }),
    tools: async () => ({ kind: 'ok', etag: '"t1"', entries: [] }),
    feeds: async () => ({ kind: 'ok', etag: '"f1"', rows: [] }),
    inventory: async () => ({ kind: 'ok', etag: '"i1"', items: [] }),
    call: async (method, path, body): Promise<HouseCall> => {
      if (method === 'GET' && path === '/location') {
        return { kind: 'ok', text: JSON.stringify(VIEW), etag: '"e1"' };
      }
      if (method === 'PUT' && path.startsWith('/location/accessories/')) {
        record(body as FixtureRecord);
        return { kind: 'ok', text: '' };
      }
      return { kind: 'ok', text: '' };
    },
  };
}

/** The fixture house with one accessory's `unit` changed. */
function withUnit(id: string, unit: Record<string, unknown>): LocationView {
  return {
    ...VIEW,
    accessories: (VIEW.accessories ?? []).map((a) => (a.id === id ? { ...a, unit: { ...a.unit, ...unit } } : a)),
  };
}

const READING = (over: Partial<MountUnitReading> = {}): MountUnitReading => ({
  value: -56.7,
  measuredAt: '2026-10-24T08:00:00.000Z',
  by: 'fx-probe-1',
  at: [12.5, -3],
  machineId: MACHINE.id,
  ...over,
});

beforeEach(() => {
  resetLocationStore();
  setHouseClientLoader(null);
});

afterEach(() => {
  setHouseClientLoader(null);
  resetLocationStore();
});

describe('#595 the mount reading write-back', () => {
  it('writes the jaw top onto the checked-out vise, with provenance and a history line', async () => {
    const puts: FixtureRecord[] = [];
    setHouseClientLoader(async () => recordingClient((b) => puts.push(b)));
    useLocationStore.setState({ status: 'present', location: VIEW, etag: '"e1"' });

    await recordMountReading(MACHINE, 'vise', { z: -56.82, at: { x: 12.5, y: -3 } }, 'fx-probe-1');

    expect(puts).toHaveLength(1);
    const acc = puts[0]!;
    expect(acc.id).toBe('fx-vise-1');
    expect(acc.unit.jawTopZ).toMatchObject({
      value: -56.82,
      by: 'fx-probe-1',
      machineId: MACHINE.id,
      at: [12.5, -3],
    });
    expect(String(acc.provenance.jawTopZ)).toMatch(/^probed:/);
    expect(acc.history[acc.history.length - 1]!.what).toContain('jaw top');
    expect(acc.history[acc.history.length - 1]!.what).toContain('Makera Wired Probe V2');
    // The record the reader accepts is the record the writer wrote.
    expect(mountUnitReading(acc.unit.jawTopZ)).not.toBeNull();
  });

  it('writes a bracket tap as the bracket top on the bracket', async () => {
    const puts: FixtureRecord[] = [];
    setHouseClientLoader(async () => recordingClient((b) => puts.push(b)));
    const bracket: FixtureRecord = {
      id: 'fx-bracket-1',
      kind: 'bracket',
      product: 'Angle bracket',
      variant: null,
      constants: {},
      unit: {},
      provenance: {},
      whereabouts: { kind: 'machine', machineId: MACHINE.id, since: '2026-10-24T00:00:00.000Z' },
      history: [],
    };
    useLocationStore.setState({ status: 'present', location: { ...VIEW, accessories: [...(VIEW.accessories ?? []), bracket] }, etag: '"e1"' });

    await recordMountReading(MACHINE, 'bracket', { z: -41.2, at: { x: 0, y: 50 } }, 'fx-probe-1');

    expect(puts).toHaveLength(1);
    expect(puts[0]!.id).toBe('fx-bracket-1');
    expect(puts[0]!.unit.bracketTopZ).toMatchObject({ value: -41.2, by: 'fx-probe-1' });
    expect(puts[0]!.history[puts[0]!.history.length - 1]!.what).toContain('bracket top');
  });

  it('writes nothing when no mount of that kind is checked out', async () => {
    const puts: FixtureRecord[] = [];
    setHouseClientLoader(async () => recordingClient((b) => puts.push(b)));
    const noVise = { ...VIEW, accessories: (VIEW.accessories ?? []).filter((a) => a.kind !== 'vise') };
    useLocationStore.setState({ status: 'present', location: noVise, etag: '"e1"' });

    await recordMountReading(MACHINE, 'vise', { z: -56.82, at: { x: 0, y: 0 } }, 'fx-probe-1');

    expect(puts).toHaveLength(0);
  });
});

describe('#595 the planner prefers the mount’s own record', () => {
  it('reads the unit’s tapped jaw top over the bed profile’s copy', () => {
    useLocationStore.setState({ status: 'present', location: withUnit('fx-vise-1', { jawTopZ: READING() }), etag: '"e1"' });

    expect(mountDatumFor(MACHINE)).toMatchObject({ jawTopZ: -56.7, by: 'fx-probe-1' });
    // The bed copy still says -56.82; the unit's record wins.
    expect(VIEW.machines[0]!.bedProfiles?.[0]?.datums.viseJawTopZ?.value).toBe(-56.82);
  });

  it('falls back to the bed profile when the unit record is absent', () => {
    useLocationStore.setState({ status: 'present', location: VIEW, etag: '"e1"' });
    expect(mountDatumFor(MACHINE)).toMatchObject({ jawTopZ: -56.82 });
  });

  it('ignores a reading taken on another machine', () => {
    useLocationStore.setState({
      status: 'present',
      location: withUnit('fx-vise-1', { jawTopZ: READING({ machineId: 'another-machine' }) }),
      etag: '"e1"',
    });
    expect(mountDatumFor(MACHINE)).toMatchObject({ jawTopZ: -56.82 });
  });

  it('ignores a reading by a probe that is not the one checked out now, and names it', () => {
    useLocationStore.setState({
      status: 'present',
      location: withUnit('fx-vise-1', { jawTopZ: READING({ by: 'fx-probe-3d' }) }),
      etag: '"e1"',
    });
    // The bed copy was taken by the checked-out probe, so it still anchors the plan…
    expect(mountDatumFor(MACHINE)).toMatchObject({ jawTopZ: -56.82, by: 'fx-probe-1' });

    // …and with no bed copy, the unit's stale reading is named as the mismatch instead.
    useLocationStore.setState({ status: 'present', location: withUnit('fx-vise-1', { jawTopZ: READING({ by: 'fx-probe-3d' }) }), etag: '"e1"' });
    const bedlessMachine = { ...MACHINE, bedProfiles: undefined, activeBedProfileId: undefined };
    expect(mountDatumFor(bedlessMachine)).toBeNull();
    expect(mountDatumMismatch(bedlessMachine)).toBe('fx-probe-3d');
  });
});
