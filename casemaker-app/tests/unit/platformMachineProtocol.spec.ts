// #255 — the machine protocol, tested without a machine.
//
// Everything here runs against a scripted fake transport: the machine's replies are frames we build
// in the test, so the discover/identify/upload/status state machines are exercised end to end with
// no socket, no desktop build and no controller. The wire facts come from Z1-Bridge-Protocol.md.

import { describe, expect, it } from 'vitest';
import {
  crc16Ccitt,
  decodeText,
  encodeFrame,
  extractIpv4,
  extractMac,
  FrameDecoder,
  md5Hex,
  parseDiscoveryDatagram,
  readU32be,
  runDiscovery,
  runIdentify,
  runStatus,
  runUpload,
  u32be,
  utf8,
  PTYPE_CTRL_MULTI,
  PTYPE_CTRL_SINGLE,
  PTYPE_FILE_CANCEL,
  PTYPE_FILE_DATA,
  PTYPE_FILE_END,
  PTYPE_FILE_MD5,
  PTYPE_FILE_RETRY,
  PTYPE_FILE_START,
  PTYPE_FILE_VIEW,
  type Frame,
  type MachineTransport,
} from '@/platform/desktop/protocol';

const EMPTY = new Uint8Array(0);

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
  listenWindow = 0;

  queueRead(...chunks: Uint8Array[]): void {
    this.reads.push(...chunks);
  }

  async udpListen(port: number, windowMs: number): Promise<string[]> {
    this.listenPort = port;
    this.listenWindow = windowMs;
    return this.udpLines;
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

describe('#255 protocol — CRC and framing', () => {
  it('matches the CRC-16/XMODEM check value', () => {
    // init 0x0000, poly 0x1021 — the catalogue check value for "123456789".
    expect(crc16Ccitt(utf8('123456789'))).toBe(0x31c3);
  });

  it('encodes the exact envelope from the protocol document', () => {
    const frame = encodeFrame(PTYPE_CTRL_SINGLE, new Uint8Array([0x3f]));
    expect(Array.from(frame.slice(0, 2))).toEqual([0x86, 0x68]); // header
    expect(frame[2]).toBe(0x00); // length high
    expect(frame[3]).toBe(0x04); // length low = 1 + 1 + 2
    expect(frame[4]).toBe(PTYPE_CTRL_SINGLE); // type
    expect(frame[5]).toBe(0x3f); // data
    expect(Array.from(frame.slice(-2))).toEqual([0x55, 0xaa]); // footer
  });

  it('round-trips a frame and reassembles one split across chunks', () => {
    const frame = encodeFrame(PTYPE_CTRL_MULTI, utf8('M482.5'));
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.slice(0, 3))).toHaveLength(0);
    const frames = decoder.push(frame.slice(3));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe(PTYPE_CTRL_MULTI);
    expect(decodeText(frames[0]?.data ?? EMPTY)).toBe('M482.5');
    expect(decoder.resyncs).toBe(0);
  });

  it('keeps two frames delivered in one chunk', () => {
    const a = encodeFrame(PTYPE_CTRL_SINGLE, new Uint8Array([0x3f]));
    const b = encodeFrame(PTYPE_CTRL_MULTI, utf8('version'));
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a, 0);
    joined.set(b, a.length);
    const frames = new FrameDecoder().push(joined);
    expect(frames.map((f) => f.type)).toEqual([PTYPE_CTRL_SINGLE, PTYPE_CTRL_MULTI]);
    expect(decodeText(frames[1]?.data ?? EMPTY)).toBe('version');
  });

  it('rejects a corrupted frame instead of delivering it', () => {
    const frame = encodeFrame(PTYPE_CTRL_MULTI, utf8('M482.5'));
    const corrupt = frame.slice();
    corrupt[6] = (corrupt[6] ?? 0) ^ 0xff; // flip a data byte; CRC no longer matches
    const decoder = new FrameDecoder();
    expect(decoder.push(corrupt)).toHaveLength(0);
    expect(decoder.resyncs).toBeGreaterThan(0);
  });

  it('resyncs past leading garbage', () => {
    const frame = encodeFrame(PTYPE_CTRL_SINGLE, new Uint8Array([0x3f]));
    const withGarbage = new Uint8Array(frame.length + 5);
    withGarbage.set([0xde, 0xad, 0xbe, 0xef, 0x00], 0);
    withGarbage.set(frame, 5);
    const frames = new FrameDecoder().push(withGarbage);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe(PTYPE_CTRL_SINGLE);
  });
});

