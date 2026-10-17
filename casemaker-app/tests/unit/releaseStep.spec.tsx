// @vitest-environment jsdom
// #469 — the release step: every program uploaded, played in cut order, the vacuum left on across
// the bit change and closed only when the run stops, and a resumed run skipping the files this
// machine already finished. The upload and the console are fake clients; nothing reaches a machine.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EngraveReleaseStep } from '@/components/panels/EngraveReleaseStep';
import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleClient } from '@/platform/machineConsole';
import { setMachineUploadLoader } from '@/platform/machineUpload';
import {
  HOUSE_SCHEMA_VERSION,
  setHouseClientLoader,
  type HouseCall,
  type HouseClient,
} from '@/platform/houseClient';
import { MachineRecordSchema, type MachineRecord } from '@/platform/locationClient';
import { describeRun, programHash } from '@/platform/machineRun';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import {
  programVacuumSpan,
  releaseFileName,
  releasePrograms,
  releasePending,
} from '@/engine/cnc/engrave/release';
import {
  endOfRun,
  machineKey,
  resetMachineRunStore,
  setRunEndIO,
  useMachineRunStore,
  type RunContext,
  type RunEndIO,
} from '@/store/machineRunStore';
import { resetRunConfirmStore } from '@/store/runConfirmStore';
import { resetEngraveReleaseStore, useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { clearStoredBaseline, resetLocationStore, useLocationStore } from '@/store/locationStore';
import { releaseBlocker, uploadBlocker } from '@/store/engraveRunGate';
import { describeUpload } from '@/components/panels/engraveUploadCopy';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';
import type { VerifyReport } from '@/engine/cnc/verify';
import type { EngraveJob } from '@/types/engraveJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET = { host: '192.0.2.10', port: 2222 };
const VERIFY: VerifyReport = {
  ok: true,
  findings: [],
  stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0], max: [1, 1, 0] } },
};

const NC1 = 'M331\nG0 X0 Y0\nM02\n';
const NC2 = 'G0 X1 Y1\nM332\nM02\n';
const P1: EngraveProgram = {
  setupIndex: 1,
  setupId: 'setup-1',
  toolKey: 'flat-1.0',
  nc: NC1,
  verify: VERIFY,
  frameNc: null,
  frameVerify: null,
  programHash: programHash(NC1),
  cam: null,
};
const P2: EngraveProgram = {
  setupIndex: 2,
  setupId: 'setup-2',
  toolKey: 'flat-3.175x12-metal',
  nc: NC2,
  verify: VERIFY,
  frameNc: null,
  frameVerify: null,
  programHash: programHash(NC2),
  cam: null,
};

/** The generated result the release step reads: two programs, no facing, no feeds row (air on). */
function generated(programs: EngraveProgram[] = [P1, P2], facingNc: string | null = null): EngraveGenerated {
  return {
    ok: true,
    stage: 'done',
    findings: [],
    feeds: null,
    threads: null,
    threadMachining: null,
    cam: null,
    nc: programs[0]?.nc ?? null,
    verify: programs[0]?.verify ?? null,
    frameNc: null,
    frameVerify: null,
    facingNc,
    facingVerify: null,
    facingToolKey: null,
    facingError: null,
    facingCam: null,
    predicted: [],
    programs,
    errors: [],
  } as unknown as EngraveGenerated;
}

/** A job with two stored setups, so the plan has a setup for each program. */
function twoSetupJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.name = 'Two setup job';
  job.toolKey = 'flat-1.0';
  const first = jobSetups(job)[0]!;
  job.setups = [first, { ...first, id: 'setup-2', tools: ['flat-3.175x12-metal'] }];
  return job;
}

const sent: string[] = [];
const uploaded: string[] = [];

/**
 * A gate for the span close, so a test can hold `M332`/`$H` in flight and try to start a program
 * underneath them. Off by default: every other test's closes land at once.
 */
let closeGate: Promise<void> = Promise.resolve();
let releaseClose: (() => void) | null = null;
let holdClose = false;

function holdSpanClose(): void {
  closeGate = new Promise((resolve) => {
    releaseClose = resolve;
  });
  holdClose = true;
}

