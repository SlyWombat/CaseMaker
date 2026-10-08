// The machine bridge — the desktop build's entry point to the Z1 (#255).
//
// DESKTOP ONLY. This file must NEVER appear in the web bundle. It is reached only through
// `loadMachineBridge()` in ../capabilities.ts, whose `await import()` sits behind the
// `canDriveMachine` guard. `tools/check-platform-gate.mjs` greps the default web build for
// DESKTOP_ONLY_MARKER and fails if it is found.
//
// It is the public surface #256's callers use: discover, identify, upload a verified program, read
// status. The protocol itself lives in `protocol.ts`; the sockets live behind `MachineTransport`.
//
// THE VERIFIED-ONLY RULE (Fabrication.md §5.7, #174, #206). Nothing reaches the machine that has
// not passed the verifier. That is enforced by the TYPE here, not merely documented: the upload
// entry point takes a `VerifiedProgram`, which only `asVerifiedProgram` produces, and it re-checks
// the report at runtime before opening a socket. There is no "send anyway" path and no flag to add
// one. If a caller ever needs to bypass this, the answer is to fix what the verifier found.
//
// The rule itself is stated once, in `engine/cnc/uploadGate.ts`, because the web-side upload client
// asks the same question before it reaches for this module and the two answers must not drift.

import type { VerifyReport } from '@/engine/cnc/verify';
import { programUploadProblem } from '@/engine/cnc/uploadGate';
import {
  COMMAND_TCP_PORT,
  DISCOVERY_UDP_PORT,
  GCODE_DIR,
  readConfigKey,
  runDiscovery,
  runIdentify,
  runStatus,
  runUpload,
  uploadPath,
  type DiscoveredMachine,
  type MachineIdentity,
  type MachineStatus,
  type MachineTransport,
  type UploadOutcome,
} from './protocol';
import { tauriTransport } from './transport';

export const DESKTOP_ONLY_MARKER = 'casemaker-desktop-bridge-v1';

export type {
  DiscoveredMachine,
  MachineIdentity,
  MachineStatus,
  MachineTransport,
  UploadOutcome,
} from './protocol';

/** Where to reach a machine: an IP (from discovery or typed) and, optionally, a non-default port. */
export interface MachineTarget {
  host: string;
  /** The TCP command port. Defaults to 2222 (Z1-Bridge-Protocol.md §1). */
  port?: number;
}

/** Common options. `transport` is the USB seam and the test seam; production uses the sockets. */
export interface BridgeOptions {
  transport?: MachineTransport;
  /** TCP connect timeout. Defaults to 3000 ms. */
  connectTimeoutMs?: number;
}

/**
 * A program that has passed the verifier (#174), bound to the exact bytes and filename that were
 * verified. Make one with {@link asVerifiedProgram}; there is no other constructor on purpose.
 *
 * Residual gap, stated honestly: the verifier's report carries no content hash, so this type binds
 * the bytes at the moment of gating but cannot re-prove that they are the bytes the report
 * describes. A caller that mutates `content` after gating defeats it. The report is the artefact
 * check (#174: "a check one level removed from the assertion is not evidence"), and this type is
 * the seam that keeps the check attached to the upload.
 */
export interface VerifiedProgram {
  readonly filename: string;
  readonly content: Uint8Array;
  readonly report: VerifyReport;
}

/**
 * Gate a program for upload. Returns null — never a partial object — when the report is not `ok`,
 * carries any error finding, or the filename is not a `.nc`.
 *
 * The clauses themselves are `programUploadProblem`'s (`engine/cnc/uploadGate.ts`), which the
 * web-side upload client asks too — so "the app will not send this" and "this type refuses it" are
 * one decision rather than two that happen to agree today.
 */
export function asVerifiedProgram(
  filename: string,
  content: Uint8Array,
  report: VerifyReport,
): VerifiedProgram | null {
  if (programUploadProblem(filename, report) !== null) return null;
  return { filename, content, report };
}

function transportOf(opts: BridgeOptions): MachineTransport {
  return opts.transport ?? tauriTransport;
}

/** Listen for the machine's UDP broadcast for `opts.windowMs` (default 3000) and return it. */
export async function discover(
  opts: BridgeOptions & { port?: number; windowMs?: number } = {},
): Promise<DiscoveredMachine[]> {
  const transport = transportOf(opts);
  return runDiscovery(transport, {
    port: opts.port ?? DISCOVERY_UDP_PORT,
    windowMs: opts.windowMs,
  });
}

/** Connect, ask `M482.5`/`M482.4`, and report which machine answered. */
export async function identify(
  target: MachineTarget,
  opts: BridgeOptions & { windowMs?: number } = {},
): Promise<MachineIdentity> {
  const transport = transportOf(opts);
  const conn = await transport.tcpConnect(target.host, target.port ?? COMMAND_TCP_PORT, opts.connectTimeoutMs ?? 3000);
  try {
    return await runIdentify(transport, conn, target.host, { windowMs: opts.windowMs });
  } finally {
    await closeQuietly(transport, conn);
  }
}

