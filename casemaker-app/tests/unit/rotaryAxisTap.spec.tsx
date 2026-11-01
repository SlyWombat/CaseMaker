// @vitest-environment jsdom
// #607 — the module's card's axis row: it offers the tap only where this window can drive the
// machine, the machine has an address and a read frame, a MEASURED probe is checked out to it, and
// the bed's surface has been measured (the trial chord needs a floor). The nominal values start
// from the datum the profile carries.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RotaryAxisTap } from '@/components/manage/RotaryAxisTap';
import { useLocationStore } from '@/store/locationStore';
import type { MachineRecord } from '@/platform/locationClient';

// vitest runs the WEB target (`__BUILD_TARGET__` = 'web'), so the gate under test is flipped here.
const caps = vi.hoisted(() => ({ canReachMachine: false }));
vi.mock('@/platform/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/capabilities')>();
  return {
    ...actual,
    get canReachMachine() {
      return caps.canReachMachine;
    },
  };
});

const TODAY = '2026-10-31T00:00:00.000Z';

function machine(over: Partial<MachineRecord> = {}): MachineRecord {
  return {
    id: 'm1',
    name: 'QA Z1',
    profileId: 'Z1',
    address: { host: '192.0.2.10', port: 2222 },
    unit: {},
    provenance: {},
    history: [],
    notes: [],
    observedAt: TODAY,
    activeBedProfileId: 'bp1',
    bedProfiles: [
      {
        id: 'bp1',
        name: 'QA bed',
        createdAt: TODAY,
        surface: { kind: 'bare-bed' },
        datums: {
          surfaceTopZ: { value: -76, measuredAt: TODAY, by: 'fx-probe-3d', at: null },
          viseJawTopZ: null,
          bracketSeatZ: null,
          rotaryAxis: null,
        },
        placements: [],
        history: [],
      },
    ],
    ...over,
  } as unknown as MachineRecord;
}

function probe(measured: boolean): Record<string, unknown> {
  return {
    id: 'fx-probe-3d',
    kind: 'probe',
    product: 'Makera 3D Probe',
    variant: '3d',
    unit: measured
      ? { tipDiameterMm: 2, rimOffsetMm: 0.875, rimOffsetUncertaintyMm: 0.01 }
      : { tipDiameterMm: null, rimOffsetMm: null, rimOffsetUncertaintyMm: null },
    whereabouts: { kind: 'machine', machineId: 'm1', since: TODAY },
    provenance: {},
    history: [],
  };
}

function seedAccessories(records: Record<string, unknown>[]): void {
  useLocationStore.setState({
    status: 'present',
    etag: '"e1"',
    reason: null,
    location: {
      machines: [machine()],
      accessories: records,
    } as unknown as NonNullable<ReturnType<typeof useLocationStore.getState>['location']>,
  });
}

beforeEach(() => {
  caps.canReachMachine = true;
});
afterEach(cleanup);

describe('#607 the module card’s axis row', () => {
  it('offers the tap with the nominal axis the profile carries, and starts at the defaults', () => {
    seedAccessories([probe(true)]);
    render(<RotaryAxisTap machine={machine()} />);
    expect(screen.getByTestId('rotary-tap')).toBeTruthy();
    expect((screen.getByTestId('rotary-tap-x') as HTMLInputElement).value).toBe('-150');
    expect((screen.getByTestId('rotary-tap-y') as HTMLInputElement).value).toBe('-180');
    expect((screen.getByTestId('rotary-tap-z') as HTMLInputElement).value).toBe('-50');
    expect((screen.getByTestId('rotary-tap-r') as HTMLInputElement).value).toBe('40');
    expect((screen.getByTestId('rotary-tap-measure') as HTMLButtonElement).disabled).toBe(false);
  });

  it('starts from the datum once one has been measured', () => {
    const seeded = machine();
    const profile = seeded.bedProfiles![0]!;
    profile.datums.rotaryAxis = {
      value: -49.87,
      measuredAt: TODAY,
      by: 'fx-probe-3d',
      at: [-150, -180.4],
      radiusMm: 40.13,
    };
    seedAccessories([probe(true)]);
    render(<RotaryAxisTap machine={seeded} />);
    expect((screen.getByTestId('rotary-tap-y') as HTMLInputElement).value).toBe('-180.4');
    expect((screen.getByTestId('rotary-tap-z') as HTMLInputElement).value).toBe('-49.87');
    expect((screen.getByTestId('rotary-tap-r') as HTMLInputElement).value).toBe('40.13');
  });

  it('draws nothing when the probe has no measured tip', () => {
    seedAccessories([probe(false)]);
    render(<RotaryAxisTap machine={machine()} />);
    expect(screen.queryByTestId('rotary-tap')).toBeNull();
  });

  it('draws nothing when the machine has no address to reach', () => {
    seedAccessories([probe(true)]);
    render(<RotaryAxisTap machine={machine({ address: null })} />);
    expect(screen.queryByTestId('rotary-tap')).toBeNull();
  });

  it('draws nothing when no probe is checked out to the machine', () => {
    seedAccessories([]);
    render(<RotaryAxisTap machine={machine()} />);
    expect(screen.queryByTestId('rotary-tap')).toBeNull();
  });
});
