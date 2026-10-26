/**
 * Taking a verified program to the machine (issue #255) — the UI-side half of the upload.
 *
 * `machineProbe.ts` is this module's sibling and its shape is copied on purpose. The bridge
 * (`platform/desktop/machineBridge.ts`) can already upload a program, but it is desktop-only and
 * reaches a raw socket, and the engrave panel has to be able to ASK for an upload and render an
 * honest answer in either build. So: the same seam. A swappable client for tests, the real one
 * behind `loadMachineBridge()`, and a result union instead of a thrown exception — a failed upload
 * is a page in the audit trail, not a crash.
 *
 * WHY THE GATE IS ASKED HERE AS WELL. `uploadVerifiedProgram` re-checks the report before it opens
 * a socket, and that stays the authority. This module asks the same question — the same
 * `programUploadProblem` predicate, not a copy of its clauses — one step earlier, so a program that
 * cannot be uploaded is refused with a sentence and WITHOUT the bridge being loaded. The caller
 * sees "this is not uploadable" rather than "the upload failed", and no socket is opened to
 * discover something the app already knew.
 *
 * WHAT THIS MODULE DOES NOT DO. It sends a file and reports what the controller said. It does not
 * start a job, jog an axis, or open a DRO — the first pass on #255 excludes all of those, and
 * `Z1-Bridge-Protocol.md` §8 says why: motion arrives with a file that has passed the verifier, and
 * this is the file, not the motion.
 *
 * THE TEST SEAM. `setMachineUploadLoader` swaps the client, matching `setMachineProbeLoader` and
 * `setRasterDecodeLoader`. Everything below the loader — the gate, the encoding, the mapping from
 * the transport's outcome to ours — is the real code in every test. Only the socket is faked,
 * because a socket is the one thing a unit test cannot have.
 */

import { programUploadProblem, type ProgramCheck } from '@/engine/cnc/uploadGate';
import { loadMachineBridge } from './capabilities';
import { liveShopDefaults, machineTiming } from './defaultsClient';

/** Where to reach the machine. Always both: an observation carries the port it was reached on. */
export interface MachineUploadTarget {
  host: string;
  port: number;
}

/**
 * What the transport reported. **This is the bridge's `UploadOutcome` restated**, for the reason
 * `machineProbe.ts` restates `DiscoveredMachine` and `MachineStatus`: importing the type would pull
 * `platform/desktop/protocol.ts` into the web bundle, which is the leak `capabilities.ts` exists to
 * prevent. `machineUpload.spec.ts` keeps the two in step by construction — the real client's return
 * type is checked against this one, so a change on either side is a type error rather than a
 * silently wrong field.
 */
export type UploadAttempt =
  | { ok: true; bytes: number; packets: number; alreadyPresent: boolean }
  | { ok: false; reason: 'refused' | 'timeout' | 'error'; detail: string };

/**
 * The controller's answer to `?`, restated for the same reason {@link UploadAttempt} is: the bridge's
 * `MachineStatus` cannot be imported here without pulling the desktop protocol into the web bundle.
 */
export interface MachineStatusReading {
  ok: boolean;
  text: string | null;
}

/**
 * The controller's state word from a status line — `Idle` from `<Idle|MPos:…>` — or null when the
 * text does not look like one. The leading `<` and the `|` or `>` after the word are the shape that
 * was read off the machine (`docs/bench/2026-10-bench-day-1.md`); anything else is "unknown", and
 * unknown is never read as idle.
 */
export function controllerState(text: string | null): string | null {
  if (text === null) return null;
  const m = /^\s*<\s*([A-Za-z]+)\s*[|>]/m.exec(text);
  return m === null ? null : (m[1] ?? null);
}

/**
 * The controller's `P:` progress percent from a status line — 100 at the end of a program, a smaller
 * number while one runs — or null when the line carries no `P:` field at all (which is what an idle
 * machine outside a job answers). `P:` is `line,percent,seconds`; only the percent is read here.
 *
 * WHY THIS EXISTS BESIDE {@link controllerState} AND NOT AS A SECOND PARSER ELSEWHERE. The state word
 * alone cannot say whether a program is running: the machine reads `Idle` MID-JOB, for the ~4 s
 * spin-down at `M05` before the head goes home (`docs/bench/traces/2026-10-12-poll*.log`,
 * `Z1-Bridge-Protocol.md` §6), so a caller that gates on `Idle` alone lets a command in during the one
 * window where a program still owns the machine (#390). The field that answers it is `P:`, and this is
 * that field read off the same line, in the same module, as the state word — one parser for a status
 * line, not two.
 *
 * **`readJobProgress`'s percent, restated web-safe** (`platform/desktop/protocol.ts`), for the reason
 * {@link MachineStatusReading} restates `MachineStatus`: importing it would pull the desktop bridge
 * into the web bundle. `machineUpload.spec.ts` keeps the two in step by running both over one table of
 * real status lines, so a divergence is a failing test rather than a silently wrong gate.
 */
