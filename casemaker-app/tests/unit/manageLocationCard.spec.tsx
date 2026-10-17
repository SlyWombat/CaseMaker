// @vitest-environment jsdom
// #412 — the location card on Manage → Machines: read from the location, drawn only where there is
// one, and honest about what the location does not hold (serial and firmware "not read yet").

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setHouseClientLoader, type HouseClient } from '@/platform/houseClient';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MachinesScope } from '@/components/manage/MachinesScope';
import { LocationViewSchema } from '@/platform/locationClient';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { resetMachineStore } from '@/store/machineStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEW = LocationViewSchema.parse(
  JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')),
);

beforeEach(() => {
  resetLocationStore();
  resetMachineStore();
});
afterEach(cleanup);

describe('#412 the location card', () => {
  it('is not drawn where there is no location (the web build)', () => {
    useLocationStore.setState({ status: 'absent', reason: 'no service' });
    render(<MachinesScope />);
    expect(screen.queryByTestId('manage-location')).toBeNull();
  });

  it('draws the location’s machine record, with what was never read said plainly', () => {
    useLocationStore.setState({ status: 'present', location: VIEW, etag: '"x"' });
    render(<MachinesScope />);
    const card = screen.getByTestId('manage-location');
    expect(card.textContent).toContain('Test bench');
    expect(card.textContent).toContain('house.json, moved into this location');
    const machine = screen.getByTestId('manage-location-machine');
    expect(machine.textContent).toContain('192.0.2.10 : 2222');
    expect(machine.textContent).toContain('not read yet');
    expect(machine.textContent).toContain('measured');
  });

  it('says when the location has no machine yet, and shows a refused write-through', () => {
    useLocationStore.setState({
      status: 'present',
      location: { ...VIEW, machines: [] },
      writeNote: 'the location changed since you read it',
    });
    render(<MachinesScope />);
    expect(screen.getByTestId('manage-location-no-machine')).toBeTruthy();
    expect(screen.getByTestId('manage-location-write-note').textContent).toContain('changed since you read it');
  });

  it('says the location cannot be read, instead of drawing a fresh one (#412 review)', () => {
    useLocationStore.setState({ status: 'error', reason: 'location.json is not readable JSON' });
    render(<MachinesScope />);
    expect(screen.getByTestId('manage-location-problem').textContent).toContain('location.json is not readable JSON');
    expect(screen.queryByTestId('manage-location')).toBeNull();
  });

  it('names a machine it cannot read, and a house.json changed after the location', () => {
    useLocationStore.setState({
      status: 'present',
      location: { ...VIEW, unreadableMachines: [{ id: 'machine-x', reason: 'margins: no source' }] },
    });
    useToolRegistryStore.setState({
      health: {
        ok: true,
        schemaVersion: 1,
        hasCatalogue: false,
        feedRows: 0,
        materialSpecRows: 0,
        catalogueSyncedAt: null,
        lastSync: null,
        problems: [],
        warnings: ['house.json was changed after location.json'],
      },
    });
    render(<MachinesScope />);
    expect(screen.getByTestId('manage-location-unreadable').textContent).toContain('machine-x');
    expect(screen.getByTestId('manage-location-warning').textContent).toContain('house.json was changed');
  });

  it('the warning has a Dismiss that tells the service (re-review)', async () => {
    const calls: string[] = [];
    const client = {
      probe: async () => ({ kind: 'absent', reason: 'test' }),
      tools: async () => ({ kind: 'absent', reason: 'test' }),
      feeds: async () => ({ kind: 'absent', reason: 'test' }),
      inventory: async () => ({ kind: 'absent', reason: 'test' }),
      call: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        return { kind: 'ok', text: '' };
      },
    } as unknown as HouseClient;
    setHouseClientLoader(async () => client);
    try {
      useLocationStore.setState({ status: 'present', location: VIEW });
      useToolRegistryStore.setState({
        health: {
          ok: true,
          schemaVersion: 1,
          hasCatalogue: false,
          feedRows: 0,
          materialSpecRows: 0,
          catalogueSyncedAt: null,
          lastSync: null,
          problems: [],
          warnings: ['house.json was changed after location.json'],
        },
      });
      render(<MachinesScope />);
      fireEvent.click(screen.getByTestId('manage-location-warning-dismiss'));
      await waitFor(() => expect(calls).toContain('POST /location/house-warning/dismiss'));
    } finally {
      setHouseClientLoader(null);
    }
  });

  it('with no power switch, no power state or On/Off appears (#416)', () => {
    const noSwitch = { ...VIEW, machines: [{ ...VIEW.machines[0]!, power: null }] };
    useLocationStore.setState({ status: 'present', location: noSwitch });
    render(<MachinesScope />);
    expect(screen.queryByTestId('manage-power')).toBeNull();
    expect(screen.queryByTestId('manage-power-on')).toBeNull();
    expect(screen.queryByTestId('manage-power-off')).toBeNull();
    expect(screen.getByTestId('manage-machine-detail').textContent).not.toContain('power.sh');
  });

  it('shows the wasteboard from the location, with the shop default’s limit', () => {
    useLocationStore.setState({ status: 'present', location: VIEW });
    render(<MachinesScope />);
    expect(screen.getByTestId('manage-wasteboard-summary').textContent).toContain('10.0 mm (measured');
    expect(screen.getByTestId('manage-wasteboard-summary').textContent).toContain('1 scar');
    expect(screen.getByTestId('manage-wasteboard-limit').textContent).toContain('fallback');
  });
});
