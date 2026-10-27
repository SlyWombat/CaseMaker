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
  useMachineStore.setState({
    machine: null,
    outcome: null,
    reason: null,
    checkedAt: null,
    heartbeat: { reachable: null, lastSeenAt: null },
  });
  localStorage.removeItem(MACHINE_STORAGE_KEY);
});

describe('#280 — machineStore', () => {
  it('keeps the machine a found probe reported, with no numbers of its own', () => {
    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation(), calibration: null });
    const s = useMachineStore.getState();
    expect(s.outcome).toBe('found');
    expect(s.machine?.profileId).toBe('Z1');
    expect(s.reason).toBeNull();
    expect(s.checkedAt).not.toBeNull();
    // The store carries the IDENTITY; every machine number stays in `engine/cnc/machine.ts`, and
    // the machine's own frame (#279) belongs to `settingsStore.machineCalibration`, where its
    // source and date travel with it — NOT to a store that says it holds no numbers.
    expect(Object.keys(s.machine!).sort()).toEqual([
      'busy', 'host', 'ip', 'mac', 'name', 'notes', 'observedAt', 'port', 'profileId', 'status',
    ]);
  });

  it('each non-found outcome clears the machine and keeps the reason where there is one', () => {
    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation(), calibration: null });

    useMachineStore.getState().setProbeResult({ kind: 'not-found' });
    expect(useMachineStore.getState().machine).toBeNull();
    expect(useMachineStore.getState().outcome).toBe('not-found');
    expect(useMachineStore.getState().reason).toBeNull();

    const unavailable: MachineProbeResult = { kind: 'unavailable', reason: 'no raw socket here' };
    useMachineStore.getState().setProbeResult(unavailable);
    expect(useMachineStore.getState().machine).toBeNull();
    expect(useMachineStore.getState().reason).toBe('no raw socket here');

    useMachineStore.getState().setProbeResult({ kind: 'error', detail: 'udp: bind failed' });
    // #726 W24 — the store writes the sentence once, so every reader (the start wizard, the
    // Machines page) prints the same words.
    expect(useMachineStore.getState().reason).toBe('The search failed: udp: bind failed');
  });

  it('forget drops the machine but keeps the record of when we last looked', () => {
    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation(), calibration: null });
    const checkedAt = useMachineStore.getState().checkedAt;
    useMachineStore.getState().forget();
    expect(useMachineStore.getState().machine).toBeNull();
    expect(useMachineStore.getState().outcome).toBeNull();
    expect(useMachineStore.getState().checkedAt).toBe(checkedAt);
  });

  it('noteLiveStatus refreshes busy, status and the moment, and nothing about who the machine is (#296)', () => {
    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation({ busy: false }), calibration: null });
    const before = useMachineStore.getState().machine!;
    useMachineStore.getState().noteLiveStatus({ busy: true, status: '<Run|MPos:1,2,3>' });
    const after = useMachineStore.getState().machine!;
    expect(after.busy).toBe(true);
    expect(after.status).toBe('<Run|MPos:1,2,3>');
    expect(after.observedAt >= before.observedAt).toBe(true);
    expect(after.host).toBe(before.host);
    expect(after.profileId).toBe(before.profileId);
    // Kept across a reload, like every other write to this store.
    expect(JSON.parse(localStorage.getItem(MACHINE_STORAGE_KEY)!).machine.busy).toBe(true);
  });

  it('noteLiveStatus with no remembered machine does nothing', () => {
    useMachineStore.getState().forget();
    useMachineStore.getState().noteLiveStatus({ busy: true, status: '<Run>' });
    expect(useMachineStore.getState().machine).toBeNull();
  });

  it('noteHeartbeat records reachable and the last-seen moment, leaving the machine record alone (#555)', () => {
    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation(), calibration: null });
    const before = useMachineStore.getState().machine!;
    useMachineStore.getState().noteHeartbeat(true);
    const after = useMachineStore.getState().machine!;
    expect(useMachineStore.getState().heartbeat.reachable).toBe(true);
    expect(useMachineStore.getState().heartbeat.lastSeenAt).not.toBeNull();
    // The machine's identity and record are the CHECK's, not the heartbeat's — nothing there moves.
    expect(after.host).toBe(before.host);
    expect(after.observedAt).toBe(before.observedAt);
    expect(after.status).toBe(before.status);
    // And the heartbeat is a live claim, never written to storage.
    expect(JSON.parse(localStorage.getItem(MACHINE_STORAGE_KEY)!).heartbeat).toBeUndefined();
  });

  it('noteHeartbeat unreachable keeps the last-seen moment (#555)', () => {
    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation(), calibration: null });
    useMachineStore.getState().noteHeartbeat(true);
    const seen = useMachineStore.getState().heartbeat.lastSeenAt;
    useMachineStore.getState().noteHeartbeat(false);
    expect(useMachineStore.getState().heartbeat.reachable).toBe(false);
    expect(useMachineStore.getState().heartbeat.lastSeenAt).toBe(seen);
  });

  it('noteHeartbeat with no remembered machine does nothing', () => {
    useMachineStore.getState().forget();
    useMachineStore.getState().noteHeartbeat(true);
    expect(useMachineStore.getState().heartbeat.reachable).toBeNull();
  });

  // #527 — a registration run owns the machine: the viewport draws its probe. Session state, so it
  // is never persisted, and a fresh check or a forget must not leave a stale "registering" claim.
  it('registrationActive is session state and is cleared by a fresh check or forget', () => {
    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation(), calibration: null });
    useMachineStore.getState().setRegistrationActive(true);
    expect(useMachineStore.getState().registrationActive).toBe(true);
    expect(JSON.parse(localStorage.getItem(MACHINE_STORAGE_KEY)!).registrationActive).toBeUndefined();

    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation(), calibration: null });
    expect(useMachineStore.getState().registrationActive).toBe(false);

    useMachineStore.getState().setRegistrationActive(true);
    useMachineStore.getState().forget();
    expect(useMachineStore.getState().registrationActive).toBe(false);
  });

  // #527 — the heartbeat's answer is the viewport's live position; it moves status/statusLine and
  // nothing else, and it is not written (a 2 s poll would churn the record for nothing).
  it('noteLiveStatusLine folds in the live line without persisting it or moving the record', () => {
    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation(), calibration: null });
    const before = useMachineStore.getState().machine!;
    const stored = localStorage.getItem(MACHINE_STORAGE_KEY);

    useMachineStore.getState().noteLiveStatusLine('<Run|MPos:1,2,3|WPos:11,22,-0.5>');
    const after = useMachineStore.getState().machine!;

    expect(after.status).toBe('<Run|MPos:1,2,3|WPos:11,22,-0.5>');
    expect(after.statusLine?.wpos).toMatchObject({ x: 11, y: 22, z: -0.5 });
    expect(after.observedAt).toBe(before.observedAt);
    expect(after.busy).toBe(before.busy);
    expect(localStorage.getItem(MACHINE_STORAGE_KEY)).toBe(stored);
  });

  it('noteLiveStatusLine with no remembered machine does nothing', () => {
    useMachineStore.getState().forget();
    useMachineStore.getState().noteLiveStatusLine('<Idle|WPos:1,2,3>');
    expect(useMachineStore.getState().machine).toBeNull();
  });

  it('reloads the machine from storage', async () => {
    useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation(), calibration: null });
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
