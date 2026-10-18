// #477 — `casemaker machine` and the line #479 confirmed.
//
// The reads are driven through a fake `MachineTransport`, exactly as the protocol's own specs do:
// the command module is the code under test, and no socket exists anywhere in this file. What the
// spec holds is the OUTCOME — the receipt the command emits, the bytes it puts on the wire, and the
// exit code — because every result line is rendered from that receipt (#478).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { machineMain } from '../../scripts/lib/casemaker/machineCommand';
import { HUMAN, type CommandOptions } from '../../scripts/lib/casemaker/output';
import {
  parseReceipt,
  receiptJson,
  type Receipt,
} from '../../src/platform/headless/receipt';
import { MachineRecordSchema } from '../../src/platform/locationClient';
import type { LoadedLocation } from '../../src/platform/headless/bootstrap';
import {
  encodeFrame,
  utf8,
  type MachineTransport,
  type UdpDatagram,
} from '../../src/platform/desktop/protocol';

const EMPTY = new Uint8Array();

class FakeTransport implements MachineTransport {
  writes: Uint8Array[] = [];
  reads: Uint8Array[] = [];
  connects = 0;
  hosts: string[] = [];
  closed: number[] = [];

  /** Queue the reply bytes for the next write. */
  queue(...chunks: Uint8Array[]): void {
    this.reads.push(...chunks);
  }
  async udpListen(): Promise<UdpDatagram[]> {
    throw new Error('these commands never broadcast');
  }
  async tcpConnect(host: string): Promise<number> {
    this.connects++;
    this.hosts.push(host);
    return 1;
  }
  async tcpWrite(_conn: number, data: Uint8Array): Promise<void> {
    this.writes.push(data);
  }
  async tcpRead(): Promise<Uint8Array> {
    return this.reads.shift() ?? EMPTY;
  }
  async tcpClose(conn: number): Promise<void> {
    this.closed.push(conn);
  }
  /** Every console line written, decoded. */
  lines(): string[] {
    // 5-byte header (magic, length, type) and a 4-byte footer (crc, magic), as `encodeFrame` writes it.
    return this.writes.map((w) => new TextDecoder().decode(w.subarray(5, w.length - 4)));
  }
}

function record(overrides: Record<string, unknown> = {}) {
  return MachineRecordSchema.parse({
    id: 'machine-1a2b3c',
    name: 'Z1',
    address: { host: '192.0.2.10', port: 2222 },
    finishedPrograms: ['3fa2b1c9', '0a1b2c3d'],
    updatedAt: '2026-10-18T00:00:00.000Z',
    ...overrides,
  });
}

function location(machines = [record()]): LoadedLocation {
  return {
    path: 'C:/shop/location.json',
    kind: 'location',
    name: 'Test bench',
    tools: [],
    inventory: [],
    machines,
    stock: [],
    defaults: null,
  };
}

/** Run a command and capture what a terminal would see. */
async function run(
  argv: string[],
  transport: FakeTransport,
  doc: LoadedLocation | null = null,
  options: CommandOptions = HUMAN,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  const code = await machineMain(argv, options, { transport, locate: () => doc });
  return { code, stdout, stderr };
}

/** The receipt a JSON run emitted, parsed the way a consumer would. */
async function receiptOf(argv: string[], transport: FakeTransport, doc: LoadedLocation | null): Promise<Receipt> {
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await machineMain(argv, { json: true }, { transport, locate: () => doc });
  return parseReceipt(JSON.parse(written.join('')));
}

afterEach(() => vi.restoreAllMocks());

