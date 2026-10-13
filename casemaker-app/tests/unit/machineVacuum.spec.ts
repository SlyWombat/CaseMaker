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

  // #386 item 3. The alarm does not have to be in the state word, and it does not have to be in the
  // reply: `ALARM: Probe fail` is a line of its own in the 2026-10-12 trace, and a frame the
  // controller sent with no line in flight is still the controller saying what state it is in. A
  // locked controller refuses a lift with `error:Alarm lock` (`Z1-Firmware-Dialect.md` §11.9), and
  // switching the vacuum there is no more welcome — so both halves refuse, and neither sends the code.
  it('refuses an alarm line that sits beside an Idle reply (#386 item 3)', async () => {
    const text = `${IDLE}\r\nALARM: Probe fail\r\nok\r\n`;
    const fake = fakeSession((line) =>
      line === '?' ? { ok: true, line, text, frames: 3, elapsedMs: 40 } : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 },
    );
    const result = await toggleVacuum(TARGET, true);

    expect(result.kind).toBe('busy');
    if (result.kind !== 'busy') return;
    expect(result.detail).toContain('ALARM: Probe fail');
    expect(result.detail).toContain('clear it at the machine first');
    expect(result.status).toBe(text);
    expect(fake.sent).toEqual(['?']);
    expect(fake.closes).toBe(1);
  });

  it('refuses an alarm the controller said with no line in flight (#386 item 3)', async () => {
    // The `M491` tail's shape: the `?` is answered normally, and the alarm was already on the socket
    // when it went out — the session hands that back as `carried`, never as the reply.
    const summary = 'M492.3\r\nERROR: Probe dead or not set, please charge or set first!\r\n';
    const fake = fakeSession((line) =>
      line === '?'
        ? { ok: true, line, text: IDLE, frames: 1, elapsedMs: 30, carried: { text: summary, frames: 3 } }
        : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 },
    );
    const result = await toggleVacuum(TARGET, false);

    expect(result.kind).toBe('busy');
    if (result.kind !== 'busy') return;
    expect(result.detail).toContain('Probe dead or not set');
    // `status` is the reply the machine gave to the ask, not the carried text: the two are different
    // statements and the refusal names one of them in `detail`.
    expect(result.status).toBe(IDLE);
    expect(fake.sent).toEqual(['?']);
    expect(fake.closes).toBe(1);
  });

  it('refuses a mid-job Idle — a `P:` percent below 100 is a program that still owns the vacuum', async () => {
    // Verbatim from `docs/bench/traces/2026-10-12-poll.log`: `Idle` at 90 %, the spindle still turning,
    // ~4 s before the trip home at `M05` (`Z1-Bridge-Protocol.md` §6). The state word alone passes
    // this, which is exactly the hole #390 item 1 names: the program's own `M332` already went out, so
    // an `M331` sent here would leave the vacuum on with nothing left to switch it off.
    const MID_JOB_IDLE =
      '<Idle|MPos:-98.4000,-102.8000,-9.6109|WPos:50.0000,22.0000,55.0000|S:11988.6,12000.0|T:1,0.507,1|P:29,90,88|OTA:0,0>';
    const fake = fakeSession((line) =>
      line === '?' ? { ok: true, line, text: MID_JOB_IDLE, frames: 1, elapsedMs: 30 } : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 },
    );
    const result = await toggleVacuum(TARGET, true);

    expect(result.kind).toBe('busy');
    if (result.kind !== 'busy') return;
    expect(result.detail).toContain('90% through');
    expect(result.detail).toContain('nothing was sent');
    expect(result.status).toBe(MID_JOB_IDLE);
    expect(fake.sent).toEqual(['?']);
    expect(fake.closes).toBe(1);
  });

  it('lets the finished line through: Idle with `P:` at 100 is a job that is over', async () => {
    const fake = fakeSession((line) =>
      line === '?'
        ? {
            ok: true,
            line,
            text: '<Idle|MPos:-11.6,-14.6,-3.0|WPos:136.8,110.2,61.6|S:0.0,12000.0|P:34,100,51|OTA:0,0>',
            frames: 1,
            elapsedMs: 30,
          }
        : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 },
    );
    const result = await toggleVacuum(TARGET, true);
    expect(result.kind).toBe('toggled');
    expect(fake.sent).toEqual(['?', 'M331']);
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
