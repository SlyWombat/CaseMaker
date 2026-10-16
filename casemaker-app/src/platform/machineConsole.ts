/**
 * The typed console, UI side (#302 item 4) — the machine's own command line, one line at a time.
 *
 * `machineUpload.ts` is this module's sibling and its shape is copied on purpose: the bridge
 * (`platform/desktop/machineBridge.ts`) can already hold a console session, but it is desktop-only
 * and reaches a raw socket, and a panel has to be able to offer this and render an honest answer in
 * either build. So: the same seam. A swappable client for tests, the real one behind
 * `loadMachineBridge()`, and outcomes instead of thrown exceptions.
 *
 * THE ORDER IS THE SAFETY RULE, and it is this module's whole reason for existing rather than the
 * panel calling the bridge itself:
 *
 *   1. the line is asked of the guards — one printable line, no config-set, no card writes, no
 *      reset/flash, no transfer (`engine/cnc/consoleGate.ts`, the same clauses the sink applies);
 *   2. a REFUSED line returns here. No loader, no bridge, no socket — the answer is a sentence;
 *   3. only then is a session opened, and it is opened LAZILY, on the first line that may be sent.
 *      Opening a console sends nothing, but it is still a socket to a machine: a panel that opened
 *      one when it appeared, or when a checkbox was ticked, would have connected before anyone had
 *      anything to say.
 *
 * WHAT THIS MODULE DOES NOT DO. No queue, no repeat, no polling, no history: every line is one call
 * from one press, and the session exists only so a reply that straddles two lines is not lost (the
 * reason `openConsole` keeps one frame channel). A macro is the case that catches both halves of
 * that: it keeps talking after the 800 ms quiet window has closed its reply, and what arrives late is
 * CARRIED on the next line's answer rather than merged into it (#386 item 3) — a `?` whose only
 * "reply" was an old frame is a poll that nothing answered, which is a different thing to show and a
 * different thing to act on. Motion still needs a person at the machine (`/Fabrication.md` §8) — the
 * panel asks for that, and this module cannot check it.
 *
 * THE TEST SEAM. `setMachineConsoleLoader` swaps the client, matching `setMachineUploadLoader` and
 * `setMachineProbeLoader`. Everything below the loader — the guard, the lazy open, the mapping from
 * the transport's outcome to ours — is the real code in every test. Only the socket is faked,
 * because a socket is the one thing a unit test cannot have.
 */

import { consoleProblem } from '@/engine/cnc/consoleGate';
import { loadMachineBridge } from './capabilities';
import { readDefault, type ShopDefaults } from './defaultsClient';

/** Where to reach the machine. Always both: an observation carries the port it was reached on. */
export interface MachineConsoleTarget {
  host: string;
  port: number;
}

/**
 * How long the panel waits, per line. These are NOT the protocol's defaults: `openConsole` waits
 * 3 s for a first reply, which is right for a status poll and wrong for a typed line — `M491` runs
 * the tool-length probe, and on the bench that needed `--first-reply 60000` (`Z1-Bridge-Protocol.md`
 * §11.9). The direction of the mistake decides the numbers: waiting too long only delays an answer,
 * while giving up too early discards bytes that have already left the controller AND reports "timed
 * out" about a machine that was working. The quiet gap (800 ms) and the ceiling stay the session's
 * own; the ceiling is raised only so it cannot cut a first reply off.
 */
export interface ConsoleTiming {
  firstReplyMs: number;
  quietMs: number;
  maxMs: number;
}

/**
 * The labelled NO-SERVICE FALLBACK (#449): the shop's `console.firstReplyMs`, `console.quietMs` and
 * `console.maxMs` are what a console uses ({@link consoleTimingFrom}); these are their fallbacks.
 */
export const CONSOLE_TIMING: ConsoleTiming = { firstReplyMs: 60_000, quietMs: 800, maxMs: 120_000 };

/**
 * A status poll's window (#423 review): `?` answers in 0.6–0.7 s (#386), and the harness's `run` gives
 * it 3 s. A 60 s window would make "three missed polls" take three minutes, and keep a Stop waiting
 * behind a poll nobody will answer.
 */
export const STATUS_POLL_TIMING: ConsoleTiming = { firstReplyMs: 3000, quietMs: 800, maxMs: 5000 };

/** How much longer than its first-reply wait a status poll may run (#449): 3000 + 2000 = the 5000 above. */
export const STATUS_POLL_HEADROOM_MS = 2000;

/**
 * A typed line's window from the shop's defaults (#449) — the labelled fallbacks with no location. The
 * ceiling is never let below the first-reply wait: a line must be allowed to finish its first reply.
 */
export function consoleTimingFrom(defaults: ShopDefaults | null): ConsoleTiming {
  const firstReplyMs = readDefault(defaults, 'console.firstReplyMs').value;
  return {
    firstReplyMs,
    quietMs: readDefault(defaults, 'console.quietMs').value,
    maxMs: Math.max(firstReplyMs, readDefault(defaults, 'console.maxMs').value),
  };
}

