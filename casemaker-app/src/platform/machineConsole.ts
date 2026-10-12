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
 * reason `openConsole` keeps one frame channel). Motion still needs a person at the machine
 * (`/Fabrication.md` §8) — the panel asks for that, and this module cannot check it.
 *
 * THE TEST SEAM. `setMachineConsoleLoader` swaps the client, matching `setMachineUploadLoader` and
 * `setMachineProbeLoader`. Everything below the loader — the guard, the lazy open, the mapping from
 * the transport's outcome to ours — is the real code in every test. Only the socket is faked,
 * because a socket is the one thing a unit test cannot have.
 */

import { consoleProblem } from '@/engine/cnc/consoleGate';
import { loadMachineBridge } from './capabilities';

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

export const CONSOLE_TIMING: ConsoleTiming = { firstReplyMs: 60_000, quietMs: 800, maxMs: 120_000 };

/**
 * What the transport said about one line. **This is the bridge's `ConsoleOutcome` restated**, for the
 * reason `machineUpload.ts` restates `UploadOutcome`: importing the type would pull
 * `platform/desktop/protocol.ts` — sockets — into the web bundle, which is the leak
 * `capabilities.ts` exists to prevent. `machineConsole.spec.ts` keeps the two in step by
 * construction, so a field changed on either side is a type error rather than a silently dropped one.
 */
export type ConsoleSend =
  | { ok: true; line: string; text: string; frames: number; elapsedMs: number }
  | { ok: false; reason: 'refused' | 'timeout'; line: string; detail: string; text: string };

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
 */
export type ConsoleSendResult =
  | { kind: 'sent'; line: string; text: string; frames: number; elapsedMs: number }
  | { kind: 'refused'; line: string; detail: string }
  | { kind: 'timeout'; line: string; detail: string; text: string }
  | { kind: 'error'; line: string; detail: string }
  | { kind: 'unavailable'; line: string; detail: string };

/**
 * A console a panel holds for as long as it is on screen. Creating one connects to NOTHING; the
 * socket appears with the first line that passes the guards, and stays for the rest of the session.
 */
export interface ConsoleHandle {
  send(line: string): Promise<ConsoleSendResult>;
  /**
   * Close the socket if one was opened. Idempotent, and NOT the end of the console: a later line
   * opens a new session.
   *
   * Why a close cannot be final. The panel closes its console from an effect cleanup, and React's
   * dev-mode StrictMode runs that cleanup ONCE ON MOUNT. A handle that went permanently dead there
   * would answer "this console is closed" to every press in a dev build — found by browser QA on
   * 2026-10-12 (`npm run dev:desktop`), where the first press came back with exactly that sentence.
   * The property that matters is the one kept: a FAILED send never reconnects by itself.
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
      session = await client.open(target, CONSOLE_TIMING);
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
    async send(line: string): Promise<ConsoleSendResult> {
      // The guards first, and here rather than at the socket alone: a refused line must cost no
      // connection, which is only true if the refusal is decided before the session is opened.
      const problem = consoleProblem(line);
      if (problem !== null) return { kind: 'refused', line, detail: problem };

      const opened = await sessionFor(line);
      if (!opened.ok) return opened.result;

      let send: ConsoleSend;
      try {
        send = await opened.session.send(line, CONSOLE_TIMING);
      } catch (e) {
        // `tcpRead` rejects when the peer closed the connection, so a dead socket arrives here
        // rather than as an outcome. The session is kept: the next line reports the same thing, and
        // reconnecting by itself is the one thing this module does not do.
        return { kind: 'error', line, detail: reasonOf(e) };
      }
      if (send.ok) {
        return { kind: 'sent', line, text: send.text, frames: send.frames, elapsedMs: send.elapsedMs };
      }
      // The transport's own two reasons map one to one, so this is a narrowing rather than a table
      // that could miss one. (`refused` is unreachable here — the guard above already ran — and is
      // mapped rather than asserted away, so a divergence shows up as an answer, not a crash.)
      return send.reason === 'timeout'
        ? { kind: 'timeout', line, detail: send.detail, text: send.text }
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
