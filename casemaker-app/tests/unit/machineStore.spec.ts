// @vitest-environment jsdom
// The connected-machine record (#280): what a probe result becomes, and what survives a reload.

import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { MachineObservation, MachineProbeResult } from '@/platform/machineProbe';
import { MACHINE_STORAGE_KEY, useMachineStore } from '@/store/machineStore';

function observation(over: Partial<MachineObservation> = {}): MachineObservation {
  return {
    name: 'Makera_Z1_010290',
    host: '192.168.10.43',
    port: 2222,
    busy: false,
    ip: '192.168.10.43',
    mac: 'aa:bb:cc:dd:ee:ff',
    status: 'Idle',
    profileId: 'Z1',
    observedAt: '2026-10-07T12:00:00.000Z',
    notes: [],
    ...over,
  };
}

beforeEach(() => {
  useMachineStore.setState({ machine: null, outcome: null, reason: null, checkedAt: null });
  localStorage.removeItem(MACHINE_STORAGE_KEY);
});

describe('#280 — machineStore', () => {
  it('keeps the machine a found probe reported, with no numbers of its own', () => {
    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation() });
    const s = useMachineStore.getState();
    expect(s.outcome).toBe('found');
    expect(s.machine?.profileId).toBe('Z1');
    expect(s.reason).toBeNull();
    expect(s.checkedAt).not.toBeNull();
    // The store carries the IDENTITY; every machine number stays in `engine/cnc/machine.ts`.
    expect(Object.keys(s.machine!).sort()).toEqual([
      'busy', 'host', 'ip', 'mac', 'name', 'notes', 'observedAt', 'port', 'profileId', 'status',
    ]);
  });

  it('each non-found outcome clears the machine and keeps the reason where there is one', () => {
    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation() });

    useMachineStore.getState().setProbeResult({ kind: 'not-found' });
    expect(useMachineStore.getState().machine).toBeNull();
    expect(useMachineStore.getState().outcome).toBe('not-found');
    expect(useMachineStore.getState().reason).toBeNull();

    const unavailable: MachineProbeResult = { kind: 'unavailable', reason: 'no raw socket here' };
    useMachineStore.getState().setProbeResult(unavailable);
    expect(useMachineStore.getState().machine).toBeNull();
    expect(useMachineStore.getState().reason).toBe('no raw socket here');

    useMachineStore.getState().setProbeResult({ kind: 'error', detail: 'udp: bind failed' });
    expect(useMachineStore.getState().reason).toBe('udp: bind failed');
  });

  it('forget drops the machine but keeps the record of when we last looked', () => {
    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation() });
    const checkedAt = useMachineStore.getState().checkedAt;
    useMachineStore.getState().forget();
    expect(useMachineStore.getState().machine).toBeNull();
    expect(useMachineStore.getState().outcome).toBeNull();
    expect(useMachineStore.getState().checkedAt).toBe(checkedAt);
  });

  it('reloads the machine from storage', async () => {
    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation() });
    vi.resetModules();
    const fresh = await import('@/store/machineStore');
    const s = fresh.useMachineStore.getState();
    expect(s.outcome).toBe('found');
    expect(s.machine?.name).toBe('Makera_Z1_010290');
    expect(s.machine?.notes).toEqual([]);
  });

  it('drops a payload it cannot read whole, rather than half-honouring it', async () => {
    // No `observedAt` — an observation with no moment attached is not a record.
    const { observedAt: _drop, ...partial } = observation();
    localStorage.setItem(MACHINE_STORAGE_KEY, JSON.stringify({ machine: partial, outcome: 'found' }));
    vi.resetModules();
    const fresh = await import('@/store/machineStore');
    expect(fresh.useMachineStore.getState().machine).toBeNull();

    // A port that is not an integer is the same class of problem.
    localStorage.setItem(
      MACHINE_STORAGE_KEY,
      JSON.stringify({ machine: observation({ port: 2222.5 }), outcome: 'found' }),
    );
    vi.resetModules();
    const again = await import('@/store/machineStore');
    expect(again.useMachineStore.getState().machine).toBeNull();
  });

  it('ignores an outcome it does not know', async () => {
    localStorage.setItem(
      MACHINE_STORAGE_KEY,
      JSON.stringify({ machine: observation(), outcome: 'connected' }),
    );
    vi.resetModules();
    const fresh = await import('@/store/machineStore');
    expect(fresh.useMachineStore.getState().outcome).toBeNull();
    // The machine itself is still readable — only the invented outcome is dropped.
    expect(fresh.useMachineStore.getState().machine?.host).toBe('192.168.10.43');
  });
});