/** A status poll's window from the shop's defaults (#449): `run.statusReplyMs`, plus the headroom. */
export function statusPollTimingFrom(defaults: ShopDefaults | null): ConsoleTiming {
  const firstReplyMs = readDefault(defaults, 'run.statusReplyMs').value;
  return {
    firstReplyMs,
    quietMs: readDefault(defaults, 'console.quietMs').value,
    maxMs: firstReplyMs + STATUS_POLL_HEADROOM_MS,
  };
}

/**
 * Where a console reads the shop's defaults from (#449). `shopDefaultsStore` sets it when it loads, so
 * every console the app opens uses the location's window; unset (a test, a build with no store), the
 * fallbacks. A function, read at each line, so a value changed in Manage reaches the next line.
 */
let defaultsSource: () => ShopDefaults | null = () => null;

/** Set where consoles read the shop's defaults; `null` restores "none" (the fallbacks). */
export function setConsoleDefaultsSource(fn: (() => ShopDefaults | null) | null): void {
  defaultsSource = fn ?? (() => null);
}

function currentConsoleTiming(): ConsoleTiming {
  try {
    return consoleTimingFrom(defaultsSource());
  } catch {
    // A source that cannot answer is no location: the labelled fallbacks.
    return consoleTimingFrom(null);
  }
}

/**
 * What the transport said about one line. **This is the bridge's `ConsoleOutcome` restated**, for the
 * reason `machineUpload.ts` restates `UploadOutcome`: importing the type would pull
 * `platform/desktop/protocol.ts` — sockets — into the web bundle, which is the leak
 * `capabilities.ts` exists to prevent. `machineConsole.spec.ts` keeps the two in step by
 * construction, so a field changed on either side is a type error rather than a silently dropped one.
 *
 * `carried` is output that arrived with no line in flight and is deliberately NOT part of `text`
 * (#386 item 3) — see `protocol.ts`'s `ConsoleCarried` for why merging it would be the bug.
 */
export interface ConsoleCarried {
  text: string;
  frames: number;
}

export type ConsoleSend =
  | {
      ok: true;
      line: string;
      text: string;
      frames: number;
      elapsedMs: number;
      carried?: ConsoleCarried;
    }
  | {
      ok: false;
      reason: 'refused' | 'timeout';
      line: string;
      detail: string;
      text: string;
      carried?: ConsoleCarried;
    };

/** The socket-facing half: open one session, send lines on it, close it. */
export interface MachineConsoleSession {
  send(line: string, timing: ConsoleTiming): Promise<ConsoleSend>;
  close(): Promise<void>;
}

export interface MachineConsoleClient {
  open(target: MachineConsoleTarget, timing: ConsoleTiming): Promise<MachineConsoleSession>;
}

/**
 * What one press of Send did. Five answers, and the split between them is the useful part:
 *
 *   - `sent` — the machine answered. `frames` is how many frames the answer arrived in and
 *     `elapsedMs` how long it took, which is what the transcript shows beside the reply.
 *   - `refused` — the guards said no. Nothing was opened, and `detail` is the sentence to show.
 *   - `timeout` — the line went out and no reply came in time. `text` is whatever partial reply
 *     arrived, because an empty box and a half-reply are different things to read.
 *   - `error` — the socket failed, or the exchange went somewhere the protocol does not allow.
 *   - `unavailable` — nothing was attempted: this build cannot reach a machine at all.
 *
 * `carried` rides beside `sent` and `timeout` — an answer and an eviction can happen on the same
 * press, and the transcript has to be able to show both without confusing one for the other.
 */
export type ConsoleSendResult =
  | {
      kind: 'sent';
      line: string;
      text: string;
      frames: number;
      elapsedMs: number;
      carried?: ConsoleCarried;
    }
  | { kind: 'refused'; line: string; detail: string }
  | { kind: 'timeout'; line: string; detail: string; text: string; carried?: ConsoleCarried }
  | { kind: 'error'; line: string; detail: string }
  | { kind: 'unavailable'; line: string; detail: string };

/**
 * A console a panel holds for as long as it is on screen. Creating one connects to NOTHING; the
 * socket appears with the first line that passes the guards, and stays for the rest of the session.
 */
