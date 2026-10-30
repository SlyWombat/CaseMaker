// #255 — the machine bridge's public surface: the verified-only gate and the four actions.
//
// `@tauri-apps/api/core` is mocked because these tests never touch a socket; the transport is
// injected. That injection is the USB seam too, so the same tests cover the shape a second
// transport must satisfy.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
  asVerifiedProgram,
  checkSerial,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_SERIAL_BAUD,
  DESKTOP_ONLY_MARKER,
  discover,
  identify,
  listSerialPorts,
  openConsoleSession,
  status,
  uploadVerifiedProgram,
  QUICKLZ_UPLOAD_THRESHOLD,
  type VerifiedProgram,
} from '@/platform/desktop/machineBridge';
import { quicklzCompress } from '@/platform/desktop/quicklz';
import { KNOWN_DEFAULTS } from '@/platform/defaultsClient';
import { DEFAULT_SERIAL_BAUD as SERIAL_MODULE_BAUD } from '@/platform/machineSerial';
import {
  decodeText,
  encodeFrame,
  FrameDecoder,
  PTYPE_CTRL_MULTI,
  PTYPE_CTRL_SINGLE,
  PTYPE_FILE_CANCEL,
  PTYPE_FILE_DATA,
  PTYPE_FILE_MD5,
  PTYPE_FILE_END,
  PTYPE_FILE_START,
  PTYPE_FILE_VIEW,
  md5Hex,
  STATUS_POLL_BYTE,
  u32be,
  utf8,
  type Frame,
  type MachineTransport,
  type UdpDatagram,
} from '@/platform/desktop/protocol';
import type { VerifyReport } from '@/engine/cnc/verify';
import { verifyCheck, type ProgramCheck } from '@/engine/cnc/uploadGate';

const EMPTY = new Uint8Array(0);
const CONTENT = new Uint8Array([1, 2, 3]);

const okReport: VerifyReport = {
  ok: true,
  findings: [],
  stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0], max: [0, 0, 0] } },
};

const badReport: VerifyReport = {
  ok: false,
  findings: [{ severity: 'error', code: 'cut-too-deep', line: 3, message: 'a cutting move is too deep' }],
  stats: { lines: 1, cuttingMoves: 1, deepestZ: -5, bbox: { min: [0, 0, -5], max: [1, 1, 0] } },
};

/** One frame per write in this fake, so a fresh decoder per write is enough. */
function decodeAll(writes: Uint8Array[]): Frame[] {
  const out: Frame[] = [];
  for (const write of writes) out.push(...new FrameDecoder().push(write));
  return out;
}

class FakeTransport implements MachineTransport {
  writes: Uint8Array[] = [];
  reads: Uint8Array[] = [];
  udpLines: string[] = [];
  connects = 0;
  closed: number[] = [];
  listenPort: number | null = null;
  /** The timeout each `tcpConnect` was asked for — how a spec sees which connect window was used. */
  connectTimeouts: number[] = [];

  queueRead(...chunks: Uint8Array[]): void {
    this.reads.push(...chunks);
  }
  async udpListen(port: number, _windowMs: number): Promise<UdpDatagram[]> {
    this.listenPort = port;
    // The bridge reads the text and nothing else, so a fixed arrival time is enough here (#275).
    return this.udpLines.map((text) => ({ at: 0, text }));
  }
  async tcpConnect(_host: string, _port: number, timeoutMs: number): Promise<number> {
    this.connects++;
    this.connectTimeouts.push(timeoutMs);
    return 1;
  }
  async tcpWrite(_conn: number, data: Uint8Array): Promise<void> {
    this.writes.push(data);
  }
  async tcpRead(_conn: number, _max: number, _timeoutMs: number): Promise<Uint8Array> {
    return this.reads.shift() ?? EMPTY;
  }
  async tcpClose(conn: number): Promise<void> {
    this.closed.push(conn);
  }
}

describe('#255 machine bridge — the desktop boundary', () => {
  it('keeps the marker the platform-gate check greps for', () => {
    expect(DESKTOP_ONLY_MARKER).toBe('casemaker-desktop-bridge-v1');
  });
});

