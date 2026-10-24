// @vitest-environment jsdom
// Issue #601 — Manage › Accessories: the mounts and probes the house owns, listed with their
// measured records, whereabouts and history; a register door; check-out/return; retire.
//
// THE LOCATION IS THE SEAM. `useLocationStore` is seeded with a `LocationView` carrying the three
// house accessories (the vise, the wired probe checked out to the Z1, the 3D probe in its box), and
// `setHouseClientLoader` swaps the house service for a fake whose `call` answers `GET /location` and
// records the accessory writes. The scope itself is the thing under test.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccessoriesScope } from '@/components/manage/AccessoriesScope';
import { useManageModeStore, resetManageMode } from '@/store/manageModeStore';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import type { FixtureRecord, LocationView } from '@/platform/locationClient';
import {
  setHouseClientLoader,
  type HouseCall,
  type HouseClient,
  type HouseHealth,
  type HouseProbe,
} from '@/platform/houseClient';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MACHINE_ID = 'machine-1a2b3c';

const HEALTH: HouseHealth = {
  ok: true,
  schemaVersion: 1,
  hasCatalogue: false,
  feedRows: 0,
  materialSpecRows: 0,
  catalogueSyncedAt: null,
  problems: [],
  warnings: [],
  lastSync: null,
};

/** The three house accessories as the fixture's `accessories[]` carries them (#601). */
const VISE: FixtureRecord = {
  id: 'fx-vise-1',
  kind: 'vise',
  product: 'makera-z1-low-profile-vise',
  variant: null,
  constants: { jawBarWidth: 10, jawLength: 100, ledgeStep: 3.1, ledgeWidth: 1.9 },
  unit: { stockProud: 1.5, fixedJawThickness: 10, movingJawThickness: 10, jawLength: 100, jawStartY: -10, uncertainty: 0.1 },
  provenance: { jawBarWidth: 'measured:2026-10-13T12:00:00.000Z', stockProud: 'measured:2026-10-13T12:00:00.000Z' },
  whereabouts: { kind: 'machine', machineId: MACHINE_ID, since: '2026-10-15T09:00:00.000Z' },
  history: [{ at: '2026-10-15T09:00:00.000Z', what: 'hoisted from the machine bed fixtures' }],
};

const WIRED_PROBE: FixtureRecord = {
  id: 'fx-probe-1',
  kind: 'probe',
  product: 'Makera Wired Probe V2',
  variant: 'wired-touch',
  constants: {},
  unit: { tipDiameterMm: 2.0, rimOffsetMm: 0.7, rimOffsetUncertaintyMm: 0.25, lastM491: null, lastM119Rest: null },
  provenance: {
    tipDiameterMm: 'measured:2026-10-23T00:00:00.000Z',
    rimOffsetMm: 'measured:2026-10-23T00:00:00.000Z',
    rimOffsetUncertaintyMm: 'measured:2026-10-23T00:00:00.000Z',
  },
  whereabouts: { kind: 'machine', machineId: MACHINE_ID, since: '2026-10-23T00:00:00.000Z' },
  history: [{ at: '2026-10-23T00:00:00.000Z', what: 'measured tip 2.0 / rim 0.70 +/- 0.25' }],
};

const PROBE_3D: FixtureRecord = {
  id: 'fx-probe-3d',
  kind: 'probe',
  product: 'Makera 3D Wired Probe',
  variant: '3d',
  constants: {},
  unit: { tipDiameterMm: null, rimOffsetMm: null, rimOffsetUncertaintyMm: null, lastM491: null, lastM119Rest: null },
  provenance: {},
  whereabouts: { kind: 'box' },
  history: [{ at: '2026-10-23T00:00:00.000Z', what: 'owned; not yet tested' }],
};

function view(): LocationView {
  return {
    kind: 'casemaker-location',
    schemaVersion: 1,
    id: 'loc-1a2b3c4d',
    name: 'Test bench',
    createdAt: '2026-10-15T09:00:00.000Z',
    migratedFrom: null,
    machines: [{ id: MACHINE_ID, profileId: 'Z1', name: 'Makera_Z1_000000', updatedAt: '2026-10-15T09:00:00.000Z' }],
    unreadableMachines: [],
    accessories: [VISE, WIRED_PROBE, PROBE_3D],
  } as unknown as LocationView;
}

