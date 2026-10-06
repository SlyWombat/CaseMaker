// The Z1 network protocol — pure codecs and the discover/identify/upload/status state machines.
//
// DESKTOP ONLY. This module is reached only through `machineBridge.ts`, itself reached only through
// `loadMachineBridge()`'s `canDriveMachine` guard (#181). It must never enter the web bundle.
//
// It is written from `/Z1-Bridge-Protocol.md`, which is the written description of the protocol
// produced before this implementation existed. Do not add a fact here that is not in that document
// (or add it there first): the description is the contract, and it exists because the vendor's
// client is GPL-3.0 and ours is Apache-2.0.
//
// NO SOCKETS HERE. Sockets live behind `MachineTransport`, implemented by Tauri commands in
// `src-tauri/src/machine.rs`. Keeping the bytes at arm's length is what lets the whole protocol be
// unit-tested against scripted machine replies, with no machine and no desktop build.

// ---------------------------------------------------------------------------
// Constants (Z1-Bridge-Protocol.md §1–§5)
// ---------------------------------------------------------------------------

export const DISCOVERY_UDP_PORT = 3333;
export const COMMAND_TCP_PORT = 2222;
/** File-transfer packet size on the WiFi transport (128 on USB). */
export const WIFI_PACKET_SIZE = 8192;

export const FRAME_HEADER = 0x8668;
export const FRAME_FOOTER = 0x55aa;

export const PTYPE_CTRL_SINGLE = 0xa1;
export const PTYPE_CTRL_MULTI = 0xa2;
export const PTYPE_FILE_START = 0xb0;
export const PTYPE_FILE_MD5 = 0xb1;
export const PTYPE_FILE_VIEW = 0xb2;
export const PTYPE_FILE_DATA = 0xb3;
export const PTYPE_FILE_END = 0xb4;
export const PTYPE_FILE_CANCEL = 0xb5;
export const PTYPE_FILE_RETRY = 0xb6;

/** The `?` status poll, as a single-byte control payload. */
export const STATUS_POLL_BYTE = 0x3f;

// ---------------------------------------------------------------------------
// The transport seam (§7)
// ---------------------------------------------------------------------------

/**
 * Five calls, no framing. Implemented today by Tauri commands over raw sockets; USB can be a second
 * implementation without anything above changing.
 *
 * `tcpRead` returns the bytes available within `timeoutMs` (an empty array on timeout) and rejects
 * if the peer closed the connection, so a caller can tell "nothing yet" from "gone".
 */