describe('#449 the connect timeout is a shop default with a labelled fallback', () => {
  it('the compiled fallback is the registry’s machine.connectTimeoutMs fallback', () => {
    expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(KNOWN_DEFAULTS['machine.connectTimeoutMs']!.fallback);
  });

  it('uses the fallback when the caller passes no timeout, and the caller’s number when it does', async () => {
    const fallback = new FakeTransport();
    await identify({ host: '192.168.10.43', port: 2222 }, { transport: fallback });
    expect(fallback.connectTimeouts).toEqual([DEFAULT_CONNECT_TIMEOUT_MS]);

    const chosen = new FakeTransport();
    await identify({ host: '192.168.10.43', port: 2222 }, { transport: chosen, connectTimeoutMs: 750 });
    expect(chosen.connectTimeouts).toEqual([750]);
  });

  it('every connect site reads the one constant rather than restating a literal', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'platform', 'desktop', 'machineBridge.ts'), 'utf8');
    // identify, status, #775's serial check, readConfigValues, uploadVerifiedProgram,
    // sendConsoleLine, openConsoleSession, and #772's two card commands (listSdFiles, deleteSdFile).
    expect(src.match(/opts\.connectTimeoutMs \?\? DEFAULT_CONNECT_TIMEOUT_MS/g)).toHaveLength(9);
    expect(src).not.toMatch(/connectTimeoutMs \?\? \d/);
  });
});

describe('#255 machine bridge — verified-only gate', () => {
  it('produces a VerifiedProgram only for an ok .nc report', () => {
    expect(asVerifiedProgram('badge.nc', CONTENT, verifyCheck(okReport))).not.toBeNull();
    expect(asVerifiedProgram('badge.nc', CONTENT, verifyCheck(badReport))).toBeNull();
    expect(asVerifiedProgram('badge.txt', CONTENT, verifyCheck(okReport))).toBeNull();
  });

  it('refuses a report with an error finding even if the ok flag says otherwise', () => {
    const lying: VerifyReport = { ...okReport, findings: badReport.findings };
    expect(asVerifiedProgram('badge.nc', CONTENT, verifyCheck(lying))).toBeNull();
  });

  it('#535 — accepts a surface check, and the upload gate still asks the one predicate', async () => {
    const surface: ProgramCheck = {
      kind: 'surface',
      gridPitchMm: 0.1,
      roughingLayers: 3,
      resolutionNote: 'sampled on a 0.1 mm grid',
      bbox: { min: [0, 0], max: [20, 20] },
    };
    expect(asVerifiedProgram('goal.nc', CONTENT, surface)).not.toBeNull();
    // The filename clause applies to a surface program too: a name that is not a .nc is refused.
    expect(asVerifiedProgram('goal.txt', CONTENT, surface)).toBeNull();
  });

  it('refuses an unverified program at upload time without opening a socket', async () => {
    // Structurally a VerifiedProgram — the runtime re-check is what refuses it.
    const forged: VerifiedProgram = { filename: 'badge.nc', content: CONTENT, check: verifyCheck(badReport) };
    const transport = new FakeTransport();
    const outcome = await uploadVerifiedProgram({ host: '10.0.0.1' }, forged, { transport });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toMatch(/verifier/i);
    expect(transport.connects).toBe(0);
  });

  it('refuses a non-.nc program at upload time without opening a socket', async () => {
    const forged: VerifiedProgram = { filename: 'badge.txt', content: CONTENT, check: verifyCheck(okReport) };
    const transport = new FakeTransport();
    const outcome = await uploadVerifiedProgram({ host: '10.0.0.1' }, forged, { transport });
    expect(outcome.ok).toBe(false);
    expect(transport.connects).toBe(0);
  });
});

