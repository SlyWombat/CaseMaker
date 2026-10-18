// #477 — `casemaker machine` and the line #479 confirmed.
//
// The reads are driven through a fake `MachineTransport`, exactly as the protocol's own specs do:
// the command module is the code under test, and no socket exists anywhere in this file. What the
// spec holds is the OUTCOME — the receipt the command emits, the bytes it puts on the wire, and the
// exit code — because every result line is rendered from that receipt (#478).

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  machineMain,
  type MachineDeps,
} from '../../scripts/lib/casemaker/machineCommand';
import { HUMAN, type CommandOptions } from '../../scripts/lib/casemaker/output';
import type {
  PreparedProgram,
  PrepareOptions,
  PrepareResult,
} from '../../scripts/lib/casemaker/verifiedProgram';
import type { MachineUploadResult } from '../../src/platform/machineUpload';
import { programHash } from '../../src/engine/cnc/programHash';
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
  /** One-shot replies to a written console line, in the order the lines arrive. */
  private responders: { line: string; frames: Uint8Array[] }[] = [];

  /** Queue reply bytes with no relation to a write (the status/version/hashes tests). */
  queue(...chunks: Uint8Array[]): void {
    this.reads.push(...chunks);
  }

  /**
   * Answer the next write of `line` with `frames`. A console session reads anything already queued
   * BEFORE it writes (`openConsole`'s carried read), so a play reply must arrive in response to its
   * own line rather than sit in the queue.
   */
  on(line: string, ...frames: Uint8Array[]): void {
    this.responders.push({ line, frames });
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
    // 5-byte header (magic, length, type) and a 4-byte footer (crc, magic), as `encodeFrame` writes it.
    const line = new TextDecoder().decode(data.subarray(5, data.length - 4));
    const at = this.responders.findIndex((r) => r.line === line);
    if (at >= 0) {
      const [responder] = this.responders.splice(at, 1);
      this.reads.push(...(responder?.frames ?? []));
    }
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
  extra: Partial<MachineDeps> = {},
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  const code = await machineMain(argv, options, { transport, locate: () => doc, ...extra });
  return { code, stdout, stderr };
}

