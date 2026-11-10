// BENCH BLOCKER 2026-11-10 — THE SHARED POLLER YIELDS A COMMAND SESSION (#1188).
//
// The Z1's TCP 2222 is ONE command channel (Z1-Bridge-Protocol.md §3). The #1173 poll opens a
// status+diagnose session every 2 s; Register's and Home's consoles hold their own session for the
// length of the action. With nothing yielding, a tick lands a SECOND connection on that channel —
// the overlap the bench's first Register reset invites. `attachConsole` now takes a `pollsItself`
// hold for its session's lifetime: while any console is open the timer does not tick, and it
// resumes when the last one closes (or is dropped on a failed read). These are fake-console tests:
// the console client and the heartbeat client are scripted, the poller is the real one, and the
// clock is fake, so "during" is exact rather than a sleep.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attachConsole,
  setMachineConsoleLoader,
  STATUS_POLL_TIMING,
  type ConsoleSend,
  type MachineConsoleClient,
  type MachineConsoleSession,
} from '@/platform/machineConsole';
import { setMachineHeartbeatLoader, type MachineHeartbeatClient } from '@/platform/machinePollClient';
import { acquireStatusPoll, releaseAllStatusPollers } from '@/platform/machineStatusPoller';
import { homeMachine } from '@/platform/machineChangeRun';

const TARGET = { host: '192.0.2.10', port: 2222 };
const IDLE_HOMED = '<Idle|MPos:-1.0000,-1.0000,-1.0000|L:0, 0, 0, 0.0,100.0|C:3,1,0,1|OTA:0,0>';
const IDLE_NOT_HOMED = '<Idle|MPos:10.0000,20.0000,30.0000|L:0, 0, 0, 0.0,100.0|C:3,1,0,1|OTA:0,0>';

type Reply = { text: string } | 'reset';

interface Scripted {
  client: MachineConsoleClient;
  state: { opens: number; closes: number; lines: string[] };
}

/** A console client whose replies are scripted; 'reset' is the bench's ECONNRESET read failure. */
function scripted(replies: Reply[]): Scripted {
  const state = { opens: 0, closes: 0, lines: [] as string[] };
  const client: MachineConsoleClient = {
    async open(): Promise<MachineConsoleSession> {
      state.opens += 1;
      return {
        async send(line: string): Promise<ConsoleSend> {
          state.lines.push(line);
          const next = replies.shift();
          if (next === undefined || next === 'reset') {
            throw new Error('read failed: Connection reset by peer (os error 104)');
          }
          return { ok: true, line, text: next.text, frames: 1, elapsedMs: 5 };
        },
        async close(): Promise<void> {
          state.closes += 1;
        },
      };
    },
  };
  return { client, state };
}

/** The heartbeat client: every `inspect` is one poll session to the controller. */
function heartbeat(): { client: MachineHeartbeatClient; inspects: () => number } {
  let n = 0;
  return {
    client: {
      async inspect() {
        n += 1;
        return { status: { ok: true, text: IDLE_HOMED }, diagnose: null };
      },
    },
    inspects: () => n,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  releaseAllStatusPollers();
  setMachineConsoleLoader(null);
  setMachineHeartbeatLoader(null);
});

afterEach(() => {
  releaseAllStatusPollers();
  setMachineConsoleLoader(null);
  setMachineHeartbeatLoader(null);
  vi.useRealTimers();
});