describe('#477 machine status — the `?` line, read-only', () => {
  it('renders the status line, state and progress, and calls job end percent 100 AND Idle', async () => {
    const transport = new FakeTransport();
    transport.queue(encodeFrame(0x81, utf8('<Run|MPos:1.0,2.0,3.0|P:12,40,95>')));
    const { code, stdout } = await run(['status'], transport, location());

    expect(code).toBe(0);
    const text = stdout.join('\n');
    expect(text).toContain('machine status  ok=true');
    expect(text).toContain('  host       192.0.2.10:2222');
    expect(text).toContain('  status     <Run|MPos:1.0,2.0,3.0|P:12,40,95>');
    expect(text).toContain('  state      Run');
    expect(text).toContain('  progress   line 12, 40 %, 95 s');
    expect(text).toContain('  job        not finished yet');
    // The poll is the single status byte (sent as a `?` frame), never a console line.
    expect(transport.lines()).toEqual(['?']);
    expect(transport.writes).toHaveLength(1);
    expect(transport.closed).toEqual([1]);
  });

  it('reads Idle mid-job as not finished, and Idle at percent 100 as finished', async () => {
    const midJob = new FakeTransport();
    midJob.queue(encodeFrame(0x81, utf8('<Idle|MPos:0,0,0|P:0,55,20>')));
    expect((await run(['status'], midJob, location())).stdout.join('\n')).toContain('  job        not finished yet');

    const ended = new FakeTransport();
    ended.queue(encodeFrame(0x81, utf8('<Idle|MPos:0,0,0|P:0,100,120>')));
    expect((await run(['status'], ended, location())).stdout.join('\n')).toContain(
      '  job        finished — percent 100 and Idle',
    );
  });

  it('reports the controller’s alarm verbatim without inventing a state', async () => {
    const transport = new FakeTransport();
    transport.queue(encodeFrame(0x81, utf8('<Alarm|MPos:0,0,0>\nALARM: Probe fail')));
    const { stdout } = await run(['status'], transport, location());
    const text = stdout.join('\n');
    expect(text).toContain('  alarm      ALARM: Probe fail');
    expect(text).toContain('  state      Alarm');
  });

  it('turns an unanswered poll into an ok=false receipt and exit 1', async () => {
    const transport = new FakeTransport();
    const { code, stdout } = await run(['status'], transport, location());
    expect(code).toBe(1);
    expect(stdout.join('\n')).toContain('machine status  ok=false');
    expect(stdout.join('\n')).toContain('  status     (no reply)');
    expect(stdout.join('\n')).toContain('did not answer a status poll');
  });

  it('takes the address from --host over the document', async () => {
    const transport = new FakeTransport();
    await run(['status', '--host', '10.9.8.7', '--port', '2223'], transport, location());
    expect(transport.hosts).toEqual(['10.9.8.7']);
    expect(transport.connects).toBe(1);
  });

  it('refuses when the document names two addressed machines, before any socket', async () => {
    const transport = new FakeTransport();
    const doc = location([
      record(),
      record({ id: 'machine-2', address: { host: '192.0.2.11', port: 2222 } }),
    ]);
    const { code, stderr } = await run(['status'], transport, doc);
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('names 2 machines');
    expect(stderr.join('\n')).toContain('machine-2 @192.0.2.11:2222');
    expect(transport.connects).toBe(0);
  });

  it('refuses with no document and no --host, before any socket', async () => {
    const transport = new FakeTransport();
    const { code, stderr } = await run(['status'], transport, null);
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('no machine address — pass --host');
    expect(transport.connects).toBe(0);
  });
});

describe('#477 machine version — the controller’s own key', () => {
  it('asks config-get for `version` from sd and renders the value', async () => {
    const transport = new FakeTransport();
    transport.queue(encodeFrame(0x81, utf8('sd: version is set to 1.1.2.0.1.13')));
    const { code, stdout } = await run(['version'], transport, location());

    expect(code).toBe(0);
    expect(transport.lines()).toEqual(['config-get sd version']);
    expect(stdout.join('\n')).toContain('  version    1.1.2.0.1.13');
  });

  it('refuses a missing key as a failed read, exit 1', async () => {
    const transport = new FakeTransport();
    transport.queue(encodeFrame(0x81, utf8('sd: version is not in config')));
    const { code, stdout } = await run(['version'], transport, location());
    expect(code).toBe(1);
    expect(stdout.join('\n')).toContain('machine version  ok=false');
    expect(stdout.join('\n')).toContain('not in config');
  });
});