describe('#255 protocol — discovery', () => {
  it('parses a machine datagram', () => {
    expect(parseDiscoveryDatagram('CARVERA_AIR_01001,192.168.10.16,2222,0')).toEqual({
      name: 'CARVERA_AIR_01001',
      host: '192.168.10.16',
      port: 2222,
      busy: false,
    });
  });

  it('marks a busy machine and ignores trailing fields', () => {
    expect(parseDiscoveryDatagram('Z1,10.0.0.5,2222,1,extra')?.busy).toBe(true);
  });

  it('defaults a missing or non-numeric port to 2222', () => {
    expect(parseDiscoveryDatagram('Z1,10.0.0.5,,0')?.port).toBe(2222);
    expect(parseDiscoveryDatagram('Z1,10.0.0.5,notaport,0')?.port).toBe(2222);
  });

  it('discards datagrams the vendor client would discard', () => {
    expect(parseDiscoveryDatagram('Z1,10.0.0.5,2222')).toBeNull(); // four fields or fewer
    expect(parseDiscoveryDatagram(',10.0.0.5,2222,0')).toBeNull(); // no name
    expect(parseDiscoveryDatagram('Z1,,2222,0')).toBeNull(); // no address
    expect(parseDiscoveryDatagram('')).toBeNull();
  });

  it('deduplicates by name and preserves arrival order', async () => {
    const transport = new FakeTransport();
    transport.udpLines = [
      'A,10.0.0.1,2222,0',
      'B,10.0.0.2,2222,0',
      'A,10.0.0.9,2222,0', // same name repeated — ignored
      'badline',
    ];
    const found = await runDiscovery(transport, { port: 3333, windowMs: 20 });
    expect(found.map((m) => m.name)).toEqual(['A', 'B']);
    expect(found[0]?.host).toBe('10.0.0.1');
    expect(transport.listenPort).toBe(3333);
  });
});

describe('#255 protocol — identity extraction', () => {
  it('finds a plausible IPv4 and rejects impossible octets', () => {
    expect(extractIpv4('IP: 192.168.10.16')).toBe('192.168.10.16');
    expect(extractIpv4('no address here')).toBeNull();
    expect(extractIpv4('999.1.2.3')).toBeNull();
  });

  it('finds and normalises a MAC', () => {
    expect(extractMac('AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(extractMac('mac=AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(extractMac('nothing')).toBeNull();
  });

  it('sends M482.5 then M482.4 and keeps the raw replies', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(0x90, utf8('IP: 192.168.10.16')),
      EMPTY,
      encodeFrame(0x90, utf8('MAC: AA:BB:CC:DD:EE:FF')),
      EMPTY,
    );
    const id = await runIdentify(transport, 1, '192.168.10.16', { windowMs: 10 });
    expect(id.ip).toBe('192.168.10.16');
    expect(id.mac).toBe('aa:bb:cc:dd:ee:ff');

    const commands = decodeAll(transport.writes);
    expect(commands.map((f) => decodeText(f.data))).toEqual(['M482.5', 'M482.4']);
    expect(commands.every((f) => f.type === PTYPE_CTRL_MULTI)).toBe(true);
  });
});

describe('#255 protocol — status', () => {
  it('returns the controller status line verbatim', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(0x81, utf8('<Idle|MPos:0.000,0.000,0.000>')));
    const status = await runStatus(transport, 1, { windowMs: 10 });
    expect(status.ok).toBe(true);
    expect(status.text).toContain('Idle');

    const poll = decodeAll(transport.writes);
    expect(poll).toHaveLength(1);
    expect(poll[0]?.type).toBe(PTYPE_CTRL_SINGLE);
    expect(Array.from(poll[0]?.data ?? EMPTY)).toEqual([0x3f]);
  });

  it('reports no reply rather than inventing a state', async () => {
    const transport = new FakeTransport();
    const status = await runStatus(transport, 1, { windowMs: 10 });
    expect(status).toEqual({ ok: false, text: null, diagnostics: [] });
  });
});

