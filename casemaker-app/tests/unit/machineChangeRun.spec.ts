/**
 * #693 — the machine's half of the change-the-machine wizard: the status reading and the two
 * commands step 2 and step 5 use.
 *
 * WHY THIS FILE IS SEPARATE FROM `machineChange.spec.ts`. The rules (which profile becomes active,
 * which datums and mountings go with it) are pure and have no socket; these tests are about a
 * conversation, and their assertions are the safety ones: nothing homes a machine that is running,
 * an already-homed machine is not re-homed, the `P:` mid-job window is not Idle, and a poll that
 * never reaches the homed rest ends with a sentence rather than a tick.
 *
 * `readMachineRest` is this module's own reader because `desktop/protocol.ts` is the desktop
 * boundary; the last test in the first block runs both over the bench's lines so the two readings
 * cannot drift.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { checkMachine, homeMachine, readMachineRest } from '@/platform/machineChangeRun';
import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleSession } from '@/platform/machineConsole';
import { readStatusLine } from '@/platform/desktop/protocol';

const TARGET = { host: '192.168.10.43', port: 2222 };
const IDLE = '<Idle|MPos:-1.000,-1.000,-1.000|WPos:147.4000,123.8000,57.6325|T:6,-17.696,-1>';
const IDLE_AWAY = '<Idle|MPos:-160.5000,-188.0000,-55.0000|WPos:19.6000,4.7000,0.4000>';
const RUNNING = '<Run|MPos:-162.0500,-162.2000,-3.0000|P:0,12,4>';
const HOMING = '<Home|MPos:-11.6000,-14.6000,-3.0000>';
const ALARM = '<Alarm|MPos:0.0000,0.0000,0.0000>';
const MID_JOB = '<Idle|MPos:-1.0000,-1.0000,-1.0000|S:12031|P:389,90,88>';

/**
 * The transport, faked only at its socket: the guard, the poll loop and the reading of every line
 * are the real code. `answer` is called once per line the module sends.
 */
function fakeConsole(answer: (line: string) => ConsoleSend): { sent: string[] } {
  const sent: string[] = [];
  const session: MachineConsoleSession = {
    async send(line) {
      sent.push(line);
      return answer(line);
    },
    async close() {},
  };
  setMachineConsoleLoader(async () => ({ async open() { return session; } }));
  return { sent };
}

const sent = (line: string, text: string): ConsoleSend => ({ ok: true, line, text, frames: 1, elapsedMs: 10 });
const refused = (line: string): ConsoleSend => ({ ok: false, reason: 'refused', line, detail: 'the console refuses that line', text: '' });

afterEach(() => setMachineConsoleLoader(null));

describe('#693 readMachineRest', () => {
  it('reads the homed rest as homed, and Idle anywhere else as not', () => {
    expect(readMachineRest(IDLE)).toMatchObject({ state: 'Idle', x: -1, y: -1, z: -1, homed: true });
    expect(readMachineRest(IDLE_AWAY)).toMatchObject({ state: 'Idle', homed: false });
    expect(readMachineRest(RUNNING)).toMatchObject({ state: 'Run', homed: false });
    expect(readMachineRest(HOMING)).toMatchObject({ state: 'Home', homed: false });
    expect(readMachineRest(ALARM)).toMatchObject({ state: 'Alarm', homed: false });
  });

  it('agrees with the desktop status reader over the bench’s own lines', () => {
    for (const line of [IDLE, IDLE_AWAY, RUNNING, HOMING, ALARM]) {
      const mine = readMachineRest(line)!;
      const theirs = readStatusLine(line);
      expect(mine.state).toBe(theirs.state);
      expect([mine.x, mine.y, mine.z]).toEqual([theirs.mpos.x, theirs.mpos.y, theirs.mpos.z]);
    }
  });

  it('calls an unreadable line unknown, never Idle', () => {
    expect(readMachineRest('???')).toBeNull();
    expect(readMachineRest('')).toBeNull();
    expect(readMachineRest(null)).toBeNull();
  });
});

