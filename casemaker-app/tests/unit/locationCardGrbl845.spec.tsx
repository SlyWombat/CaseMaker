// @vitest-environment jsdom
// #845 slice B — ADDING A GRBL MACHINE FROM THE LOCATION CARD.
//
// The button under the machine list creates an ordinary house-location machine record from a
// preset (the manager's rule: machines are shared location data, visible from any LAN browser).
// This pins the press: the record written names the preset model, reaches no address, and the row
// stops offering a preset the location already holds.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { LocationCard } from '@/components/manage/LocationCard';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { resetHouseStore, useHouseStore } from '@/store/houseStore';
import { HOUSE_SCHEMA_VERSION, setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import type { LocationView, MachineRecord } from '@/platform/locationClient';
import { LocationViewSchema } from '@/platform/locationClient';
import { MILL_MODELS } from '@/engine/cnc/machine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW_DOC: LocationView = LocationViewSchema.parse({
  kind: 'casemaker-location',
  schemaVersion: 1,
  id: 'loc-1',
  name: 'My shop',
  createdAt: '2026-11-01T00:00:00.000Z',
  machines: [],
  accessories: [],
});

function fakeHouse(served: LocationView): { writes: MachineRecord[] } {
  const writes: MachineRecord[] = [];
  let doc = served;
  const client: HouseClient = {
    probe: async () => ({
      kind: 'present' as const,
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
    tools: async () => ({ kind: 'ok' as const, etag: '"t"', entries: [] }),
    feeds: async () => ({ kind: 'absent' as const, reason: 'none' }),
    inventory: async () => ({ kind: 'ok' as const, etag: '"i"', items: [] }),
    call: async (method, path, body): Promise<HouseCall> => {
      if (method === 'GET' && path === '/location') return { kind: 'ok', text: JSON.stringify(doc), etag: '"e1"' };
      if (method === 'PUT' && path.startsWith('/location/machines/')) {
        const record = body as MachineRecord;
        writes.push(record);
        doc = { ...doc, machines: [...doc.machines, record] } as unknown as LocationView;
        return { kind: 'ok', text: '' };
      }
      return { kind: 'refused', status: 404, message: `${method} ${path} is not served` };
    },
  };
  setHouseClientLoader(async () => client);
  return { writes };
}

beforeEach(() => {
  resetLocationStore();
  resetHouseStore();
  useHouseStore.setState({ busy: null });
});

afterEach(() => {
  cleanup();
  setHouseClientLoader(null);
});

describe('#845 slice B the location card’s GRBL presets', () => {
  it('offers the four presets on a location with no machine, and a press writes the record', async () => {
    const house = fakeHouse(NOW_DOC);
    act(() => {
      useLocationStore.setState({ status: 'present', location: NOW_DOC, etag: '"e1"', reason: null });
    });
    render(<LocationCard location={NOW_DOC} writeNote={null} />);

    expect(screen.getByTestId('manage-location-add-grbl')).toBeTruthy();
    const button = screen.getByTestId('manage-location-add-grbl:shapeoko-4');
    expect(button.textContent).toContain('Add Shapeoko 4 XXL');
    fireEvent.click(button);

    await waitFor(() => expect(house.writes).toHaveLength(1));
    const record = house.writes[0]!;
    expect(record.profileId).toBe('grbl:shapeoko-4');
    expect(record.address).toBeNull();
    expect(MILL_MODELS[record.profileId!]?.post).toBe('grbl');
    await waitFor(() =>
      expect(screen.getByTestId('manage-location-add-note').textContent).toContain(
        'Case Maker writes its .nc and does not drive it',
      ),
    );
  });

  it('does not offer a preset the location already holds', () => {
    const held = LocationViewSchema.parse({
      ...NOW_DOC,
      machines: [{ id: 'machine-grbl-1', profileId: 'grbl:shapeoko-4', name: 'Shapeoko 4 XXL', updatedAt: '2026-11-01T00:00:00.000Z' }],
    });
    fakeHouse(held);
    act(() => {
      useLocationStore.setState({ status: 'present', location: held, etag: '"e1"', reason: null });
    });
    render(<LocationCard location={held} writeNote={null} />);
    expect(screen.queryByTestId('manage-location-add-grbl:shapeoko-4')).toBeNull();
    expect(screen.getByTestId('manage-location-add-grbl:shapeoko-5-pro')).toBeTruthy();
  });
});