describe('#1188 the poller yields a console command session', () => {
  it('during Register’s console the poller is paused — one session to the controller — and it resumes when the console closes', async () => {
    const hb = heartbeat();
    setMachineHeartbeatLoader(async () => hb.client);
    // The Pin is on screen, so the shared timer is running before Register starts.
    const releasePin = acquireStatusPoll(TARGET, 'pin');
    await vi.advanceTimersByTimeAsync(0);
    expect(hb.inspects(), 'the poll runs before the console opens').toBe(1);

    const c = scripted([{ text: 'ok' }]);
    setMachineConsoleLoader(async () => c.client);
    const register = attachConsole(TARGET);
    // The registration executor's first line, at its own long reply window.
    const r = await register.send('M491', { firstReplyMs: 60_000, quietMs: 800, maxMs: 120_000 });
    expect(r.kind).toBe('sent');
    expect(c.state.opens, 'one command session').toBe(1);

    const during = hb.inspects();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(hb.inspects(), 'no poll session opened during Register').toBe(during);
    expect(c.state.opens - c.state.closes, 'still exactly one session to the controller').toBe(1);

    await register.close();
    expect(c.state.opens - c.state.closes, 'zero left open after Register').toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(hb.inspects(), 'the poller resumes after the console closes').toBe(during + 1);
    releasePin();
  });

  it('a failed read releases the hold too — the poll resumes with no session left open', async () => {
    const hb = heartbeat();
    setMachineHeartbeatLoader(async () => hb.client);
    const releasePin = acquireStatusPoll(TARGET, 'pin');
    await vi.advanceTimersByTimeAsync(0);
    expect(hb.inspects()).toBe(1);

    const c = scripted(['reset']);
    setMachineConsoleLoader(async () => c.client);
    const register = attachConsole(TARGET);
    const before = hb.inspects();
    const r = await register.send('M491', { firstReplyMs: 60_000, quietMs: 800, maxMs: 120_000 });
    expect(r.kind).toBe('error');
    expect(c.state.opens - c.state.closes, 'the failed session was closed, not left open').toBe(0);

    await vi.advanceTimersByTimeAsync(0);
    expect(hb.inspects(), 'the poller resumes after a dropped console session').toBeGreaterThan(before);
    await register.close();
    releasePin();
  });

  it('Home holds ONE session and pauses the poller for its duration, then the poll returns', async () => {
    const hb = heartbeat();
    setMachineHeartbeatLoader(async () => hb.client);
    const releasePin = acquireStatusPoll(TARGET, 'pin');
    await vi.advanceTimersByTimeAsync(0);
    expect(hb.inspects()).toBe(1);

    const c = scripted([
      { text: IDLE_NOT_HOMED }, // `?` before homing
      { text: '' }, // `$H` accepted
      { text: IDLE_HOMED }, // the first poll after homing
    ]);
    setMachineConsoleLoader(async () => c.client);
    const home = homeMachine(TARGET, { polls: 3, pollMs: 100 });
    await vi.advanceTimersByTimeAsync(0); // the two sends go out; the Home poll waits

    const during = hb.inspects();
    await vi.advanceTimersByTimeAsync(50);
    expect(hb.inspects(), 'no poll session opened during Home').toBe(during);

    await vi.advanceTimersByTimeAsync(60); // the Home poll answers
    const answer = await home;
    expect(answer.kind).toBe('homed');
    expect(c.state.opens, 'exactly one session for the whole Home action').toBe(1);
    expect(c.state.opens - c.state.closes, 'zero left open after Home').toBe(0);

    await vi.advanceTimersByTimeAsync(0);
    expect(hb.inspects(), 'the poller resumes after Home').toBe(during + 1);
    releasePin();
  });

  it('two consoles: the poller stays paused until the LAST one closes', async () => {
    const hb = heartbeat();
    setMachineHeartbeatLoader(async () => hb.client);
    const releasePin = acquireStatusPoll(TARGET, 'pin');
    await vi.advanceTimersByTimeAsync(0);
    expect(hb.inspects()).toBe(1);

    const c = scripted([{ text: 'ok' }, { text: 'ok' }]);
    setMachineConsoleLoader(async () => c.client);
    const first = attachConsole(TARGET);
    const second = attachConsole(TARGET);
    await first.send('?', STATUS_POLL_TIMING);
    await second.send('?', STATUS_POLL_TIMING);
    expect(c.state.opens).toBe(2);

    const during = hb.inspects();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(hb.inspects()).toBe(during);

    await first.close();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(hb.inspects(), 'the second console still holds the poller').toBe(during);

    await second.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(hb.inspects()).toBe(during + 1);
    releasePin();
  });
});
