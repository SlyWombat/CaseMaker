// @vitest-environment jsdom
// #1149 M1 — the Manage "Alarm · Clear alarm" row appears ONLY when the machine reports Alarm.
// The hint already said "offered only against a machine that reports Alarm" while the control was
// drawn unconditionally, so a healthy machine looked alarmed; the land15 strip already gates its
// Unlock on the state word (#1123 item 33) and this page follows the same rule.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MachineUnlock } from '@/components/manage/MachineUnlock';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const caps = vi.hoisted(() => ({ drive: true }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canReachMachine() {
      return caps.drive;
    },
  };
});

const TARGET = { host: '192.168.10.43', port: 2222 };

function remember(status: string | null): void {
  useMachineStore.setState({
    machine: {
      name: 'Z1',
      host: TARGET.host,
      port: TARGET.port,
      busy: false,
      ip: TARGET.host,
      mac: null,
      status,
      profileId: 'Z1',
      observedAt: '2026-11-09T14:00:00.000Z',
      notes: [],
    },
  });
}

beforeEach(() => {
  cleanup();
  resetMachineStore();
  caps.drive = true;
});

afterEach(() => cleanup());

describe('#1149 M1 — Clear alarm only against a machine that reports Alarm', () => {
  it('draws nothing while the machine reads Idle', () => {
    remember('<Idle|MPos:-1.0000,-1.0000,-1.0000|WPos:-1.0000,-1.0000,-1.0000>');
    render(<MachineUnlock host={TARGET.host} port={TARGET.port} />);
    expect(screen.queryByTestId('manage-unlock')).toBeNull();
  });

  it('draws nothing when the machine has not answered, or belongs to another address', () => {
    remember(null);
    render(<MachineUnlock host={TARGET.host} port={TARGET.port} />);
    expect(screen.queryByTestId('manage-unlock')).toBeNull();

    remember('<Idle|MPos:0,0,0>');
    render(<MachineUnlock host="192.0.2.99" port={2233} />);
    expect(screen.queryByTestId('manage-unlock')).toBeNull();
  });

  it('appears when the machine reports Alarm, and goes away when the alarm clears', () => {
    remember('<Alarm|MPos:0.0000,0.0000,0.0000>');
    const { rerender } = render(<MachineUnlock host={TARGET.host} port={TARGET.port} />);
    expect(screen.getByTestId('manage-unlock')).not.toBeNull();
    expect(screen.getByTestId('manage-unlock-press').textContent).toContain('Clear alarm');
    // The hint now states the live fact, not the rule the page failed to apply.
    expect(screen.getByTestId('manage-unlock-hint').textContent).toContain('reports Alarm');

    // The heartbeat's next line reads Idle: the row is gone without a reload.
    remember('<Idle|MPos:0.0000,0.0000,0.0000>');
    rerender(<MachineUnlock host={TARGET.host} port={TARGET.port} />);
    expect(screen.queryByTestId('manage-unlock')).toBeNull();
  });

  it('is not drawn at all in a build without a socket', () => {
    caps.drive = false;
    remember('<Alarm|MPos:0.0000,0.0000,0.0000>');
    render(<MachineUnlock host={TARGET.host} port={TARGET.port} />);
    expect(screen.queryByTestId('manage-unlock')).toBeNull();
  });
});
