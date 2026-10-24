// @vitest-environment jsdom
// #613 — the first vise registration on a machine with no bed profile creates the bed: the vise
// accessory is written to the house's accessories[] and the machine is returned with the active
// profile. The client is the seam: a minimal fake serving GET /location and PUT /location/accessories/:id.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOUSE_SCHEMA_VERSION, setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import type { LocationView, MachineRecord } from '@/platform/locationClient';
import { createFirstBed, resetLocationStore, useLocationStore } from '@/store/locationStore';
import { resetHouseStore, useHouseStore } from '@/store/houseStore';

/** The k3 house shape: no fixtures, no wasteboard, no accessories, no bed profile. */
const K3: MachineRecord = {
  id: 'machine-1a2b3c',
  name: 'Makera_Z1_000000',
  address: { host: '192.0.2.10', port: 2222 },
  fixtures: {},
  wasteboard: null,
  updatedAt: '2026-10-23T00:00:00.000Z',
} as unknown as MachineRecord;

const NOW = '2026-10-23T00:00:00.000Z';
const REGISTRATION = { measuredAt: NOW, correctedG54: { x: -181.2, y: -193.5 } };

function minimalService() {
  const puts: unknown[] = [];
  const client: HouseClient = {
    probe: async () => ({
      kind: 'present',
      base: '',
      health: {
        ok: true,
        schemaVersion: HOUSE_SCHEMA_VERSION,
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
    call: async (method, path, body): Promise<HouseCall> => {
      if (method === 'GET' && path === '/location') {
        const view = {
          kind: 'casemaker-location',
          schemaVersion: 1,
          id: 'loc-test',
          name: 'My shop',
          createdAt: NOW,
          migratedFrom: NOW,
          machines: [K3],
        };
        return { kind: 'ok', text: JSON.stringify(view), etag: '"loc-1"' };
      }
      if (method === 'PUT' && path.startsWith('/location/accessories/')) {
        puts.push(body);
        return { kind: 'ok', text: '' };
      }
      return { kind: 'refused', status: 404, message: `${method} ${path} is not served` };
    },
  };
  setHouseClientLoader(async () => client);
  return { puts };
}

beforeEach(() => {
  resetLocationStore();
  resetHouseStore();
  useHouseStore.setState({ busy: null });
});

afterEach(() => {
  setHouseClientLoader(null);
});

describe('#613 the first registration creates the bed', () => {
  it('writes the vise accessory and the active profile, once', async () => {
    const service = minimalService();
    useLocationStore.setState({
      status: 'present',
      location: { id: 'loc-test', name: 'My shop', kind: 'casemaker-location', schemaVersion: 1, createdAt: NOW, migratedFrom: NOW, machines: [K3] } as unknown as LocationView,
      etag: '"loc-1"',
    });

    const withBed = await createFirstBed(K3, REGISTRATION, NOW);

    expect(service.puts).toHaveLength(1);
    expect((service.puts[0] as { id: string }).id).toBe('fx-vise-1');
    expect(withBed.bedProfiles).toHaveLength(1);
    expect(withBed.activeBedProfileId).toBeDefined();
    expect(withBed.bedProfiles![0]!.placements[0]!.frame).toEqual({ fixedJawFaceX: -181.2, jawStartY: -203.5 });

    // A second registration on the now-described machine writes nothing more.
    const again = await createFirstBed(withBed, REGISTRATION, NOW);
    expect(again).toBe(withBed);
    expect(service.puts).toHaveLength(1);
  });
});
