/**
 * #302 item 4 — the console seam: the guard runs before the bridge, and a session is one connection.
 *
 * The orchestration under test is the real one — only the socket is faked (the seam shape
 * `machineUpload.spec.ts` and `setMachineProbeLoader` use), so what runs here is the guard → load
 * bridge → open session → send path the app runs. The two assertions that matter most are the safety
 * ones: a line the guards refuse never reaches the loader at all, and a console that has been closed
 * answers rather than quietly reconnecting.
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
  attachConsole,
  setMachineConsoleLoader,
  CONSOLE_TIMING,
  type ConsoleSend,
  type MachineConsoleClient,
  type MachineConsoleSession,
} from '@/platform/machineConsole';
import type { ConsoleOutcome } from '@/platform/desktop/protocol';

afterEach(() => setMachineConsoleLoader(null));

const TARGET = { host: '192.168.10.43', port: 2222 };

/** How a fake session answers a line. The recorder is the fake's own, so `sent` is always the truth. */
type Answer = (line: string) => ConsoleSend;

const ANSWERS_OK: Answer = (line) => ({ ok: true, line, text: 'ok', frames: 1, elapsedMs: 7 });

/** A session that answers as scripted, and remembers what it was asked. */
interface FakeSession {
  session: MachineConsoleSession;
  sent: string[];
  timings: Array<{ firstReplyMs: number; quietMs: number; maxMs: number }>;
  readonly closes: number;
}

function fakeSession(answer: Answer = ANSWERS_OK): FakeSession {
  const sent: string[] = [];
  const timings: FakeSession['timings'] = [];
  const counters = { closes: 0 };
  const session: MachineConsoleSession = {
    async send(line, timing) {
      sent.push(line);
      timings.push(timing);
      return answer(line);
    },
    async close() {
      counters.closes += 1;
    },
  };
  // `closes` is read after the fact, so it has to be a live read rather than a copied number.
  return {
    session,
    sent,
    timings,
    get closes() {
      return counters.closes;
    },
  };
}

/**
 * Install a client and count how many times the loader was REACHED. That count is what makes the
 * "without loading the bridge" assertion mean something: a refusal that still called the factory
 * would have loaded the desktop module in the web build, which is the thing the guard is for.
 */
function use(session: MachineConsoleSession): {
  loads: () => number;
  opens: () => Array<{ host: string; port: number }>;
  timings: () => unknown[];
} {
  let loads = 0;
  const opens: Array<{ host: string; port: number }> = [];
  const timings: unknown[] = [];
  const client: MachineConsoleClient = {
    async open(target, timing) {
      opens.push(target);
      timings.push(timing);
      return session;
    },
  };
  setMachineConsoleLoader(async () => {
    loads += 1;
    return client;
  });
  return { loads: () => loads, opens: () => opens, timings: () => timings };
}

describe('#302 the console seam — the guard runs before the bridge', () => {
  it('refuses a config-set line without loading the bridge, in the guard’s own words', async () => {
    const fake = fakeSession();
    const wire = use(fake.session);
    const console = attachConsole(TARGET);

    const result = await console.send('config-set sd x 1');

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.detail).toContain('changes a configuration value');
    expect(wire.loads()).toBe(0);
    expect(fake.sent).toEqual([]);
  });

  it('refuses a reset, a card write, a transfer and a bare realtime byte, all without a socket', async () => {
    const fake = fakeSession();
    const wire = use(fake.session);
    const console = attachConsole(TARGET);

    for (const line of ['reset', 'rm /sd/x', 'upload /sd/y', '!']) {
      const result = await console.send(line);
      expect(result.kind, line).toBe('refused');
    }
    expect(wire.loads()).toBe(0);
    expect(wire.opens()).toEqual([]);
  });

  it('refuses an empty line and a control character, which are not lines at all', async () => {
    const fake = fakeSession();
    const wire = use(fake.session);
    const console = attachConsole(TARGET);

    expect((await console.send('')).kind).toBe('refused');
    expect((await console.send('M3\nM5')).kind).toBe('refused');
    expect(wire.loads()).toBe(0);
  });

  it('is unavailable, with the guard’s own reason, when this build has no bridge', async () => {
    // Exactly what the web build does: `loadMachineBridge()` throws inside the guard.
    setMachineConsoleLoader(async () => {
      throw new Error('Driving the machine requires the desktop build (BUILD_TARGET=desktop).');
    });
    const result = await attachConsole(TARGET).send('?');
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.detail).toContain('desktop build');
    // The answer still names the line: "this build cannot send" is about a specific line.
    expect(result.line).toBe('?');
  });
});

