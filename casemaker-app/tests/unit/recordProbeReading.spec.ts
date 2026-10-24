// @vitest-environment jsdom
// #601 — the executor's M491/M119 write-back lands on the checked-out probe accessory.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setHouseClientLoader, type HouseCall, type HouseClient, type HouseHealth, type HouseProbe } from '@/platform/houseClient';
import { LocationViewSchema, type FixtureRecord } from '@/platform/locationClient';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { recordProbeReading, probeFor } from '@/engine/cnc/registration/mountContext';

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

beforeEach(() => {
  resetLocationStore();
  setHouseClientLoader(null);
});

afterEach(() => {
  setHouseClientLoader(null);
  resetLocationStore();
});

describe('#601 the probe reading write-back', () => {
  it('writes lastM491 and lastM119Rest onto the checked-out probe, with a history line', async () => {
    const puts: FixtureRecord[] = [];
    setHouseClientLoader(async () => recordingClient((b) => puts.push(b)));
    useLocationStore.setState({ status: 'present', location: VIEW, etag: '"e1"' });

    await recordProbeReading(MACHINE, { lengthZ: -76.063, rest: 'X_max:0 Y_max:0 Z_max:0 A_min:1 Probe: 0' });

    expect(puts).toHaveLength(1);
    const acc = puts[0]!;
    expect(acc.id).toBe('fx-probe-1');
    expect(acc.unit.lastM491).toMatchObject({ z: -76.063 });
    expect(acc.unit.lastM119Rest).toBe('0');
    expect(acc.history[acc.history.length - 1]!.what).toContain('probe length');
  });

  it('writes nothing when no probe accessory is checked out', async () => {
    const puts: FixtureRecord[] = [];
    setHouseClientLoader(async () => recordingClient((b) => puts.push(b)));
    const noProbe = { ...VIEW, accessories: (VIEW.accessories ?? []).filter((a) => a.kind !== 'probe') };
    useLocationStore.setState({ status: 'present', location: noProbe, etag: '"e1"' });

    await recordProbeReading(MACHINE, { lengthZ: -76.063, rest: 'X_max:0 Y_max:0 Z_max:0 A_min:1 Probe: 0' });

    expect(puts).toHaveLength(0);
  });
});

describe('#525 the checked-out probe carries its instrument', () => {
  /** The same house, with the 3D probe checked out to the machine instead of the wired one. */
  const checkedOut3d = () => ({
    ...VIEW,
    accessories: (VIEW.accessories ?? []).map((a) => {
      if (a.id === 'fx-probe-3d') {
        return { ...a, whereabouts: { kind: 'machine' as const, machineId: MACHINE.id, since: '2026-10-24T00:00:00.000Z' } };
      }
      if (a.id === 'fx-probe-1') return { ...a, whereabouts: { kind: 'box' as const } };
      return a;
    }),
  });

  it('the wired probe is z-only, with its measured tip', () => {
    useLocationStore.setState({ status: 'present', location: VIEW, etag: '"e1"' });
    const probe = probeFor(MACHINE)!;
    expect(probe.instrument).toBe('z-only');
    expect(probe.tip).toMatchObject({ diameterMm: 2, rimOffsetMm: 0.7 });
  });

  it('the 3D probe is the xyz instrument with a NULL tip — the planner then refuses, never assumes', () => {
    useLocationStore.setState({ status: 'present', location: checkedOut3d(), etag: '"e1"' });
    const probe = probeFor(MACHINE)!;
    expect(probe.id).toBe('fx-probe-3d');
    expect(probe.instrument).toBe('xyz');
    expect(probe.tip).toBeNull();
  });
});
