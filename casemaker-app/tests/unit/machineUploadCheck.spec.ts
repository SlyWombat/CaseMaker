// #502 — the bench script's argument and gate ordering, driven with a fake transport and a fake
// prepare, so no socket opens and no wasm generator runs. The pipeline is the library's
// (`prepareVerifiedProgram`); these tests pin the script's own ordering — the --my-machine/--dry
// rule, the exact --acknowledge refusal, the no-cutter and gate stops, and "--dry never reaches the
// socket". A fake `prepare` stands in for the generator, exactly as `machineCommands.spec.ts` does.

import { describe, expect, it, vi } from 'vitest';

import { machineUploadCheck } from '../../scripts/machine-upload-check';
import type {
  PreparedProgram,
  PrepareOptions,
  PrepareResult,
} from '../../scripts/lib/casemaker/verifiedProgram';
import type { MachineTransport } from '../../src/platform/desktop/protocol';

/** A transport that records whether the socket was ever opened, and answers empty reads. */
class SpyTransport implements MachineTransport {
  connects = 0;
  async udpListen(): Promise<never[]> {
    return [];
  }
  async tcpConnect(): Promise<number> {
    this.connects += 1;
    return 1;
  }
  async tcpWrite(): Promise<void> {}
  async tcpRead(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async tcpClose(): Promise<void> {}
}

const JOB = 'job.json';
const HOST = '192.0.2.10';
const NC = 'G0 X0 Y0\n';

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
    stage: 'done',
    ok: true,
    errors: [],
    hash: 'abc123',
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

function prepareReturning(result: PrepareResult) {
  return vi.fn(async (_jobPath: string, _opts: PrepareOptions): Promise<PrepareResult> => result);
}

describe('#502 the bench upload check', () => {
  it('a real upload without --my-machine stops before the socket', async () => {
    const transport = new SpyTransport();
    const prepare = prepareReturning({ ok: true, program: prepared() });
    const exit = await machineUploadCheck([JOB, HOST], { transport, prepare });

    expect(exit).toBe(2);
    expect(transport.connects).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('--dry may go without --my-machine and never reaches the socket', async () => {
    const transport = new SpyTransport();
    const exit = await machineUploadCheck([JOB, HOST, '--dry'], {
      transport,
      prepare: prepareReturning({ ok: true, program: prepared() }),
    });

    expect(exit).toBe(0);
    expect(transport.connects).toBe(0);
  });

  it('a job with no usable cutter stops at exit 1', async () => {
    const transport = new SpyTransport();
    const exit = await machineUploadCheck([JOB, HOST, '--dry'], {
      transport,
      prepare: prepareReturning({ ok: false, stage: 'findings', reason: 'the job has no usable cutter' }),
    });

    expect(exit).toBe(1);
    expect(transport.connects).toBe(0);
  });

  it('an unparseable job stops at exit 2', async () => {
    const transport = new SpyTransport();
    const exit = await machineUploadCheck([JOB, HOST, '--dry'], {
      transport,
      prepare: prepareReturning({ ok: false, stage: 'job', reason: 'job.json is not a valid job document' }),
    });

    expect(exit).toBe(2);
    expect(transport.connects).toBe(0);
  });

  it('a gate refusal (uploadBlocker) stops at exit 1', async () => {
    const transport = new SpyTransport();
    const exit = await machineUploadCheck([JOB, HOST, '--dry'], {
      transport,
      prepare: prepareReturning({
        ok: true,
        program: prepared({ blocker: 'the cutter cannot reach the label' }),
      }),
    });

    expect(exit).toBe(1);
    expect(transport.connects).toBe(0);
  });

  it('an --acknowledge that is not exactly the required codes is a usage error (exit 2)', async () => {
    const transport = new SpyTransport();
    const exit = await machineUploadCheck([JOB, HOST, '--dry', '--acknowledge=other-code'], {
      transport,
      prepare: prepareReturning({
        ok: true,
        program: prepared({
          requiredAcks: ['vise-default'],
          ackError: '--acknowledge must name exactly the codes this run asks for',
        }),
      }),
    });

    expect(exit).toBe(2);
    expect(transport.connects).toBe(0);
  });

  it('a bare --acknowledge means no codes, not a flag error', async () => {
    // A bare --acknowledge parses to `[]` (not a usage error); the exactness refusal then comes from
    // the library's ackError, which the fake reports here, so the script exits 2.
    const transport = new SpyTransport();
    const exit = await machineUploadCheck([JOB, HOST, '--dry', '--acknowledge'], {
      transport,
      prepare: prepareReturning({
        ok: true,
        program: prepared({
          requiredAcks: ['vise-default'],
          ackError: '--acknowledge must name exactly the codes this run asks for',
        }),
      }),
    });

    expect(exit).toBe(2);
  });
});