/** The receipt a JSON run emitted, parsed the way a consumer would. */
async function receiptOf(
  argv: string[],
  transport: FakeTransport,
  doc: LoadedLocation | null,
  extra: Partial<MachineDeps> = {},
): Promise<Receipt> {
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await machineMain(argv, { json: true }, { transport, locate: () => doc, ...extra });
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

// ---------------------------------------------------------------------------------------------
// upload and play — the two commands that move the machine (#477, #479's line)
// ---------------------------------------------------------------------------------------------

/** A real file on disk, because the receipt describes the input it actually read. */
const JOB = 'tests/unit/fixtures/single-barrel.job.json';
const NC = 'G0 X0 Y0\nG1 Z-1\n';
const HASH = programHash(NC);

/** The program the fake preparer answers with; the gate's fields are overridable per test. */
function prepared(overrides: Partial<PreparedProgram> = {}): PreparedProgram {
  return {
    jobPath: JOB,
    jobName: 'Badge',
    filename: 'badge.nc',
    nc: NC,
    verify: {
      ok: true,
      findings: [],
      stats: { lines: 2, cuttingMoves: 0, deepestZ: -1, bbox: { min: [0, 0, -1], max: [0, 0, 0] } },
    },
    hash: HASH,
    findings: [],
    sim: { status: 'ready', diagnostics: [], oracle: null },
    margins: { boundaryMargin: 0.5, zTolerance: 0.1, source: 'default' },
    machineId: 'z1-350',
    marginsFrom: 'the shipped defaults (no --my-machine)',
    calibrationNote: null,
    requiredAcks: [],
    ackError: null,
    blocker: null,
    ...overrides,
  };
}

function prepareReturning(program: PreparedProgram) {
  return vi.fn(async (_jobPath: string, _opts: PrepareOptions): Promise<PrepareResult> => ({
    ok: true as const,
    program,
  }));
}

function uploading(result: MachineUploadResult) {
  return vi.fn(async (): Promise<MachineUploadResult> => result);
}

const OK_STATUS = '<Idle|MPos:0,0,0|P:0,100,120>';

describe('#477 machine upload — the app’s own gate, behind --confirm', () => {
  it('--dry generates, prints the hash and the token that would send it, and opens no socket', async () => {
    const transport = new FakeTransport();
    const upload = uploading({
      kind: 'uploaded',
      filename: 'badge.nc',
      bytes: NC.length,
      packets: 1,
      alreadyPresent: false,
      status: OK_STATUS,
    });
    const { code, stdout } = await run(['upload', JOB, '--dry'], transport, location(), HUMAN, {
      prepare: prepareReturning(prepared()),
      upload,
    });

    expect(code).toBe(0);
    const text = stdout.join('\n');
    expect(text).toContain('machine upload  ok=true');
    expect(text).toContain(`  program    ${HASH}`);
    expect(text).toContain('  confirm    (none — --dry)');
    expect(text).toContain('  path       /sd/gcodes/badge.nc');
    expect(text).toContain('  sent       (dry run — nothing was sent)');
    expect(text).toContain(`  next       re-run with --confirm ${HASH} to send it`);
    expect(upload).not.toHaveBeenCalled();
    expect(transport.connects).toBe(0);
  });

  it('refuses a token that names another program, with both hashes and no socket', async () => {
    const transport = new FakeTransport();
    const upload = uploading({
      kind: 'uploaded',
      filename: 'badge.nc',
      bytes: NC.length,
      packets: 1,
      alreadyPresent: false,
      status: OK_STATUS,
    });
    const { code, stdout } = await run(['upload', JOB, '--confirm', 'deadbeef'], transport, location(), HUMAN, {
      prepare: prepareReturning(prepared()),
      upload,
    });

    expect(code).toBe(1);
    const text = stdout.join('\n');
    expect(text).toContain(`--confirm deadbeef does not name this job's program: ${JOB} generates ${HASH}. Nothing was sent.`);
    expect(upload).not.toHaveBeenCalled();
    expect(transport.connects).toBe(0);
  });

  it('sends through the app’s upload path when the token matches, and shows the machine’s status', async () => {
    const transport = new FakeTransport();
    const upload = uploading({
      kind: 'uploaded',
      filename: 'badge.nc',
      bytes: NC.length,
      packets: 2,
      alreadyPresent: false,
      status: OK_STATUS,
    });
    const { code, stdout } = await run(['upload', JOB, '--confirm', HASH], transport, location(), HUMAN, {
      prepare: prepareReturning(prepared()),
      upload,
    });

    expect(code).toBe(0);
    const text = stdout.join('\n');
    expect(text).toContain('  sent       upload /sd/gcodes/badge.nc');
    expect(text).toContain(`  status     ${OK_STATUS}`);
    expect(text).toContain('  job        finished — percent 100 and Idle');
    expect(upload).toHaveBeenCalledWith(
      { host: '192.0.2.10', port: 2222 },
      { filename: 'badge.nc', nc: NC, verify: expect.objectContaining({ ok: true }) },
      transport,
    );
  });

  it('notes a card that already held identical bytes as a success, not a rewrite', async () => {
    const transport = new FakeTransport();
    const upload = uploading({
      kind: 'uploaded',
      filename: 'badge.nc',
      bytes: NC.length,
      packets: 0,
      alreadyPresent: true,
      status: OK_STATUS,
    });
    const { code, stdout } = await run(['upload', JOB, '--confirm', HASH], transport, location(), HUMAN, {
      prepare: prepareReturning(prepared()),
      upload,
    });
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('the card already held identical bytes — nothing was rewritten');
  });

  it('reports the app’s busy answer as a refusal, with the machine’s line quoted', async () => {
    const transport = new FakeTransport();
    const upload = uploading({
      kind: 'busy',
      filename: 'badge.nc',
      detail: 'the machine is Run, not Idle — nothing was sent',
      status: '<Run|MPos:1,2,3|P:5,10,4>',
    });
    const { code, stdout } = await run(['upload', JOB, '--confirm', HASH], transport, location(), HUMAN, {
      prepare: prepareReturning(prepared()),
      upload,
    });
    expect(code).toBe(1);
    const text = stdout.join('\n');
    expect(text).toContain('  !! the machine is Run, not Idle — nothing was sent');
    expect(text).toContain('  status     <Run|MPos:1,2,3|P:5,10,4>');
    expect(text).toContain('  state      Run');
  });

  it('does not send when the app’s own gate blocks, and names the clearance codes', async () => {
    const transport = new FakeTransport();
    const upload = uploading({
      kind: 'uploaded',
      filename: 'badge.nc',
      bytes: NC.length,
      packets: 1,
      alreadyPresent: false,
      status: OK_STATUS,
    });
    const { code, stdout } = await run(['upload', JOB, '--confirm', HASH], transport, location(), HUMAN, {
      prepare: prepareReturning(
        prepared({ blocker: 'The vise is at its default height', requiredAcks: ['vise-default'] }),
      ),
      upload,
    });
    expect(code).toBe(1);
    const text = stdout.join('\n');
    expect(text).toContain(
      '  !! The vise is at its default height. Once they are made at the machine, pass --acknowledge=vise-default.',
    );
    expect(upload).not.toHaveBeenCalled();
    expect(transport.connects).toBe(0);
  });

  it('passes --acknowledge through to the gate as the codes the run was cleared by', async () => {
    const observed: PrepareOptions[] = [];
    const prepare = vi.fn(async (_jobPath: string, opts: PrepareOptions): Promise<PrepareResult> => {
      observed.push(opts);
      return { ok: true as const, program: prepared() };
    });
    const { code, stdout } = await run(
      ['upload', JOB, '--dry', '--acknowledge=vise-default,holder-unproven'],
      new FakeTransport(),
      location(),
      HUMAN,
      { prepare },
    );
    expect(code).toBe(0);
    expect(observed[0]?.acknowledged).toEqual(['vise-default', 'holder-unproven']);
    expect(stdout.join('\n')).toContain('  cleared    vise-default, holder-unproven');
  });

  it('refuses an acknowledgement list that is not exactly what the run asks for, before sending', async () => {
    const transport = new FakeTransport();
    const upload = uploading({ kind: 'unavailable', filename: 'badge.nc', reason: 'never asked' });
    const { code, stderr } = await run(
      ['upload', JOB, '--confirm', HASH, '--acknowledge=released-onto-board'],
      transport,
      location(),
      HUMAN,
      {
        prepare: prepareReturning(
          prepared({ ackError: '--acknowledge must name exactly the codes this run asks for: (none) — named but not asked for: released-onto-board' }),
        ),
        upload,
      },
    );
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('named but not asked for: released-onto-board');
    expect(upload).not.toHaveBeenCalled();
  });

  it('reports a job that produces no program as a refusal, exiting 1', async () => {
    const transport = new FakeTransport();
    const prepare = vi.fn(
      async (): Promise<PrepareResult> => ({
        ok: false as const,
        stage: 'findings',
        reason: 'the job has no usable cutter — nothing is swept or prepared',
      }),
    );
    const { code, stdout } = await run(['upload', JOB, '--dry'], transport, location(), HUMAN, { prepare });
    expect(code).toBe(1);
    const text = stdout.join('\n');
    expect(text).toContain('machine upload  ok=false');
    expect(text).toContain('  !! the job has no usable cutter — nothing is swept or prepared');
  });

  it('refuses a job file that is not there, before anything is prepared or sent', async () => {
    const prepare = vi.fn();
    const { code, stderr } = await run(['upload', 'tests/unit/fixtures/no-such-job.json', '--dry'], new FakeTransport(), location(), HUMAN, {
      prepare,
    });
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('cannot read tests/unit/fixtures/no-such-job.json');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('fills the receipt’s action block from a dry run', async () => {
    const receipt = await receiptOf(
      ['upload', JOB, '--dry'],
      new FakeTransport(),
      location(),
      { prepare: prepareReturning(prepared()) },
    );
    if (receipt.command !== 'machine') throw new Error('expected a machine receipt');
    expect(receipt.ok).toBe(true);
    expect(receipt.stage).toBe('upload');
    expect(receipt.details.action).toEqual({
      confirm: null,
      programHash: HASH,
      path: '/sd/gcodes/badge.nc',
      sent: null,
      dryRun: true,
      ackCodes: [],
      alreadyPresent: false,
    });
    expect(receipt.inputs.map((f) => f.path)).toEqual([JOB]);
    expect(receipt.refusals).toEqual([]);
  });
});

describe('#477 machine play — the card’s own bytes, behind --confirm', () => {
  const CARD = '/sd/gcodes/badge.nc';

  it('reads the card, hashes what it returns, and runs it once the token matches', async () => {
    const transport = new FakeTransport();
    transport.on(`cat ${CARD}`, encodeFrame(0x81, utf8(NC)));
    // The pre-play read and the post-play poll; the second only arrives after the program is sent.
    transport.on('?', encodeFrame(0x81, utf8(OK_STATUS)));
    transport.on('?', encodeFrame(0x81, utf8(OK_STATUS)));
    transport.on(`play ${CARD}`, encodeFrame(0x81, utf8('ok')));

    const { code, stdout } = await run(['play', CARD, '--confirm', HASH], transport, location(), HUMAN, {
      sleep: async () => undefined,
    });

    expect(code).toBe(0);
    expect(transport.lines()).toEqual([`cat ${CARD}`, '?', `play ${CARD}`, '?']);
    const text = stdout.join('\n');
    expect(text).toContain('machine play  ok=true');
    expect(text).toContain(`  confirm    ${HASH}`);
    expect(text).toContain(`  program    ${HASH}`);
    expect(text).toContain(`  sent       play ${CARD}`);
    expect(text).toContain('  job        finished — percent 100 and Idle');
  });

  it('refuses a token that does not name the bytes the card holds, and sends no play', async () => {
    const transport = new FakeTransport();
    transport.on(`cat ${CARD}`, encodeFrame(0x81, utf8(NC)));
    const { code, stdout } = await run(['play', CARD, '--confirm', 'deadbeef'], transport, location());

    expect(code).toBe(1);
    expect(transport.lines()).toEqual([`cat ${CARD}`]);
    const text = stdout.join('\n');
    expect(text).toContain('does not name the bytes the card holds');
    expect(text).toContain(`hashes ${HASH}`);
    expect(text).toContain('Nothing was sent.');
  });

  it('will not start a program while the controller reports Run', async () => {
    const transport = new FakeTransport();
    transport.on(`cat ${CARD}`, encodeFrame(0x81, utf8(NC)));
    transport.on('?', encodeFrame(0x81, utf8('<Run|MPos:1,2,3|P:5,10,4>')));
    const { code, stdout } = await run(['play', CARD, '--confirm', HASH], transport, location());

    expect(code).toBe(1);
    expect(transport.lines()).toEqual([`cat ${CARD}`, '?']);
    expect(stdout.join('\n')).toContain('  !! it reports Run rather than Idle — nothing was sent');
  });

  it('treats Idle with a program mid-way through as busy (#390)', async () => {
    const transport = new FakeTransport();
    transport.on(`cat ${CARD}`, encodeFrame(0x81, utf8(NC)));
    transport.on('?', encodeFrame(0x81, utf8('<Idle|MPos:0,0,0|P:0,55,20>')));
    const { code, stdout } = await run(['play', CARD, '--confirm', HASH], transport, location());

    expect(code).toBe(1);
    expect(transport.lines()).toEqual([`cat ${CARD}`, '?']);
    expect(stdout.join('\n')).toContain('  !! it reports Idle, but its status line says a program is 55% through');
  });

  it('will not play while the controller is in an alarm, and quotes it', async () => {
    const transport = new FakeTransport();
    transport.on(`cat ${CARD}`, encodeFrame(0x81, utf8(NC)));
    transport.on('?', encodeFrame(0x81, utf8('<Alarm|MPos:0,0,0>')));
    const { code, stdout } = await run(['play', CARD, '--confirm', HASH], transport, location());

    expect(code).toBe(1);
    expect(transport.lines()).toEqual([`cat ${CARD}`, '?']);
    expect(stdout.join('\n')).toContain('the controller is in an alarm');
  });

  it('refuses a card that will not return the file, and sends no play', async () => {
    const transport = new FakeTransport();
    const { code, stdout } = await run(['play', CARD, '--confirm', HASH], transport, location());
    expect(code).toBe(1);
    expect(transport.lines()).toEqual([`cat ${CARD}`]);
    expect(stdout.join('\n')).toContain('  !! the card did not return ' + CARD);
  });

  it('needs the token: play without --confirm is a usage error, before any socket', async () => {
    const transport = new FakeTransport();
    const { code, stderr } = await run(['play', CARD], transport, location());
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('play needs --confirm <program hash>');
    expect(transport.connects).toBe(0);
  });

  it('refuses a path the protocol will not build a play line from', async () => {
    const transport = new FakeTransport();
    const { code, stderr } = await run(['play', '/sd/gcodes/bad name.nc', '--confirm', HASH], transport, location());
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('is not a playable card path');
    expect(transport.connects).toBe(0);
  });

  it('reports the card’s hash and the sent line in the receipt', async () => {
    const transport = new FakeTransport();
    transport.on(`cat ${CARD}`, encodeFrame(0x81, utf8(NC)));
    transport.on('?', encodeFrame(0x81, utf8(OK_STATUS)));
    transport.on('?', encodeFrame(0x81, utf8(OK_STATUS)));
    transport.on(`play ${CARD}`, encodeFrame(0x81, utf8('ok')));
    const receipt = await receiptOf(['play', CARD, '--confirm', HASH], transport, location(), {
      sleep: async () => undefined,
    });
    if (receipt.command !== 'machine') throw new Error('expected a machine receipt');
    expect(receipt.details.action).toEqual({
      confirm: HASH,
      programHash: HASH,
      path: CARD,
      sent: `play ${CARD}`,
      dryRun: false,
      ackCodes: [],
      alreadyPresent: false,
    });
  });
});

describe('#477 machine — flags belong to the command that reads them', () => {
  it('refuses a token on a read rather than ignoring it', async () => {
    const transport = new FakeTransport();
    const { code, stderr } = await run(['status', '--confirm', 'abc'], transport, location());
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('status is a read and takes none of --confirm');
    expect(transport.connects).toBe(0);
  });

  it('refuses a poll faster than the controller tolerates, before any socket', async () => {
    const transport = new FakeTransport();
    const { code, stderr } = await run(['play', '/sd/gcodes/badge.nc', '--confirm', 'abc', '--poll', '500'], transport, location());
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('--poll must be at least 2000 ms — a faster poll faulted the controller on 2026-10-12');
    expect(transport.connects).toBe(0);
  });

  it('refuses --dry together with --confirm, and neither of them', async () => {
    const both = await run(['upload', JOB, '--dry', '--confirm', 'abc'], new FakeTransport(), location());
    expect(both.code).toBe(2);
    expect(both.stderr.join('\n')).toContain('upload needs exactly one of --confirm <program hash> or --dry');

    const neither = await run(['upload', JOB], new FakeTransport(), location());
    expect(neither.code).toBe(2);
    expect(neither.stderr.join('\n')).toContain('upload needs exactly one of --confirm <program hash> or --dry');
  });
});
