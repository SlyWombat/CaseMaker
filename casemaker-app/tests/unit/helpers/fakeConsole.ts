/**
 * The unit specs' one fake machine console (#1180 D).
 *
 * `setMachineConsoleLoader` is the seam every console-driven unit spec uses; this is the builder
 * that was retyped in each of them — a session whose `send` records every line and answers from the
 * spec's own function, a client whose `open` counts, and live counters for what the code under test
 * did (`opens`, `closes`, `loads`). Each spec keeps its own answer function, so what it asserts is
 * unchanged; only the recording machinery is shared.
 *
 * The counters are live getters, not a snapshot: a test reads them after the press it is testing.
 *
 * `statusOnly(status)` is the common answer: `?` says `status`, everything else `ok`.
 */

import {
  setMachineConsoleLoader,
  type ConsoleSend,
  type MachineConsoleSession,
} from '@/platform/machineConsole';

/** The spec's controller: the line sent, and how many lines came before it (1-based). */
export type ConsoleAnswer = (line: string, sentBefore: number) => ConsoleSend;

export interface FakeConsoleSession {
  /** Every line the code under test sent, in order. */
  sent: string[];
  /** The session itself, for a spec that closes it directly. */
  session: MachineConsoleSession;
  /** How many times the loader was called (a connect attempt, not a session). */
  readonly loads: number;
  readonly opens: number;
  readonly closes: number;
}

/** An answer of `ok` for any line. */
export function okAnswer(line: string): ConsoleSend {
  return { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 };
}

/** `?` answers `status`; every other line answers `ok`. */
export function statusOnly(status: string): ConsoleAnswer {
  return (line) =>
    line === '?'
      ? { ok: true, line, text: status, frames: 1, elapsedMs: 30 }
      : okAnswer(line);
}

/**
 * Install a fake console and return its recorder. Call before rendering; the loader stays installed
 * until the spec's `afterEach` clears it.
 */
export function fakeConsoleSession(answer: ConsoleAnswer = okAnswer): FakeConsoleSession {
  let loads = 0;
  const sent: string[] = [];
  const counters = { opens: 0, closes: 0 };
  const session: MachineConsoleSession = {
    async send(line) {
      sent.push(line);
      return answer(line, sent.length);
    },
    async close() {
      counters.closes += 1;
    },
  };
  setMachineConsoleLoader(async () => {
    loads += 1;
    return {
      async open() {
        counters.opens += 1;
        return session;
      },
    };
  });
  return {
    sent,
    session,
    get loads() {
      return loads;
    },
    get opens() {
      return counters.opens;
    },
    get closes() {
      return counters.closes;
    },
  };
}