describe('#477 machine hashes — the controller hashes its own files', () => {
  it('asks for each path and renders every digest', async () => {
    const transport = new FakeTransport();
    transport.queue(encodeFrame(0x81, utf8('0123456789abcdef0123456789abcdef  /sd/gcodes/a.nc')));
    transport.queue(encodeFrame(0x81, utf8('fedcba9876543210fedcba9876543210  /sd/gcodes/b.nc')));
    const { code, stdout } = await run(['hashes', '/sd/gcodes/a.nc', '/sd/gcodes/b.nc'], transport, location());

    expect(code).toBe(0);
    expect(transport.lines()).toEqual(['md5sum /sd/gcodes/a.nc', 'md5sum /sd/gcodes/b.nc']);
    expect(stdout.join('\n')).toContain('  file       /sd/gcodes/a.nc  md5=0123456789abcdef0123456789abcdef');
    expect(stdout.join('\n')).toContain('  file       /sd/gcodes/b.nc  md5=fedcba9876543210fedcba9876543210');
  });

  it('reports a file the card does not hold and exits 1', async () => {
    const transport = new FakeTransport();
    transport.queue(encodeFrame(0x81, utf8('error: File not found')));
    const { code, stdout } = await run(['hashes', '/sd/gcodes/missing.nc'], transport, location());
    expect(code).toBe(1);
    expect(stdout.join('\n')).toContain('machine hashes  ok=false');
    expect(stdout.join('\n')).toContain('(no digest —');
  });

  it('needs at least one path, before any socket', async () => {
    const transport = new FakeTransport();
    const { code, stderr } = await run(['hashes'], transport, location());
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('needs at least one absolute path');
    expect(transport.connects).toBe(0);
  });
});

describe('#477 machine finished — the record’s own list, nothing sent', () => {
  it('prints every finished hash for the document’s only machine', async () => {
    const transport = new FakeTransport();
    const { code, stdout } = await run(['finished'], transport, location());
    expect(code).toBe(0);
    expect(transport.connects).toBe(0);
    const text = stdout.join('\n');
    expect(text).toContain('  machine    machine-1a2b3c');
    expect(text).toContain('  finished   3fa2b1c9');
    expect(text).toContain('  finished   0a1b2c3d');
  });

  it('says so when no program has finished, and names the record with --machine', async () => {
    const doc = location([
      record({ finishedPrograms: [] }),
      record({ id: 'machine-2', finishedPrograms: ['deadbeef'] }),
    ]);
    const first = await run(['finished', '--machine', 'machine-2'], new FakeTransport(), doc);
    expect(first.stdout.join('\n')).toContain('  finished   deadbeef');

    const empty = await run(['finished', '--machine', 'machine-1a2b3c'], new FakeTransport(), doc);
    expect(empty.stdout.join('\n')).toContain('(no program has finished cleanly yet)');
  });

  it('refuses an unknown machine id, before anything is read', async () => {
    const { code, stderr } = await run(['finished', '--machine', 'nope'], new FakeTransport(), location());
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('has no machine "nope"');
  });
});

describe('#477 machine — the receipt is the only result', () => {
  it('emits exactly the receipt document under --json', async () => {
    const transport = new FakeTransport();
    transport.queue(encodeFrame(0x81, utf8('<Idle|MPos:0,0,0|P:0,100,120>')));
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await machineMain(['status'], { json: true }, { transport, locate: () => location() });
    const text = written.join('');
    const receipt = parseReceipt(JSON.parse(text));
    expect(receiptJson(receipt)).toBe(text);
    expect(receipt.command).toBe('machine');
    if (receipt.command !== 'machine') throw new Error('expected a machine receipt');
    expect(receipt.ok).toBe(true);
    expect(receipt.stage).toBe('status');
    expect(receipt.details.status?.finished).toBe(true);
    expect(receipt.details.status?.percent).toBe(100);
    expect(receipt.details.host).toBe('192.0.2.10');
    expect(receipt.details.port).toBe(2222);
  });

  it('carries the finished hashes in the receipt, not in prose', async () => {
    const receipt = await receiptOf(['finished'], new FakeTransport(), location());
    if (receipt.command !== 'machine') throw new Error('expected a machine receipt');
    expect(receipt.details.finished).toEqual({
      machine: 'machine-1a2b3c',
      hashes: ['3fa2b1c9', '0a1b2c3d'],
    });
  });
});
