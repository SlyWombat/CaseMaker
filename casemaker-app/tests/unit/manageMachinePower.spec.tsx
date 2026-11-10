// @vitest-environment jsdom
// #416 review — the card's Off, end to end in the component: the guard is judged on SEVERAL probes,
// a running machine is refused, and a silent one is switched off only after the person confirms.
// The provider and the machine check are fakes; nothing reaches Home Assistant or a plug.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MachineRecord } from '@/platform/locationClient';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const world = vi.hoisted(() => ({
  status: null as string | null,
  switched: [] as boolean[],
  removed: [] as string[],
}));

vi.mock('@/platform/capabilities', async (orig) => ({
  ...(await orig<typeof import('@/platform/capabilities')>()),
  canReachMachine: true,
}));
vi.mock('@/platform/machineProbe', () => ({
  probeMachine: async () =>
    world.status === null
      ? { kind: 'not-found', reason: 'silent' }
      : { kind: 'found', calibration: null, observation: { status: world.status } },
}));
vi.mock('@/platform/powerClient', async (orig) => ({
  ...(await orig<typeof import('@/platform/powerClient')>()),
  housePower: async () => ({
    kind: 'ok',
    status: { switch: null, hasToken: true, state: { kind: 'on' }, problem: null },
  }),
  houseRemovePower: async (id: string) => {
    world.removed.push(id);
    return { kind: 'ok' };
  },
  houseSwitchPower: async (_id: string, on: boolean) => {
    world.switched.push(on);
    return { kind: 'ok', status: { switch: null, hasToken: true, state: { kind: on ? 'on' : 'off' }, problem: null } };
  },
}));

const { MachinePower } = await import('@/components/manage/MachinePower');
const { powerSwitchName } = await import('@/components/manage/display');

const MACHINE: MachineRecord = {
  id: 'm-1',
  profileId: 'Z1',
  name: null,
  nickname: null,
  serial: null,
  firmware: null,
  address: { host: '192.0.2.10', port: 2222 },
  calibration: null,
  fixtures: null,
  margins: null,
  power: { provider: 'home-assistant', baseUrl: 'http://ha.local:8123', entityId: 'switch.makera_cnc' },
  wasteboard: null,
  finishedPrograms: [],
  updatedAt: '2026-10-15T00:00:00.000Z',
};

async function pressOff() {
  // The waits return at once: the real gap is 2 s between each of three probes, and #449 holds every
  // gap to that floor in code, so a test cannot shorten it — it can only not wait for it.
  render(<MachinePower machine={MACHINE} sleep={async () => {}} />);
  await waitFor(() => expect((screen.getByTestId('manage-power-off') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId('manage-power-off'));
}

beforeEach(() => {
  world.status = null;
  world.switched = [];
  world.removed = [];
});
afterEach(cleanup);

describe('#416 the card’s Off', () => {
  it('switches off a machine that reads Idle', async () => {
    world.status = '<Idle|MPos:0,0,0>';
    await pressOff();
    await waitFor(() => expect(world.switched).toEqual([false]));
  });

  it('refuses a machine whose status line says a program is running', async () => {
    world.status = '<Run|MPos:1,2,3|P:10,40,5>';
    await pressOff();
    await waitFor(() => expect(screen.getByTestId('manage-power-note').textContent).toContain('a program is running'));
    expect(world.switched).toEqual([]);
  });

  it('a silent machine is NOT switched off until the person confirms', async () => {
    await pressOff();
    const confirm = await screen.findByTestId('manage-power-off-confirm');
    expect(world.switched).toEqual([]);
    expect(screen.getByTestId('manage-power-note').textContent).toContain('switch it off anyway');
    fireEvent.click(confirm);
    await waitFor(() => expect(world.switched).toEqual([false]));
  });
});

// #1150 — REMOVE THE SWITCH TAKES TWO PRESSES, and the second names the switch it forgets.
describe('#1150 the card’s Remove the switch', () => {
  it('names the switch first, sends nothing on Cancel, and removes on the confirm', async () => {
    render(<MachinePower machine={MACHINE} sleep={async () => {}} />);
    fireEvent.click(screen.getByTestId('manage-power-remove'));
    expect(world.removed).toEqual([]);
    expect(screen.getByTestId('manage-power-remove-sentence').textContent).toBe(
      'Remove the link to the power switch “Makera CNC”? The plug stays as it is.',
    );

    fireEvent.click(screen.getByTestId('manage-power-remove-cancel'));
    expect(world.removed).toEqual([]);
    expect(screen.getByTestId('manage-power-remove')).not.toBeNull();

    fireEvent.click(screen.getByTestId('manage-power-remove'));
    fireEvent.click(screen.getByTestId('manage-power-remove-confirm'));
    await waitFor(() => expect(world.removed).toEqual(['m-1']));
  });
});

// #1150 — the switch's human name is derived from its entity id (the service reads no friendly name),
// with the id itself as the last fallback rather than a broken name.
describe('#1150 powerSwitchName', () => {
  it('turns switch.makera_cnc into “Makera CNC”', () => {
    expect(powerSwitchName('switch.makera_cnc')).toBe('Makera CNC');
    expect(powerSwitchName('switch.shop_vacuum_2')).toBe('Shop Vacuum 2');
    expect(powerSwitchName('mystery')).toBe('Mystery');
    expect(powerSwitchName('')).toBe('');
  });
});
