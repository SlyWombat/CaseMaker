// #255 — the machine bridge's public surface: the verified-only gate and the four actions.
//
// `@tauri-apps/api/core` is mocked because these tests never touch a socket; the transport is
// injected. That injection is the USB seam too, so the same tests cover the shape a second
// transport must satisfy.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
  asVerifiedProgram,
  DESKTOP_ONLY_MARKER,
  discover,
  identify,
  openConsoleSession,
  status,
  uploadVerifiedProgram,
  type VerifiedProgram,
} from '@/platform/desktop/machineBridge';
import {
  decodeText,
  encodeFrame,
  FrameDecoder,
  PTYPE_CTRL_MULTI,
  PTYPE_CTRL_SINGLE,
  PTYPE_FILE_DATA,
  PTYPE_FILE_END,
  PTYPE_FILE_START,
  PTYPE_FILE_VIEW,
  STATUS_POLL_BYTE,
  u32be,
  utf8,
  type Frame,
  type MachineTransport,
  type UdpDatagram,
} from '@/platform/desktop/protocol';
import type { VerifyReport } from '@/engine/cnc/verify';

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

  queueRead(...chunks: Uint8Array[]): void {
    this.reads.push(...chunks);
  }
  async udpListen(port: number, _windowMs: number): Promise<UdpDatagram[]> {
    this.listenPort = port;
    // The bridge reads the text and nothing else, so a fixed arrival time is enough here (#275).
    return this.udpLines.map((text) => ({ at: 0, text }));
  }
  async tcpConnect(_host: string, _port: number, _timeoutMs: number): Promise<number> {
    this.connects++;
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

describe('#255 machine bridge — verified-only gate', () => {
  it('produces a VerifiedProgram only for an ok .nc report', () => {
    expect(asVerifiedProgram('badge.nc', CONTENT, okReport)).not.toBeNull();
    expect(asVerifiedProgram('badge.nc', CONTENT, badReport)).toBeNull();
    expect(asVerifiedProgram('badge.txt', CONTENT, okReport)).toBeNull();
  });

  it('refuses a report with an error finding even if the ok flag says otherwise', () => {
    const lying: VerifyReport = { ...okReport, findings: badReport.findings };
    expect(asVerifiedProgram('badge.nc', CONTENT, lying)).toBeNull();
  });

  it('refuses an unverified program at upload time without opening a socket', async () => {
    // Structurally a VerifiedProgram — the runtime re-check is what refuses it.
    const forged: VerifiedProgram = { filename: 'badge.nc', content: CONTENT, report: badReport };
    const transport = new FakeTransport();
    const outcome = await uploadVerifiedProgram({ host: '10.0.0.1' }, forged, { transport });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toMatch(/verifier/i);
    expect(transport.connects).toBe(0);
  });

  it('refuses a non-.nc program at upload time without opening a socket', async () => {
    const forged: VerifiedProgram = { filename: 'badge.txt', content: CONTENT, report: okReport };
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
    const program = asVerifiedProgram('badge.nc', CONTENT, okReport);
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
    const program = asVerifiedProgram('badge.nc', CONTENT, okReport);
    if (program === null) throw new Error('expected a verified program');

    await uploadVerifiedProgram({ host: '10.0.0.1', port: 2222 }, program, {
      transport,
      packetSize: 8,
    });

    const start = decodeAll(transport.writes).find((f) => f.type === PTYPE_FILE_START);
    expect(start).toBeDefined();
    expect(decodeText(start!.data)).toBe('upload /sd/gcodes/badge.nc\n');
  });

  it('honours a caller-chosen directory instead of the default', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(PTYPE_FILE_VIEW, EMPTY), encodeFrame(PTYPE_FILE_END, EMPTY));
    const program = asVerifiedProgram('badge.nc', CONTENT, okReport);
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