/** Connect, send `?`, and report the controller's status line verbatim. */
export async function status(
  target: MachineTarget,
  opts: BridgeOptions & { windowMs?: number } = {},
): Promise<MachineStatus> {
  const transport = transportOf(opts);
  const conn = await transport.tcpConnect(target.host, target.port ?? COMMAND_TCP_PORT, opts.connectTimeoutMs ?? 3000);
  try {
    return await runStatus(transport, conn, { windowMs: opts.windowMs });
  } finally {
    await closeQuietly(transport, conn);
  }
}

/** What one configuration key answered. `value` is the controller's text, verbatim. */
export interface ConfigReadOutcome {
  key: string;
  ok: boolean;
  /** The controller's own text (`"-190.89"`, `"true"`), or null when it did not answer. */
  value: string | null;
  /** `not-in-config` / `bad-request` / `timeout`, or `''` when it answered. */
  reason: string;
  detail: string;
}

/**
 * Read configuration keys from the machine's own `/sd/config.txt` (#279).
 *
 * The app's own path to `config-get`, added because #279 needs it and the app could not previously
 * reach it at all: `readConfigKey` existed in `protocol.ts` and was exercised by the bench harness,
 * which imports the protocol module directly — but the BRIDGE never exposed it, so nothing in the
 * app could ask a machine about its own frame.
 *
 * ONE connection for the whole list, one `config-get sd <key>` per key, in order — the shape
 * `tools/z1/z1.mjs config` uses, and the reason this takes a list rather than being called once per
 * key: a calibration is fourteen keys, and fourteen connects would make the check unusable.
 *
 * `source` defaults to `sd`, NOT the one-argument effective form. On this build the merged cache
 * answers `not in config` for keys `sd` reads correctly (measured 2026-10-06, Z1-Bridge-Protocol
 * §5), so the effective form would silently produce an incomplete read.
 *
 * A key that did not answer is returned as a refusal with its reason rather than omitted, so the
 * caller can say WHICH key stopped the read — an absent key and an unread key look identical in a
 * record with holes in it.
 */
export async function readConfigValues(
  target: MachineTarget,
  keys: readonly string[],
  opts: BridgeOptions & { source?: string; windowMs?: number } = {},
): Promise<ConfigReadOutcome[]> {
  const transport = transportOf(opts);
  const conn = await transport.tcpConnect(target.host, target.port ?? COMMAND_TCP_PORT, opts.connectTimeoutMs ?? 3000);
  try {
    const out: ConfigReadOutcome[] = [];
    for (const key of keys) {
      const r = await readConfigKey(transport, conn, key, {
        source: opts.source ?? 'sd',
        windowMs: opts.windowMs,
      });
      out.push(
        r.ok
          ? { key, ok: true, value: r.value, reason: '', detail: '' }
          : { key, ok: false, value: null, reason: r.reason, detail: r.detail },
      );
    }
    return out;
  } finally {
    await closeQuietly(transport, conn);
  }
}

/**
 * Upload a verified `.nc`. Refuses anything that is not a `VerifiedProgram` and re-checks the
 * report before touching the socket. A refusal from the machine is returned as a refusal.
 *
 * The line between the two refusals is deliberate, and it is about WHO decided. A program the
 * gate refuses was never uploaded — nothing was sent, and the answer is the gate's own sentence.
 * A program the MACHINE refuses was offered and declined, which is a fact about the machine and
 * comes back with the controller's own detail (`refused` / `timeout` / `error`).
 *
 * The program lands at `<directory>/<filename>`, defaulting to the machine's own job directory.
 * See {@link GCODE_DIR} for why that is measured rather than assumed.
 */
export async function uploadVerifiedProgram(
  target: MachineTarget,
  program: VerifiedProgram,
  opts: BridgeOptions & { packetSize?: number; inactivityMs?: number; directory?: string } = {},
): Promise<UploadOutcome> {
  // The null guards are for a caller that reached us from plain JS: the type says `VerifiedProgram`
  // and cannot be, but `program.report` is read below and a crash here would be an unhandled
  // rejection rather than the refusal this function promises.
  if (program === null || program === undefined || program.report === null || program.report === undefined) {
    return { ok: false, reason: 'error', detail: 'refused: the program has not passed the verifier' };
  }
  const problem = programUploadProblem(program.filename, program.report);
  if (problem !== null) {
    return { ok: false, reason: 'error', detail: `refused: ${problem}` };
  }

  // `program.filename` is the name the verifier saw; the machine needs a PATH. The directory is a
  // parameter with a measured default rather than a constant baked in, because which directory a
  // given machine wants is a fact about that machine — but the default is the one Studio itself
  // uses, and the one the first live upload was accepted into.
  const destination = uploadPath(opts.directory ?? GCODE_DIR, program.filename);

  const transport = transportOf(opts);
  const conn = await transport.tcpConnect(target.host, target.port ?? COMMAND_TCP_PORT, opts.connectTimeoutMs ?? 3000);
  try {
    return await runUpload(transport, conn, destination, program.content, {
      packetSize: opts.packetSize,
      inactivityMs: opts.inactivityMs,
    });
  } finally {
    await closeQuietly(transport, conn);
  }
}

async function closeQuietly(transport: MachineTransport, conn: number): Promise<void> {
  try {
    await transport.tcpClose(conn);
  } catch {
    // Closing an already-dead socket is not a failure worth surfacing over the real outcome.
  }
}
