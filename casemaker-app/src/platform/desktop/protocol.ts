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
 * One datagram, as it arrived (#275): the bytes, and when the listener took them off the socket.
 *
 * `at` is **receipt at this listener**, in epoch milliseconds — not a send time, and not the
 * machine's clock. Nothing in the datagram says when it was sent (`Z1-Bridge-Protocol.md` §2), so the
 * only time a listener can honestly report is its own, at the moment the bytes reached it. That is
 * all it is for: ordering one window's datagrams, and putting a field-4 state change at a moment.
 * Two listeners' times are not comparable, and neither is a listener's time against the controller's.
 */
export interface UdpDatagram {
  /** Epoch milliseconds, at the receiving listener (see above). */
  at: number;
  /** The datagram's bytes as UTF-8, trimmed. Empty datagrams are never returned. */
  text: string;
}

/**
 * Five calls, no framing. Implemented today by Tauri commands over raw sockets; USB can be a second
 * implementation without anything above changing.
 *
 * `tcpRead` returns the bytes available within `timeoutMs` (an empty array on timeout) and rejects
 * if the peer closed the connection, so a caller can tell "nothing yet" from "gone".
 */
export interface MachineTransport {
  /** Every datagram that arrived in the window, in arrival order, each stamped when it was taken
   *  off the socket ({@link UdpDatagram}). */
  udpListen(port: number, windowMs: number): Promise<UdpDatagram[]>;
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
  /**
   * Field 4 of the datagram — a textual state the real machine sends (`Idle` is the only value ever
   * seen). Undocumented, and **deliberately not used to decide anything** (#275): if field 4 and
   * `busy` ever diverge, which one is authoritative is unknown, so the field is surfaced for an
   * observation (`discover --all`) to compare them — never for a caller to key off.
   */
  state?: string;
}

/**
 * Parse one `name,ip,port,busy,state` UDP datagram. Returns null for anything the client would
 * discard: four fields or fewer, or an empty name or address. Unknown values are defaulted, not
 * guessed: a missing/!numeric port becomes 2222 and anything but `1` is "not busy". Field 4, when
 * present and non-empty, is kept as `state` (#275); fields beyond it are ignored, since the
 * datagram's shape past the fifth has never been seen.
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
  const machine: DiscoveredMachine = { name, host, port, busy: (fields[3] ?? '').trim() === '1' };
  const state = (fields[4] ?? '').trim();
  if (state.length > 0) machine.state = state;
  return machine;
}

/**
 * How long to listen for the machine's UDP broadcast, ms — the labelled NO-SERVICE FALLBACK of the
 * shop's `machine.discoveryWindowMs` (#449). A caller that has read the location passes its number;
 * this module is pure protocol and never imports the registry.
 */
export const DISCOVERY_WINDOW_MS = 3000;

/**
 * Every datagram received in the listen window, in arrival order, each with the time it arrived and
 * its text **unparsed** — no de-duplication and nothing discarded (#275). This is what wants field 4
 * watched against field 3 as the machine changes state: a machine list would collapse the repeats
 * that carry the change, and would drop the malformed line that says something else is broadcasting.
 * The arrival time is what turns that list into a sequence — `0,Idle` before `0,Run` only says which
 * came first, not how long it stayed that way.
 */
export async function discoveryDatagrams(
  transport: MachineTransport,
  opts: { port?: number; windowMs?: number } = {},
): Promise<UdpDatagram[]> {
  return transport.udpListen(opts.port ?? DISCOVERY_UDP_PORT, opts.windowMs ?? DISCOVERY_WINDOW_MS);
}

/** Listen for the machine's broadcast and return unique machines in arrival order. */
export async function runDiscovery(
  transport: MachineTransport,
  opts: { port?: number; windowMs?: number } = {},
): Promise<DiscoveredMachine[]> {
  const datagrams = await discoveryDatagrams(transport, opts);
  const seen = new Set<string>();
  const out: DiscoveredMachine[] = [];
  for (const datagram of datagrams) {
    const machine = parseDiscoveryDatagram(datagram.text);
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
 * Send `M482.5` then `M482.4` and read the replies.
 *
 * The reply format is no longer provisional: it was OBSERVED on hardware at bench B0 on 2026-10-06
 * and the row is closed (`Z1-Bridge-Protocol.md` §4, §9; `docs/bench/2026-10-bench-day-1.md`) —
 * `M482.5` answers `STA param[5]:<ip>` and `M482.4` answers `STA param[4]:<mac with dashes>`. The
 * extraction below is written to those replies. The return still keeps the raw text alongside the
 * extracted values, because the parser is deliberately lenient (`extractIpv4` / `extractMac` take a
 * plausible value out of whatever arrived) and a reply that does not match the observed shape
 * should be readable rather than silently dropped.
 */
/**
 * How long each reply to the identify asks is waited for, ms — the labelled NO-SERVICE FALLBACK of
 * the shop's `machine.identifyWindowMs` (#449). `M482.5` then `M482.4` each get their own window,
 * and the controller's answer to either is a single line (§4).
 */
export const IDENTIFY_WINDOW_MS = 1500;

export async function runIdentify(
  transport: MachineTransport,
  conn: number,
  host: string,
  opts: { windowMs?: number } = {},
): Promise<MachineIdentity> {
  const windowMs = opts.windowMs ?? IDENTIFY_WINDOW_MS;
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

/**
 * How fast a caller may poll the status, ms — never below this (§6, #386).
 *
 * Replies to `?` took **0.6–0.7 s** on this bench, and a poll every 0.6 s is the interval that
 * faulted the controller on 2026-10-12 (`ALARM: Mainboard did not receive a status response from the
 * CTRL`, spindle frozen in `Run`, the mains plug the only stop). 2 s is what the bench used for every
 * clean run since. It is the floor for `z1.mjs run`'s polling loop and for a piped `console` session.
 */
export const MIN_STATUS_POLL_MS = 2000;

/** What a status line says about the running job (§6, #386). Every field is null when absent. */
export interface JobProgress {
  /** The state word at the front of the line: `Idle`, `Run`, `Alarm`, `Home`, … (`<Run|MPos:…>`). */
  state: string | null;
  /** `P:`'s first field — the line of the file being run. */
  line: number | null;
  /** `P:`'s second field — percent complete, 100 at the end. */
  percent: number | null;
  /** `P:`'s third field — seconds elapsed in the job. */
  elapsedS: number | null;
}

/**
 * Read a status line for the job's progress. Pure text, so the caller decides what "finished" means.
 *
 * The decision itself is NOT here, because it is the one thing about this reply that reads wrong at a
 * glance: `Idle` appears **mid-job** — the air file reports it for 3–4 s at `M05` and then `Run`
 * again for the trip home (traces: `docs/bench/traces/2026-10-12-poll*.log`) — so a caller that stops
 * on the state word alone loses the rest of the file. **Job end is percent 100 AND `Idle`.**
 */
export function readJobProgress(text: string): JobProgress {
  const state = /^<([A-Za-z]+)/.exec(text.trim());
  const p = /(?:^|\|)P:([^|>]*)/.exec(text);
  const fields = p === null ? [] : (p[1] as string).split(',');
  const num = (i: number): number | null => {
    const raw = fields[i]?.trim();
    if (raw === undefined || raw === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  return { state: state === null ? null : state[1]!, line: num(0), percent: num(1), elapsedS: num(2) };
}

/** One axis triplet off the status line — X Y Z, plus A/B when the rotary is fitted (#526). */
export interface StatusPosition {
  x: number | null;
  y: number | null;
  z: number | null;
  a: number | null;
  b: number | null;
}

/** A `F:`/`S:` field — actual, set, and the override percent (#526). */
export interface StatusRate {
  actual: number | null;
  set: number | null;
  override: number | null;
}

/**
 * What a `?` status line says, whole (#526): the state word and the job's progress (reusing
 * `readJobProgress`), plus the work and machine positions, the feed and spindle rates, and the
 * tool number. Every field is null when the line does not carry it — an idle machine has no `P:`
 * and a probe-only poll has no `T:`.
 */
export interface MachineStatusLine {
  state: string | null;
  /** The work position (`WPos:`), the frame the job is written in. */
  wpos: StatusPosition;
  /** The machine position (`MPos:`), what the axis encoders report. */
  mpos: StatusPosition;
  /** The feed rate (`F:`): actual mm/min, the set figure, and the override percent. */
  feed: StatusRate;
  /** The spindle (`S:`): actual rpm, the set figure, and the override percent. */
  spindle: StatusRate;
  /** The tool number (`T:`), or null when no tool is fitted. */
  tool: number | null;
  /**
   * #655 — the tool number the controller is WAITING for: the `T:` field's third value
   * (`…|T:0,-9.757,1|…` while the state reads `Tool` after an `M6`, the machine stopped for the
   * operator's `M490.2`). Null whenever no change is pending.
   *
   * The firmware writes `-1` in that slot when nothing is pending — every idle frame in
   * `docs/bench/traces/2026-10-24-run1-status-trail.log` reads `T:1,0.047,-1` — so the parser
   * normalises a negative value to null here; callers never see the sentinel (#769 review).
   */
  toolWaiting: number | null;
  /**
   * #769 — the `A:` field, where the frame carries one: the controller's ATC state, an integer.
   *
   * This is NOT a fourth-axis position, and the firmware says so itself: in
   * `Kernel::get_query_string` (`MakeraInc/CarveraFirmware`, the same source #659 cites) `A:` is
   * written only inside `if (THEKERNEL->factory_set->FuncSetting & (1<<2)) //ATC` — as `|A:%d`
   * (the ATC state) or `|A:%d,%d` (two ATC pin states). The 4th axis is the `a` in `wpos`/`mpos`,
   * which the frame always carries. The Z1 has the ATC bit clear (`isATC=0`), so it never emits
   * this field: none of the frames recorded under `docs/bench/traces` or `.scratch` carries one.
   * It is still parsed where present because an ATC machine can be connected, and the value is
   * surfaced raw — never dressed as an angle.
   */
  atcState: number | null;
  /** #659 — the readings the frame carries beyond position, rates and progress. */
  monitor: StatusMonitor;
  progress: JobProgress;
}

/**
 * #659 — THE STATUS MONITOR's readings, from the fields the frame carries and we used to skip.
 *
 * WHAT EACH ONE IS, from the Z1's own firmware source (`MakeraInc/CarveraFirmware`,
 * `src/libs/Kernel.cpp` `Kernel::get_query_string`), not from a guess:
 *
 *  - `S:` is `current_rpm,target_rpm,factor,vacuum_mode,spindle_temp,power_temp,0,0,extout_mode` —
 *    the fifth value is the SPINDLE temperature and the sixth the POWER board's, °C;
 *  - `H:<n>` is the firmware's halt reason, sent only while halted, and its enum
 *    (`src/libs/Kernel.h`) names what stopped the machine — including `COVER_OPEN` and
 *    `PROBE_FAIL`, which is where the cover and the probe appear in this frame;
 *  - `O:<mm>` is present while the machine's own leveling is active, and is the grid's LARGEST
 *    correction.
 *
 * WHAT IS DELIBERATELY NOT READ. `C:` carries the machine model, a factory bitfield and the
 * inch/absolute mode (the bitfield's bits are not documented); `L:` is the LASER's mode/power, not
 * limits; `E:` in our captures does not match the upstream endstop list; `W:` is the wireless
 * probe's voltage (this machine has none); `OTA:` is not built by the firmware source at all.
 * (`A:` was on this list until #769 read it — see {@link MachineStatusLine.atcState}; it is the
 * ATC state, which is a different thing from the fourth axis.) None of these is shown — a field
 * nobody can explain is not an operator reading.
 */
export interface StatusMonitor {
  /** Spindle temperature, °C (`S:` value 5), or null when the frame does not carry it. */
  spindleTempC: number | null;
  /** Power-board temperature, °C (`S:` value 6), or null. */
  powerTempC: number | null;
  /** The firmware's halt reason (`H:`), named in operator words, or null when not halted. */
  halt: { code: number; words: string } | null;
  /** The largest correction the machine's own leveling is applying, mm (`O:`), or null. */
  levellingMm: number | null;
}

/** The firmware's `HALT_REASON` enum (`Kernel.h`), in the operator's words. */
const HALT_WORDS: Readonly<Record<number, string>> = {
  1: 'the machine was halted by hand',
  2: 'homing failed',
  3: 'a probe touch did not trigger',
  4: 'calibration failed',
  5: 'the tool changer could not home',
  6: 'the tool changer read an invalid tool',
  7: 'the tool changer found no tool',
  8: 'the tool changer found a tool it did not expect',
  9: 'the spindle overheated',
  10: 'a soft limit was reached',
  11: 'the cover was opened',
  12: 'the probe is not reading correctly',
  13: 'the emergency stop was pressed',
  14: 'the power board overheated',
  15: 'a move was sent before homing',
  21: 'a hard limit was hit',
  22: 'the X motor reported an error',
  23: 'the Y motor reported an error',
  24: 'the Z motor reported an error',
  25: 'the spindle stalled',
  26: 'the SD card reported an error',
  41: 'the spindle reported an alarm',
};

/** A finite number from `parts[i]`, or null. */
function value(parts: readonly string[], i: number): number | null {
  const raw = parts[i]?.trim();
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/** #659 — the monitor's readings from the `S:`, `H:` and `O:` fields. */
function readMonitor(text: string): StatusMonitor {
  const s = statusField(text, 'S');
  const sParts = s === null ? [] : s.split(',');
  const h = statusField(text, 'H');
  const hCode = h === null ? null : value(h.split(','), 0);
  const o = statusField(text, 'O');
  return {
    spindleTempC: value(sParts, 4),
    powerTempC: value(sParts, 5),
    halt:
      hCode === null
        ? null
        : { code: hCode, words: HALT_WORDS[hCode] ?? `the machine halted (reason code ${hCode})` },
    levellingMm: o === null ? null : value(o.split(','), 0),
  };
}

/** The `KEY:value` field of a status line, or null — fields are `|`-separated (#526). */
function statusField(text: string, key: string): string | null {
  const m = new RegExp(`(?:^|\\|)${key}:([^|>]*)`).exec(text);
  return m === null ? null : m[1]!;
}

/** `X,Y,Z` (and `A,B` when fitted) into a `StatusPosition`. */
function readPosition(field: string | null): StatusPosition {
  const parts = field === null ? [] : field.split(',');
  const at = (i: number): number | null => {
    const raw = parts[i]?.trim();
    if (raw === undefined || raw === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  return { x: at(0), y: at(1), z: at(2), a: at(3), b: at(4) };
}

/** `actual,set,override%` into a `StatusRate`. */
function readRate(field: string | null): StatusRate {
  const parts = field === null ? [] : field.split(',');
  const at = (i: number): number | null => {
    const raw = parts[i]?.trim();
    if (raw === undefined || raw === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  return { actual: at(0), set: at(1), override: at(2) };
}

/**
 * Parse one status line into its facts (#526). Pure text; the strip, the viewport and the
 * registration runner all read the same line through this, so they cannot disagree about what the
 * machine said. `state` and the `P:` progress come from `readJobProgress` — the one reader that
 * already knows the state word and the job's line/percent/elapsed.
 */
export function readStatusLine(text: string): MachineStatusLine {
  const tool = readRate(statusField(text, 'T'));
  // #769 — `A:` is the ATC state (see `MachineStatusLine.atcState`), one integer, or two pin
  // states in the other firmware branch. Its first value is the reading; an unreadable one is
  // null, never 0 — the frame did not say 0, it said something this parser cannot read.
  const atc = statusField(text, 'A');
  return {
    state: readJobProgress(text).state,
    wpos: readPosition(statusField(text, 'WPos')),
    mpos: readPosition(statusField(text, 'MPos')),
    feed: readRate(statusField(text, 'F')),
    spindle: readRate(statusField(text, 'S')),
    tool: tool.actual,
    // The T field is `actual,offset,awaited` — the third value is not a rate's "override" (that is
    // only the positional name `readRate` gives slot 3). `-1` there is the firmware's "no change is
    // pending" (#769 review), and the field's contract is null for that, so it is normalised —
    // a negative number is never a tool. The recorded idle trail carries it throughout (e.g.
    // `T:1,0.047,-1`).
    toolWaiting: tool.override !== null && tool.override >= 0 ? tool.override : null,
    atcState: atc === null ? null : value(atc.split(','), 0),
    monitor: readMonitor(text),
    progress: readJobProgress(text),
  };
}

/**
 * The work-coordinate offset (G54) read back from a status line: `MPos − WPos`, per axis (#567).
 *
 * The controller reports `WPos = MPos − G54 − TLO` (`Z1-Firmware-Dialect.md` §11.12), so this
 * difference IS the G54 offset on X and Y — the two axes a registration pre-flight confirms ("G54 ≈
 * the job's origin" before the surface touch, #567 step 4). On Z it also carries the tool-length
 * offset, so the Z returned here is `G54_z + TLO_z`, not `G54_z` alone; `M499` reads the tool
 * length to separate the two. An axis where either side is missing returns null.
 */
export function workOffset(line: MachineStatusLine): StatusPosition {
  const sub = (m: number | null, w: number | null): number | null => (m === null || w === null ? null : m - w);
  return {
    x: sub(line.mpos.x, line.wpos.x),
    y: sub(line.mpos.y, line.wpos.y),
    z: sub(line.mpos.z, line.wpos.z),
    a: sub(line.mpos.a, line.wpos.a),
    b: sub(line.mpos.b, line.wpos.b),
  };
}

/**
 * The words the controller uses when it has stopped for its own reasons — a bare line, not a state
 * word: `ALARM: Probe fail` after a `G38.2` finds nothing (`Z1-Firmware-Dialect.md` §11.2), the
 * `ERROR: Probe dead or not set…` line an `M491` macro ends with (§11.9), and Marlin's own
 * `error:`/`error:Alarm lock` prefix for a command it refused. The words are the dialect's, read off
 * the 2026-10-12 trace, not a list invented here.
 */
const ALARM_WORDS = /\bALARM\b|Probe fail|error:/i;

/**
 * The controller's own alarm line, if this text carries one — the first one, verbatim, or null.
 *
 * A status line's state word already reads `Alarm` when the machine is locked, so why a second
 * reader? Because the alarm is not only in the state word: the 2026-10-12 trace shows it arriving as
 * its own line (`ALARM: Probe fail`), it can share a reply with a state word that reads `Idle` (the
 * `M491` tail lands beside a poll's answer), and a caller deciding whether the machine is free has to
 * act on it wherever it appears — a frame that arrived with no line in flight is still the controller
 * saying the machine is in a state, and carrying only changes where that text is SHOWN
 * ({@link ConsoleCarried}, #386 item 3).
 *
 * Returns the line rather than a boolean so the refusal can quote what the machine actually said.
 */
export function alarmLine(text: string | null): string | null {
  if (text === null) return null;
  for (const line of text.split(/\r?\n/)) {
    if (ALARM_WORDS.test(line)) return line.trim();
  }
  return null;
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
  /** How long to wait for the machine's answer to the pre-data `md5sum` re-check (#300). */
  md5WindowMs?: number;
}

/** The longest a one-line `md5sum` reply is waited for; `runMd5Sum`'s default window too. */
const MD5_WINDOW_MS = 2000;

/**
 * The machine's job directory. Studio asks for it on every connect (`ls -e -s /sd/gcodes`,
 * recorded in `docs/bench/2026-10-bench-day-1.md`), and it is where a `.nc` has to land.
 *
 * This is a MEASURED value, not a guessed one. The first live upload (2026-10-07) sent a bare
 * `165-depth-ladder.nc`, which the machine resolved to the card root and answered with
 * `Error: failed to open file [/165-depth-ladder.nc]!`. The same bytes to
 * `/sd/gcodes/165-depth-ladder.nc` were accepted with `Info: upload success: ...`. An upload
 * destination is therefore a full absolute path, and this is the directory half of it.
 */
export const GCODE_DIR = '/sd/gcodes';

/**
 * A path the machine can be given to WRITE. Two things are required, and the first was learned the
 * hard way:
 *
 * - **Absolute.** A bare name is not refused by the machine — it is resolved against the card root
 *   and fails there, which is how the first live upload (2026-10-07) came back as
 *   `Error: failed to open file [/165-depth-ladder.nc]!`.
 * - **No control characters.** The name is written into an `upload <name>` line whose framing is a
 *   trailing newline, so a newline inside the name would end the command early.
 *
 * Spaces are deliberately ALLOWED here, unlike {@link READABLE_PATH}'s alphabet: §5 encodes them as
 * byte `0x01` precisely so a path may contain one, and {@link encodeTransferName} does that. A guard
 * that banned them would quietly disable a documented part of the protocol to no benefit.
 */
const WRITABLE_PATH = /^\/[A-Za-z0-9._/ -]*$/;

/** Join a directory and a file name into the absolute path an upload needs. */
export function uploadPath(directory: string, filename: string): string {
  return `${directory.replace(/\/+$/, '')}/${filename}`;
}

/**
 * Turn a path into the transport name the machine expects: spaces become byte 0x01 and backslashes
 * become forward slashes (Z1-Bridge-Protocol.md §5). A trailing newline is added by the caller
 * before framing.
 */
export function encodeTransferName(path: string): string {
  return path.replace(/\\/g, '/').replace(/ /g, '\u0001');
}

/**
 * How long an upload waits for the machine's next frame before it cancels, ms — the labelled
 * NO-SERVICE FALLBACK of the shop's `machine.uploadInactivityMs` (#449). A caller that has read the
 * location passes its number; this module is pure protocol and never imports the registry.
 */
export const UPLOAD_INACTIVITY_MS = 9000;

/**
 * The receiver-driven file upload. The machine asks for packets by sequence; we answer. Returns an
 * explicit outcome — a refusal (`0xB5` after data began) is never retried and never reported as a
 * success.
 */
export async function runUpload(
  transport: MachineTransport,
  conn: number,
  path: string,
  content: Uint8Array,
  opts: UploadOptions = {},
): Promise<UploadOutcome> {
  const packetSize = opts.packetSize ?? WIFI_PACKET_SIZE;
  const inactivityMs = opts.inactivityMs ?? UPLOAD_INACTIVITY_MS;
  if (!Number.isInteger(packetSize) || packetSize <= 0) {
    return { ok: false, reason: 'error', detail: `invalid packet size ${packetSize}` };
  }
  // The destination is a full path, and it has to be. A bare name is not rejected by the machine —
  // it is silently resolved against the card root and then fails there, which is how the first live
  // upload (2026-10-07) came back as `Error: failed to open file [/165-depth-ladder.nc]!`. Refusing
  // here turns that into a sentence the caller can act on, before a socket is opened.
  if (!WRITABLE_PATH.test(path)) {
    return {
      ok: false,
      reason: 'error',
      detail: `refusing to upload to ${JSON.stringify(path)}: a writable path is absolute and made of A-Z a-z 0-9 . _ - /`,
    };
  }

  const channel = new FrameChannel(transport, conn);

  const startFrame = encodeFrame(PTYPE_FILE_START, utf8(`upload ${encodeTransferName(path)}\n`));
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
      // A cancel is the machine's word for two different things (§5): "I already hold this exact
      // file" and "I am refusing this transfer". The frame does not say which, and the first live
      // upload (2026-10-07) showed what assuming costs — the machine answered `Error: failed to
      // open file [...]!` and the bridge reported a successful upload, because it read every
      // pre-data cancel as a match. An operator would have been told the file was on the machine
      // when it was not.
      //
      // So the claim is CHECKED rather than assumed: the machine is asked to hash the very path we
      // just offered, and "already present" is returned only when the digest is the one we sent.
      // Anything else is a refusal, carrying the machine's own words. The check runs on THIS
      // channel: a second one would hold a second decoder and race this one for the same socket.
      const said = decodeText(frame.data).trim();
      if (!requested) {
        const refusedDetail = said.length > 0 ? said : 'the machine cancelled the transfer without saying why';
        // A path with a space is a legal upload destination (§5 encodes it as 0x01) but not a legal
        // `md5sum` argument: the controller splits on the space and hashes the wrong file (#298).
        // The "already present" claim then cannot be checked, so it is not made — and the caller is
        // told why, rather than reading a bare refusal for a file that may well be on the card.
        if (!READABLE_PATH.test(path)) {
          return {
            ok: false,
            reason: 'refused',
            detail: `${refusedDetail} (whether the machine already holds this file could not be checked: its path has characters md5sum cannot take)`,
          };
        }
        // The refusal's reply is one line and arrives at once, so the window here is the SHORT one
        // `runMd5Sum` uses, not the transfer's inactivity budget (#300): a refusal must not make the
        // operator wait out nine seconds of a transfer that never began.
        const existing = await md5ViaChannel(transport, conn, channel, path, opts.md5WindowMs ?? MD5_WINDOW_MS);
        if (existing.ok && existing.md5 === md5Hex(content)) {
          return { ok: true, bytes: content.length, packets: 0, alreadyPresent: true };
        }
        return { ok: false, reason: 'refused', detail: refusedDetail };
      }
      return {
        ok: false,
        reason: 'refused',
        detail: said.length > 0 ? said : 'the machine rejected the transfer (file cancel)',
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
  const windowMs = opts.windowMs ?? MD5_WINDOW_MS;
  if (!READABLE_PATH.test(path)) {
    return {
      ok: false,
      reason: 'bad-path',
      detail: `refusing to send ${JSON.stringify(path)}: a readable path is absolute and made of A-Z a-z 0-9 . _ - /`,
      text: '',
    };
  }

  return md5ViaChannel(transport, conn, new FrameChannel(transport, conn), path, windowMs);
}

/**
 * Send `md5sum <path>` on an EXISTING frame channel and read the reply.
 *
 * Split out for `runUpload`, which has to ask this question in the middle of its own exchange and
 * cannot open a second channel to do it: {@link FrameChannel} owns a private decoder, so two of
 * them on one socket would each consume bytes the other needs.
 */
async function md5ViaChannel(
  transport: MachineTransport,
  conn: number,
  channel: FrameChannel,
  path: string,
  windowMs: number,
): Promise<Md5SumOutcome> {
  // The sink guards itself (#298): an unquoted space would send `md5sum` a different file than the
  // one asked about, and every caller must get the same answer to "may this path be sent".
  if (!READABLE_PATH.test(path)) {
    return {
      ok: false,
      reason: 'bad-path',
      detail: `refusing to send ${JSON.stringify(path)}: a readable path is absolute and made of A-Z a-z 0-9 . _ - /`,
      text: '',
    };
  }
  await transport.tcpWrite(conn, encodeFrame(PTYPE_CTRL_MULTI, utf8(`md5sum ${path}`)));

  // Read until the answer is COMPLETE, not until the window closes (#300). The reply is one line, so
  // the window is only the upper bound for a machine that says nothing.
  let text = '';
  const deadline = Date.now() + windowMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const frame = await channel.next(remaining);
    if (frame === null) break;
    if (frame.type < 0x80) continue;
    text += decodeText(frame.data);
    if (MD5_NOT_FOUND.test(text) || MD5_DIGEST.test(text)) break;
  }

  // Two spellings, both read off the machine: `cat` says `File not found: <path>` and `md5sum` says
  // `Error: file not found [<path>]`. Matched case-insensitively and without the wrapper, because the
  // only thing worth keying on is the phrase, and a third spelling would otherwise read as success.
  if (MD5_NOT_FOUND.test(text)) {
    return { ok: false, reason: 'not-found', detail: text.trim(), text };
  }
  if (text.length === 0) {
    return { ok: false, reason: 'timeout', detail: `no reply to \`md5sum ${path}\``, text: '' };
  }
  // Anchor to the line start: the digest is followed immediately by the path, so there is no
  // separator to split on and a bare 32-hex search could match inside the filename.
  const match = MD5_DIGEST.exec(text);
  if (match === null) {
    return { ok: false, reason: 'unparsed', detail: `no digest in the reply: ${text.trim()}`, text };
  }
  return { ok: true, md5: match[1] ?? '', path, text };
}

const MD5_NOT_FOUND = /^(?:error: )?file not found/im;
const MD5_DIGEST = /^([0-9a-f]{32})/m;

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
  const windowMs = opts.windowMs ?? MD5_WINDOW_MS;
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

// ---------------------------------------------------------------------------
// Console (#302) — one typed line, the controller's reply
// ---------------------------------------------------------------------------

/**
 * Why this exists. `Makera-Parity.md` R10 and §8 used to say "no jog, MDI or console in the app". That
 * was a scoping decision made before the bridge existed, and the maintainer reopened it on 2026-10-08
 * (#302). What did NOT change is §8's safety rule: nothing is sent without an explicit user action,
 * and motion needs a person at the machine. So this is a console and not a passthrough: one line per
 * call, from a caller that was asked to send it, through the guards below.
 *
 * The guards are at the sink, the same place `READABLE_PATH` guards `cat` and `md5sum`: every caller —
 * the bench harness, the app panel, the bridge — gets the same answer to "may this line be sent".
 * The clauses themselves live in `engine/cnc/consoleGate.ts`, because the panel asks them before it
 * loads this module and must not import sockets to do it (#302 item 4). This is a relative import,
 * not the `@/` alias, because `tools/z1/z1.mjs` runs THIS file under Node, which resolves no alias.
 */
import { consolePipedProblem, consoleProblem } from '../../engine/cnc/consoleGate.ts';

export { consolePipedProblem, consoleProblem };

/**
 * A path a program may be started from: absolute, and nothing but path characters — no space, no
 * shell punctuation, no quote. The same shape `READABLE_PATH` guards `cat` and `md5sum` with, and for
 * the same reason: `play` is a lowercase SHELL line, so anything the shell would read as a second
 * word or a separator (`play /sd/a.nc; rm …`) must never be buildable from a caller's argument.
 */
const PLAYABLE_PATH = /^\/[A-Za-z0-9._/-]+$/;

/**
 * The one console line that STARTS a program, or null for a path that may not be played (#386 review).
 *
 * This is the run path the bench uses: upload the verified `.nc` (§5), then `play /sd/gcodes/<file>`,
 * polling the status every {@link MIN_STATUS_POLL_MS} or slower on the same connection (Z1-Bridge-
 * Protocol.md §8). It is built here, at the sink, from a checked path rather than accepted as a
 * free-text line — the same distinction `read` and `config` are built on. Which files may be played
 * at all (this session's uploads, or any file on the card) stays the open decision it is recorded as
 * in §8; this only refuses a path that is not a plain card path.
 */
export function playProgramLine(path: string): string | null {
  return PLAYABLE_PATH.test(path) ? `play ${path}` : null;
}

export interface ConsoleOptions {
  /** How long to wait for the FIRST reply frame. Default 3000. */
  firstReplyMs?: number;
  /** Quiet time after the last frame that ends the reply. Default 800. */
  quietMs?: number;
  /** Hard ceiling on one line, however chatty. Default 15000. */
  maxMs?: number;
}

/**
 * Frames that arrived with NO line in flight — the controller talking on its own, or the tail of a
 * macro whose reply window closed early (#386 item 3, `Z1-Firmware-Dialect.md` §11.9: `M491`'s
 * `M492.3 ERROR: Probe dead or not set…` lands tens of seconds after the line that started it).
 *
 * They are reported BESIDE a line's answer and never merged into it, because the reading that must
 * not happen is an old frame taken for the current answer: a `?` whose only "reply" was a stale
 * alarm is a poll that went UNANSWERED, and calling it `ok` with the state `Alarm` is how a finished
 * program's alarm becomes a running machine's state (`machineVacuum.ts` and `z1.mjs run` both read
 * that text as what the machine is doing now).
 */
export interface ConsoleCarried {
  /** The frames' text, verbatim, in arrival order. */
  text: string;
  frames: number;
}

/**
 * How long a line's send keeps reading for output that had ALREADY arrived before it wrote. Not a
 * wait for a reply, and emphatically not a wider quiet window.
 *
 * A frame sitting on the socket before the line went out is PROVEN to belong to no line this session
 * sent: the session is the only writer, and it writes one line at a time, so nothing it sent can be
 * being answered yet. That is the whole of the guarantee — everything arriving after the write is the
 * reply's, and stays the reply's, even when it is really the tail of the line before.
 *
 * Small on purpose: a longer window delays every press and separates the two cases no better, and a
 * zero window would never ask the socket at all (it would only empty the decoder's own queue), which
 * is why this is a couple of milliseconds rather than none.
 */
export const CARRY_READ_MS = 2;

export type ConsoleOutcome =
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

/** A console on one open connection; its channel survives from line to line. */
export interface ConsoleSession {
  send(line: string, opts?: ConsoleOptions): Promise<ConsoleOutcome>;
  /**
   * Read what has arrived with no line in flight, waiting up to `windowMs` after the last frame.
   *
   * `send` asks this before it writes, so a caller that wants the controller's own late output — the
   * bench harness before it leaves, say — asks the same question rather than inventing a second one.
   * `null` is "the socket was quiet", which is the ordinary answer.
   */
  late(windowMs: number): Promise<ConsoleCarried | null>;
}

/**
 * Open a console on an already-connected socket. The session owns ONE frame channel, because a reply
 * can straddle two lines (a move's "ok" arrives after the next prompt) and a fresh decoder per line
 * would drop the bytes between them.
 *
 * `?` goes out as the single status byte, exactly as {@link runStatus} sends it; every other line is
 * one multi-byte console frame.
 */
export function openConsole(transport: MachineTransport, conn: number): ConsoleSession {
  const channel = new FrameChannel(transport, conn);

  /**
   * Frames that arrive now, reading until `windowMs` of silence. The wait restarts after each frame,
   * so one window is a silence budget rather than a total one: the pre-send read (`CARRY_READ_MS`)
   * takes a burst whole, and a caller draining at the end of a session gets the macro that is still
   * talking instead of the part of it that fit in one window.
   */
  async function late(windowMs: number): Promise<ConsoleCarried | null> {
    const parts: string[] = [];
    let frames = 0;
    for (;;) {
      const next = await channel.next(windowMs);
      if (next === null) break;
      if (next.type < 0x80) continue; // not a reply to a console line
      parts.push(decodeText(next.data));
      frames++;
    }
    return frames === 0 ? null : { text: parts.join(''), frames };
  }

  return {
    async send(line, opts = {}) {
      const problem = consoleProblem(line);
      if (problem !== null) return { ok: false, reason: 'refused', line, detail: problem, text: '' };

      const firstReplyMs = opts.firstReplyMs ?? 3000;
      const quietMs = opts.quietMs ?? 800;
      const maxMs = opts.maxMs ?? 15000;

      // BEFORE the write, and that ordering is the whole of it (#386 item 3): whatever is here now
      // cannot be this line's reply, because this line has not gone out yet.
      const carried = await late(CARRY_READ_MS);

      const frame =
        line.trim() === '?'
          ? encodeFrame(PTYPE_CTRL_SINGLE, new Uint8Array([STATUS_POLL_BYTE]))
          : encodeFrame(PTYPE_CTRL_MULTI, utf8(line));
      const started = Date.now();
      await transport.tcpWrite(conn, frame);

      const parts: string[] = [];
      let frames = 0;
      let wait = firstReplyMs;
      for (;;) {
        const remaining = maxMs - (Date.now() - started);
        if (remaining <= 0) break;
        const next = await channel.next(Math.min(wait, remaining));
        if (next === null) break;
        if (next.type < 0x80) continue; // not a reply to a console line
        parts.push(decodeText(next.data));
        frames++;
        wait = quietMs; // once it has started talking, a short silence ends the reply
      }
      const text = parts.join('');
      const elapsedMs = Date.now() - started;
      const beside = carried === null ? {} : { carried };
      if (frames === 0) {
        return {
          ok: false,
          reason: 'timeout',
          line,
          detail: `no reply within ${firstReplyMs} ms of sending ${JSON.stringify(line)}`,
          text: '',
          ...beside,
        };
      }
      return { ok: true, line, text, frames, elapsedMs, ...beside };
    },

    late,
  };
}
