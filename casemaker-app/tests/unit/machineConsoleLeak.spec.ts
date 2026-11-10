// BENCH BLOCKER 2026-11-10 — A FAILED CONSOLE SESSION IS CLOSED, NEVER LEAKED.
//
// On the bench the Register read failed with "read failed: Connection reset by peer (os error
// 104)". The console seam's catch set the session reference to null and returned the error WITHOUT
// closing it, so the Rust relay (which keeps a connection until `tcpClose`) held an ESTABLISHED
// socket to the controller after every failed action — the analyst counted 2 after the failed
// Register, 4 after Home, with no browser attached. These cases count sessions on a scripted
// console client: after a rejected read and after a Home that cannot answer, ZERO are left open,
// and the next line opens exactly one new one (a failed socket is never reused).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  attachConsole,
  setMachineConsoleLoader,
  STATUS_POLL_TIMING,
  type ConsoleSend,
  type MachineConsoleClient,
  type MachineConsoleSession,
} from '@/platform/machineConsole';
import { homeMachine } from '@/platform/machineChangeRun';

interface Scripted {
  client: MachineConsoleClient;
  /** Sessions opened, sessions closed, and every line sent. */
  state: { opens: number; closes: number; lines: string[] };
}

type Reply = { text: string } | 'reset';

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

const TARGET = { host: '192.0.2.10', port: 2222 };
/** Idle at a non-homed rest: Home will want to send `$H`. */
const IDLE_NOT_HOMED = '<Idle|MPos:10.0000,20.0000,30.0000|L:0, 0, 0, 0.0,100.0|C:3,1,0,1|OTA:0,0>';
/** Idle at the homed rest (-1,-1,-1): a home that has finished. */
const IDLE_HOMED = '<Idle|MPos:-1.0000,-1.0000,-1.0000|L:0, 0, 0, 0.0,100.0|C:3,1,0,1|OTA:0,0>';

beforeEach(() => {
  setMachineConsoleLoader(null);
});
afterEach(() => {
  setMachineConsoleLoader(null);
});

describe('#bench-2026-11-10 a failed console session is closed, not leaked', () => {
  it('a rejected read closes the session — zero open — and the next line opens exactly one new one', async () => {
    const { client, state } = scripted(['reset', { text: IDLE_HOMED }]);
    setMachineConsoleLoader(async () => client);
    const console = attachConsole(TARGET);

    // The bench's Register shape: a status read that the controller resets.
    const first = await console.send('?', STATUS_POLL_TIMING);
    expect(first.kind).toBe('error');
    expect(state.opens).toBe(1);
    expect(state.closes, 'the failed session was CLOSED, not dropped').toBe(1);
    expect(state.opens - state.closes, 'no session left open').toBe(0);

    // The failed socket is never reused: the next line opens a fresh session, and closes cleanly.
    const second = await console.send('?', STATUS_POLL_TIMING);
    expect(second.kind).toBe('sent');
    expect(state.opens).toBe(2);
    await console.close();
    expect(state.opens - state.closes).toBe(0);
  });

  it('the Register executor’s first line failing leaves zero open', async () => {
    // The executor's order: `M491` (the probe reference) before anything moves.
    const { client, state } = scripted(['reset']);
    setMachineConsoleLoader(async () => client);
    const console = attachConsole(TARGET);
    const r = await console.send('M491', { firstReplyMs: 60_000, quietMs: 800, maxMs: 120_000 });
    expect(r.kind).toBe('error');
    expect(state.lines).toEqual(['M491']);
    expect(state.opens - state.closes, 'zero sessions left open after the failed Register line').toBe(0);
    await console.close();
    expect(state.opens - state.closes).toBe(0);
  });

  it('Home that cannot answer (`$H` reset) leaves zero open — and does not open one per poll', async () => {
    const { client, state } = scripted([{ text: IDLE_NOT_HOMED }, 'reset']);
    setMachineConsoleLoader(async () => client);
    const answer = await homeMachine(TARGET, { polls: 30, pollMs: 0 });
    expect(answer.kind).toBe('failed');
    expect(state.lines).toEqual(['?', '$H']);
    // The loop must NOT continue against a session the reset killed: one open, one close.
    expect(state.opens).toBe(1);
    expect(state.closes).toBe(1);
    expect(state.opens - state.closes, 'zero sessions left open after Home failed').toBe(0);
  });

  it('a poll that is reset mid-loop stops the loop with zero open (no per-poll session churn)', async () => {
    const { client, state } = scripted([
      { text: IDLE_NOT_HOMED }, // `?` before homing
      { text: '' }, // `$H` accepted
      'reset', // the first poll's read is reset
    ]);
    setMachineConsoleLoader(async () => client);
    const answer = await homeMachine(TARGET, { polls: 30, pollMs: 0 });
    expect(answer.kind).toBe('failed');
    expect(state.opens).toBe(1);
    expect(state.closes).toBe(1);
    // ONE `?` poll went out, not the whole 30-poll budget on a dead link.
    expect(state.lines.filter((l) => l === '?')).toHaveLength(2);
    expect(state.opens - state.closes).toBe(0);
  });

  it('a normal run still opens exactly one session and closes it', async () => {
    const { client, state } = scripted([{ text: IDLE_HOMED }, { text: IDLE_HOMED }]);
    setMachineConsoleLoader(async () => client);
    const answer = await homeMachine(TARGET, { polls: 3, pollMs: 0 });
    expect(answer.kind).toBe('homed');
    expect(state.opens, 'exactly one session for the whole Home action').toBe(1);
    expect(state.opens - state.closes).toBe(0);
  });
});