/** A fake service that serves the location and records accessory writes. */
function fakeClient(record: (method: string, path: string, body: unknown, ifMatch: string | null | undefined) => void): HouseClient {
  return {
    probe: async (): Promise<HouseProbe> => ({ kind: 'present', health: HEALTH, base: '' }),
    tools: async () => ({ kind: 'ok', etag: '"t1"', entries: [] }),
    feeds: async () => ({ kind: 'ok', etag: '"f1"', rows: [] }),
    inventory: async () => ({ kind: 'ok', etag: '"i1"', items: [] }),
    call: async (method, path, body, opts): Promise<HouseCall> => {
      if (method === 'GET' && path === '/location') {
        return { kind: 'ok', text: JSON.stringify(view()), etag: '"e1"' };
      }
      record(method, path, body, opts?.ifMatch);
      return { kind: 'ok', text: '' };
    },
  };
}

beforeEach(() => {
  cleanup();
  resetManageMode();
  resetLocationStore();
  setHouseClientLoader(null);
  useManageModeStore.getState().openManage('accessories');
});

afterEach(() => {
  cleanup();
  setHouseClientLoader(null);
  resetLocationStore();
  resetManageMode();
});

/** Seed the location and draw the scope. */
function seed(over: Partial<LocationView> = {}): void {
  useLocationStore.setState({ status: 'present', location: { ...view(), ...over }, etag: '"e1"', reason: null });
}

const q = (id: string) => screen.queryByTestId(id);

describe('#601 — the Accessories scope lists the house', () => {
  it('draws the vise and the two probes with their measured lines and whereabouts', () => {
    seed();
    render(<AccessoriesScope />);

    // The wired probe: its measured tip/rim line and "in the Z1 since".
    const wired = screen.getByTestId('manage-accessories-row-fx-probe-1');
    expect(wired.textContent).toContain('Makera Wired Probe V2');
    expect(wired.textContent).toContain('wired-touch');
    expect(wired.textContent).toContain('in the Z1 since');
    expect(wired.textContent).toContain('tip ⌀ 2.0 · rim 0.7 ± 0.25');

    // The 3D probe: in its box, unmeasured, "not yet tested".
    const probe3d = screen.getByTestId('manage-accessories-row-fx-probe-3d');
    expect(probe3d.textContent).toContain('Makera 3D Wired Probe');
    expect(probe3d.textContent).toContain('3d');
    expect(probe3d.textContent).toContain('in its box');
    expect(probe3d.textContent).toContain('not measured');
    expect(probe3d.textContent).toContain('owned; not yet tested');

    // The vise: a mount with measured numbers.
    const vise = screen.getByTestId('manage-accessories-row-fx-vise-1');
    expect(vise.textContent).toContain('makera-z1-low-profile-vise');
    expect(vise.textContent).toContain('vise');
    expect(vise.textContent).toContain('measured');
  });

  it('with no service shows the absent card, not an empty list', () => {
    useLocationStore.setState({ status: 'absent', location: null, reason: 'no location here' });
    render(<AccessoriesScope />);
    expect(q('manage-accessories-absent')).not.toBeNull();
    expect(q('manage-accessories-table')).toBeNull();
  });
});

describe('#601 — check-out and return move whereabouts', () => {
  let calls: Array<{ method: string; path: string; body: unknown; ifMatch: string | null | undefined }>;

  beforeEach(() => {
    calls = [];
    setHouseClientLoader(async () => fakeClient((method, path, body, ifMatch) => calls.push({ method, path, body, ifMatch })));
  });

  it('checking a box probe out writes whereabouts to the chosen machine, guarded on the location', async () => {
    seed();
    render(<AccessoriesScope />);

    fireEvent.click(screen.getByTestId('manage-accessories-pick-fx-probe-3d'));
    // The 3D probe is in its box, so the rail offers a check-out.
    expect(q('manage-acc-checkout')).not.toBeNull();
    expect(q('manage-acc-return')).toBeNull();

    fireEvent.click(screen.getByTestId('manage-acc-checkout'));
    await waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.path).toBe('/location/accessories/fx-probe-3d');
    expect(calls[0]!.ifMatch).toBe('"e1"');
    const sent = calls[0]!.body as FixtureRecord;
    expect(sent.whereabouts).toMatchObject({ kind: 'machine', machineId: MACHINE_ID });
    // The measured record and the product survive the move untouched.
    expect(sent.product).toBe('Makera 3D Wired Probe');
    expect(sent.unit).toMatchObject({ tipDiameterMm: null });
  });

  it('returning the wired probe writes whereabouts back to the box', async () => {
    seed();
    render(<AccessoriesScope />);

    fireEvent.click(screen.getByTestId('manage-accessories-pick-fx-probe-1'));
    // Checked out: the rail offers a return, not another check-out.
    expect(q('manage-acc-return')).not.toBeNull();
    expect(q('manage-acc-checkout')).toBeNull();

    fireEvent.click(screen.getByTestId('manage-acc-return'));
    await waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.path).toBe('/location/accessories/fx-probe-1');
    const sent = calls[0]!.body as FixtureRecord;
    expect(sent.whereabouts).toEqual({ kind: 'box' });
  });
});

