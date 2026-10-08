import { describe, it, expect, afterEach } from 'vitest';

import {
  programBytes,
  setMachineUploadLoader,
  controllerState,
  uploadProgram,
  type MachineUploadClient,
  type UploadAttempt,
} from '@/platform/machineUpload';
import type { UploadOutcome } from '@/platform/desktop/protocol';
import type { VerifyReport } from '@/engine/cnc/verify';

/**
 * Issue #255 — sending a verified program to the machine.
 *
 * The orchestration under test is the real one: only the socket is faked (the seam shape
 * `machineProbe.spec.ts` and `setRasterDecodeLoader` use), so what runs here is the gate → load
 * bridge → connect path the app runs. The two assertions that matter most are the safety ones: a
 * program the verifier refused is stopped BEFORE the bridge is loaded, and a machine that already
 * holds the file is a success rather than a failure.
 */

afterEach(() => setMachineUploadLoader(null));

const TARGET = { host: '192.168.10.43', port: 2222 };

const OK_REPORT: VerifyReport = {
  ok: true,
  findings: [],
  stats: { lines: 3, cuttingMoves: 1, deepestZ: -1, bbox: { min: [0, 0, -1], max: [1, 1, 0] } },
};

/** A report the type says is fine and the findings contradict — the shape a forged object has. */
const LYING_REPORT: VerifyReport = {
  ...OK_REPORT,
  findings: [{ severity: 'error', code: 'cut-too-deep', line: 3, message: 'cuts deeper than allowed' }],
};

const BAD_REPORT: VerifyReport = { ...OK_REPORT, ok: false, findings: LYING_REPORT.findings };

/** A transport that answers exactly as scripted. */
function fakeClient(over: Partial<MachineUploadClient> = {}): MachineUploadClient {
  return {
    status: over.status ?? (async () => ({ ok: true, text: '<Idle|MPos:0,0,0>' })),
    upload: over.upload ?? (async () => ({ ok: true, bytes: 3, packets: 1, alreadyPresent: false })),
  };
}

/**
 * Install a client and count how many times the loader was REACHED. That count is what makes the
 * "without loading the bridge" assertions mean something: a refusal that still called the factory
 * would have loaded the desktop module in the web build, which is the thing the gate is for.
 */
function use(client: MachineUploadClient): { loads: () => number } {
  let loads = 0;
  setMachineUploadLoader(async () => {
    loads += 1;
    return client;
  });
  return { loads: () => loads };
}

describe('#255 uploadProgram — the gate runs before the bridge', () => {
  it('refuses a name that is not a .nc without loading the bridge', async () => {
    const { loads } = use(fakeClient());
    const result = await uploadProgram(TARGET, {
      filename: 'badge.txt',
      nc: ';@MKR|BEGIN\nM02',
      verify: OK_REPORT,
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.detail).toContain('not a .nc program');
    expect(loads()).toBe(0);
  });

  it('refuses a report that is not ok without loading the bridge', async () => {
    const { loads } = use(fakeClient());
    const result = await uploadProgram(TARGET, { filename: 'badge.nc', nc: 'M02', verify: BAD_REPORT });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.detail).toContain('verifier');
    expect(loads()).toBe(0);
  });

  it('refuses error findings even when the ok flag says otherwise, without loading the bridge', async () => {
    const { loads } = use(fakeClient());
    const result = await uploadProgram(TARGET, { filename: 'badge.nc', nc: 'M02', verify: LYING_REPORT });
    expect(result.kind).toBe('error');
    expect(loads()).toBe(0);
  });
});

describe('#255 uploadProgram — the transport', () => {
  it('hands the client the exact bytes and the filename the caller gave', async () => {
    // An array rather than a `let`: the assignment happens inside the client's callback, so a
    // closed-over variable would still read as `null` to the type-checker after the await.
    const seen: Array<{ filename: string; content: Uint8Array; report: VerifyReport }> = [];
    use(
      fakeClient({
        upload: async (_target, program) => {
          seen.push(program);
          return { ok: true, bytes: program.content.length, packets: 2, alreadyPresent: false };
        },
      }),
    );
    const nc = ';@MKR|BEGIN\nG21 G90\nG1 X1 Y1 F200\nM02\n';
    const result = await uploadProgram(TARGET, { filename: 'Untitled-engrave-job.nc', nc, verify: OK_REPORT });

    expect(seen).toHaveLength(1);
    const program = seen[0]!;
    expect(program.filename).toBe('Untitled-engrave-job.nc');
    expect(program.report).toBe(OK_REPORT);
    // The bytes are the program, not a copy of it that could have been altered on the way.
    expect(Array.from(program.content)).toEqual(Array.from(programBytes(nc)));

    expect(result).toEqual({
      kind: 'uploaded',
      filename: 'Untitled-engrave-job.nc',
      bytes: nc.length,
      packets: 2,
      alreadyPresent: false,
    });
  });

  it('reports a machine that already holds the file as an upload, not a failure', async () => {
    use(fakeClient({ upload: async () => ({ ok: true, bytes: 42, packets: 0, alreadyPresent: true }) }));
    const result = await uploadProgram(TARGET, { filename: 'job.nc', nc: 'M02', verify: OK_REPORT });
    expect(result.kind).toBe('uploaded');
    if (result.kind !== 'uploaded') return;
    // 0 packets is the protocol's own signal (the machine cancelled after the MD5 step matched).
    expect(result.alreadyPresent).toBe(true);
    expect(result.packets).toBe(0);
  });

  it('maps each of the transport’s refusals to its own kind, with its detail', async () => {
    for (const reason of ['refused', 'timeout', 'error'] as const) {
      use(fakeClient({ upload: async () => ({ ok: false, reason, detail: `${reason} detail` }) }));
      const result = await uploadProgram(TARGET, { filename: 'job.nc', nc: 'M02', verify: OK_REPORT });
      expect(result.kind).toBe(reason);
      if (result.kind === 'uploaded' || result.kind === 'unavailable') throw new Error('unreachable');
      expect(result.detail).toBe(`${reason} detail`);
      expect(result.filename).toBe('job.nc');
    }
  });

  it('turns a thrown socket error into an outcome rather than an exception', async () => {
    use(
      fakeClient({
        upload: async () => {
          throw new Error('connect ETIMEDOUT 192.168.10.43:2222');
        },
      }),
    );
    const result = await uploadProgram(TARGET, { filename: 'job.nc', nc: 'M02', verify: OK_REPORT });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.detail).toContain('ETIMEDOUT');
  });

  it('is unavailable, with the guard’s own reason, when this build has no bridge', async () => {
    // Exactly what the web build does: `loadMachineBridge()` throws inside the guard.
    setMachineUploadLoader(async () => {
      throw new Error('Driving the machine requires the desktop build (BUILD_TARGET=desktop).');
    });
    const result = await uploadProgram(TARGET, { filename: 'job.nc', nc: 'M02', verify: OK_REPORT });
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toContain('desktop build');
    // The answer still names the file: "this build cannot upload" is about a specific program.
    expect(result.filename).toBe('job.nc');
  });
});

