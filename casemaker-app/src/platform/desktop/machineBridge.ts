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

import { programUploadProblem, type ProgramCheck } from '@/engine/cnc/uploadGate';
import { quicklzCompress } from './quicklz';
import {
  COMMAND_TCP_PORT,
  DISCOVERY_UDP_PORT,
  GCODE_DIR,
  consoleProblem,
  openConsole,
  readConfigKey,
  runDeleteSd,
  runDiscovery,
  runListSd,
  runIdentify,
  runStatus,
  runUpload,
  uploadPath,
  type ConsoleOptions,
  type ConsoleOutcome,
  type DiscoveredMachine,
  type MachineIdentity,
  type MachineStatus,
  type MachineTransport,
  type SdDeleteOutcome,
  type SdListOutcome,
  type UploadOutcome,
} from './protocol';
import { tauriTransport } from './transport';
import { httpTransport } from './httpTransport';

export const DESKTOP_ONLY_MARKER = 'casemaker-desktop-bridge-v1';

export { consoleProblem } from './protocol';
export type {
  ConsoleOptions,
  ConsoleOutcome,
  DiscoveredMachine,
  MachineIdentity,
  MachineStatus,
  MachineTransport,
  SdDeleteOutcome,
  SdEntry,
  SdListOutcome,
  UploadOutcome,
} from './protocol';

/** Where to reach a machine: an IP (from discovery or typed) and, optionally, a non-default port. */
export interface MachineTarget {
  host: string;
  /** The TCP command port. Defaults to 2222 (Z1-Bridge-Protocol.md §1). */
  port?: number;
}