function releaseSpanClose(): void {
  holdClose = false;
  releaseClose?.();
  releaseClose = null;
}

/**
 * A controller that finishes each played program after `finishAfter` polls. `?` is Idle before a
 * play and after it finishes; an abort makes it Idle at once.
 */
function controller(finishAfter = 2): MachineConsoleClient {
  let playing: { polls: number } | null = null;
  let aborted = false;
  return {
    async open() {
      return {
        async send(line: string): Promise<ConsoleSend> {
          sent.push(line);
          // The line is sent; the answer is what is held. That is the in-flight close the release
          // step must not start underneath.
          if (holdClose && (line === 'M332' || line === '$H')) await closeGate;
          let text = 'ok';
          if (line === '?') {
            if (playing === null || aborted) text = '<Idle|MPos:0,0,0>';
            else text = playing.polls++ < finishAfter ? '<Run|MPos:0,0,0|P:10,20,5>' : '<Idle|P:9,100,4>';
          } else if (line.startsWith('play')) {
            playing = { polls: 0 };
            aborted = false;
            text = 'File size 10';
          } else if (line === 'abort') {
            aborted = true;
            text = 'ok\nAborted playing or paused file.';
          }
          return { ok: true, line, text, frames: 1, elapsedMs: 1 };
        },
        async close() {},
      };
    },
  };
}

function runEndIO(consumed: string[]): RunEndIO {
  return {
    refreshStock: async () => {},
    stockItem: () => null,
    consume: async (id) => {
      consumed.push(id);
      return { ok: true, text: '' };
    },
    addOffcut: async () => ({ ok: true, text: '' }),
    inventory: () => [],
    updateItem: async () => ({ ok: true, text: '' }),
    machineIdFor: () => null,
    recordFinishedProgram: async () => ({ ok: true, added: true, text: '' }),
    minSideMm: () => 5,
    offerOffcuts: () => false,
    wearWeight: () => ({ value: 1, source: 'test' }),
    newId: () => 'offcut-1',
    now: () => '2026-10-17T00:00:00.000Z',
  };
}

let consumed: string[];
beforeEach(() => {
  sent.length = 0;
  uploaded.length = 0;
  consumed = [];
  closeGate = Promise.resolve();
  releaseClose = null;
  holdClose = false;
  resetRunConfirmStore();
  resetMachineRunStore();
  resetEngraveReleaseStore();
  resetLocationStore();
  clearStoredBaseline();
  setMachineConsoleLoader(async () => controller(2));
  setMachineUploadLoader(async () => ({
    status: async () => ({ ok: true, text: '<Idle|MPos:0,0,0>' }),
    upload: async (_target, program) => {
      uploaded.push(program.filename);
      return { ok: true, bytes: program.content.length, packets: 1, alreadyPresent: false };
    },
  }));
  setRunEndIO(runEndIO(consumed));
});
afterEach(() => {
  cleanup();
  setMachineConsoleLoader(null);
  setMachineUploadLoader(null);
  setHouseClientLoader(null);
  setRunEndIO(null);
});

const record = () => useEngraveReleaseStore.getState().records[`${TARGET.host}:${TARGET.port}`];

async function uploadOnly(): Promise<void> {
  fireEvent.click(await screen.findByTestId('engrave-release-upload'));
  fireEvent.click(screen.getByTestId('engrave-release-upload-confirm-send'));
  await screen.findByTestId('engrave-release-start');
}

async function uploadAndStart(): Promise<void> {
  fireEvent.click(await screen.findByTestId('engrave-release-upload'));
  fireEvent.click(screen.getByTestId('engrave-release-upload-confirm-send'));
  await screen.findByTestId('engrave-release-start');
  fireEvent.click(screen.getByTestId('engrave-release-at-machine'));
  fireEvent.click(screen.getByTestId('engrave-release-start'));
}

