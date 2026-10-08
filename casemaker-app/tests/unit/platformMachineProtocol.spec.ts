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
  readConfigKey,
  runMd5Sum,
  runReadFile,
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
  type Md5SumOutcome,
  type ReadConfigKeyOutcome,
  type ReadFileOutcome,
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
  /** The timeout each `tcpRead` was asked for — how a spec sees which window a caller chose. */
  readTimeouts: number[] = [];

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
  async tcpRead(_conn: number, _max: number, timeoutMs: number): Promise<Uint8Array> {
    this.readTimeouts.push(timeoutMs);
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
    const outcome = await runUpload(transport, 1, '/sd/gcodes/badge.nc', content, { packetSize, inactivityMs: 50 });
    expect(outcome).toEqual({ ok: true, bytes: 9, packets: 3, alreadyPresent: false });

    const frames = decodeAll(transport.writes);
    expect(frames[0]?.type).toBe(PTYPE_FILE_START);
    expect(decodeText(frames[0]?.data ?? EMPTY)).toBe('upload /sd/gcodes/badge.nc\n');
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

  it('returns "already present" for a pre-data cancel only once the machine confirms the digest', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(PTYPE_FILE_CANCEL, EMPTY),
      // The machine runs the digest into the path with no separator (the §5 quirk `runMd5Sum` reads).
      encodeFrame(0x90, utf8(`${md5Hex(content)}/sd/gcodes/badge.nc`)),
    );
    const outcome = await runUpload(transport, 1, '/sd/gcodes/badge.nc', content, { packetSize, inactivityMs: 50 });
    expect(outcome).toEqual({ ok: true, bytes: 9, packets: 0, alreadyPresent: true });
    // The claim was CHECKED, not assumed — that round trip is the whole point of this fix.
    const asked = decodeAll(transport.writes).at(-1);
    expect(decodeText(asked?.data ?? EMPTY)).toBe('md5sum /sd/gcodes/badge.nc');
  });

  // The live run on 2026-10-07 found this: the machine answered a bare-name upload with
  // `Error: failed to open file [/165-depth-ladder.nc]!` and the bridge reported a SUCCESSFUL
  // UPLOAD, because every pre-data cancel was read as "already present". An operator is told the
  // file is on the machine when it is not. Both halves are pinned here: the machine's words reach
  // the caller, and the missing file is what decides.
  it('reports a pre-data cancel as a REFUSAL when the machine does not hold that file', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(PTYPE_FILE_CANCEL, utf8('Error: failed to open file [/165-depth-ladder.nc]!\r\n')),
      encodeFrame(0x90, utf8('Error: file not found [/165-depth-ladder.nc]')),
    );
    const outcome = await runUpload(transport, 1, '/sd/gcodes/badge.nc', content, { packetSize, inactivityMs: 50 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('refused');
    expect(outcome.detail).toContain('failed to open file');
  });

  it('reports a pre-data cancel as a refusal when the file there is a DIFFERENT file', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(PTYPE_FILE_CANCEL, EMPTY),
      // The path exists and hashes cleanly — it just is not the program we offered.
      encodeFrame(0x90, utf8(`${md5Hex(new Uint8Array([1, 2, 3]))}/sd/gcodes/badge.nc`)),
    );
    const outcome = await runUpload(transport, 1, '/sd/gcodes/badge.nc', content, { packetSize, inactivityMs: 50 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('refused');
    expect(outcome.detail).toContain('without saying why');
  });

  // #300: the refusal's md5 reply is one line. It used to be drained for the transfer's whole
  // inactivity budget, so every refusal cost the operator nine seconds.
  it('asks for the pre-data md5 reply with the short window, not the transfer inactivity budget (#300)', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(PTYPE_FILE_CANCEL, utf8('Error: failed to open file [/sd/gcodes/badge.nc]!\r\n')),
      encodeFrame(0x90, utf8('Error: file not found [/sd/gcodes/badge.nc]')),
    );
    await runUpload(transport, 1, '/sd/gcodes/badge.nc', content, { packetSize, inactivityMs: 9000 });
    // The first read is the transfer's (9000); every read after the cancel is the md5 answer's.
    expect(transport.readTimeouts[0]).toBeGreaterThan(8000);
    expect(transport.readTimeouts.slice(1).every((t) => t <= 2000)).toBe(true);
  });

  it('stops reading the md5 reply as soon as the answer is complete (#300)', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(PTYPE_FILE_CANCEL, EMPTY),
      encodeFrame(0x90, utf8(`${md5Hex(content)}/sd/gcodes/badge.nc`)),
      // A frame that must NOT be consumed: if the read ran out the window it would be swallowed.
      encodeFrame(0x90, utf8('trailing')),
    );
    const outcome = await runUpload(transport, 1, '/sd/gcodes/badge.nc', content, { packetSize, inactivityMs: 9000 });
    expect(outcome).toEqual({ ok: true, bytes: 9, packets: 0, alreadyPresent: true });
    expect(transport.reads).toHaveLength(1);
  });

  // #298: WRITABLE_PATH allows a space (it travels as 0x01), `md5sum` does not — it splits on it and
  // hashes `/sd/gcodes/my`. The claim "already present" is then unmakeable, so it is not made.
  it('does not send md5sum a path with a space, and says the claim could not be checked (#298)', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(PTYPE_FILE_CANCEL, EMPTY));
    const outcome = await runUpload(transport, 1, '/sd/gcodes/my part.nc', content, { packetSize, inactivityMs: 50 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('refused');
    expect(outcome.detail).toContain('could not be checked');
    const sentMd5sum = decodeAll(transport.writes).some((f) => decodeText(f.data).startsWith('md5sum'));
    expect(sentMd5sum).toBe(false);
  });

  it('refuses a destination that is not an absolute path, before opening the transfer', async () => {
    const transport = new FakeTransport();
    const outcome = await runUpload(transport, 1, 'badge.nc', content, { packetSize, inactivityMs: 50 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.detail).toContain('absolute');
    // Nothing was sent at all — this is caught before the machine hears about it.
    expect(transport.writes).toHaveLength(0);
  });

  it('refuses a destination carrying a newline, which would end the command early', async () => {
    const transport = new FakeTransport();
    const outcome = await runUpload(transport, 1, '/sd/gcodes/badge\nx.nc', content, { packetSize, inactivityMs: 50 });
    expect(outcome.ok).toBe(false);
    expect(transport.writes).toHaveLength(0);
  });

  it('reports a cancel after data began as a refusal, with no retry', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(PTYPE_FILE_VIEW, EMPTY),
      dataRequest(1),
      encodeFrame(PTYPE_FILE_CANCEL, utf8('Error: disk full\r\n')),
    );
    const outcome = await runUpload(transport, 1, '/sd/gcodes/badge.nc', content, { packetSize, inactivityMs: 50 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('refused');
    expect(outcome.detail).toContain('disk full');
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
    const outcome = await runUpload(transport, 1, '/sd/gcodes/badge.nc', content, { packetSize, inactivityMs: 50 });
    expect(outcome.ok).toBe(true);
    const frames = decodeAll(transport.writes);
    const dataFrames = frames.filter((f) => f.type === PTYPE_FILE_DATA);
    expect(dataFrames).toHaveLength(3); // packet 1, the retry of packet 1, packet 2
    expect(Array.from(dataFrames[0]?.data ?? EMPTY)).toEqual(Array.from(dataFrames[1]?.data ?? EMPTY));
    expect(readU32be(dataFrames[2]?.data ?? EMPTY)).toBe(2);
  });

  it('cancels and reports a timeout when the machine goes quiet', async () => {
    const transport = new FakeTransport();
    const outcome = await runUpload(transport, 1, '/sd/gcodes/badge.nc', content, { packetSize, inactivityMs: 20 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('timeout');
    const last = decodeAll(transport.writes).at(-1);
    expect(last?.type).toBe(PTYPE_FILE_CANCEL);
  });

  it('encodes a transfer name the way the machine expects', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(PTYPE_FILE_CANCEL, EMPTY));
    await runUpload(transport, 1, '/sd/gcodes/my badge.nc', new Uint8Array([1]), { packetSize, inactivityMs: 20 });
    const first = decodeAll(transport.writes)[0];
    // Space becomes 0x01 (a raw space would split the command).
    expect(decodeText(first?.data ?? EMPTY)).toBe(`upload /sd/gcodes/my\u0001badge.nc\n`);
  });
});

