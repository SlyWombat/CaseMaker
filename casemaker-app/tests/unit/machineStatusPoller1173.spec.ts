// @vitest-environment jsdom
// #1173 — ONE status poller per machine, reference-counted, and the run is it.
//
// The analyst's bar (2026-11-10): one status poller per machine connection, owned by the machine
// store and reference-counted by whoever needs it (the pin, the Cut step's run, the Manage page) —
// never a second timer — plus a test proving that with Manage open during a run the status-request
// rate is unchanged from the run alone.
//
// THE RATE IS COUNTED AT THE CONTROLLER, not at a timer: every `?` the run's console sends and
// every `inspect` the poller makes is one status request, from whichever socket. With a run going,
// the run's own loop IS the poller; opening Manage adds a HOLD, not a stream.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MIN_STATUS_POLL_MS } from '@/platform/desktop/protocol';
import {
  HEARTBEAT_POLL_MS,
  acquireStatusPoll,
  releaseAllStatusPollers,
  setMachineHeartbeatLoader,
  type MachineHeartbeatClient,
} from '@/platform/machineStatusPoller';
import { setMachineConsoleLoader, type ConsoleSend } from '@/platform/machineConsole';
import { clearMachineHeartbeatInFlight, type HeartbeatInspection } from '@/platform/machinePollClient';
import { resetMachineNoticeStore } from '@/store/machineNoticeStore';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import { machineKey, resetMachineRunStore, useMachineRunStore } from '@/store/machineRunStore';
import { runSettings } from '@/platform/machineRun';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import type { MachineObservation } from '@/platform/machineProbe';

const TARGET = { host: '192.0.2.10', port: 2222 };

function observation(): MachineObservation {
  return {
    name: 'QA Z1',
    host: TARGET.host,
    port: TARGET.port,
    busy: false,
    ip: null,
    mac: null,
    status: '<Idle|MPos:0,0,0>',
    profileId: 'Z1',
    observedAt: '2026-11-10T00:00:00.000Z',
    notes: [],
  };
}

/** Every status request the controller sees, from any socket. */
let statusRequests = 0;

/** The poller's client: one status read per inspect, counted. */
function countingPoller(): MachineHeartbeatClient {
  return {
    inspect: async () => {
      statusRequests += 1;
      return { status: { ok: true, text: '<Idle|MPos:0,0,0>' }, diagnose: null };
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  statusRequests = 0;
  resetMachineStore();
  resetMachineRunStore();
  resetMachineNoticeStore();
  useMachineStore.getState().setProbeResult({ kind: 'found', observation: observation(), calibration: null });
  setMachineHeartbeatLoader(async () => countingPoller());
});

afterEach(() => {
  releaseAllStatusPollers();
  clearMachineHeartbeatInFlight();
  setMachineHeartbeatLoader(null);
  setMachineConsoleLoader(null);
  resetMachineRunStore();
  vi.useRealTimers();
});

describe('#1173 — the poller is reference-counted', () => {
  it('two holds share ONE timer, and the poll stops only when the last hold lets go', async () => {
    expect(HEARTBEAT_POLL_MS).toBe(MIN_STATUS_POLL_MS);

    const releasePin = acquireStatusPoll(TARGET, 'pin');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusRequests).toBe(1);

    // Manage opens: a second hold, not a second timer. One poll per interval, not two.
    const releaseManage = acquireStatusPoll(TARGET, 'manage');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_POLL_MS);
    expect(statusRequests).toBe(2);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_POLL_MS);
    expect(statusRequests).toBe(3);

    // Manage closes: the pin still holds the poll.
    releaseManage();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_POLL_MS);
    expect(statusRequests).toBe(4);

    // The last hold lets go: no more requests, at any interval.
    releasePin();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_POLL_MS * 3);
    expect(statusRequests).toBe(4);
  });

  it('a hold on a second machine is its own poller, not a second timer for the first', async () => {
    const other = { host: '192.0.2.11', port: 2222 };
    const releaseA = acquireStatusPoll(TARGET, 'pin');
    const releaseB = acquireStatusPoll(other, 'pin');
    await vi.advanceTimersByTimeAsync(0);
    // One tick each, two machines: the request count is per controller, and this fake is one
    // counter, so the second machine's poller is visible as a second request.
    expect(statusRequests).toBe(2);
    releaseA();
    releaseB();
  });
});

