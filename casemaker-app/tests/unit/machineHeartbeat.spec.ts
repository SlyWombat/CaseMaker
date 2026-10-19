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
import { useMachineStore } from '@/store/machineStore';
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
  const state = { reachable: true };
  const client: MachineHeartbeatClient = {
    status: async () => ({ ok: state.reachable, text: state.reachable ? '<Idle|MPos:0,0,0>' : null }),
  };
  return { client, setReachable: (v: boolean) => (state.reachable = v) };
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
      status: async () => {
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
});