describe('#255 protocol — reading a file back', () => {
  /** Narrow a read outcome to its failure branch, so the assertions below can name a reason. */
  function failed(read: ReadFileOutcome): Extract<ReadFileOutcome, { ok: false }> {
    if (read.ok) throw new Error(`expected a failure, got ${JSON.stringify(read)}`);
    return read;
  }

  it('asks for the file with the console `cat` and returns the text verbatim', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(0x81, utf8('# config.txt\r\nacceleration 3000\r\n')), EMPTY);
    const read = await runReadFile(transport, 1, '/sd/config.txt', { windowMs: 10 });
    expect(read).toEqual({ ok: true, text: '# config.txt\r\nacceleration 3000\r\n', frames: 1 });

    const sent = decodeAll(transport.writes);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe(PTYPE_CTRL_MULTI);
    expect(decodeText(sent[0]?.data ?? EMPTY)).toBe('cat /sd/config.txt');
  });

  it('passes a line limit as the shell\'s own second word', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(0x81, utf8('# config.txt\r\n')), EMPTY);
    await runReadFile(transport, 1, '/sd/config.txt', { limit: 40, windowMs: 10 });
    const sent = decodeAll(transport.writes);
    expect(decodeText(sent[0]?.data ?? EMPTY)).toBe('cat /sd/config.txt 40');
  });

  it('joins a file that arrives as more than one frame, in order', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(0x81, utf8('# config.txt\r\n')),
      encodeFrame(0x81, utf8('acceleration 3000\r\n')),
      EMPTY,
    );
    const read = await runReadFile(transport, 1, '/sd/config.txt', { windowMs: 10 });
    expect(read).toEqual({ ok: true, text: '# config.txt\r\nacceleration 3000\r\n', frames: 2 });
  });

  it('refuses a path that could smuggle a second word or command, and sends nothing', async () => {
    for (const path of ['/sd/config.txt; rm -rf /sd', '/sd/config.txt 40', 'relative.txt', '/sd/a\nb', '/sd/$HOME']) {
      const transport = new FakeTransport();
      const read = failed(await runReadFile(transport, 1, path, { windowMs: 10 }));
      expect(read.reason, path).toBe('bad-path');
      // The point of the guard: a refused path never reaches the wire.
      expect(transport.writes, path).toHaveLength(0);
    }
  });

  it('reports the shell\'s own message as not-found rather than as content', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(0x81, utf8('File not found: /sd/nope.txt\r\n')), EMPTY);
    const read = failed(await runReadFile(transport, 1, '/sd/nope.txt', { windowMs: 10 }));
    expect(read.reason).toBe('not-found');
    expect(read.text).toContain('File not found: /sd/nope.txt');
  });

  it('reports an empty window as a timeout, not as an empty file', async () => {
    const transport = new FakeTransport();
    const read = failed(await runReadFile(transport, 1, '/sd/config.txt', { windowMs: 10 }));
    expect(read.reason).toBe('timeout');
  });

  it('ignores the machine\'s own echo of what we sent', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(0x02, utf8('cat /sd/config.txt')), EMPTY);
    const read = failed(await runReadFile(transport, 1, '/sd/config.txt', { windowMs: 10 }));
    expect(read.reason).toBe('timeout');
  });
});