/**
 * The TCP connect timeout, ms — the labelled NO-SERVICE FALLBACK of the shop's
 * `machine.connectTimeoutMs` (#449). Every connect in this file uses it when the caller passes none;
 * the web-side wrappers pass the number they read from the location.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 3000;

/** Common options. `transport` is the USB seam and the test seam; production uses the sockets. */
export interface BridgeOptions {
  transport?: MachineTransport;
  /** TCP connect timeout. Defaults to {@link DEFAULT_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
}

/**
 * A program that has passed its check (#174), bound to the exact bytes and filename that were
 * checked. Make one with {@link asVerifiedProgram}; there is no other constructor on purpose.
 *
 * The check is the verifier's report, or — for a 3D goal program the exact verifier cannot judge —
 * the material sweep's surface check (#535). It is never absent: the union type has no null arm.
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
  readonly check: ProgramCheck;
}

/**
 * Gate a program for upload. Returns null — never a partial object — when its check refuses it (a
 * verifier report that is not `ok` or carries an error finding) or the filename is not a `.nc`.
 *
 * The clauses themselves are `programUploadProblem`'s (`engine/cnc/uploadGate.ts`), which the
 * web-side upload client asks too — so "the app will not send this" and "this type refuses it" are
 * one decision rather than two that happen to agree today.
 */
export function asVerifiedProgram(
  filename: string,
  content: Uint8Array,
  check: ProgramCheck,
): VerifiedProgram | null {
  if (programUploadProblem(filename, check) !== null) return null;
  return { filename, content, check };
}

/**
 * The default transport (#571). This desktop bundle runs in two places: the shell's own webview,
 * where Tauri IPC is present, and a LAN browser that the embedded HTTP server served the same bundle
 * to, where it is NOT — there `invoke` would throw. `globalThis.isTauri` is the flag the Tauri v2
 * runtime sets (and what `@tauri-apps/api`'s own `isTauri()` reads); its absence is exactly the
 * browser case, which uses the server's HTTP machine API instead. This is the runtime probe #181's
 * note said to add "only alongside a real consumer that needs it" — #571 is that consumer. It reads
 * the documented `isTauri` flag, not the internals object #181 migrated the app off.
 */
export function defaultTransport(): MachineTransport {
  const hasTauri = !!(globalThis as { isTauri?: unknown }).isTauri;
  return hasTauri ? tauriTransport : httpTransport;
}

function transportOf(opts: BridgeOptions): MachineTransport {
  return opts.transport ?? defaultTransport();
}

/** Listen for the machine's UDP broadcast for `opts.windowMs` (the protocol's fallback 3000 ms) and return it. */
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
  const conn = await transport.tcpConnect(target.host, target.port ?? COMMAND_TCP_PORT, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
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
  const conn = await transport.tcpConnect(target.host, target.port ?? COMMAND_TCP_PORT, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  try {
    return await runStatus(transport, conn, { windowMs: opts.windowMs });
  } finally {
    await closeQuietly(transport, conn);
  }
}

/**
 * List a directory on the machine's card (#772) — the controller's own `ls -e -s`, over the
 * machine channel. One connection, one command, closed again.
 */
export async function listSdFiles(
  target: MachineTarget,
  opts: BridgeOptions & { directory?: string; windowMs?: number } = {},
): Promise<SdListOutcome> {
  const transport = transportOf(opts);
  const conn = await transport.tcpConnect(target.host, target.port ?? COMMAND_TCP_PORT, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  try {
    return await runListSd(transport, conn, opts.directory ?? GCODE_DIR, { windowMs: opts.windowMs });
  } finally {
    await closeQuietly(transport, conn);
  }
}

/**
 * Delete one file from the machine's card (#772) — the controller's own `rm <file> -e`. The
 * caller's rule about WHICH files may be deleted lives above this seam; this sends what it is
 * given.
 */
export async function deleteSdFile(
  target: MachineTarget,
  path: string,
  opts: BridgeOptions & { windowMs?: number } = {},
): Promise<SdDeleteOutcome> {
  const transport = transportOf(opts);
  const conn = await transport.tcpConnect(target.host, target.port ?? COMMAND_TCP_PORT, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  try {
    return await runDeleteSd(transport, conn, path, { windowMs: opts.windowMs });
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
  const conn = await transport.tcpConnect(target.host, target.port ?? COMMAND_TCP_PORT, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
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
/**
 * #562 — the size above which Studio compresses an upload (RE 05: `size > 0x1000`, and the config's
 * type is `lz`). Below it, or with compression switched off, the plain file goes as it always has.
 */
export const QUICKLZ_UPLOAD_THRESHOLD = 4096;

export async function uploadVerifiedProgram(
  target: MachineTarget,
  program: VerifiedProgram,
  opts: BridgeOptions & {
    packetSize?: number;
    inactivityMs?: number;
    directory?: string;
    /**
     * #562 — `quicklz` compresses a program over {@link QUICKLZ_UPLOAD_THRESHOLD} and uploads it as
     * `<name>.bin`; `plain` (the default) never does. The caller reads the location's
     * `machine.uploadCompression`, which is opt-in until the bench confirms the Z1 decompresses it.
     */
    compress?: 'plain' | 'quicklz';
  } = {},
): Promise<UploadOutcome> {
  // The null guards are for a caller that reached us from plain JS: the type says `VerifiedProgram`
  // and cannot be, but `program.check` is read below and a crash here would be an unhandled
  // rejection rather than the refusal this function promises.
  if (program === null || program === undefined || program.check === null || program.check === undefined) {
    return { ok: false, reason: 'error', detail: 'refused: the program has not passed its check' };
  }
  const problem = programUploadProblem(program.filename, program.check);
  if (problem !== null) {
    return { ok: false, reason: 'error', detail: `refused: ${problem}` };
  }

  // `program.filename` is the name the verifier saw; the machine needs a PATH. The directory is a
  // parameter with a measured default rather than a constant baked in, because which directory a
  // given machine wants is a fact about that machine — but the default is the one Studio itself
  // uses, and the one the first live upload was accepted into.
  const destination = uploadPath(opts.directory ?? GCODE_DIR, program.filename);

  const transport = transportOf(opts);
  const send = async (path: string, content: Uint8Array): Promise<UploadOutcome> => {
    const conn = await transport.tcpConnect(target.host, target.port ?? COMMAND_TCP_PORT, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    try {
      return await runUpload(transport, conn, path, content, {
        packetSize: opts.packetSize,
        inactivityMs: opts.inactivityMs,
      });
    } finally {
      await closeQuietly(transport, conn);
    }
  };

  // #562 — COMPRESSED, WHEN THE LOCATION ASKS FOR IT. Studio's form (RE 05): over 4 KB the payload
  // is QuickLZ level 1 and the destination gains a `.bin` suffix. The MD5 step inside `runUpload`
  // hashes the SAME bytes the machine stores — the compressed stream for this attempt — so the
  // machine's "I already hold this file" check compares like with like.
  const wanted = opts.compress === 'quicklz' && program.content.length > QUICKLZ_UPLOAD_THRESHOLD;
  const packed = wanted ? quicklzCompress(program.content) : null;
  if (packed === null) return send(destination, program.content);

  const first = await send(`${destination}.bin`, packed);
  if (first.ok) return { ...first, compressed: true };
  // NOT EVERY CONTROLLER SPEAKS IT, and a refused `.bin` must not cost the operator the upload:
  // the same program goes plain, and the answer says which was accepted. Only a REFUSAL retries —
  // a timeout or a socket error is a fact about the connection, and doubling the wait would not
  // change what the controller can read.
  if (first.reason !== 'refused') return first;
  const note = `the compressed upload (${program.filename}.bin) was refused — ${first.detail}`;
  const plain = await send(destination, program.content);
  return plain.ok ? { ...plain, fallback: note } : { ...plain, detail: `${plain.detail} (${note})` };
}

/**
 * Send ONE typed line to the machine's console and return what it said (#302).
 *
 * The caller is asking for exactly this line, now — there is no queue and no repeat — and the guards
 * (`consoleProblem`) run before a socket is opened, so a refused line costs no connection. A caller
 * with several lines to send in order, such as an interactive console, keeps a connection with
 * {@link openConsoleSession} so replies that straddle two lines are not lost; this is the one-shot
 * form, and it is what one press of an app's Send button gets.
 *
 * Motion needs a person at the machine (`/Fabrication.md` §8). That is the caller's to establish and
 * is not something this function can check.
 */
export async function sendConsoleLine(
  target: MachineTarget,
  line: string,
  opts: BridgeOptions & ConsoleOptions = {},
): Promise<ConsoleOutcome> {
  const problem = consoleProblem(line);
  if (problem !== null) return { ok: false, reason: 'refused', line, detail: problem, text: '' };
  const transport = transportOf(opts);
  const conn = await transport.tcpConnect(target.host, target.port ?? COMMAND_TCP_PORT, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  try {
    return await openConsole(transport, conn).send(line, opts);
  } finally {
    await closeQuietly(transport, conn);
  }
}

/**
 * A console on ONE connection, open until {@link LiveConsole.close} (#302 item 4).
 *
 * The app's panel uses this rather than `sendConsoleLine` per line: a connection per line is a
 * connect/close per line, and — the reason `openConsole` exists at all — a reply that straddles two
 * lines is attributed to the later one. One session, one connection, one frame channel.
 */
export interface LiveConsole {
  send(line: string, opts?: ConsoleOptions): Promise<ConsoleOutcome>;
  /** Close the socket. Idempotent, and safe after a failed send: closing a dead socket is not a failure. */
  close(): Promise<void>;
}

/**
 * Open a console session against `target`. The socket is connected HERE, once; nothing is sent by
 * opening it, so a caller can hold a session open while the person decides what to type.
 */
export async function openConsoleSession(
  target: MachineTarget,
  opts: BridgeOptions = {},
): Promise<LiveConsole> {
  const transport = transportOf(opts);
  const conn = await transport.tcpConnect(target.host, target.port ?? COMMAND_TCP_PORT, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  const session = openConsole(transport, conn);
  return {
    send: (line, sendOpts) => session.send(line, sendOpts),
    close: () => closeQuietly(transport, conn),
  };
}

async function closeQuietly(transport: MachineTransport, conn: number): Promise<void> {
  try {
    await transport.tcpClose(conn);
  } catch {
    // Closing an already-dead socket is not a failure worth surfacing over the real outcome.
  }
}
