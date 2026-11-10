// @vitest-environment jsdom
// #289 — the accessory-mode switches on the machine card in Manage → Machines: spindle fan, power
// fan, external output, WP charge. The vacuum switch's shape and its seams (the console client is
// the fake, the capability is a getter), so what runs is the panel's real ask `?` → send → show
// path. What this pins: the switches exist only where a socket can be opened, each claims only what
// it last sent (`unknown` before that), a running machine refuses the press without an accessory
// code, and the card STATES why there is no air switch.

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MachinesScope } from '@/components/manage/MachinesScope';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import { setMachineConsoleLoader, type ConsoleSend } from '@/platform/machineConsole';
import { fakeConsoleSession, statusOnly } from './helpers/fakeConsole';
import { ACCESSORIES } from '@/platform/machineAccessory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const caps = vi.hoisted(() => ({ drive: false }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canReachMachine() {
      return caps.drive;
    },
  };
});

vi.mock('@/platform/machineStatusPoller', () => ({
  acquireStatusPoll: vi.fn(() => () => {}),
}));

const Z1_RECORD = {
  name: 'Z1',
  host: '192.168.10.43',
  port: 2222,
  busy: false,
  ip: '192.168.10.43',
  mac: 'AA:BB:CC:DD:EE:FF',
  status: '<Idle|MPos:0.000,0.000,0.000|Bf:14,128>',
  profileId: 'Z1',
  observedAt: '2026-10-09T06:00:00.000Z',
  notes: [],
};

const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128>';
const RUNNING = '<Run|MPos:0,0,0|P:34,42,17>';


function withMachine(): void {
  useMachineStore.setState({
    machine: Z1_RECORD,
    outcome: 'found',
    reason: null,
    checkedAt: '2026-10-09T06:00:00.000Z',
  });
}

beforeEach(() => {
  cleanup();
  caps.drive = true;
  resetMachineStore();
  useSettingsStore.setState({ machineCalibration: undefined });
});

afterEach(() => setMachineConsoleLoader(null));

describe('#289 the accessory switches on the machine card', () => {
  it('draws one switch per Z1 accessory, each “not sent this session” until it has sent', () => {
    withMachine();
    render(<MachinesScope />);
    // #884 — the Z1's external output IS the vacuum (one row, above) and its probe charger has
    // nothing attached, so the two REMAINING switches are the fans.
    for (const spec of ACCESSORIES.filter((a) => a.id === 'spindle-fan' || a.id === 'power-fan')) {
      const row = screen.getByTestId(`manage-accessory-${spec.id}`);
      expect(row).toBeTruthy();
      expect(screen.getByTestId(`manage-accessory-${spec.id}-state`).getAttribute('data-mode')).toBe('unknown');
      expect(screen.getByTestId(`manage-accessory-${spec.id}-state`).textContent).toBe('not sent this session');
      // The vendor key is the provenance the button titles carry, and the hint says what it is.
      expect(screen.getByTestId(`manage-accessory-${spec.id}-on`).getAttribute('title')).toContain(spec.vendorKey);
      expect(screen.getByTestId(`manage-accessory-${spec.id}-hint`).textContent).toBe(spec.meaning);
    }
    expect(screen.queryByTestId('manage-accessory-external-output')).toBeNull();
    expect(screen.queryByTestId('manage-accessory-wp-charge')).toBeNull();
    // No air switch — the card says why instead.
    expect(screen.queryByTestId('manage-accessory-air')).toBeNull();
    expect(screen.getByTestId('manage-accessory-no-air').textContent).toContain('No air switch');
    expect(screen.getByTestId('manage-accessory-no-air').textContent).toContain('M7/M9');
  });

  it('turns a fan on: one press, the firmware’s code, and the switch shows what it sent', async () => {
    withMachine();
    const { sent } = fakeConsoleSession(statusOnly(IDLE));
    render(<MachinesScope />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('manage-accessory-spindle-fan-on'));
    });
    expect(sent).toEqual(['?', 'M811']);
    await waitFor(() =>
      expect(screen.getByTestId('manage-accessory-spindle-fan-state').getAttribute('data-mode')).toBe('on'),
    );
    expect(screen.getByTestId('manage-accessory-spindle-fan-note').textContent).toContain('spindle fan is on');
  });

  it('sends the off code from the Off half', async () => {
    // A machine that keeps the separate charger row (#884 hides it on the Z1).
    useMachineStore.setState({
      machine: { ...Z1_RECORD, profileId: 'CARVERA' },
      outcome: 'found',
      reason: null,
      checkedAt: '2026-10-09T06:00:00.000Z',
    });
    const { sent } = fakeConsoleSession(statusOnly(IDLE));
    render(<MachinesScope />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('manage-accessory-wp-charge-off'));
    });
    expect(sent).toEqual(['?', 'M842']);
    await waitFor(() =>
      expect(screen.getByTestId('manage-accessory-wp-charge-state').getAttribute('data-mode')).toBe('off'),
    );
  });

  it('refuses a running machine and shows the reason, sending no accessory code', async () => {
    withMachine();
    const { sent } = fakeConsoleSession(statusOnly(RUNNING));
    render(<MachinesScope />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('manage-accessory-spindle-fan-on'));
    });
    expect(sent).toEqual(['?']);
    expect(screen.getByTestId('manage-accessory-spindle-fan-note').textContent).toContain('Run');
    expect(screen.getByTestId('manage-accessory-spindle-fan-state').getAttribute('data-mode')).toBe('unknown');
  });

  it('a build that cannot open a socket draws none of them', () => {
    caps.drive = false;
    withMachine();
    render(<MachinesScope />);
    for (const spec of ACCESSORIES) {
      expect(screen.queryByTestId(`manage-accessory-${spec.id}`)).toBeNull();
    }
    expect(screen.queryByTestId('manage-vacuum')).toBeNull();
  });
});