export interface ConsoleHandle {
  /**
   * `timing` narrows this ONE line's reply window (#423 review): a status poll is answered in about
   * 0.7 s, so a run's watch gives `?` a few seconds, not the 60 s a typed `M491` needs. Default: the
   * shop's `console.*` window ({@link consoleTimingFrom}), {@link CONSOLE_TIMING} with no location.
   */
  send(line: string, timing?: Partial<ConsoleTiming>): Promise<ConsoleSendResult>;
  /**
   * Close the socket if one was opened. Idempotent, and NOT the end of the console: a later line
   * opens a new session.
   *
   * Why a close cannot be final. The panel closes its console from an effect cleanup, and React's
   * dev-mode StrictMode runs that cleanup ONCE ON MOUNT. A handle that went permanently dead there
   * would answer "this console is closed" to every press in a dev build — found by browser QA on
   * 2026-10-12 (`npm run dev:desktop`), where the first press came back with exactly that sentence.
   * The property that matters is the one kept: a FAILED LINE is never re-sent by itself. Dropping the
   * session after a socket-level failure is what keeps the next press working (#386).
   */
  close(): Promise<void>;
}

/** The session, or the answer to give when one could not be opened. */
type SessionOpen =
  | { ok: true; session: MachineConsoleSession }
  | { ok: false; result: ConsoleSendResult };

/** The real client: the bridge, reached only through the capability guard. */
async function loadRealClient(): Promise<MachineConsoleClient> {
  const bridge = await loadMachineBridge();
  return {
    // The timing reaches the wire per LINE (`live.send`), not at open: connecting has its own
    // timeout, and the reply window is a property of the line being sent.
    async open(target, _timing) {
      const live = await bridge.openConsoleSession(target);
      return {
        send: (line, t) => live.send(line, t),
        close: () => live.close(),
      };
    },
  };
}

let clientFactory: () => Promise<MachineConsoleClient> = loadRealClient;

/** Swap the client. Vitest uses this; the app never calls it. `null` restores the real bridge. */
export function setMachineConsoleLoader(fn: (() => Promise<MachineConsoleClient>) | null): void {
  clientFactory = fn ?? loadRealClient;
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A console for one machine. Never throws and never opens a socket by itself: the returned handle
 * connects on its first allowed line.
 */
export function attachConsole(target: MachineConsoleTarget): ConsoleHandle {
  let session: MachineConsoleSession | null = null;

  /** The session, opening one if the first allowed line has just arrived. */
  async function sessionFor(line: string): Promise<SessionOpen> {
    if (session !== null) return { ok: true, session };
    let client: MachineConsoleClient;
    try {
      client = await clientFactory();
    } catch (e) {
      // The web build's answer, and the reason is the guard's own sentence rather than a generic one.
      return { ok: false, result: { kind: 'unavailable', line, detail: reasonOf(e) } };
    }
    try {
      session = await client.open(target, currentConsoleTiming());
      return { ok: true, session };
    } catch (e) {
      return {
        ok: false,
        result: {
          kind: 'error',
          line,
          detail: `could not open a console on ${target.host}:${target.port}: ${reasonOf(e)}`,
        },
      };
    }
  }

  return {
    async send(line: string, timing?: Partial<ConsoleTiming>): Promise<ConsoleSendResult> {
      // The guards first, and here rather than at the socket alone: a refused line must cost no
      // connection, which is only true if the refusal is decided before the session is opened.
      const problem = consoleProblem(line);
      if (problem !== null) return { kind: 'refused', line, detail: problem };

      const opened = await sessionFor(line);
      if (!opened.ok) return opened.result;

      let send: ConsoleSend;
      try {
        send = await opened.session.send(line, { ...currentConsoleTiming(), ...timing });
      } catch (e) {
        // `tcpRead` rejects when the peer closed the connection, so a dead socket arrives here rather
        // than as an outcome. The SESSION is dropped — the LINE never is: the next press opens a fresh
        // one, so a dropped link (the controller left the network, or `power.sh on --cycle`) costs one
        // press instead of a trip out to Manage → Machines and back (#386). Re-sending the failed line
        // here would be the app moving the machine again on its own, which is the thing this module
        // must not do.
        session = null;
        return { kind: 'error', line, detail: reasonOf(e) };
      }
      // Output that arrived with no line in flight is passed along as its own field, never folded
      // into `text`: the panel's whole job here is to keep "what answered this line" and "what the
      // controller said on its own" apart (#386 item 3).
      const beside = send.carried === undefined ? {} : { carried: send.carried };
      if (send.ok) {
        return {
          kind: 'sent',
          line,
          text: send.text,
          frames: send.frames,
          elapsedMs: send.elapsedMs,
          ...beside,
        };
      }
      // The transport's own two reasons map one to one, so this is a narrowing rather than a table
      // that could miss one. (`refused` is unreachable here — the guard above already ran — and is
      // mapped rather than asserted away, so a divergence shows up as an answer, not a crash.)
      return send.reason === 'timeout'
        ? { kind: 'timeout', line, detail: send.detail, text: send.text, ...beside }
        : { kind: 'refused', line, detail: send.detail };
    },

    async close(): Promise<void> {
      const open = session;
      // Released before the await, so a second close during the first finds nothing to do.
      session = null;
      if (open !== null) {
        try {
          await open.close();
        } catch {
          // Closing an already-dead socket is not a failure worth surfacing.
        }
      }
    },
  };
}