describe('#601 — the register door creates a probe exactly as the fixture has it', () => {
  let calls: Array<{ method: string; path: string; body: unknown }>;

  beforeEach(() => {
    calls = [];
    setHouseClientLoader(async () => fakeClient((method, path, body) => calls.push({ method, path, body })));
  });

  it('an unmeasured 3D probe registers in the box, untested, with the registration keys as nulls', async () => {
    seed();
    render(<AccessoriesScope />);

    fireEvent.click(screen.getByTestId('manage-accessories-register-open'));
    expect(q('manage-acc-register')).not.toBeNull();

    fireEvent.change(screen.getByTestId('manage-acc-product'), { target: { value: 'Makera 3D Wired Probe' } });
    fireEvent.change(screen.getByTestId('manage-acc-variant'), { target: { value: '3d' } });
    const submit = screen.getByTestId('manage-acc-register-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.path).toMatch(/^\/location\/accessories\/fx-/);
    const sent = calls[0]!.body as FixtureRecord;
    expect(sent.kind).toBe('probe');
    expect(sent.product).toBe('Makera 3D Wired Probe');
    expect(sent.variant).toBe('3d');
    // Exactly the fixture's shape: tip/rim null, the registration keys present as nulls, in the box.
    expect(sent.unit).toEqual({ tipDiameterMm: null, rimOffsetMm: null, rimOffsetUncertaintyMm: null, lastM491: null, lastM119Rest: null });
    expect(sent.provenance).toEqual({});
    expect(sent.whereabouts).toEqual({ kind: 'box' });
    expect(sent.history[0]!.what).toBe('owned; not yet tested');
  });

  it('a measured probe records its tip and rim, dated as measured', async () => {
    seed();
    render(<AccessoriesScope />);

    fireEvent.click(screen.getByTestId('manage-accessories-register-open'));
    fireEvent.change(screen.getByTestId('manage-acc-product'), { target: { value: 'Makera Wired Probe V2' } });
    fireEvent.change(screen.getByTestId('manage-acc-variant'), { target: { value: 'wired-touch' } });
    fireEvent.change(screen.getByTestId('manage-acc-tip'), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('manage-acc-rim'), { target: { value: '0.7' } });
    fireEvent.change(screen.getByTestId('manage-acc-rim-unc'), { target: { value: '0.25' } });
    fireEvent.click(screen.getByTestId('manage-acc-register-submit'));

    await waitFor(() => expect(calls).toHaveLength(1));
    const sent = calls[0]!.body as FixtureRecord;
    expect(sent.unit).toMatchObject({ tipDiameterMm: 2, rimOffsetMm: 0.7, rimOffsetUncertaintyMm: 0.25 });
    expect(sent.provenance.tipDiameterMm).toMatch(/^measured:/);
    expect(sent.history[0]!.what).toContain('measured tip 2.0 / rim 0.7 +/- 0.25');
  });

  it('refuses a nameless probe, and a negative tip', () => {
    seed();
    render(<AccessoriesScope />);

    fireEvent.click(screen.getByTestId('manage-accessories-register-open'));
    const submit = screen.getByTestId('manage-acc-register-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('manage-acc-product'), { target: { value: 'Makera 3D Wired Probe' } });
    expect(submit.disabled).toBe(false);
    fireEvent.change(screen.getByTestId('manage-acc-tip'), { target: { value: '-3' } });
    expect(submit.disabled).toBe(true);
    expect(submit.title).toContain('tip ⌀');
  });
});

describe('#601 — the detail rail edits the label and retires', () => {
  let calls: Array<{ method: string; path: string; body: unknown }>;

  beforeEach(() => {
    calls = [];
    setHouseClientLoader(async () => fakeClient((method, path, body) => calls.push({ method, path, body })));
  });

  it('editing the label saves the product, and Retire deletes the record', async () => {
    seed();
    render(<AccessoriesScope />);

    fireEvent.click(screen.getByTestId('manage-accessories-pick-fx-probe-3d'));
    const label = screen.getByTestId('manage-acc-label') as HTMLInputElement;
    expect(label.value).toBe('Makera 3D Wired Probe');
    fireEvent.change(label, { target: { value: 'Makera 3D Wired Probe (box 2)' } });
    fireEvent.click(screen.getByTestId('manage-acc-save'));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.path).toBe('/location/accessories/fx-probe-3d');
    expect((calls[0]!.body as FixtureRecord).product).toBe('Makera 3D Wired Probe (box 2)');

    fireEvent.click(screen.getByTestId('manage-acc-retire'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.method).toBe('DELETE');
    expect(calls[1]!.path).toBe('/location/accessories/fx-probe-3d');
  });
});