describe('#469 the release step', () => {
  it('names a one-program job as the run sheet does and a list by cut-order position', () => {
    expect(releaseFileName('My job', 1, 1)).toBe('My-job.nc');
    expect(releaseFileName('My job', 1, 2)).toBe('My-job-p1.nc');
    expect(releaseFileName('My job', 2, 2)).toBe('My-job-p2.nc');
  });

  it('keeps a finished program in the list, marks it done, and leaves it out of what is left to play', () => {
    const files = releasePrograms('Job', [P1, P2], [P1.programHash]);
    expect(files).toHaveLength(2);
    expect(files[0]!.done).toBe(true);
    expect(files[1]!.done).toBe(false);
    expect(releasePending(files).map((f) => f.index)).toEqual([2]);
  });

  it('reads each file’s own vacuum share, including a middle file that says nothing', () => {
    expect(programVacuumSpan(NC1, true)).toBe('first');
    expect(programVacuumSpan('G0 X0\n', true)).toBe('middle');
    expect(programVacuumSpan(NC2, true)).toBe('last');
    expect(programVacuumSpan('G0 X0\n', false)).toBe('none');
  });

  it('lifts the single-file refusal for the release step only, and refuses a faced job by name', () => {
    const view = {
      generated: generated(),
      oracle: { ok: true, band: 0, levels: [], worst: { underCut: 0, overCut: 0 } },
      simDiagnostics: [],
      simStatus: 'ready' as const,
      phase: 'ready' as const,
      acknowledged: false,
      staleSince: null,
      error: null,
    };
    expect(uploadBlocker(view)).toBe('this job is 2 programs; the app plays one');
    expect(releaseBlocker(view)).toBeNull();
    expect(releaseBlocker({ ...view, generated: generated([P1, P2], 'M02\n') })).toContain('faces the stock first');
  });

  it('uploads every program, plays them in order, and sends no vacuum word between them', async () => {
    render(<EngraveReleaseStep target={TARGET} job={twoSetupJob()} generated={generated()} blocker={null} />);
    await uploadAndStart();

    // Program 1 runs to its end; the release pauses at the bit change with the machine homed.
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 10000 });
    expect(uploaded).toEqual(['Two-setup-job-p1.nc', 'Two-setup-job-p2.nc']);
    expect(sent.filter((l) => l.startsWith('play'))).toEqual(['play /sd/gcodes/Two-setup-job-p1.nc']);
    // The program carries M331; the release adds no word of its own, and no M332 at a change.
    expect(sent).not.toContain('M331');
    expect(sent).not.toContain('M332');
    expect(
      useEngraveReleaseStore.getState().records[`${TARGET.host}:${TARGET.port}`]?.notes.some((n) => n.includes('stays on')),
    ).toBe(true);

    fireEvent.click(screen.getByTestId('engrave-release-change-ok'));
    fireEvent.click(screen.getByTestId('engrave-release-change-done'));
    await screen.findByTestId('engrave-release-done', undefined, { timeout: 10000 });

    expect(sent.filter((l) => l.startsWith('play'))).toEqual([
      'play /sd/gcodes/Two-setup-job-p1.nc',
      'play /sd/gcodes/Two-setup-job-p2.nc',
    ]);
    // M332 was in program 2's own text, not sent by the release step between files.
    expect(sent.filter((l) => l === 'M332')).toHaveLength(0);
  }, 30000);

  it('a Stop between programs closes the span: M332 then $H, on an Idle machine', async () => {
    render(<EngraveReleaseStep target={TARGET} job={twoSetupJob()} generated={generated()} blocker={null} />);
    await uploadAndStart();
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 10000 });

    const before = sent.length;
    fireEvent.click(screen.getByTestId('engrave-release-stop'));
    await waitFor(() => expect(sent.slice(before)).toContain('M332'), { timeout: 5000 });
    const tail = sent.slice(before);
    expect(tail.filter((l) => l === 'M332')).toHaveLength(1);
    expect(tail.indexOf('M332')).toBeLessThan(tail.lastIndexOf('$H'));
    expect(sent.filter((l) => l.startsWith('play'))).toHaveLength(1);
    expect(useEngraveReleaseStore.getState().records[`${TARGET.host}:${TARGET.port}`]?.phase).toBe('stopped');
  }, 30000);

  it('resumes at the first unfinished program: a done file is skipped and the span is switched on for the next', async () => {
    // The machine's location record says program 1 finished there (#419 §4.5).
    const machine: MachineRecord = MachineRecordSchema.parse({
      id: 'm-1',
      address: TARGET,
      updatedAt: '2026-10-16T00:00:00.000Z',
    });
    machine.finishedPrograms = [P1.programHash];
    const client: HouseClient = {
      probe: async () => ({
        kind: 'present',
        base: '',
        health: {
          ok: true,
          schemaVersion: HOUSE_SCHEMA_VERSION,
          hasCatalogue: false,
          feedRows: 0,
          materialSpecRows: 0,
          catalogueSyncedAt: null,
          lastSync: null,
          problems: [],
          warnings: [],
        },
      }),
      tools: async () => ({ kind: 'ok', etag: '"t"', entries: [] }),
      feeds: async () => ({ kind: 'absent', reason: 'none' }),
      inventory: async () => ({ kind: 'ok', etag: '"i"', items: [] }),
      call: async (method, path): Promise<HouseCall> =>
        method === 'GET' && path === '/location'
          ? {
              kind: 'ok',
              text: JSON.stringify({
                kind: 'casemaker-location',
                schemaVersion: 1,
                id: 'loc-test',
                name: 'My shop',
                createdAt: '2026-10-15T00:00:00.000Z',
                migratedFrom: null,
                machines: [machine],
              }),
              etag: '"loc-1"',
            }
          : { kind: 'refused', status: 404, message: `${method} ${path} is not served here` },
    };
    setHouseClientLoader(async () => client);
    await useLocationStore.getState().refresh();

    render(<EngraveReleaseStep target={TARGET} job={twoSetupJob()} generated={generated()} blocker={null} />);
    fireEvent.click(await screen.findByTestId('engrave-release-upload'));
    fireEvent.click(screen.getByTestId('engrave-release-upload-confirm-send'));
    await screen.findByTestId('engrave-release-start');
    expect(screen.getByTestId('engrave-release-progress').textContent).toContain('1 of 2 finished');
    fireEvent.click(screen.getByTestId('engrave-release-at-machine'));
    fireEvent.click(screen.getByTestId('engrave-release-start'));

    // The first unfinished file is program 2, so the release asks for its cutter BEFORE playing.
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 5000 });
    expect(sent.filter((l) => l.startsWith('play'))).toEqual([]);
    fireEvent.click(screen.getByTestId('engrave-release-change-ok'));
    fireEvent.click(screen.getByTestId('engrave-release-change-done'));
    await screen.findByTestId('engrave-release-done', undefined, { timeout: 10000 });

    expect(sent.filter((l) => l.startsWith('play'))).toEqual(['play /sd/gcodes/Two-setup-job-p2.nc']);
    // Program 2 carries M332 only; the vacuum was off before the resume, so the step switches it on.
    expect(sent).toContain('M331');
  }, 30000);

  it('an unticked Resume is disabled and sends nothing', async () => {
    render(<EngraveReleaseStep target={TARGET} job={twoSetupJob()} generated={generated()} blocker={null} />);
    await uploadOnly();
    // Stop at `ready`: the phase is `stopped`, the at-machine tick was never made.
    await act(async () => {
      useEngraveReleaseStore.getState().stop(TARGET);
    });
    await waitFor(() => expect(record()?.phase).toBe('stopped'), { timeout: 5000 });

    const start = screen.getByTestId('engrave-release-start') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    expect(sent.filter((l) => l.startsWith('play'))).toEqual([]);

    // The tick is what enables Resume, not the phase alone.
    fireEvent.click(screen.getByTestId('engrave-release-at-machine'));
    expect((screen.getByTestId('engrave-release-start') as HTMLButtonElement).disabled).toBe(false);
  }, 20000);

  it('a Resume pressed while the span close is in flight does not start, and one after it resolves does', async () => {
    render(<EngraveReleaseStep target={TARGET} job={twoSetupJob()} generated={generated()} blocker={null} />);
    await uploadOnly();
    fireEvent.click(screen.getByTestId('engrave-release-at-machine'));
    holdSpanClose();
    await act(async () => {
      useEngraveReleaseStore.getState().stop(TARGET);
    });
    await waitFor(() => expect(record()?.phase).toBe('closing'), { timeout: 5000 });

    // `M332`/`$H` are in flight. The button is disabled, and the store refuses a direct press too:
    // starting now could put a program's own M331 underneath the late M332.
    const start = screen.getByTestId('engrave-release-start') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    useEngraveReleaseStore.getState().startRelease(TARGET);
    expect(record()?.phase).toBe('closing');
    expect(sent.filter((l) => l.startsWith('play'))).toEqual([]);

    releaseSpanClose();
    await waitFor(() => expect(record()?.phase).toBe('stopped'), { timeout: 5000 });
    expect((screen.getByTestId('engrave-release-start') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('engrave-release-start'));
    await waitFor(() => expect(sent.filter((l) => l.startsWith('play'))).toEqual(['play /sd/gcodes/Two-setup-job-p1.nc']), {
      timeout: 5000,
    });
    // Let the program finish, so the test does not leave a run in flight at cleanup.
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 10000 });
  }, 30000);

  it('a start that fails after M331 says the vacuum is on and closes the span', async () => {
    render(<EngraveReleaseStep target={TARGET} job={twoSetupJob()} generated={generated()} blocker={null} />);
    await uploadAndStart();
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 10000 });

    // Stop at the change, then resume at program 2: it carries only M332, so the release switches
    // the vacuum on itself before starting.
    await act(async () => {
      useEngraveReleaseStore.getState().stop(TARGET);
    });
    await waitFor(() => expect(record()?.phase).toBe('stopped'), { timeout: 5000 });
    fireEvent.click(screen.getByTestId('engrave-release-start'));
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 5000 });

    // Make `prepare` refuse: another run is already going on this machine.
    const key = machineKey(TARGET);
    await act(async () => {
      const entry = useMachineRunStore.getState().runs[key]!;
      useMachineRunStore.setState({
        runs: { ...useMachineRunStore.getState().runs, [key]: { ...entry, running: true } },
      });
    });
    const before = sent.length;
    fireEvent.click(screen.getByTestId('engrave-release-change-ok'));
    fireEvent.click(screen.getByTestId('engrave-release-change-done'));

    await waitFor(() => expect(record()?.phase).toBe('failed'), { timeout: 5000 });
    const tail = sent.slice(before);
    expect(tail).toContain('M331');
    expect(tail).toContain('M332');
    expect(tail).toContain('$H');
    expect(record()?.notes.join('\n')).toContain('on with nothing cutting');
  }, 30000);

  it('consumes the job’s blank only when its LAST program finishes, not once per file', async () => {
    const ctx = (index: number): RunContext => ({
      nc: 'M02\n',
      jobId: 'job-1',
      stockEntryId: 'shelf-1',
      stockXY: { x: 100, y: 60 },
      toolRadius: 1,
      programIndex: index,
      programTotal: 2,
    });
    const finished = {
      kind: 'finished' as const,
      last: { state: 'Idle', line: 9, percent: 100, elapsedS: 60 },
      homed: true,
      vacuumOff: true,
    };
    const first = await endOfRun(TARGET, finished, ctx(1));
    expect(consumed).toEqual([]);
    expect(first.lines.join(' ')).toContain('stays reserved');
    const last = await endOfRun(TARGET, finished, ctx(2));
    expect(consumed).toEqual(['shelf-1']);
    expect(last.lines.join(' ')).toContain('Stock used');
  });

  it('says what a finished first/middle file left the vacuum doing', () => {
    const o = {
      kind: 'finished' as const,
      last: { state: 'Idle', line: 9, percent: 100, elapsedS: 1 },
      homed: true,
      vacuumOff: false,
      vacuumOwner: 'job' as const,
      span: 'first' as const,
    };
    expect(describeRun(o)).toContain('stays on for the next program');
    expect(describeRun({ ...o, span: 'none' })).toContain('without the vacuum');
    expect(describeUpload({ kind: 'uploaded', filename: 'p.nc', bytes: 3, packets: 1, alreadyPresent: false, status: '' }, 'Z1')).toContain('p.nc');
  });
});