export function jobProgressPercent(text: string | null): number | null {
  if (text === null) return null;
  const m = /(?:^|\|)P:([^|>]*)/.exec(text);
  if (m === null) return null;
  const raw = (m[1] as string).split(',')[1]?.trim();
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/** The dialect's own words for an alarm — `protocol.ts`'s constant, restated with the reader above. */
const ALARM_WORDS = /\bALARM\b|Probe fail|error:/i;

/**
 * The controller's own alarm line from a status text, or null — **`protocol.ts`'s `alarmLine`,
 * restated web-safe**, for the reason {@link jobProgressPercent} restates `readJobProgress`, and kept
 * in step the same way (`machineUpload.spec.ts` runs both over one table of the 2026-10-12 trace's
 * own lines). The first line that carries the dialect's alarm words is returned verbatim.
 *
 * WHY A DECISION NEEDS THIS AND NOT JUST THE STATE WORD. `controllerState` reads the state word at the
 * front of a status line, and an alarm is not always there: the trace shows it arriving as its own
 * line, `ALARM: Probe fail`, beside a reply that reads perfectly `Idle` (the two halves of one
 * exchange), and a frame that arrived with no line in flight carries the same words (#386 item 3).
 * A gate asking "may I send this now?" has to act on the alarm whichever of those it came in.
 */
export function alarmLine(text: string | null): string | null {
  if (text === null) return null;
  for (const line of text.split(/\r?\n/)) {
    if (ALARM_WORDS.test(line)) return line.trim();
  }
  return null;
}

/** The socket-facing half of the upload: one status read, one transfer. */
export interface MachineUploadClient {
  /**
   * Ask the machine what it is doing NOW (#296). Required, not optional: a client with no way to
   * ask would make the idle check silently skip, which is the stale-memory gate it replaces.
   */
  status(target: MachineUploadTarget): Promise<MachineStatusReading>;
  upload(
    target: MachineUploadTarget,
    /** The program as it will be sent: bytes, and the check that gated them. */
    program: { filename: string; content: Uint8Array; check: ProgramCheck },
  ): Promise<UploadAttempt>;
}

/**
 * What one upload did. Six answers, and the split between them is the useful part:
 *
 *   - `uploaded` — the machine took the file. `alreadyPresent` means it declined the transfer
 *     because it already held an identical file (the MD5 step matched), which is a success with a
 *     different sentence, not a failure.
 *   - `refused` — the machine was offered the file and declined it. A result about the machine.
 *   - `busy` — nothing was sent: the machine, asked just now, did not say it was idle (#296). Three
 *     answers land here and `detail` says which: a state word that is not `Idle`, an `Idle` line whose
 *     `P:` percent says a job is still running (#390), or a controller that is in an alarm.
 *   - `timeout` / `error` — the socket failed, or the exchange went somewhere the protocol does not
 *     allow. A result about the network.
 *   - `unavailable` — nothing was attempted, because this build cannot reach a machine at all.
 *
 * `filename` is carried on every one of them, including `unavailable`: the answer is about a
 * specific file, and a caller that renders "the upload failed" without saying which program is
 * telling the operator less than it knows.
 */
export type MachineUploadResult =
  | { kind: 'uploaded'; filename: string; bytes: number; packets: number; alreadyPresent: boolean; status: string }
  | { kind: 'refused'; filename: string; detail: string }
  // The machine was asked just before the transfer and was not idle (#296). `status` is its line,
  // verbatim, so the panel can show what the controller said and refresh its stored observation.
  | { kind: 'busy'; filename: string; detail: string; status: string }
  | { kind: 'timeout'; filename: string; detail: string }
  | { kind: 'error'; filename: string; detail: string }
  | { kind: 'unavailable'; filename: string; reason: string };

/**
 * The program as the bytes the machine receives: UTF-8, which is what the `.nc` file holds on disk
 * too. Exported because the confirmation step needs the size it is about to send, and computing it
 * some other way would be a second answer to "how big is this program".
 */
export function programBytes(nc: string): Uint8Array {
  return new TextEncoder().encode(nc);
}

/** The real client: the bridge, reached only through the capability guard. */
async function loadRealClient(): Promise<MachineUploadClient> {
  const bridge = await loadMachineBridge();
  // The connect timeout and the upload's inactivity window are the shop's (#449), read at each call
  // from the section the store holds; with no location `protocol.ts` / `machineBridge.ts` answer
  // their labelled compiled fallbacks.
  const timing = () => machineTiming(liveShopDefaults());
  return {
    status: async (target) => {
      const reading = await bridge.status(target, { connectTimeoutMs: timing().connectTimeoutMs });
      return { ok: reading.ok, text: reading.text };
    },
    upload: async (target, program) => {
      const verified = bridge.asVerifiedProgram(program.filename, program.content, program.check);
      if (verified === null) {
        // Unreachable from `uploadProgram`, which asks the same question first. It stays because
        // this is the bridge's own constructor and it is ALLOWED to refuse: reporting its refusal
        // is better than asserting the invariant away with a cast, and if the two gates ever do
        // disagree, this is the line that makes it visible instead of sending the program anyway.
        return { ok: false, reason: 'error', detail: 'the program has not passed its check' };
      }
      const t = timing();
      return bridge.uploadVerifiedProgram(target, verified, {
        inactivityMs: t.uploadInactivityMs,
        connectTimeoutMs: t.connectTimeoutMs,
      });
    },
  };
}

let clientFactory: () => Promise<MachineUploadClient> = loadRealClient;

/** Swap the client. Vitest uses this; the app never calls it. `null` restores the real bridge. */
export function setMachineUploadLoader(fn: (() => Promise<MachineUploadClient>) | null): void {
  clientFactory = fn ?? loadRealClient;
}

function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Send a verified program to a machine. Never throws: every failure is one of the six outcomes,
 * because the panel has to render a failure as readily as a success.
 *
 * The order matters and is the point of the module: gate first, load the bridge second, connect
 * third. A program the verifier refused therefore costs no connection and produces a sentence that
 * names the reason.
 */
export async function uploadProgram(
  target: MachineUploadTarget,
  program: { filename: string; nc: string; check: ProgramCheck },
): Promise<MachineUploadResult> {
  const { filename } = program;
  const content = programBytes(program.nc);

  const problem = programUploadProblem(filename, program.check);
  if (problem !== null) return { kind: 'error', filename, detail: problem };

  let client: MachineUploadClient;
  try {
    client = await clientFactory();
  } catch (e) {
    // The web build's answer, and the reason is the guard's own sentence rather than a generic one.
    return { kind: 'unavailable', filename, reason: reasonOf(e) };
  }

  // Ask the machine what it is doing NOW (#296). The wizard's record of `busy` can be days old, and
  // a write to `/sd/gcodes/` while the controller is reading that file is the one thing here that
  // could disturb a cut. Only an explicit Idle passes: busy, silence and an unreadable line all
  // refuse, because "I could not tell" is not permission.
  let reading: MachineStatusReading;
  try {
    reading = await client.status(target);
  } catch (e) {
    return { kind: 'error', filename, detail: `could not confirm the machine is idle before writing: ${reasonOf(e)}` };
  }
  if (!reading.ok || reading.text === null) {
    return { kind: 'error', filename, detail: 'could not confirm the machine is idle before writing: it did not answer a status request' };
  }
  // AN ALARM OUTRANKS THE STATE WORD, and it is asked first because it is the more specific
  // statement: a controller that has locked itself (`ALARM: Probe fail`, `error:Alarm lock`) may well
  // report `Idle`, and writing to its card is not a thing to do while it is in that state. Checked
  // over the whole text rather than the state word alone — the 2026-10-12 trace's alarm is its own
  // line beside an ordinary status line — and the sentence quotes the machine's own words, because
  // "clear it at the machine first" is only honest once the person can see WHICH alarm it is.
  const alarm = alarmLine(reading.text);
  if (alarm !== null) {
    return {
      kind: 'busy',
      filename,
      detail: `the controller is in an alarm (\`${alarm}\`), so nothing was sent — clear it at the machine first`,
      status: reading.text,
    };
  }
  const state = controllerState(reading.text);
  if (state === null) {
    return { kind: 'error', filename, detail: `could not confirm the machine is idle before writing: its status line was not readable (${reading.text})` };
  }
  if (state.toLowerCase() !== 'idle') {
    return { kind: 'busy', filename, detail: `it reports ${state} rather than Idle, so nothing was sent`, status: reading.text };
  }

  // IDLE IS NOT ENOUGH, and this is the window the state word hides (#390). The Z1 reads `Idle`
  // MID-JOB — for the ~4 s spin-down at `M05`, before the head goes home — so a line like
  // `<Idle|…|S:11988.6…|P:29,74,42>` passes the test above while a program still owns the machine
  // (`Z1-Bridge-Protocol.md` §6, traces `docs/bench/traces/2026-10-12-poll*.log`). `P:` is present
  // only while a program is running, so a percent below 100 means one is, whatever the state word
  // says. Writing to `/sd/gcodes/` in that window is the very thing this check exists to avoid, so
  // the state word cannot be the whole gate.
  const percent = jobProgressPercent(reading.text);
  if (percent !== null && percent < 100) {
    return {
      kind: 'busy',
      filename,
      detail: `it reports Idle, but its status line says a program is ${percent}% through — writing to the card now could disturb it, so nothing was sent`,
      status: reading.text,
    };
  }

  let attempt: UploadAttempt;
  try {
    attempt = await client.upload(target, { filename, content, check: program.check });
  } catch (e) {
    return { kind: 'error', filename, detail: reasonOf(e) };
  }

  if (attempt.ok) {
    return {
      kind: 'uploaded',
      filename,
      bytes: attempt.bytes,
      packets: attempt.packets,
      alreadyPresent: attempt.alreadyPresent,
      // The idle line that let the transfer start, so the caller can refresh what it remembers.
      status: reading.text,
    };
  }
  // The transport's own three reasons are ours too, so the mapping is the reason itself rather
  // than a table that could miss one.
  return { kind: attempt.reason, filename, detail: attempt.detail };
}