describe('#255 uploadProgram — the restated attempt', () => {
  /** Both ways, so a field added on either side is a compile error rather than a silent drop. */
  type Mutual<A, B> = A extends B ? (B extends A ? true : never) : never;

  it('is the bridge’s UploadOutcome, clause for clause', () => {
    // `machineUpload.ts` restates `UploadOutcome` rather than importing it, because importing would
    // pull `platform/desktop/protocol.ts` into the web bundle. This is the assertion that keeps the
    // restatement honest — the same trick `machineProbe.spec.ts` uses for the command port.
    const same: Mutual<UploadAttempt, UploadOutcome> = true;
    expect(same).toBe(true);
  });
});

describe('#255 programBytes', () => {
  it('encodes UTF-8, which is what the .nc file holds on disk', () => {
    // A label's text can carry an accent; a byte-count taken as `.length` would send 6 and the
    // machine would receive 7. This is that difference, pinned.
    const nc = '; café\nM02';
    expect(nc.length).toBe(10);
    expect(programBytes(nc).length).toBe(11);
    expect(Array.from(programBytes(nc).slice(2, 4))).toEqual([0x63, 0x61]); // 'c', 'a'
    expect(Array.from(programBytes(nc).slice(5, 7))).toEqual([0xc3, 0xa9]); // 'é'
  });
});

describe('#296 uploadProgram — the machine is asked NOW, not remembered', () => {
  const run = () => uploadProgram(TARGET, { filename: 'job.nc', nc: 'M02', verify: OK_REPORT });

  it('sends nothing to a machine that is running, and says what it reported', async () => {
    let uploads = 0;
    use(
      fakeClient({
        status: async () => ({ ok: true, text: '<Run|MPos:1,2,3>' }),
        upload: async () => {
          uploads += 1;
          return { ok: true, bytes: 3, packets: 1, alreadyPresent: false };
        },
      }),
    );
    const result = await run();
    expect(result.kind).toBe('busy');
    if (result.kind !== 'busy') return;
    expect(result.status).toBe('<Run|MPos:1,2,3>');
    expect(result.detail).toContain('Run');
    expect(uploads).toBe(0);
  });

  it.each(['Hold', 'Alarm', 'Home', 'Door'])('treats %s as not idle', async (state) => {
    use(fakeClient({ status: async () => ({ ok: true, text: `<${state}|MPos:0,0,0>` }) }));
    expect((await run()).kind).toBe('busy');
  });

  it('refuses when the machine does not answer — silence is not permission', async () => {
    let uploads = 0;
    use(
      fakeClient({
        status: async () => ({ ok: false, text: null }),
        upload: async () => {
          uploads += 1;
          return { ok: true, bytes: 3, packets: 1, alreadyPresent: false };
        },
      }),
    );
    const result = await run();
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.detail).toContain('could not confirm the machine is idle');
    expect(uploads).toBe(0);
  });

  it('refuses a status line it cannot read, and one that throws', async () => {
    use(fakeClient({ status: async () => ({ ok: true, text: 'ok' }) }));
    const unreadable = await run();
    expect(unreadable.kind).toBe('error');

    use(
      fakeClient({
        status: async () => {
          throw new Error('connect ETIMEDOUT');
        },
      }),
    );
    const thrown = await run();
    expect(thrown.kind).toBe('error');
    if (thrown.kind !== 'error') return;
    expect(thrown.detail).toContain('ETIMEDOUT');
  });

  it('uploads when the machine says Idle', async () => {
    use(fakeClient());
    expect((await run()).kind).toBe('uploaded');
  });

  it('reads the state word out of a real status line', () => {
    expect(controllerState('<Idle|MPos:-1.0000,-1.0000,-1.0000|WPos:147.4,123.8,57.6>')).toBe('Idle');
    expect(controllerState('<Run>')).toBe('Run');
    expect(controllerState('Idle')).toBeNull();
    expect(controllerState(null)).toBeNull();
  });
});