describe('#255 machine bridge — actions', () => {
  it('uploads a verified program and closes the connection afterwards', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(PTYPE_FILE_VIEW, EMPTY),
      encodeFrame(PTYPE_FILE_DATA, u32be(1)),
      encodeFrame(PTYPE_FILE_END, EMPTY),
    );
    const program = asVerifiedProgram('badge.nc', CONTENT, verifyCheck(okReport));
    expect(program).not.toBeNull();
    if (program === null) throw new Error('expected a verified program');

    const outcome = await uploadVerifiedProgram({ host: '10.0.0.1', port: 2222 }, program, {
      transport,
      packetSize: 8,
    });
    expect(outcome).toEqual({ ok: true, bytes: 3, packets: 1, alreadyPresent: false });
    expect(transport.connects).toBe(1);
    expect(transport.closed).toEqual([1]);
  });

  it('names the destination as an absolute path under the job directory', async () => {
    // The first live upload (2026-10-07) sent the bare name and the machine answered
    // `Error: failed to open file [/165-depth-ladder.nc]!` — it resolved the name against the card
    // root. The gate is in `runUpload`; this pins that the BRIDGE hands it a path, since the bridge
    // builds that path itself and a regression here would be invisible to every other test.
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(PTYPE_FILE_VIEW, EMPTY),
      encodeFrame(PTYPE_FILE_END, EMPTY),
    );
    const program = asVerifiedProgram('badge.nc', CONTENT, verifyCheck(okReport));
    if (program === null) throw new Error('expected a verified program');

    await uploadVerifiedProgram({ host: '10.0.0.1', port: 2222 }, program, {
      transport,
      packetSize: 8,
    });

    const start = decodeAll(transport.writes).find((f) => f.type === PTYPE_FILE_START);
    expect(start).toBeDefined();
    expect(decodeText(start!.data)).toBe('upload /sd/gcodes/badge.nc\n');
  });

  // #562 — compressed uploads, opt-in. Studio's form (RE 05): over 4 KB the payload is QuickLZ and
  // the destination gains `.bin`; the MD5 step hashes what the machine stores (the compressed bytes),
  // and a controller that refuses the compressed file gets the plain one instead.
  describe('#562 compressed uploads', () => {
    /** A program big enough to compress: repeated G-code, which is what a real `.nc` is. */
    const BIG = new TextEncoder().encode('G1 X10.000 Y10.000 F600\nG1 Z-0.200\n'.repeat(220));

    function uploadedContent(writes: Uint8Array[]): { paths: string[]; md5s: string[]; payload: Uint8Array } {
      const frames = decodeAll(writes);
      const paths: string[] = [];
      const md5s: string[] = [];
      const chunks: number[] = [];
      for (const f of frames) {
        if (f.type === PTYPE_FILE_START) paths.push(decodeText(f.data).trim());
        else if (f.type === PTYPE_FILE_MD5) md5s.push(decodeText(f.data));
        else if (f.type === PTYPE_FILE_DATA) chunks.push(...f.data.subarray(4));
      }
      return { paths, md5s, payload: new Uint8Array(chunks) };
    }

    it('sends the compressed bytes to `<name>.bin` and an MD5 of those bytes when the location asks', async () => {
      expect(BIG.length).toBeGreaterThan(QUICKLZ_UPLOAD_THRESHOLD);
      const packed = quicklzCompress(BIG);
      expect(packed).not.toBeNull();

      const transport = new FakeTransport();
      transport.queueRead(
        encodeFrame(PTYPE_FILE_VIEW, EMPTY),
        encodeFrame(PTYPE_FILE_DATA, u32be(1)),
        encodeFrame(PTYPE_FILE_END, EMPTY),
      );
      const program = asVerifiedProgram('badge.nc', BIG, verifyCheck(okReport))!;
      const outcome = await uploadVerifiedProgram({ host: '10.0.0.1', port: 2222 }, program, {
        transport,
        packetSize: 4096,
        compress: 'quicklz',
      });

      expect(outcome).toEqual({ ok: true, bytes: packed!.length, packets: 1, alreadyPresent: false, compressed: true });
      const sent = uploadedContent(transport.writes);
      expect(sent.paths).toEqual(['upload /sd/gcodes/badge.nc.bin']);
      // The digest is of what the machine STORES — the compressed stream, not the original program.
      expect(sent.md5s[0]).toBe(md5Hex(packed!));
      expect(sent.payload).toEqual(packed!);
    });

    it('leaves a small program plain even when compression is asked for', async () => {
      const transport = new FakeTransport();
      transport.queueRead(encodeFrame(PTYPE_FILE_VIEW, EMPTY), encodeFrame(PTYPE_FILE_DATA, u32be(1)), encodeFrame(PTYPE_FILE_END, EMPTY));
      const program = asVerifiedProgram('badge.nc', CONTENT, verifyCheck(okReport))!;
      const outcome = await uploadVerifiedProgram({ host: '10.0.0.1', port: 2222 }, program, { transport, packetSize: 8, compress: 'quicklz' });
      expect(outcome.ok).toBe(true);
      const sent = uploadedContent(transport.writes);
      expect(sent.paths).toEqual(['upload /sd/gcodes/badge.nc']);
      expect(sent.md5s[0]).toBe(md5Hex(CONTENT));
    });

    it('falls back to the plain file when the controller refuses the compressed one, and says so', async () => {
      const transport = new FakeTransport();
      // First attempt: the machine asks for data, then cancels mid-transfer — a refusal.
      transport.queueRead(
        encodeFrame(PTYPE_FILE_VIEW, EMPTY),
        encodeFrame(PTYPE_FILE_DATA, u32be(1)),
        encodeFrame(PTYPE_FILE_CANCEL, utf8('Error: unknown file type')),
        // Second attempt (plain): an ordinary accepted transfer.
        encodeFrame(PTYPE_FILE_VIEW, EMPTY),
        encodeFrame(PTYPE_FILE_DATA, u32be(1)),
        encodeFrame(PTYPE_FILE_END, EMPTY),
      );
      const program = asVerifiedProgram('badge.nc', BIG, verifyCheck(okReport))!;
      const outcome = await uploadVerifiedProgram({ host: '10.0.0.1', port: 2222 }, program, {
        transport,
        packetSize: 4096,
        compress: 'quicklz',
      });

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('expected the plain retry to be accepted');
      expect(outcome.compressed).toBeUndefined();
      expect(outcome.fallback).toContain('compressed upload');
      expect(outcome.fallback).toContain('unknown file type');
      const sent = uploadedContent(transport.writes);
      // Two uploads: the refused `.bin`, then the plain program — with ITS OWN digest.
      expect(sent.paths).toEqual(['upload /sd/gcodes/badge.nc.bin', 'upload /sd/gcodes/badge.nc']);
      expect(sent.md5s[1]).toBe(md5Hex(BIG));
    });

    it('does not compress unless the location asks', async () => {
      const transport = new FakeTransport();
      transport.queueRead(
        encodeFrame(PTYPE_FILE_VIEW, EMPTY),
        encodeFrame(PTYPE_FILE_DATA, u32be(1)),
        encodeFrame(PTYPE_FILE_DATA, u32be(2)),
        encodeFrame(PTYPE_FILE_END, EMPTY),
      );
      const program = asVerifiedProgram('badge.nc', BIG, verifyCheck(okReport))!;
      await uploadVerifiedProgram({ host: '10.0.0.1', port: 2222 }, program, { transport, packetSize: 4096 });
      const sent = uploadedContent(transport.writes);
      expect(sent.paths).toEqual(['upload /sd/gcodes/badge.nc']);
      expect(sent.payload).toEqual(BIG);
    });
  });

  it('honours a caller-chosen directory instead of the default', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(PTYPE_FILE_VIEW, EMPTY), encodeFrame(PTYPE_FILE_END, EMPTY));
    const program = asVerifiedProgram('badge.nc', CONTENT, verifyCheck(okReport));
    if (program === null) throw new Error('expected a verified program');

    await uploadVerifiedProgram({ host: '10.0.0.1', port: 2222 }, program, {
      transport,
      packetSize: 8,
      directory: '/sd/gcodes/sub/',
    });

    const start = decodeAll(transport.writes).find((f) => f.type === PTYPE_FILE_START);
    expect(decodeText(start!.data)).toBe('upload /sd/gcodes/sub/badge.nc\n');
  });

  it('discovers on UDP 3333 by default', async () => {
    const transport = new FakeTransport();
    transport.udpLines = ['Z1,10.0.0.5,2222,0'];
    const found = await discover({ transport });
    expect(found.map((m) => m.name)).toEqual(['Z1']);
    expect(transport.listenPort).toBe(3333);
  });

  it('identifies a machine and closes the connection', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(0x90, utf8('192.168.10.16')),
      EMPTY,
      encodeFrame(0x90, utf8('AA:BB:CC:DD:EE:FF')),
      EMPTY,
    );
    const identity = await identify({ host: '192.168.10.16' }, { transport });
    expect(identity.ip).toBe('192.168.10.16');
    expect(identity.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(transport.closed).toEqual([1]);
  });

  it('reads status and closes the connection', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(0x81, utf8('<Idle|MPos:0,0,0>')));
    const machineStatus = await status({ host: '10.0.0.1' }, { transport });
    expect(machineStatus.ok).toBe(true);
    expect(machineStatus.text).toContain('Idle');
    expect(transport.closed).toEqual([1]);
  });
});