describe('#255 protocol — file upload', () => {
  const content = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90]); // 9 bytes, 4-byte packets
  const packetSize = 4;
  const dataRequest = (seq: number): Uint8Array => encodeFrame(PTYPE_FILE_DATA, u32be(seq));

  it('drives the receiver-led transfer and reports success', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(PTYPE_FILE_VIEW, EMPTY),
      dataRequest(1),
      dataRequest(2),
      dataRequest(3),
      encodeFrame(PTYPE_FILE_END, EMPTY),
    );
    const outcome = await runUpload(transport, 1, 'badge.nc', content, { packetSize, inactivityMs: 50 });
    expect(outcome).toEqual({ ok: true, bytes: 9, packets: 3, alreadyPresent: false });

    const frames = decodeAll(transport.writes);
    expect(frames[0]?.type).toBe(PTYPE_FILE_START);
    expect(decodeText(frames[0]?.data ?? EMPTY)).toBe('upload badge.nc\n');
    expect(frames[1]?.type).toBe(PTYPE_FILE_MD5);
    expect(decodeText(frames[1]?.data ?? EMPTY)).toBe(md5Hex(content));

    expect(frames[2]?.type).toBe(PTYPE_FILE_VIEW);
    const view = frames[2]?.data ?? EMPTY;
    expect(readU32be(view.slice(0, 4))).toBe(3); // packet count
    expect(view[4]).toBe(0); // packet size high
    expect(view[5]).toBe(4); // packet size low

    expect(frames[3]?.type).toBe(PTYPE_FILE_DATA);
    const d1 = frames[3]?.data ?? EMPTY;
    expect(readU32be(d1)).toBe(1);
    expect(Array.from(d1.slice(4))).toEqual([10, 20, 30, 40]);

    const d3 = frames[5]?.data ?? EMPTY;
    expect(readU32be(d3)).toBe(3);
    expect(Array.from(d3.slice(4))).toEqual([90]);
  });

  it('treats a cancel before any data request as "already present"', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(PTYPE_FILE_CANCEL, EMPTY));
    const outcome = await runUpload(transport, 1, 'badge.nc', content, { packetSize, inactivityMs: 50 });
    expect(outcome).toEqual({ ok: true, bytes: 9, packets: 0, alreadyPresent: true });
  });

  it('reports a cancel after data began as a refusal, with no retry', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(PTYPE_FILE_VIEW, EMPTY),
      dataRequest(1),
      encodeFrame(PTYPE_FILE_CANCEL, EMPTY),
    );
    const outcome = await runUpload(transport, 1, 'badge.nc', content, { packetSize, inactivityMs: 50 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('refused');
      expect(outcome.detail).toMatch(/rejected|refus/i);
    }
  });

  it('re-sends the exact previous data frame on a retry', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(PTYPE_FILE_VIEW, EMPTY),
      dataRequest(1),
      encodeFrame(PTYPE_FILE_RETRY, EMPTY),
      dataRequest(2),
      encodeFrame(PTYPE_FILE_END, EMPTY),
    );
    const outcome = await runUpload(transport, 1, 'badge.nc', content, { packetSize, inactivityMs: 50 });
    expect(outcome.ok).toBe(true);
    const frames = decodeAll(transport.writes);
    const dataFrames = frames.filter((f) => f.type === PTYPE_FILE_DATA);
    expect(dataFrames).toHaveLength(3); // packet 1, the retry of packet 1, packet 2
    expect(Array.from(dataFrames[0]?.data ?? EMPTY)).toEqual(Array.from(dataFrames[1]?.data ?? EMPTY));
    expect(readU32be(dataFrames[2]?.data ?? EMPTY)).toBe(2);
  });

  it('cancels and reports a timeout when the machine goes quiet', async () => {
    const transport = new FakeTransport();
    const outcome = await runUpload(transport, 1, 'badge.nc', content, { packetSize, inactivityMs: 20 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('timeout');
    const last = decodeAll(transport.writes).at(-1);
    expect(last?.type).toBe(PTYPE_FILE_CANCEL);
  });

  it('encodes a transfer name the way the machine expects', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(PTYPE_FILE_CANCEL, EMPTY));
    await runUpload(transport, 1, 'my badge.nc', new Uint8Array([1]), { packetSize, inactivityMs: 20 });
    const first = decodeAll(transport.writes)[0];
    // Space becomes 0x01 (a raw space would split the command).
    expect(decodeText(first?.data ?? EMPTY)).toBe(`upload my\u0001badge.nc\n`);
  });
});

describe('#255 protocol — MD5', () => {
  it('matches the RFC 1321 test vectors', () => {
    expect(md5Hex(utf8(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex(utf8('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex(utf8('message digest'))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5Hex(utf8('abcdefghijklmnopqrstuvwxyz'))).toBe('c3fcd3d76192e4007dfb496cca67e13b');
    expect(md5Hex(utf8('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))).toBe(
      '57edf4a22be3c955ac49da2e2107b67a',
    );
  });
});
