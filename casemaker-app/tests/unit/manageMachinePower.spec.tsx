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
}));

vi.mock('@/platform/capabilities', async (orig) => ({
  ...(await orig<typeof import('@/platform/capabilities')>()),
  canDriveMachine: true,
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
  houseSwitchPower: async (_id: string, on: boolean) => {
    world.switched.push(on);
    return { kind: 'ok', status: { switch: null, hasToken: true, state: { kind: on ? 'on' : 'off' }, problem: null } };
  },
}));

const { MachinePower } = await import('@/components/manage/MachinePower');

const MACHINE: MachineRecord = {
  id: 'm-1',
  profileId: 'Z1',
  name: null,
  serial: null,
  firmware: null,
  address: { host: '192.0.2.10', port: 2222 },
  calibration: null,
  fixtures: null,
  margins: null,
  power: { provider: 'home-assistant', baseUrl: 'http://ha.local:8123', entityId: 'switch.makera_cnc' },
  wasteboard: null,
  updatedAt: '2026-10-15T00:00:00.000Z',
};

async function pressOff() {
  // A short probe gap: the real one is 2 s between each of three probes.
  render(<MachinePower machine={MACHINE} probeGapMs={5} />);
  await waitFor(() => expect((screen.getByTestId('manage-power-off') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId('manage-power-off'));
}

beforeEach(() => {
  world.status = null;
  world.switched = [];
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