// #302 item 4 — the app's console panel keeps ONE session, rather than a connect per line, so a
// reply that straddles the next line is still attributed to the line that caused it.
describe('#302 openConsoleSession — one connection, replies kept with their line', () => {
  /**
   * A transport whose replies are scripted PER LINE: `script[i]` answers the i-th write. A flat queue
   * of reads would let the second line's reply be read as part of the first line's answer — the very
   * confusion the session's single frame channel exists to prevent — so the fake must not create it.
   */
  class ScriptedConsoleTransport extends FakeTransport {
    script: Uint8Array[][] = [];
    private pending: Uint8Array[] = [];

    override async tcpWrite(conn: number, data: Uint8Array): Promise<void> {
      await super.tcpWrite(conn, data);
      this.pending = [...(this.script[this.writes.length - 1] ?? [])];
    }

    override async tcpRead(): Promise<Uint8Array> {
      return this.pending.shift() ?? EMPTY;
    }
  }

  it('sends two lines on one connection, and closes that connection once', async () => {
    const transport = new ScriptedConsoleTransport();
    transport.script = [
      [encodeFrame(0x81, utf8('<Idle|MPos:0,0,0>'))],
      [encodeFrame(0x81, utf8('ok'))],
    ];

    const live = await openConsoleSession({ host: '192.168.10.43', port: 2222 }, { transport });
    expect(transport.connects).toBe(1);

    const first = await live.send('?');
    const second = await live.send('M491');
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.text).toBe('<Idle|MPos:0,0,0>');
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.text).toBe('ok');

    // Still the one connection, and still nothing closed until the panel says so.
    expect(transport.connects).toBe(1);
    expect(transport.closed).toEqual([]);
    await live.close();
    expect(transport.closed).toEqual([1]);

    // The first line went out as the single status byte and the second as a console frame, exactly
    // as `runStatus` and `openConsole` send them.
    const frames = decodeAll(transport.writes);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.type).toBe(PTYPE_CTRL_SINGLE);
    expect(frames[0]!.data).toEqual(new Uint8Array([STATUS_POLL_BYTE]));
    expect(frames[1]!.type).toBe(PTYPE_CTRL_MULTI);
    expect(decodeText(frames[1]!.data)).toBe('M491');
  });

  it('joins a reply split across two frames to the line that caused it, not to the next one', async () => {
    // The reason the session owns one channel: the second frame of a reply can arrive after the next
    // line has gone out. A decoder built per line would read it as that line's answer.
    const transport = new ScriptedConsoleTransport();
    transport.script = [
      [encodeFrame(0x81, utf8('<Idle')), encodeFrame(0x81, utf8('|MPos:0,0,0>'))],
      [encodeFrame(0x81, utf8('ok'))],
    ];

    const live = await openConsoleSession({ host: '192.168.10.43' }, { transport });
    const first = await live.send('?');
    const second = await live.send('M491');

    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.frames).toBe(2);
      expect(first.text).toBe('<Idle|MPos:0,0,0>');
    }
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.frames).toBe(1);
      expect(second.text).toBe('ok');
    }
  });

  it('refuses a guarded line without writing it, on a session that is already open', async () => {
    const transport = new ScriptedConsoleTransport();
    transport.script = [[encodeFrame(0x81, utf8('ok'))]];
    const live = await openConsoleSession({ host: '192.168.10.43' }, { transport });

    const refused = await live.send('config-set sd x 1');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.detail).toContain('configuration value');
    // Nothing went out, and the session is still usable: a refusal is not a broken connection.
    expect(transport.writes).toEqual([]);
    const after = await live.send('?');
    expect(after.ok).toBe(true);
  });
});