export interface MachineTransport {
  udpListen(port: number, windowMs: number): Promise<string[]>;
  tcpConnect(host: string, port: number, timeoutMs: number): Promise<number>;
  tcpWrite(conn: number, data: Uint8Array): Promise<void>;
  tcpRead(conn: number, max: number, timeoutMs: number): Promise<Uint8Array>;
  tcpClose(conn: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// CRC16-CCITT (§3)
// ---------------------------------------------------------------------------

/** CRC-16/CCITT, polynomial 0x1021, initial value 0, no final XOR. */
export function crc16Ccitt(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data[i] ?? 0) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

// ---------------------------------------------------------------------------
// Frame codec (§3)
// ---------------------------------------------------------------------------

export interface Frame {
  type: number;
  data: Uint8Array;
}

/** A frame rejected by the decoder, with why. Surfaced for honest reporting, never silently ignored. */
export interface FrameError {
  reason: 'crc' | 'footer' | 'length';
}

/**
 * Encode one command/reply frame:
 * `0x8668 | length(BE, = 1 + N + 2) | type | data | crc(BE) | 0x55AA`.
 * The CRC covers `length + type + data` (header and footer excluded).
 */
export function encodeFrame(type: number, data: Uint8Array): Uint8Array {
  const length = 1 + data.length + 2;
  const crcInput = new Uint8Array(3 + data.length);
  crcInput[0] = (length >>> 8) & 0xff;
  crcInput[1] = length & 0xff;
  crcInput[2] = type & 0xff;
  crcInput.set(data, 3);
  const crc = crc16Ccitt(crcInput);

  const out = new Uint8Array(2 + 2 + 1 + data.length + 2 + 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, FRAME_HEADER);
  view.setUint16(2, length);
  out[4] = type & 0xff;
  out.set(data, 5);
  view.setUint16(5 + data.length, crc);
  view.setUint16(5 + data.length + 2, FRAME_FOOTER);
  return out;
}

/**
 * Incremental frame assembler. TCP has no message boundaries, so bytes arrive in arbitrary chunks;
 * `push` appends bytes and returns every complete, CRC-valid frame it can now extract.
 *
 * On garbage it drops one byte and re-scans for the next `0x8668`, so a single corrupt byte costs
 * one frame at most rather than the rest of the stream. `resyncs` counts those events so a caller
 * can report a noisy link instead of hiding it.
 */
export class FrameDecoder {
  private buffer: number[] = [];
  private resyncCount = 0;

  get resyncs(): number {
    return this.resyncCount;
  }

  push(chunk: Uint8Array): Frame[] {
    for (let i = 0; i < chunk.length; i++) this.buffer.push(chunk[i] ?? 0);
    const frames: Frame[] = [];
    for (;;) {
      const start = this.findHeader();
      if (start < 0) {
        // No header anywhere. Keep a trailing 0x86 in case the next chunk completes it.
        const keep = this.buffer.length > 0 && this.buffer[this.buffer.length - 1] === 0x86 ? 1 : 0;
        if (this.buffer.length > keep) this.resyncCount++;
        this.buffer = keep === 1 ? [0x86] : [];
        break;
      }
      if (start > 0) {
        this.buffer.splice(0, start);
        this.resyncCount++;
      }
      if (this.buffer.length < 4) break; // need the length field
      const length = ((this.buffer[2] ?? 0) << 8) | (this.buffer[3] ?? 0);
      if (length < 3 || length > 8200) {
        this.buffer.splice(0, 1);
        this.resyncCount++;
        continue;
      }
      // `length` counts type + data + CRC (header and footer excluded), so the whole frame is
      // header(2) + lengthfield(2) + length + footer(2) = length + 6.
      const total = length + 6;
      if (this.buffer.length < total) break; // wait for the rest
      if ((this.buffer[total - 2] ?? 0) !== 0x55 || (this.buffer[total - 1] ?? 0) !== 0xaa) {
        this.buffer.splice(0, 1);
        this.resyncCount++;
        continue;
      }
      const crcRegion = Uint8Array.from(this.buffer.slice(2, total - 4));
      const expected = ((this.buffer[total - 4] ?? 0) << 8) | (this.buffer[total - 3] ?? 0);
      if (crc16Ccitt(crcRegion) !== expected) {
        this.buffer.splice(0, 1);
        this.resyncCount++;
        continue;
      }
      const type = this.buffer[4] ?? 0;
      const data = Uint8Array.from(this.buffer.slice(5, total - 4));
      frames.push({ type, data });
      this.buffer.splice(0, total);
    }
    return frames;
  }

  private findHeader(): number {
    for (let i = 0; i + 1 < this.buffer.length; i++) {
      if (this.buffer[i] === 0x86 && this.buffer[i + 1] === 0x68) return i;
    }
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8(text: string): Uint8Array {
  return textEncoder.encode(text);
}

export function decodeText(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

/** Big-endian helpers, for the sequence/packet-count fields. */
export function u32be(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export function readU32be(data: Uint8Array): number {
  return (
    ((data[0] ?? 0) << 24) | ((data[1] ?? 0) << 16) | ((data[2] ?? 0) << 8) | (data[3] ?? 0)
  ) >>> 0;
}

// ---------------------------------------------------------------------------
// Discovery (§2)
// ---------------------------------------------------------------------------

export interface DiscoveredMachine {
  name: string;
  host: string;
  port: number;
  busy: boolean;
}

/**
 * Parse one `name,ip,port,busy` UDP datagram. Returns null for anything the client would discard:
 * four fields or fewer, or an empty name or address. Unknown values are defaulted, not guessed:
 * a missing/!numeric port becomes 2222 and anything but `1` is "not busy".
 */
export function parseDiscoveryDatagram(text: string): DiscoveredMachine | null {
  const fields = text.trim().split(',');
  if (fields.length <= 3) return null;
  const name = (fields[0] ?? '').trim();
  const host = (fields[1] ?? '').trim();
  if (name.length === 0 || host.length === 0) return null;
  const rawPort = (fields[2] ?? '').trim();
  const parsed = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  const port = Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : COMMAND_TCP_PORT;
  return { name, host, port, busy: (fields[3] ?? '').trim() === '1' };
}

/** Listen for the machine's broadcast and return unique machines in arrival order. */
export async function runDiscovery(
  transport: MachineTransport,
  opts: { port?: number; windowMs?: number } = {},
): Promise<DiscoveredMachine[]> {
  const port = opts.port ?? DISCOVERY_UDP_PORT;
  const windowMs = opts.windowMs ?? 3000;
  const lines = await transport.udpListen(port, windowMs);
  const seen = new Set<string>();
  const out: DiscoveredMachine[] = [];
  for (const line of lines) {
    const machine = parseDiscoveryDatagram(line);
    if (machine !== null && !seen.has(machine.name)) {
      seen.add(machine.name);
      out.push(machine);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading frames off the wire
// ---------------------------------------------------------------------------

/** A decoder plus a queue, so a chunk carrying two frames does not lose the second one. */
class FrameChannel {
  private readonly transport: MachineTransport;
  private readonly conn: number;
  private readonly decoder = new FrameDecoder();
  private queue: Frame[] = [];

  constructor(transport: MachineTransport, conn: number) {
    this.transport = transport;
    this.conn = conn;
  }

  /** The next frame, or null if none arrived within `timeoutMs`. Rejects if the peer closed. */
  async next(timeoutMs: number): Promise<Frame | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const chunk = await this.transport.tcpRead(this.conn, 4096, remaining);
      if (chunk.length === 0) return null;
      const frames = this.decoder.push(chunk);
      if (frames.length > 0) {
        const first = frames.shift();
        if (frames.length > 0) this.queue.push(...frames);
        return first ?? null;
      }
    }
  }

  /** Read every frame until the window closes; used for the reply-then-quiet commands. */
  async drain(windowMs: number): Promise<Frame[]> {
    const out: Frame[] = [];
    const deadline = Date.now() + windowMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const frame = await this.next(remaining);
      if (frame === null) break;
      out.push(frame);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Identify (§4)
// ---------------------------------------------------------------------------

export interface MachineIdentity {
  host: string;
  /** The IPv4 the machine reported for itself, or null if none was found in the reply. */
  ip: string | null;
  /** The MAC the machine reported, normalised to lowercase colon form, or null. */
  mac: string | null;
  /** Every text reply frame seen, verbatim, so an unexpected format can be read rather than lost. */
  replies: string[];
}

/** The first plausible IPv4 address in `text`, or null. Octets over 255 are rejected. */
export function extractIpv4(text: string): string | null {
  const match = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/.exec(text);
  if (match === null) return null;
  const candidate = match[1];
  if (candidate === undefined) return null;
  const octets = candidate.split('.').map((part) => Number(part));
  if (octets.some((n) => n > 255)) return null;
  return candidate;
}

/** The first six-pair MAC (colon or dash separated) in `text`, normalised, or null. */
export function extractMac(text: string): string | null {
  const match = /\b([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})\b/.exec(text);
  const candidate = match?.[1];
  if (candidate === undefined) return null;
  return candidate.replace(/-/g, ':').toLowerCase();
}

/**
 * Send `M482.5` then `M482.4` and read the replies. The literal reply format is PROVISIONAL
 * (Z1-Bridge-Protocol.md §9), so the return keeps the raw text alongside the extracted values.
 */
export async function runIdentify(
  transport: MachineTransport,
  conn: number,
  host: string,
  opts: { windowMs?: number } = {},
): Promise<MachineIdentity> {
  const windowMs = opts.windowMs ?? 1500;
  const channel = new FrameChannel(transport, conn);

  await transport.tcpWrite(conn, encodeFrame(PTYPE_CTRL_MULTI, utf8('M482.5')));
  const ipFrames = await channel.drain(windowMs);

  await transport.tcpWrite(conn, encodeFrame(PTYPE_CTRL_MULTI, utf8('M482.4')));
  const macFrames = await channel.drain(windowMs);

  const replies = [...ipFrames, ...macFrames].map((f) => decodeText(f.data)).filter((s) => s.length > 0);
  const ipText = ipFrames.map((f) => decodeText(f.data)).join('\n');
  const macText = macFrames.map((f) => decodeText(f.data)).join('\n');
  return { host, ip: extractIpv4(ipText), mac: extractMac(macText), replies };
}

// ---------------------------------------------------------------------------
// Status (§6)
// ---------------------------------------------------------------------------

export interface MachineStatus {
  ok: boolean;
  text: string | null;
  /** Diagnostics frames (0x82) if any, verbatim. */
  diagnostics: string[];
}

/** Send `?` and return the controller's status line verbatim. Empty is reported as `ok: false`. */
export async function runStatus(
  transport: MachineTransport,
  conn: number,
  opts: { windowMs?: number } = {},
): Promise<MachineStatus> {
  const windowMs = opts.windowMs ?? 1500;
  const channel = new FrameChannel(transport, conn);

  await transport.tcpWrite(conn, encodeFrame(PTYPE_CTRL_SINGLE, new Uint8Array([STATUS_POLL_BYTE])));
  const frames = await channel.drain(windowMs);

  const statusLines: string[] = [];
  const diagnostics: string[] = [];
  for (const frame of frames) {
    const text = decodeText(frame.data);
    if (frame.type === 0x82) diagnostics.push(text);
    else if (frame.type >= 0x80 && frame.type <= 0x90) statusLines.push(text);
    // Types below 0x80 are not replies we asked for; ignored.
  }
  const text = statusLines.join('\n').trim();
  return { ok: text.length > 0, text: text.length > 0 ? text : null, diagnostics };
}

// ---------------------------------------------------------------------------
// Upload (§5)
// ---------------------------------------------------------------------------

export type UploadOutcome =
  | { ok: true; bytes: number; packets: number; alreadyPresent: boolean }
  | { ok: false; reason: 'refused' | 'timeout' | 'error'; detail: string };

export interface UploadOptions {
  packetSize?: number;
  /** Inactivity window: no frame at all for this long cancels the transfer (§5). */
  inactivityMs?: number;
}

/**
 * Turn a filename into the transport name the machine expects: spaces become byte 0x01 and
 * backslashes become forward slashes (Z1-Bridge-Protocol.md §5). A trailing newline is added by
 * the caller before framing.
 */
export function encodeTransferName(filename: string): string {
  return filename.replace(/\\/g, '/').replace(/ /g, '\u0001');
}

/**
 * The receiver-driven file upload. The machine asks for packets by sequence; we answer. Returns an
 * explicit outcome — a refusal (`0xB5` after data began) is never retried and never reported as a
 * success.
 */
export async function runUpload(
  transport: MachineTransport,
  conn: number,
  filename: string,
  content: Uint8Array,
  opts: UploadOptions = {},
): Promise<UploadOutcome> {
  const packetSize = opts.packetSize ?? WIFI_PACKET_SIZE;
  const inactivityMs = opts.inactivityMs ?? 9000;
  if (!Number.isInteger(packetSize) || packetSize <= 0) {
    return { ok: false, reason: 'error', detail: `invalid packet size ${packetSize}` };
  }

  const channel = new FrameChannel(transport, conn);

  const startFrame = encodeFrame(PTYPE_FILE_START, utf8(`upload ${encodeTransferName(filename)}\n`));
  await transport.tcpWrite(conn, startFrame);

  const md5Frame = encodeFrame(PTYPE_FILE_MD5, utf8(md5Hex(content)));
  await transport.tcpWrite(conn, md5Frame);

  const packetCount = Math.max(1, Math.ceil(content.length / packetSize));
  let lastSeq = 0;
  let lastDataFrame: Uint8Array | null = null;
  let lastSent: Uint8Array = md5Frame;
  let requested = false;

  const send = async (frame: Uint8Array): Promise<void> => {
    await transport.tcpWrite(conn, frame);
    lastSent = frame;
  };

  for (;;) {
    const frame = await channel.next(inactivityMs);
    if (frame === null) {
      await transport.tcpWrite(conn, encodeFrame(PTYPE_FILE_CANCEL, new Uint8Array()));
      return {
        ok: false,
        reason: 'timeout',
        detail: `the machine sent nothing for ${inactivityMs} ms`,
      };
    }

    const type = frame.type;
    if (type < PTYPE_FILE_MD5) continue; // a status/info frame crossed the transfer; ignore it

    if (type === PTYPE_FILE_CANCEL) {
      if (!requested) {
        // A cancel after the MD5 step means the machine already holds an identical file.
        return { ok: true, bytes: content.length, packets: 0, alreadyPresent: true };
      }
      return {
        ok: false,
        reason: 'refused',
        detail: 'the machine rejected the transfer (file cancel)',
      };
    }

    if (type === PTYPE_FILE_RETRY) {
      await send(lastSent);
      continue;
    }

    if (type === PTYPE_FILE_MD5) {
      await send(md5Frame);
      continue;
    }

    if (type === PTYPE_FILE_VIEW) {
      const view = new Uint8Array(6);
      view.set(u32be(packetCount), 0);
      view[4] = (packetSize >>> 8) & 0xff;
      view[5] = packetSize & 0xff;
      await send(encodeFrame(PTYPE_FILE_VIEW, view));
      lastSeq = 0;
      continue;
    }

    if (type === PTYPE_FILE_DATA) {
      requested = true;
      if (frame.data.length < 4) {
        return { ok: false, reason: 'error', detail: 'the machine sent a data request without a sequence number' };
      }
      const seq = readU32be(frame.data);
      if (seq === lastSeq && lastDataFrame !== null) {
        await send(lastDataFrame);
        continue;
      }
      const offset = (seq - 1) * packetSize;
      if (seq < 1 || offset >= content.length) {
        return { ok: false, reason: 'error', detail: `the machine asked for packet ${seq}, past the end of the file` };
      }
      const chunk = content.subarray(offset, offset + packetSize);
      const payload = new Uint8Array(4 + chunk.length);
      payload.set(u32be(seq), 0);
      payload.set(chunk, 4);
      const dataFrame = encodeFrame(PTYPE_FILE_DATA, payload);
      await send(dataFrame);
      lastSeq = seq;
      lastDataFrame = dataFrame;
      continue;
    }

    if (type === PTYPE_FILE_END) {
      return { ok: true, bytes: content.length, packets: lastSeq, alreadyPresent: false };
    }

    // Any other file type (0xB0) is not something the machine should echo; ignore rather than crash.
  }
}

// ---------------------------------------------------------------------------
// Reading a file back (§5 — the console `cat`)
// ---------------------------------------------------------------------------

export type ReadFileOutcome =
  | { ok: true; text: string; frames: number }
  | { ok: false; reason: 'bad-path' | 'not-found' | 'timeout' | 'error'; detail: string; text: string };

export interface ReadFileOptions {
  /** Stop after this many lines — the shell's own second parameter. Omit for the whole file. */
  limit?: number;
  /** How long to keep collecting output. A large file needs longer than a one-line reply. */
  windowMs?: number;
}

/**
 * A path the shell can be trusted with. The command line is whitespace-separated and the path is
 * pasted into it, so a space (or anything that isn't a plain path character) would let a caller turn
 * one read into a second command. Refused rather than escaped: there is nothing here worth escaping.
 */
const READABLE_PATH = /^\/[A-Za-z0-9._/-]*$/;

/**
 * Read a file off the machine's card with the controller's own console `cat` (Z1-Bridge-Protocol.md
 * §5). One frame out, text back — no handshake, no packet sequence, and nothing but a read.
 *
 * The reply is returned verbatim, including the shell's `File not found:` line when the path is
 * wrong; that case is also reported as a `not-found` reason so a caller need not match on prose.
 */
export async function runReadFile(
  transport: MachineTransport,
  conn: number,
  path: string,
  opts: ReadFileOptions = {},
): Promise<ReadFileOutcome> {
  const windowMs = opts.windowMs ?? 4000;
  if (!READABLE_PATH.test(path)) {
    return {
      ok: false,
      reason: 'bad-path',
      detail: `refusing to send ${JSON.stringify(path)}: a readable path is absolute and made of A-Z a-z 0-9 . _ - /`,
      text: '',
    };
  }
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
    return { ok: false, reason: 'error', detail: `invalid line limit ${opts.limit}`, text: '' };
  }

  const command = opts.limit === undefined ? `cat ${path}` : `cat ${path} ${opts.limit}`;
  const channel = new FrameChannel(transport, conn);
  await transport.tcpWrite(conn, encodeFrame(PTYPE_CTRL_MULTI, utf8(command)));
  const frames = await channel.drain(windowMs);

  // Console output arrives as reply frames; anything the machine echoes back at us is not output.
  const text = frames
    .filter((f) => f.type >= 0x80)
    .map((f) => decodeText(f.data))
    .join('');

  if (/^File not found:/m.test(text)) {
    return { ok: false, reason: 'not-found', detail: text.trim(), text };
  }
  if (text.length === 0) {
    return {
      ok: false,
      reason: 'timeout',
      detail: `no console output within ${windowMs} ms of sending \`${command}\``,
      text: '',
    };
  }
  return { ok: true, text, frames: frames.length };
}

export type Md5SumOutcome =
  | { ok: true; md5: string; path: string; text: string }
  | { ok: false; reason: 'bad-path' | 'not-found' | 'timeout' | 'unparsed'; detail: string; text: string };

export interface Md5SumOptions {
  /** One short line comes back; this is the quiet-window timeout, not a transfer budget. */
  windowMs?: number;
}

/**
 * Ask the controller to hash a file **it** holds (Z1-Bridge-Protocol.md §5).
 *
 * This is the read that does not move bytes: the machine computes the digest and returns 32
 * characters. It is the independent half of an upload check — §5 verifies a `.nc` with the bridge's
 * own handshake and MD5, and this asks the controller what *it* ended up with, so a fault on our side
 * of the wire cannot make both agree.
 *
 * **A quirk of this firmware, recorded rather than smoothed over:** the reply is the digest and the
 * filename run together with no separator — observed on the machine 2026-10-06 as
 * `00ceac76d7a4930bac754795b388f34b/sd/config.txt`. So the digest is taken from the *start of the
 * line*, not by splitting on whitespace, and the `path` returned is the one the caller asked for
 * rather than anything re-parsed out of the echo.
 *
 * The path is checked against the same alphabet a read uses, for the same reason: this line is built
 * by concatenation and the shell splits it on whitespace.
 */
export async function runMd5Sum(
  transport: MachineTransport,
  conn: number,
  path: string,
  opts: Md5SumOptions = {},
): Promise<Md5SumOutcome> {
  const windowMs = opts.windowMs ?? 2000;
  if (!READABLE_PATH.test(path)) {
    return {
      ok: false,
      reason: 'bad-path',
      detail: `refusing to send ${JSON.stringify(path)}: a readable path is absolute and made of A-Z a-z 0-9 . _ - /`,
      text: '',
    };
  }

  const command = `md5sum ${path}`;
  const channel = new FrameChannel(transport, conn);
  await transport.tcpWrite(conn, encodeFrame(PTYPE_CTRL_MULTI, utf8(command)));
  const frames = await channel.drain(windowMs);
  const text = frames
    .filter((f) => f.type >= 0x80)
    .map((f) => decodeText(f.data))
    .join('');

  // Two spellings, both read off the machine: `cat` says `File not found: <path>` and `md5sum` says
  // `Error: file not found [<path>]`. Matched case-insensitively and without the wrapper, because the
  // only thing worth keying on is the phrase, and a third spelling would otherwise read as success.
  if (/^(?:error: )?file not found/im.test(text)) {
    return { ok: false, reason: 'not-found', detail: text.trim(), text };
  }
  if (text.length === 0) {
    return { ok: false, reason: 'timeout', detail: `no reply to \`${command}\``, text: '' };
  }
  // Anchor to the line start: the digest is followed immediately by the path, so there is no
  // separator to split on and a bare 32-hex search could match inside the filename.
  const match = /^([0-9a-f]{32})/m.exec(text);
  if (match === null) {
    return { ok: false, reason: 'unparsed', detail: `no digest in the reply: ${text.trim()}`, text };
  }
  return { ok: true, md5: match[1] ?? '', path, text };
}

// ---------------------------------------------------------------------------
// The machine's own configuration (§5 — `config-get`)
// ---------------------------------------------------------------------------

export type ReadConfigKeyOutcome =
  | { ok: true; value: string; text: string }
  | { ok: false; reason: 'not-in-config' | 'bad-request' | 'timeout'; detail: string; text: string };

export interface ReadConfigKeyOptions {
  /**
   * A configuration source to read from, or omitted for the effective value.
   *
   * Omitted, the query is `config-get <key>` — one argument — and the firmware answers from its
   * **merged** cache with a `cached:` prefix. That is the value the machine is actually running, and
   * it is the right default: it needs no knowledge of which file a key happens to live in.
   *
   * Named, the query is `config-get <source> <key>` and the firmware reads that one file. `sd` is
   * `/sd/config.txt`, which on a Z1 is the vendor's *override* file rather than the whole
   * configuration — so a key missing from `sd` is not unset, it is simply not overridden there.
   */
  source?: string;
  /** Small: one key is one short line, and §6's status poll answers in about the same time. */
  windowMs?: number;
}

/** A configuration source name ("sd", "local") and a key ("coordinate.anchor1_x"). */
const CONFIG_SOURCE = /^[a-z]+$/;
const CONFIG_KEY = /^[A-Za-z0-9_.]+$/;

/**
 * Ask the controller what one of its own configuration keys is set to (Z1-Bridge-Protocol.md §5).
 *
 * **This is the only configuration channel this firmware answers.** Read on the machine on
 * 2026-10-06: `cat /sd/config.txt` reports `File not found` for a path `config-get` reads values out
 * of, and `config-get-all` — which would dump the whole file — returns nothing when typed at it. So
 * keys are read one at a time, by name.
 *
 * Replies are `<label>: <key> is set to <value>` and `<label>: <key> is not in config`, where the
 * label is `cached` for an effective-value query and the source's own name otherwise. Both are
 * returned verbatim so a caller can read what the machine actually said.
 *
 * **Silence is not a slow machine.** The firmware's source loop has no `else`, so naming a source
 * the controller does not carry produces *no output at all* rather than an error — observed on
 * 2026-10-06 for both `firm` and a deliberately bogus name. A timeout here therefore means the query
 * was not understood; it does not mean the machine is busy, and retrying it will not help.
 *
 * The source and the key are **pattern-checked** rather than escaped, for the same reason a read
 * path is: this line is assembled by string concatenation and the shell splits it on whitespace, so
 * anything outside those alphabets could turn one query into two commands.
 */
export async function readConfigKey(
  transport: MachineTransport,
  conn: number,
  key: string,
  opts: ReadConfigKeyOptions = {},
): Promise<ReadConfigKeyOutcome> {
  const windowMs = opts.windowMs ?? 2000;
  const source = opts.source;
  if (!CONFIG_KEY.test(key) || (source !== undefined && !CONFIG_SOURCE.test(source))) {
    return {
      ok: false,
      reason: 'bad-request',
      detail: `refusing to send source ${JSON.stringify(source ?? null)} / key ${JSON.stringify(key)}: a source is lowercase letters, a key is A-Z a-z 0-9 . _`,
      text: '',
    };
  }

  const command = source === undefined ? `config-get ${key}` : `config-get ${source} ${key}`;
  const label = source ?? 'cached';
  const channel = new FrameChannel(transport, conn);
  await transport.tcpWrite(conn, encodeFrame(PTYPE_CTRL_MULTI, utf8(command)));
  const frames = await channel.drain(windowMs);
  const text = frames
    .filter((f) => f.type >= 0x80)
    .map((f) => decodeText(f.data))
    .join('');

  if (text.length === 0) {
    return { ok: false, reason: 'timeout', detail: `no reply to \`${command}\``, text: '' };
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^${label}: ${escaped} is not in config`, 'm').test(text)) {
    return { ok: false, reason: 'not-in-config', detail: text.trim(), text };
  }
  const match = new RegExp(`^${label}: ${escaped} is set to (.*)$`, 'm').exec(text);
  if (match === null) {
    return { ok: false, reason: 'not-in-config', detail: `unrecognised reply: ${text.trim()}`, text };
  }
  return { ok: true, value: (match[1] ?? '').trim(), text };
}

// ---------------------------------------------------------------------------
// MD5 (§5 — the handshake digest)
// ---------------------------------------------------------------------------

// MD5 is required by the wire protocol, which is the only reason it is here: WebCrypto does not
// offer it. RFC 1321, checked against the published test vectors in the spec.
const MD5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

/** Lowercase hex MD5 digest of `input`. */
export function md5Hex(input: Uint8Array): string {
  const bitLen = input.length * 8;
  const padded = (input.length + 1 + 8 + 63) & ~63;
  const msg = new Uint8Array(padded);
  msg.set(input);
  msg[input.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(padded - 8, bitLen >>> 0, true);
  view.setUint32(padded - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const words = new Uint32Array(16);

  for (let offset = 0; offset < padded; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (f + a + (MD5_K[i] ?? 0) + (words[g] ?? 0)) | 0;
      const shift = MD5_SHIFT[i] ?? 0;
      const rotated = (sum << shift) | (sum >>> (32 - shift));
      a = d;
      d = c;
      c = b;
      b = (b + rotated) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  return [a0, b0, c0, d0].map(wordHex).join('');
}

function wordHex(word: number): string {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, word >>> 0, true);
  let out = '';
  for (let i = 0; i < 4; i++) out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  return out;
}
