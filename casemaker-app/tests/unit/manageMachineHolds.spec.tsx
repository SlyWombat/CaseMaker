// @vitest-environment jsdom
// Issue #602 — the machine card's nickname and Holds list, and check-out/return from the machine side.
//
// THE LOCATION IS THE SEAM. `useLocationStore` is seeded with the fixture's location (its machine
// checked out to the vise and the wired probe, the 3D probe in its box) and its nickname overridden
// to "Zoomba". A stateful fake service answers `GET /location` and applies accessory/machine writes
// back to its own copy, so a Return's re-read shows the accessory in the box — exactly what the
// Accessories scope reads to say "in its box".

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setHouseClientLoader, type HouseCall, type HouseClient, type HouseHealth, type HouseProbe } from '@/platform/houseClient';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MachinesScope } from '@/components/manage/MachinesScope';
import {
  LocationViewSchema,
  type FixtureRecord,
  type LocationView,
  type MachineRecord,
} from '@/platform/locationClient';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { resetMachineStore } from '@/store/machineStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEW = LocationViewSchema.parse(JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')));
const MACHINE_ID = VIEW.machines[0]!.id;

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

/** The fixture's location with the machine nicknamed "Zoomba" (#602's acceptance). */
function zoomba(): LocationView {
  return { ...VIEW, machines: [{ ...VIEW.machines[0]!, nickname: 'Zoomba' }] };
}

/**
 * A fake service that serves the location and applies writes back to a caller-held copy, so a
 * re-read after a Return (or a nickname save) reflects the change — the Accessories scope agrees.
 * `state.location` is a shared object because `ask` calls the loader afresh on every request; a
 * `let` captured inside the factory would be reset between the write and the re-read.
 */
function statefulClient(
  state: { location: LocationView },
  record: (method: string, path: string, body: unknown, ifMatch: string | null | undefined) => void,
): HouseClient {
  return {
    probe: async (): Promise<HouseProbe> => ({ kind: 'present', health: HEALTH, base: '' }),
    tools: async () => ({ kind: 'ok', etag: '"t1"', entries: [] }),
    feeds: async () => ({ kind: 'ok', etag: '"f1"', rows: [] }),
    inventory: async () => ({ kind: 'ok', etag: '"i1"', items: [] }),
    call: async (method, path, body, opts): Promise<HouseCall> => {
      if (method === 'GET' && path === '/location') {
        return { kind: 'ok', text: JSON.stringify(state.location), etag: '"e1"' };
      }
      if (method === 'PUT' && path.startsWith('/location/accessories/')) {
        const acc = body as FixtureRecord;
        state.location = { ...state.location, accessories: (state.location.accessories ?? []).map((a) => (a.id === acc.id ? acc : a)) };
        record(method, path, body, opts?.ifMatch);
        return { kind: 'ok', text: '' };
      }
      if (method === 'PUT' && path.startsWith('/location/machines/')) {
        const m = body as MachineRecord;
        state.location = { ...state.location, machines: state.location.machines.map((x) => (x.id === m.id ? m : x)) };
        record(method, path, body, opts?.ifMatch);
        return { kind: 'ok', text: '' };
      }
      // Any other read (a power read, a health check) answers ok without being recorded.
      return { kind: 'ok', text: '' };
    },
  };
}

beforeEach(() => {
  cleanup();
  resetLocationStore();
  resetMachineStore();
  setHouseClientLoader(null);
});

afterEach(() => {
  cleanup();
  setHouseClientLoader(null);
  resetLocationStore();
  resetMachineStore();
});

function seed(): void {
  useLocationStore.setState({ status: 'present', location: zoomba(), etag: '"e1"', reason: null });
}

describe('#602 — the machine card names and holds', () => {
  it('shows the nickname and lists the held accessories, with the boxed probe only in the picker', () => {
    seed();
    render(<MachinesScope />);

    // The nickname is the card's editable field, seeded "Zoomba".
    const input = screen.getByTestId('manage-location-nickname-input') as HTMLInputElement;
    expect(input.value).toBe('Zoomba');

    // The vise and the wired probe are checked out to this machine; each has a Return.
    const vise = screen.getByTestId('manage-hold-fx-vise-1');
    expect(vise.textContent).toContain('makera-z1-low-profile-vise');
    const wired = screen.getByTestId('manage-hold-fx-probe-1');
    expect(wired.textContent).toContain('Makera Wired Probe V2');
    expect(screen.getByTestId('manage-hold-return-fx-vise-1')).toBeTruthy();
    expect(screen.getByTestId('manage-hold-return-fx-probe-1')).toBeTruthy();

    // The 3D probe is in the box, so it is a check-out option, not a hold.
    expect(screen.queryByTestId('manage-hold-fx-probe-3d')).toBeNull();
    const pick = screen.getByTestId('manage-checkout-pick') as HTMLSelectElement;
    expect(pick.textContent).toContain('Makera 3D Wired Probe');
  });

  it('Return moves a held accessory to the box, and the location (the Accessories scope) agrees', async () => {
    const calls: Array<{ method: string; path: string; body: unknown; ifMatch: string | null | undefined }> = [];
    const state = { location: zoomba() };
    setHouseClientLoader(async () => statefulClient(state, (method, path, body, ifMatch) => calls.push({ method, path, body, ifMatch })));
    seed();
    render(<MachinesScope />);

    fireEvent.click(screen.getByTestId('manage-hold-return-fx-probe-1'));
    await waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.path).toBe('/location/accessories/fx-probe-1');
    expect(calls[0]!.ifMatch).toBe('"e1"');
    expect((calls[0]!.body as FixtureRecord).whereabouts).toEqual({ kind: 'box' });

    // The re-read (the seam the Accessories scope reads) now has the probe in its box.
    await waitFor(() => {
      const probe = useLocationStore.getState().location?.accessories?.find((a) => a.id === 'fx-probe-1');
      expect(probe?.whereabouts).toEqual({ kind: 'box' });
    });
  });

  it('editing the nickname writes the machine record, guarded on the location', async () => {
    const calls: Array<{ method: string; path: string; body: unknown; ifMatch: string | null | undefined }> = [];
    const state = { location: zoomba() };
    setHouseClientLoader(async () => statefulClient(state, (method, path, body, ifMatch) => calls.push({ method, path, body, ifMatch })));
    seed();
    render(<MachinesScope />);

    const input = screen.getByTestId('manage-location-nickname-input') as HTMLInputElement;
    const save = screen.getByTestId('manage-location-nickname-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true); // unchanged
    fireEvent.change(input, { target: { value: 'Zoomba 2' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.path).toBe(`/location/machines/${MACHINE_ID}`);
    expect(calls[0]!.ifMatch).toBe('"e1"');
    expect((calls[0]!.body as MachineRecord).nickname).toBe('Zoomba 2');
  });
});
