// @vitest-environment jsdom
// The live reachability heartbeat (#555): an active low-rate poll that records reachable /
// unreachable / last-seen into machineStore and posts a transition notice.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MIN_STATUS_POLL_MS } from '@/platform/desktop/protocol';
import {
  HEARTBEAT_POLL_MS,
  setMachineHeartbeatLoader,
  startHeartbeat,
  stopHeartbeat,
  type MachineHeartbeatClient,
} from '@/platform/machineHeartbeat';
import { resetMachineNoticeStore, useMachineNoticeStore } from '@/store/machineNoticeStore';
import { MACHINE_STORAGE_KEY, useMachineStore } from '@/store/machineStore';
import type { MachineObservation } from '@/platform/machineProbe';

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

/** A client whose answer can be flipped between ticks, so transitions can be scripted. */
function makeClient() {
  const state = { reachable: true, diagnose: null as string | null };
  const client: MachineHeartbeatClient = {
    inspect: async () => ({
      status: { ok: state.reachable, text: state.reachable ? '<Idle|MPos:0,0,0>' : null },
      diagnose: state.diagnose === null ? null : { ok: true, text: state.diagnose },
    }),
  };
  return {
    client,
    setReachable: (v: boolean) => (state.reachable = v),
    setDiagnose: (line: string | null) => (state.diagnose = line),
  };
}

function rememberMachine(): void {
  useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation(), calibration: null });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetMachineNoticeStore();
  useMachineStore.setState({
    machine: null,
    outcome: null,
    reason: null,
    checkedAt: null,
    heartbeat: { reachable: null, lastSeenAt: null },
  });
});

afterEach(() => {
  stopHeartbeat();
  setMachineHeartbeatLoader(null);
  resetMachineNoticeStore();
  vi.useRealTimers();
});

describe('#555 — HEARTBEAT_POLL_MS cannot drift from the protocol', () => {
  it('matches MIN_STATUS_POLL_MS', () => {
    expect(HEARTBEAT_POLL_MS).toBe(MIN_STATUS_POLL_MS);
  });
});

describe('#555 — machineHeartbeat', () => {
  it('polls immediately and records reachable with a last-seen moment', async () => {
    const { client } = makeClient();
    setMachineHeartbeatLoader(async () => client);
    rememberMachine();

    startHeartbeat({ host: '192.168.10.43', port: 2222 });
    await vi.advanceTimersByTimeAsync(0);

    expect(useMachineStore.getState().heartbeat.reachable).toBe(true);
    expect(useMachineStore.getState().heartbeat.lastSeenAt).not.toBeNull();
  });

  it('a rejected status read is a result (unreachable), not a fault', async () => {
    setMachineHeartbeatLoader(async () => ({
      inspect: async () => {
        throw new Error('tcp: connection refused');
      },
    }));
    rememberMachine();

    startHeartbeat({ host: '192.168.10.43', port: 2222 });
    await vi.advanceTimersByTimeAsync(0);

    expect(useMachineStore.getState().heartbeat.reachable).toBe(false);
    expect(useMachineStore.getState().heartbeat.lastSeenAt).toBeNull();
  });

  it('posts a notice only on a transition, offline then back online', async () => {
    const { client, setReachable } = makeClient();
    setMachineHeartbeatLoader(async () => client);
    rememberMachine();

    startHeartbeat({ host: '192.168.10.43', port: 2222 });
    await vi.advanceTimersByTimeAsync(0);
    // The first tick establishes the answer; it is not a transition.
    expect(useMachineNoticeStore.getState().notice).toBeNull();

    setReachable(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(useMachineStore.getState().heartbeat.reachable).toBe(false);
    expect(useMachineNoticeStore.getState().notice?.kind).toBe('offline');

    setReachable(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(useMachineStore.getState().heartbeat.reachable).toBe(true);
    expect(useMachineNoticeStore.getState().notice?.kind).toBe('online');
  });

  it('stopHeartbeat ends the poll', async () => {
    const { client, setReachable } = makeClient();
    setMachineHeartbeatLoader(async () => client);
    rememberMachine();

    startHeartbeat({ host: '192.168.10.43', port: 2222 });
    await vi.advanceTimersByTimeAsync(0);
    const seen = useMachineStore.getState().heartbeat.lastSeenAt;

    stopHeartbeat();
    setReachable(false);
    await vi.advanceTimersByTimeAsync(5000);

    expect(useMachineStore.getState().heartbeat.reachable).toBe(true);
    expect(useMachineStore.getState().heartbeat.lastSeenAt).toBe(seen);
    expect(useMachineNoticeStore.getState().notice).toBeNull();
  });

  // #527 — the same `?` answer is the viewport's live position, so the heartbeat keeps the RAW
  // line beside reachability. A dropped poll must leave the last line alone: `reachable` is what
  // stops it being drawn as live, and the line is still the last thing the machine said.
  it('records the status line it read, and the parsed work position with it', async () => {
    setMachineHeartbeatLoader(async () => ({
      inspect: async () => ({
        status: { ok: true, text: '<Idle|MPos:1,2,3|WPos:11.5,22.25,-0.5|F:0,0,100>' },
        diagnose: null,
      }),
    }));
    rememberMachine();

    startHeartbeat({ host: '192.168.10.43', port: 2222 });
    await vi.advanceTimersByTimeAsync(0);

    const machine = useMachineStore.getState().machine!;
    expect(machine.status).toContain('WPos:11.5,22.25,-0.5');
    expect(machine.statusLine?.wpos).toMatchObject({ x: 11.5, y: 22.25, z: -0.5 });
  });

  // #826 — the same tick asks `diagnose`; a changed reading reaches the store, an unchanged one
  // does not (the monitor shows changes, not a stream).
  it('folds the diagnostic line in, and keeps the same reading when nothing changed', async () => {
    const { client, setDiagnose } = makeClient();
    setMachineHeartbeatLoader(async () => client);
    rememberMachine();
    setDiagnose('{S:0|T:0|C:1|E:0,0,0,0,0,1,1,0|P:0,0|I:0|RSSI:-40}');

    startHeartbeat({ host: '192.168.10.43', port: 2222 });
    await vi.advanceTimersByTimeAsync(0);
    const first = useMachineStore.getState().diagnose;
    expect(first?.probe).toBe(false);
    expect(first?.coverClosed).toBe(true);
    expect(first?.rssi).toBe(-40);

    // The same line next tick: the store keeps the SAME object, so nothing re-renders.
    await vi.advanceTimersByTimeAsync(2000);
    expect(useMachineStore.getState().diagnose).toBe(first);

    // The probe is pressed: the reading moves.
    setDiagnose('{S:0|T:0|C:1|E:0,0,0,0,0,1,1,0|P:1,0|I:0|RSSI:-41}');
    await vi.advanceTimersByTimeAsync(2000);
    const next = useMachineStore.getState().diagnose;
    expect(next).not.toBe(first);
    expect(next?.probe).toBe(true);
    expect(next?.rssi).toBe(-41);
  });

  it('does not persist the live line: the record stays the check’s', async () => {
    const { client } = makeClient();
    setMachineHeartbeatLoader(async () => client);
    rememberMachine();
    const stored = localStorage.getItem(MACHINE_STORAGE_KEY);
    const observedAt = useMachineStore.getState().machine!.observedAt;

    startHeartbeat({ host: '192.168.10.43', port: 2222 });
    await vi.advanceTimersByTimeAsync(0);

    expect(useMachineStore.getState().machine!.observedAt).toBe(observedAt);
    expect(localStorage.getItem(MACHINE_STORAGE_KEY)).toBe(stored);
    stopHeartbeat();
  });
});
