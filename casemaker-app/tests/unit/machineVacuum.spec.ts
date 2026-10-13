/**
 * #390 — the vacuum seam: it asks before it switches, and only an Idle machine is switched.
 *
 * The orchestration under test is the real one — only the socket is faked (`setMachineConsoleLoader`,
 * the seam shape `machineConsole.spec.ts` uses), so what runs here is attachConsole → ask `?` → read
 * the state word → send `M331`/`M332` → close. The assertions that matter are the safety ones: a
 * machine that is not Idle never receives the code, and the entire press is one connection.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleSession } from '@/platform/machineConsole';
import { toggleVacuum, vacuumLine, VACUUM_ON, VACUUM_OFF } from '@/platform/machineVacuum';

afterEach(() => setMachineConsoleLoader(null));

const TARGET = { host: '192.168.10.43', port: 2222 };

/** An idle controller's reply, as the console returns it. */
const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128>';

/** A session that answers as scripted, and remembers what it was asked and whether it was closed. */
function fakeSession(answer: (line: string) => ConsoleSend) {
  const sent: string[] = [];
  const counters = { closes: 0, opens: 0 };
  const session: MachineConsoleSession = {
    async send(line) {
      sent.push(line);
      return answer(line);
    },
    async close() {
      counters.closes += 1;
    },
  };
  setMachineConsoleLoader(async () => ({
    async open() {
      counters.opens += 1;
      return session;
    },
  }));
  return {
    sent,
    get closes() {
      return counters.closes;
    },
    get opens() {
      return counters.opens;
    },
  };
}

/** The controller's own `ok` for a command, and its status line for `?`. */
const idleMachine: (line: string) => ConsoleSend = (line) =>
  line === '?'
    ? { ok: true, line, text: IDLE, frames: 1, elapsedMs: 30 }
    : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 };

describe('#390 the vacuum line', () => {
  it('is the machine’s own bare code, on and off', () => {
    expect(vacuumLine(true)).toBe('M331');
    expect(vacuumLine(false)).toBe('M332');
    expect(VACUUM_ON).toBe('M331');
    expect(VACUUM_OFF).toBe('M332');
  });
});

describe('#390 the vacuum seam — it asks before it switches', () => {
  it('asks `?` then sends `M331` on an idle machine, on one connection, then closes it', async () => {
    const fake = fakeSession(idleMachine);
    const result = await toggleVacuum(TARGET, true);

    expect(result).toEqual({ kind: 'toggled', on: true, status: IDLE });
    expect(fake.sent).toEqual(['?', 'M331']);
    // One press, one connection: the ask and the code ride it, and it is closed afterwards so the
    // control holds no socket beside the console's.
    expect(fake.opens).toBe(1);
    expect(fake.closes).toBe(1);
  });

  it('sends `M332` when switching off', async () => {
    const fake = fakeSession(idleMachine);
    const result = await toggleVacuum(TARGET, false);
    expect(result.kind).toBe('toggled');
    if (result.kind !== 'toggled') return;
    expect(result.on).toBe(false);
    expect(fake.sent).toEqual(['?', 'M332']);
  });

  it('refuses a machine that reports Run rather than Idle, and sends no code', async () => {
    // The #296 rule, over this control's own connection: a program owns the vacuum while it runs.
    const fake = fakeSession((line) =>
      line === '?'
        ? { ok: true, line, text: '<Run|MPos:0,0,0|P:34,42,17>', frames: 1, elapsedMs: 30 }
        : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 },
    );
    const result = await toggleVacuum(TARGET, true);

    expect(result.kind).toBe('busy');
    if (result.kind !== 'busy') return;
    expect(result.detail).toContain('Run');
    expect(result.detail).toContain('a program owns the vacuum');
    expect(result.status).toBe('<Run|MPos:0,0,0|P:34,42,17>');
    // The whole point: the code never left. And the connection is still closed.
    expect(fake.sent).toEqual(['?']);
    expect(fake.closes).toBe(1);
  });

  it('treats an unreadable status line as no permission, and sends no code', async () => {
    const fake = fakeSession((line) =>
      line === '?'
        ? { ok: true, line, text: 'garbage from the controller', frames: 1, elapsedMs: 30 }
        : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 },
    );
    const result = await toggleVacuum(TARGET, true);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.detail).toContain('not readable');
    expect(fake.sent).toEqual(['?']);
  });

  it('refuses any state word but Idle, so only an explicit idle passes', async () => {
    const fake = fakeSession((line) =>
      line === '?'
        ? { ok: true, line, text: '<Hold|MPos:0,0,0>', frames: 1, elapsedMs: 30 }
        : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 },
    );
    expect((await toggleVacuum(TARGET, false)).kind).toBe('busy');
    expect(fake.sent).toEqual(['?']);
  });
});

describe('#390 the vacuum seam — a socket that failed', () => {
  it('reports a timeout on the ask without sending the code', async () => {
    const fake = fakeSession(() => ({ ok: false, reason: 'timeout', line: '?', detail: 'no reply within 60000 ms', text: '' }));
    const result = await toggleVacuum(TARGET, true);
    expect(result.kind).toBe('timeout');
    expect(fake.sent).toEqual(['?']);
  });

  it('reports a timeout on the code itself, after the ask succeeded', async () => {
    const fake = fakeSession((line) =>
      line === '?'
        ? { ok: true, line, text: IDLE, frames: 1, elapsedMs: 30 }
        : { ok: false, reason: 'timeout', line, detail: 'no reply within 60000 ms', text: '' },
    );
    const result = await toggleVacuum(TARGET, true);
    expect(result.kind).toBe('timeout');
    expect(fake.sent).toEqual(['?', 'M331']);
  });

  it('turns a dead socket into an error answer rather than a thrown exception', async () => {
    fakeSession(() => {
      throw new Error('tcpRead: connection reset by peer');
    });
    const result = await toggleVacuum(TARGET, true);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.detail).toContain('connection reset');
  });

  it('is unavailable, with the guard’s own reason, when this build has no bridge', async () => {
    setMachineConsoleLoader(async () => {
      throw new Error('Driving the machine requires the desktop build (BUILD_TARGET=desktop).');
    });
    const result = await toggleVacuum(TARGET, true);
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.detail).toContain('desktop build');
  });
});