describe('#693 checkMachine', () => {
  it('asks once and answers online with the rest it read', async () => {
    const z1 = fakeConsole((line) => sent(line, IDLE));
    const r = await checkMachine(TARGET);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.rest.homed).toBe(true);
    expect(z1.sent).toEqual(['?']);
  });

  it('answers an offline machine with the transport’s own sentence', async () => {
    fakeConsole((line) => ({ ok: false, reason: 'timeout', line, detail: 'no reply within 6000 ms', text: '' }));
    const r = await checkMachine(TARGET);
    expect(r).toEqual({ kind: 'no', detail: 'no reply within 6000 ms' });
  });

  it('answers an alarm as a machine that cannot be made safe', async () => {
    fakeConsole((line) => sent(line, `${ALARM}\nALARM: Probe fail`));
    const r = await checkMachine(TARGET);
    expect(r.kind).toBe('no');
    if (r.kind === 'no') expect(r.detail).toContain('alarm');
  });
});

describe('#693 homeMachine', () => {
  it('does not send $H to a machine that is not Idle', async () => {
    const z1 = fakeConsole((line) => sent(line, RUNNING));
    const r = await homeMachine(TARGET, { polls: 2, pollMs: 0 });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.detail).toContain('Run');
    expect(z1.sent).toEqual(['?']);
  });

  it('does not send $H to a machine already Idle at its homed rest', async () => {
    const z1 = fakeConsole((line) => sent(line, IDLE));
    const r = await homeMachine(TARGET, { polls: 2, pollMs: 0 });
    expect(r).toMatchObject({ kind: 'homed', sent: false });
    expect(z1.sent).toEqual(['?']);
  });

  it('refuses an Idle line whose P: percent says the job has not finished (#390)', async () => {
    const z1 = fakeConsole((line) => sent(line, MID_JOB));
    const r = await homeMachine(TARGET, { polls: 2, pollMs: 0 });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.detail).toContain('90%');
    expect(z1.sent).toEqual(['?']);
  });

  it('sends $H from Idle, then reads the rest from the status poll rather than the acknowledgement', async () => {
    let asked = 0;
    const z1 = fakeConsole((line) => {
      if (line === '?') {
        asked += 1;
        return sent(line, asked === 1 ? IDLE_AWAY : IDLE);
      }
      return sent(line, 'ok');
    });
    const r = await homeMachine(TARGET, { polls: 2, pollMs: 0 });
    expect(r).toMatchObject({ kind: 'homed', sent: true });
    expect(z1.sent[0]).toBe('?');
    expect(z1.sent[1]).toBe('$H');
    expect(z1.sent.filter((l) => l === '?').length).toBeGreaterThanOrEqual(2);
  });

  it('reports an alarm that arrives mid-poll', async () => {
    let asked = 0;
    fakeConsole((line) => {
      if (line === '?') {
        asked += 1;
        return sent(line, asked === 1 ? IDLE_AWAY : ALARM);
      }
      return sent(line, 'ok');
    });
    const r = await homeMachine(TARGET, { polls: 3, pollMs: 0 });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.detail).toContain('alarm');
  });

  it('ends the window with the sentence that says where the machine actually is', async () => {
    fakeConsole((line) => (line === '?' ? sent(line, IDLE_AWAY) : sent(line, 'ok')));
    const r = await homeMachine(TARGET, { polls: 2, pollMs: 0 });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') {
      expect(r.detail).toContain('Idle at -160.5, -188, -55');
      expect(r.detail).toContain('not at its homed rest');
    }
  });

  it('reports a refused $H without claiming the head moved', async () => {
    fakeConsole((line) => (line === '?' ? sent(line, IDLE_AWAY) : refused(line)));
    const r = await homeMachine(TARGET, { polls: 1, pollMs: 0 });
    expect(r).toEqual({ kind: 'failed', detail: 'the console refuses that line' });
  });
});