describe('#302 the console seam — one connection, one line per press', () => {
  it('sends a line through the session once and reports what came back', async () => {
    const fake = fakeSession((line) => ({ ok: true, line, text: '<Idle|MPos:0,0,0>', frames: 2, elapsedMs: 41 }));
    use(fake.session);
    const result = await attachConsole(TARGET).send('?');

    expect(result).toEqual({
      kind: 'sent',
      line: '?',
      text: '<Idle|MPos:0,0,0>',
      frames: 2,
      elapsedMs: 41,
    });
    expect(fake.sent).toEqual(['?']);
  });

  it('opens ONE session for two lines, and sends the panel’s own timing on both', async () => {
    const fake = fakeSession();
    const wire = use(fake.session);
    const console = attachConsole(TARGET);

    await console.send('?');
    await console.send('M491');

    expect(wire.loads()).toBe(1);
    expect(wire.opens()).toEqual([TARGET]);
    expect(fake.sent).toEqual(['?', 'M491']);
    // The session is opened with the console timing, and each line carries it too — the 3 s first
    // reply that suits a status poll is too short for a typed probe line (§11.9 needed 60 s).
    expect(wire.timings()).toEqual([CONSOLE_TIMING]);
    expect(fake.timings).toEqual([CONSOLE_TIMING, CONSOLE_TIMING]);
    expect(CONSOLE_TIMING.firstReplyMs).toBeGreaterThan(3000);
  });

  it('maps a timeout with a partial reply, which is not the same thing as an empty box', async () => {
    const fake = fakeSession((line) => ({
      ok: false,
      reason: 'timeout',
      line,
      detail: 'no reply within 60000 ms',
      text: 'half',
    }));
    use(fake.session);
    const result = await attachConsole(TARGET).send('M491');
    expect(result.kind).toBe('timeout');
    if (result.kind !== 'timeout') return;
    expect(result.text).toBe('half');
    expect(result.detail).toContain('no reply within');
  });

  it('turns a dead socket into an error answer rather than a thrown exception', async () => {
    const fake = fakeSession(() => {
      throw new Error('tcpRead: connection reset by peer');
    });
    use(fake.session);
    const result = await attachConsole(TARGET).send('?');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.detail).toContain('connection reset');
  });

  it('reports a session that cannot be opened as an error naming the address', async () => {
    setMachineConsoleLoader(async () => ({
      async open() {
        throw new Error('connect ECONNREFUSED 192.168.10.43:2222');
      },
    }));
    const result = await attachConsole(TARGET).send('?');
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.detail).toContain('192.168.10.43:2222');
    expect(result.detail).toContain('ECONNREFUSED');
  });
});

describe('#302 the console seam — closing', () => {
  it('closes the session, and a later line opens a new one rather than answering a dead handle', async () => {
    // Browser QA found this on 2026-10-12: the panel closes its console from an effect cleanup, and
    // React's dev-mode StrictMode runs that cleanup once ON MOUNT, so a handle that stayed dead after
    // a close answered "this console is closed" to the first press in a dev build.
    const first = fakeSession();
    const second = fakeSession();
    let opens = 0;
    setMachineConsoleLoader(async () => ({
      async open() {
        opens += 1;
        return opens === 1 ? first.session : second.session;
      },
    }));
    const console = attachConsole(TARGET);

    await console.send('?');
    await console.close();
    expect(first.closes).toBe(1);
    // Idempotent: nothing is open now, so the second close closes nothing.
    await console.close();
    expect(first.closes).toBe(1);

    const after = await console.send('M491');
    expect(after.kind).toBe('sent');
    expect(second.sent).toEqual(['M491']);
    expect(opens).toBe(2);
  });

  it('closing a console whose session was never opened does nothing at all', async () => {
    const fake = fakeSession();
    const wire = use(fake.session);
    await attachConsole(TARGET).close();
    expect(fake.closes).toBe(0);
    expect(wire.loads()).toBe(0);
  });
});

describe('#302 the restated console reply', () => {
  /** Both ways, so a field added on either side is a compile error rather than a silent drop. */
  type Mutual<A, B> = A extends B ? (B extends A ? true : never) : never;

  it('is the bridge’s ConsoleOutcome, clause for clause', () => {
    // `machineConsole.ts` restates `ConsoleOutcome` rather than importing it, because importing
    // would pull `platform/desktop/protocol.ts` into the web bundle. This is the assertion that keeps
    // the restatement honest — the same trick `machineUpload.spec.ts` uses for `UploadOutcome`.
    const same: Mutual<ConsoleSend, ConsoleOutcome> = true;
    expect(same).toBe(true);
  });
});
