// @vitest-environment jsdom
// #1188 follow-up — AT IDLE, ONE SESSION TO THE CONTROLLER, ALWAYS.
//
// The analyst's real-controller count (2026-11-10 evening, build 29652d89): with only the idle
// poller running, two sessions to 192.168.10.43:2222 were ESTABLISHED at once in 20–30 % of
// samples; a slower sample showed the previous session still up when the next connected. The
// earlier fix proved "nothing leaks after an action"; this one proves the CONCURRENCY: the fake
// machine counts sessions open at the same time, over N poll cycles, and its maximum must be 1.
//
// The hole the old tests could not see: a poll's session outlives the poller's tab. When the pin
// unmounts (Manage takes the tree) and Manage mounts again, the old chain's inspect is still open;
// the new chain used to connect beside it. One inspection per target at a time is the rule.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEARTBEAT_POLL_MS,
  acquireStatusPoll,
  releaseAllStatusPollers,
  setMachineHeartbeatLoader,
  type MachineHeartbeatClient,
} from '@/platform/machineStatusPoller';
import { clearMachineHeartbeatInFlight, type HeartbeatInspection } from '@/platform/machinePollClient';
import { resetMachineNoticeStore } from '@/store/machineNoticeStore';
import { resetMachineStore } from '@/store/machineStore';

const TARGET = { host: '192.0.2.10', port: 2222 };
const OK: HeartbeatInspection = { status: { ok: true, text: '<Idle|MPos:0,0,0>' }, diagnose: null };
/** How long one session stays open — the controller answers in ms; the read window is seconds. */
const SESSION_MS = 1500;

let open = 0;
let maxOpen = 0;

/** The fake machine: each `inspect` is one session, open for SESSION_MS from connect to close. */
function sessionPoller(): MachineHeartbeatClient {
  return {
    inspect: async () => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, SESSION_MS));
        return OK;
      } finally {
        open -= 1;
      }
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  open = 0;
  maxOpen = 0;
  resetMachineStore();
  resetMachineNoticeStore();
  setMachineHeartbeatLoader(async () => sessionPoller());
});

afterEach(() => {
  releaseAllStatusPollers();
  clearMachineHeartbeatInFlight();
  setMachineHeartbeatLoader(null);
  vi.useRealTimers();
});

/** Advance N full poll cycles, with the session window inside each. */
async function cycles(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await vi.advanceTimersByTimeAsync(HEARTBEAT_POLL_MS + SESSION_MS);
}

describe('#1188 — the idle poller opens at most one session', () => {
  it('one steady poller: never two sessions open at once, over 6 cycles', async () => {
    const release = acquireStatusPoll(TARGET, 'pin');
    await cycles(6);
    expect(maxOpen).toBe(1);
    release();
    // The last session closes; nothing is left behind.
    await vi.advanceTimersByTimeAsync(SESSION_MS + 1);
    expect(open).toBe(0);
  });

  it('two surfaces holding the same poller: still one session', async () => {
    const releasePin = acquireStatusPoll(TARGET, 'pin');
    const releaseManage = acquireStatusPoll(TARGET, 'manage');
    await cycles(4);
    expect(maxOpen).toBe(1);
    releaseManage();
    releasePin();
    await vi.advanceTimersByTimeAsync(SESSION_MS + 1);
    expect(open).toBe(0);
  });

  it('a poll in flight when a surface re-acquires: the new poll joins it, never a second socket', async () => {
    // The pin has a poll in flight (its session is open for SESSION_MS)…
    const releasePin = acquireStatusPoll(TARGET, 'pin');
    await vi.advanceTimersByTimeAsync(100);
    expect(open).toBe(1);
    // …and the tree changes: the pin unmounts and Manage mounts (a reload of the rail, a nav).
    releasePin();
    const releaseManage = acquireStatusPoll(TARGET, 'manage');
    await vi.advanceTimersByTimeAsync(100);
    // The old session is still open; the new poll must NOT open a second one beside it.
    expect(maxOpen).toBe(1);
    await cycles(2);
    expect(maxOpen).toBe(1);
    releaseManage();
    await vi.advanceTimersByTimeAsync(SESSION_MS + 1);
    expect(open).toBe(0);
  });
});
