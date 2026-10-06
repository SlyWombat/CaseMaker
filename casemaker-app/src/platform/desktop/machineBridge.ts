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

import type { VerifyReport } from '@/engine/cnc/verify';
import {
  COMMAND_TCP_PORT,
  DISCOVERY_UDP_PORT,
  runDiscovery,
  runIdentify,
  runStatus,
  runUpload,
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
 * carries any error finding, or the filename is not a `.nc`. The runtime check mirrors the type so
 * a forged object cannot slip past the upload entry point either.
 */
export function asVerifiedProgram(
  filename: string,
  content: Uint8Array,
  report: VerifyReport,
): VerifiedProgram | null {
  if (!report.ok) return null;
  if (report.findings.some((finding) => finding.severity === 'error')) return null;
  if (!/\.nc$/i.test(filename)) return null;
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

/**
 * Upload a verified `.nc`. Refuses anything that is not a `VerifiedProgram` and re-checks the
 * report before touching the socket. A refusal from the machine is returned as a refusal.
 */
export async function uploadVerifiedProgram(
  target: MachineTarget,
  program: VerifiedProgram,
  opts: BridgeOptions & { packetSize?: number; inactivityMs?: number } = {},
): Promise<UploadOutcome> {
  if (
    program === null ||
    program === undefined ||
    program.report === null ||
    program.report === undefined ||
    !program.report.ok ||
    program.report.findings.some((finding) => finding.severity === 'error')
  ) {
    return { ok: false, reason: 'error', detail: 'refused: the program has not passed the verifier' };
  }
  if (!/\.nc$/i.test(program.filename)) {
    return { ok: false, reason: 'error', detail: `refused: '${program.filename}' is not a .nc program` };
  }

  const transport = transportOf(opts);
  const conn = await transport.tcpConnect(target.host, target.port ?? COMMAND_TCP_PORT, opts.connectTimeoutMs ?? 3000);
  try {
    return await runUpload(transport, conn, program.filename, program.content, {
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