// #775 — the serial arm. The transport is injected here exactly as it is for TCP, which is the
// claim the feature rests on: everything above `connect` is the same code, and the only serial
// thing about it is which connect was called.
describe('#775 machine bridge — USB serial is the same protocol over a second transport', () => {
  /** Reads scripted per write, like ScriptedConsoleTransport: each ask gets its own reply, and a
   *  drain ends on the empty read that follows rather than swallowing the next ask's frames. */
  class FakeSerialTransport extends FakeTransport {
    serialConns = 0;
    serialOpened: Array<{ port: string; baud: number; timeoutMs: number }> = [];
    ports = [
      { portName: 'COM4', label: 'USB-SERIAL CH340', usb: true },
      { portName: 'COM7', label: '', usb: false },
    ];
    script: Uint8Array[][] = [];
    private pendingReads: Uint8Array[] = [];

    override async tcpWrite(conn: number, data: Uint8Array): Promise<void> {
      await super.tcpWrite(conn, data);
      this.pendingReads = [...(this.script[this.writes.length - 1] ?? [])];
    }

    override async tcpRead(): Promise<Uint8Array> {
      return this.pendingReads.shift() ?? EMPTY;
    }

    async serialList() {
      return this.ports;
    }

    async serialConnect(port: string, baud: number, timeoutMs: number): Promise<number> {
      this.serialConns += 1;
      this.serialOpened.push({ port, baud, timeoutMs });
      return 2;
    }
  }

  it('the UI module and the bridge agree on the fallback baud', () => {
    expect(SERIAL_MODULE_BAUD).toBe(DEFAULT_SERIAL_BAUD);
  });

  it('lists ports without touching a socket', async () => {
    const transport = new FakeSerialTransport();
    expect(await listSerialPorts({ transport })).toEqual(transport.ports);
    expect(transport.connects).toBe(0);
    expect(transport.serialConns).toBe(0);
  });

  it('a transport with no serial calls lists nothing — the LAN browser’s answer', async () => {
    expect(await listSerialPorts({ transport: new FakeTransport() })).toEqual([]);
  });

  it('identify over serial sends the same M482.5/M482.4 frames as over TCP', async () => {
    const transport = new FakeSerialTransport();
    transport.script = [
      [encodeFrame(0x81, utf8('STA param[5]:192.168.10.43'))],
      [encodeFrame(0x81, utf8('STA param[4]:AA-BB-CC-DD-EE-FF'))],
    ];

    const identity = await identify({ serialPort: 'COM4' }, { transport });

    expect(transport.serialOpened).toEqual([
      { port: 'COM4', baud: DEFAULT_SERIAL_BAUD, timeoutMs: DEFAULT_CONNECT_TIMEOUT_MS },
    ]);
    expect(transport.connects).toBe(0);
    expect(identity.host).toBe('COM4');
    expect(identity.ip).toBe('192.168.10.43');
    expect(identity.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(decodeAll(transport.writes).map((f) => decodeText(f.data))).toEqual(['M482.5', 'M482.4']);
    expect(transport.closed).toEqual([2]);
  });

  it('checkSerial asks identify and status on ONE connection', async () => {
    const transport = new FakeSerialTransport();
    transport.script = [
      [encodeFrame(0x81, utf8('STA param[5]:192.168.10.43'))],
      [encodeFrame(0x81, utf8('STA param[4]:AA-BB-CC-DD-EE-FF'))],
      [encodeFrame(0x81, utf8('<Idle|MPos:0.000,0.000,0.000>'))],
    ];

    const check = await checkSerial({ serialPort: 'COM5', baud: 57_600 }, { transport });

    expect(transport.serialOpened).toEqual([
      { port: 'COM5', baud: 57_600, timeoutMs: DEFAULT_CONNECT_TIMEOUT_MS },
    ]);
    expect(transport.serialConns).toBe(1); // one open for both asks: a CDC port may reset on close
    expect(transport.connects).toBe(0);
    expect(check.port).toBe('COM5');
    expect(check.baud).toBe(57_600);
    expect(check.identity.ip).toBe('192.168.10.43');
    expect(check.status?.text).toContain('Idle');
    expect(transport.closed).toEqual([2]);
  });

  it('a serial target on a transport without serial calls is refused, not sent to DNS', async () => {
    await expect(identify({ serialPort: 'COM4' }, { transport: new FakeTransport() })).rejects.toThrow(
      /Serial connections are available only in the desktop app/,
    );
  });
});