describe('#255 protocol — hashing a file the machine holds', () => {
  /** Narrow an outcome to its failure branch, so the assertions below can name a reason. */
  function failed(sum: Md5SumOutcome): Extract<Md5SumOutcome, { ok: false }> {
    if (sum.ok) throw new Error(`expected a failure, got ${JSON.stringify(sum)}`);
    return sum;
  }

  it('sends one `md5sum` line and reads the digest the machine reports', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(0x81, utf8('00ceac76d7a4930bac754795b388f34b/sd/config.txt\r\n')),
      EMPTY,
    );
    const sum = await runMd5Sum(transport, 1, '/sd/config.txt', { windowMs: 10 });
    expect(sum.ok).toBe(true);
    if (!sum.ok) return;
    expect(sum.md5).toBe('00ceac76d7a4930bac754795b388f34b');
    expect(sum.path).toBe('/sd/config.txt');

    const sent = decodeAll(transport.writes);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe(PTYPE_CTRL_MULTI);
    expect(decodeText(sent[0]?.data ?? EMPTY)).toBe('md5sum /sd/config.txt');
  });

  it('takes the digest from the line start, not from a 32-hex run inside the filename', async () => {
    // The firmware runs the digest and the path together with no separator. A filename that is
    // itself 32 hex characters must not be mistaken for the digest.
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(0x81, utf8('00ceac76d7a4930bac754795b388f34b/sd/deadbeefdeadbeefdeadbeefdeadbeef.nc\r\n')),
      EMPTY,
    );
    const sum = await runMd5Sum(transport, 1, '/sd/deadbeefdeadbeefdeadbeefdeadbeef.nc', { windowMs: 10 });
    expect(sum.ok).toBe(true);
    if (!sum.ok) return;
    expect(sum.md5).toBe('00ceac76d7a4930bac754795b388f34b');
  });

  it('joins a digest split across frames', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(0x81, utf8('00ceac76d7a4930ba')),
      encodeFrame(0x81, utf8('c754795b388f34b/sd/config.txt\r\n')),
      EMPTY,
    );
    const sum = await runMd5Sum(transport, 1, '/sd/config.txt', { windowMs: 10 });
    expect(sum.ok).toBe(true);
    if (!sum.ok) return;
    expect(sum.md5).toBe('00ceac76d7a4930bac754795b388f34b');
  });

  it('refuses a path that could smuggle a second word or command, and sends nothing', async () => {
    for (const path of ['/sd/a; rm -rf /sd', '/sd/a b', 'relative.txt', '/sd/a\nb', '/sd/$HOME']) {
      const transport = new FakeTransport();
      const sum = failed(await runMd5Sum(transport, 1, path, { windowMs: 10 }));
      expect(sum.reason, path).toBe('bad-path');
      // The point of the guard: a refused path never reaches the wire.
      expect(transport.writes, path).toHaveLength(0);
    }
  });

  it('reports the shell\'s own message as not-found rather than as a digest', async () => {
    // Verbatim from the machine, 2026-10-06 — `md5sum` spells this differently from `cat`, which
    // says `File not found: /sd/nope.txt`. Both must land on not-found.
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(0x81, utf8('Error: file not found [/sd/nope.txt]\r\n')), EMPTY);
    const sum = failed(await runMd5Sum(transport, 1, '/sd/nope.txt', { windowMs: 10 }));
    expect(sum.reason).toBe('not-found');
    expect(sum.text).toContain('file not found');
  });

  it('reads `cat`\'s spelling of the same failure identically', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(0x81, utf8('File not found: /sd/nope.txt\r\n')), EMPTY);
    const sum = failed(await runMd5Sum(transport, 1, '/sd/nope.txt', { windowMs: 10 }));
    expect(sum.reason).toBe('not-found');
  });

  it('reports a reply with no digest as unparsed, not as a digest of nothing', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(0x81, utf8('error:Unsupported command - md5sum\r\n')), EMPTY);
    const sum = failed(await runMd5Sum(transport, 1, '/sd/config.txt', { windowMs: 10 }));
    expect(sum.reason).toBe('unparsed');
  });

  it('reports an empty window as a timeout', async () => {
    const transport = new FakeTransport();
    const sum = failed(await runMd5Sum(transport, 1, '/sd/config.txt', { windowMs: 10 }));
    expect(sum.reason).toBe('timeout');
  });
});

