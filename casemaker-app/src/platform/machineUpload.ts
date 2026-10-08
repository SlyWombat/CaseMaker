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

import type { VerifyReport } from '@/engine/cnc/verify';
import { programUploadProblem } from '@/engine/cnc/uploadGate';
import { loadMachineBridge } from './capabilities';

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

/** The socket-facing half of the upload: one status read, one transfer. */
export interface MachineUploadClient {
  /**
   * Ask the machine what it is doing NOW (#296). Required, not optional: a client with no way to
   * ask would make the idle check silently skip, which is the stale-memory gate it replaces.
   */
  status(target: MachineUploadTarget): Promise<MachineStatusReading>;
  upload(
    target: MachineUploadTarget,
    /** The program as it will be sent: bytes, and the report that gated them. */
    program: { filename: string; content: Uint8Array; report: VerifyReport },
  ): Promise<UploadAttempt>;
}

/**
 * What one upload did. Six answers, and the split between them is the useful part:
 *
 *   - `uploaded` — the machine took the file. `alreadyPresent` means it declined the transfer
 *     because it already held an identical file (the MD5 step matched), which is a success with a
 *     different sentence, not a failure.
 *   - `refused` — the machine was offered the file and declined it. A result about the machine.
 *   - `busy` — nothing was sent: the machine, asked just now, did not say it was idle (#296).
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
  return {
    status: async (target) => {
      const reading = await bridge.status(target);
      return { ok: reading.ok, text: reading.text };
    },
    upload: async (target, program) => {
      const verified = bridge.asVerifiedProgram(program.filename, program.content, program.report);
      if (verified === null) {
        // Unreachable from `uploadProgram`, which asks the same question first. It stays because
        // this is the bridge's own constructor and it is ALLOWED to refuse: reporting its refusal
        // is better than asserting the invariant away with a cast, and if the two gates ever do
        // disagree, this is the line that makes it visible instead of sending the program anyway.
        return { ok: false, reason: 'error', detail: 'the program has not passed the verifier' };
      }
      return bridge.uploadVerifiedProgram(target, verified);
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
  program: { filename: string; nc: string; verify: VerifyReport },
): Promise<MachineUploadResult> {
  const { filename } = program;
  const content = programBytes(program.nc);

  const problem = programUploadProblem(filename, program.verify);
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
  const state = controllerState(reading.text);
  if (state === null) {
    return { kind: 'error', filename, detail: `could not confirm the machine is idle before writing: its status line was not readable (${reading.text})` };
  }
  if (state.toLowerCase() !== 'idle') {
    return { kind: 'busy', filename, detail: `it reports ${state} rather than Idle, so nothing was sent`, status: reading.text };
  }

  let attempt: UploadAttempt;
  try {
    attempt = await client.upload(target, { filename, content, report: program.verify });
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