describe('#1173 — a run IS the status poller', () => {
  it('with Manage open during a run, the status-request rate is unchanged from the run alone', async () => {
    // The run's console: Idle before play, Run until abort, Idle afterwards. Every `?` is a status
    // request to the controller and is counted with the poller's inspects.
    let played = false;
    let aborted = false;
    setMachineConsoleLoader(async () => ({
      async open() {
        return {
          async send(line: string): Promise<ConsoleSend> {
            if (line === '?') statusRequests += 1;
            let text = 'ok';
            if (line === '?') {
              text = played && !aborted ? '<Run|MPos:0,0,0|P:10,20,5>' : '<Idle|MPos:0,0,0>';
            } else if (line.startsWith('play')) {
              played = true;
              text = 'File size 10';
            } else if (line === 'abort') {
              aborted = true;
              text = 'ok\nAborted playing or paused file.';
            }
            return { ok: true, line, text, frames: 1, elapsedMs: 1 };
          },
          async close() {},
        };
      },
    }));

    useMachineRunStore.getState().prepare(TARGET, 'job.nc', 'hash');
    const settings = runSettings(useShopDefaultsStore.getState().defaults);
    expect(useMachineRunStore.getState().start(TARGET, settings)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    const runKey = machineKey(TARGET);
    expect(useMachineRunStore.getState().runs[runKey]?.running).toBe(true);

    // ── the run alone: its own polls, and NO poller of its own.
    const aloneFrom = statusRequests;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_POLL_MS * 3);
    const alone = statusRequests - aloneFrom;
    expect(alone).toBeGreaterThan(0);

    // ── Manage opens: a hold on the same machine while the run owns the status polling.
    const releaseManage = acquireStatusPoll(TARGET, 'manage');
    const withManageFrom = statusRequests;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_POLL_MS * 3);
    const withManage = statusRequests - withManageFrom;
    expect(withManage).toBe(alone);

    // ── the run ends with Manage still open: the run's hold is released and the store's timer
    // takes over, so the page does not freeze on the run's last line.
    useMachineRunStore.getState().requestStop(runKey);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_POLL_MS * 8);
    expect(useMachineRunStore.getState().runs[runKey]?.running).toBe(false);

    const afterFrom = statusRequests;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_POLL_MS * 2);
    expect(statusRequests - afterFrom).toBeGreaterThan(0);
    releaseManage();
  });

  it('a self-polling hold keeps the timer off and hands it back on release', async () => {
    const releaseManage = acquireStatusPoll(TARGET, 'manage');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusRequests).toBe(1);

    const releaseRun = acquireStatusPoll(TARGET, 'run', { pollsItself: true });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_POLL_MS * 3);
    expect(statusRequests).toBe(1);

    releaseRun();
    // The hand-off back polls at once, then keeps the interval, because Manage still holds it.
    await vi.advanceTimersByTimeAsync(0);
    expect(statusRequests).toBe(2);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_POLL_MS);
    expect(statusRequests).toBe(3);
    releaseManage();
  });

  // THE DOUBLE-TIMER CHAIN (analyst, 2026-11-10). A boolean `running` cannot tell an OLD tick from a
  // NEW one: a tick in flight while a run takes and releases the poll sees `running === true` again
  // and schedules its own timer beside the new tick's, so two chains poll forever. The generation
  // counter is what makes that old tick return.
  //
  // #1188 — AND THE NEW CHAIN JOINS THE OLD TICK'S INSPECTION. The generation guard stops a second
  // timer chain; the client gate (`inspectTarget`) additionally stops a second SOCKET: the new
  // chain's first tick shares the inspection already in flight instead of connecting beside it.
  it('a tick in flight across a run hold cannot start a second chain', async () => {
    const OK: HeartbeatInspection = { status: { ok: true, text: '<Idle|MPos:0,0,0>' }, diagnose: null };
    let inspects = 0;
    const resolvers: Array<(reading: HeartbeatInspection) => void> = [];
    setMachineHeartbeatLoader(async () => ({
      inspect: () => {
        inspects += 1;
        return new Promise<HeartbeatInspection>((resolve) => resolvers.push(resolve));
      },
    }));

    const releasePin = acquireStatusPoll(TARGET, 'pin');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolvers).toHaveLength(1); // tick 1 is in flight, its inspect unanswered

    // The run takes the poll, and lets go at once (a play refused or an alarm ends a run that fast).
    const releaseRun = acquireStatusPoll(TARGET, 'run', { pollsItself: true });
    releaseRun();
    await vi.advanceTimersByTimeAsync(0);
    // #1188 — the new chain JOINS tick 1's inspection: still one session, one resolver.
    expect(resolvers).toHaveLength(1);

    // Tick 1 answers NOW. The old chain is generation-stale and returns; the new chain takes the
    // shared answer and schedules its own next timer — exactly one.
    resolvers.splice(0)[0]!(OK);
    await vi.advanceTimersByTimeAsync(0);

    const before = inspects;
    for (let interval = 0; interval < 3; interval += 1) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_POLL_MS);
      for (const resolve of resolvers.splice(0)) resolve(OK);
      await vi.advanceTimersByTimeAsync(0);
    }
    // ONE chain: one inspect per interval (plus the shared one was already counted before `before`).
    expect(inspects - before).toBe(3);
    releasePin();
  });
});