describe('#255 protocol — reading one configuration key', () => {
  /** Narrow an outcome to its failure branch, so the assertions below can name a reason. */
  function failed(read: ReadConfigKeyOutcome): Extract<ReadConfigKeyOutcome, { ok: false }> {
    if (read.ok) throw new Error(`expected a failure, got ${JSON.stringify(read)}`);
    return read;
  }

  it('asks for the effective value with a one-argument `config-get` and reads it back', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(0x81, utf8('cached: coordinate.anchor1_x is set to -190.89\n')), EMPTY);
    const read = await readConfigKey(transport, 1, 'coordinate.anchor1_x', { windowMs: 10 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toBe('-190.89');

    const sent = decodeAll(transport.writes);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe(PTYPE_CTRL_MULTI);
    expect(decodeText(sent[0]?.data ?? EMPTY)).toBe('config-get coordinate.anchor1_x');
  });

  it('reads one named source when asked to, and expects that source\'s own prefix', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(0x81, utf8('sd: soft_endstop.enable is set to true\n')), EMPTY);
    const read = await readConfigKey(transport, 1, 'soft_endstop.enable', { source: 'sd', windowMs: 10 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toBe('true');
    const sent = decodeAll(transport.writes);
    expect(decodeText(sent[0]?.data ?? EMPTY)).toBe('config-get sd soft_endstop.enable');
  });

  it('does not accept a cached answer as a named source\'s answer, nor the reverse', async () => {
    // The label is part of the reply's meaning: `cached` is the merged value, `sd` is the file's.
    // A reply carrying the wrong label must not be read as an answer to the question that was asked.
    const a = new FakeTransport();
    a.queueRead(encodeFrame(0x81, utf8('cached: soft_endstop.enable is set to true\n')), EMPTY);
    expect(failed(await readConfigKey(a, 1, 'soft_endstop.enable', { source: 'sd', windowMs: 10 })).reason).toBe(
      'not-in-config',
    );

    const b = new FakeTransport();
    b.queueRead(encodeFrame(0x81, utf8('sd: soft_endstop.enable is set to true\n')), EMPTY);
    expect(failed(await readConfigKey(b, 1, 'soft_endstop.enable', { windowMs: 10 })).reason).toBe('not-in-config');
  });

  it('reports a key the machine does not carry as not-in-config, not as a value', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(0x81, utf8('cached: coordinate.anchor2_x is not in config\n')), EMPTY);
    const read = failed(await readConfigKey(transport, 1, 'coordinate.anchor2_x', { windowMs: 10 }));
    expect(read.reason).toBe('not-in-config');
    expect(read.detail).toContain('is not in config');
  });

  it('keeps a value whole when it contains spaces, and joins frames that split it', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(0x81, utf8('cached: coordinate.')),
      encodeFrame(0x81, utf8('anchor1_x is set to 112.500 250.000\n')),
      EMPTY,
    );
    const read = await readConfigKey(transport, 1, 'coordinate.anchor1_x', { windowMs: 10 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toBe('112.500 250.000');
  });

  it('refuses a source or key that could smuggle a second word or command, and sends nothing', async () => {
    const bad: Array<{ key: string; source?: string }> = [
      { key: 'coordinate.anchor1_x soft_endstop.enable' },
      { key: 'coordinate.anchor1_x;rm -rf /sd' },
      { key: 'coordinate.anchor1_x\nconfig-set sd x 1' },
      { key: 'coordinate/anchor1_x' },
      { key: 'coordinate.anchor1_x', source: 'sd; rm -rf /sd' },
      { key: 'coordinate.anchor1_x', source: 'sd extra' },
      { key: 'coordinate.anchor1_x', source: 'SD' },
      { key: 'coordinate.anchor1_x', source: '' },
    ];
    for (const { key, source } of bad) {
      const transport = new FakeTransport();
      const read = failed(await readConfigKey(transport, 1, key, { source, windowMs: 10 }));
      expect(read.reason, `${source ?? '-'} ${key}`).toBe('bad-request');
      // The point of the guard: a refused query never reaches the wire.
      expect(transport.writes, `${source ?? '-'} ${key}`).toHaveLength(0);
    }
  });

  it('reports an empty window as a timeout, not as a value', async () => {
    const transport = new FakeTransport();
    const read = failed(await readConfigKey(transport, 1, 'coordinate.anchor1_x', { windowMs: 10 }));
    expect(read.reason).toBe('timeout');
  });

  it('does not accept another key\'s answer for the key that was asked for', async () => {
    const transport = new FakeTransport();
    // Reading `anchor2_x` must not be answered by a line about `anchor1_x`; both regexes are anchored.
    transport.queueRead(encodeFrame(0x81, utf8('cached: coordinate.anchor1_x is set to -190.89\n')), EMPTY);
    const read = failed(await readConfigKey(transport, 1, 'coordinate.anchor2_x', { windowMs: 10 }));
    expect(read.reason).toBe('not-in-config');
    expect(read.detail).toContain('unrecognised reply');
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
