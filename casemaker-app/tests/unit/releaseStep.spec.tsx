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
import { resetInventoryConditions, setInventoryConditions, type ToolCopy } from '@/engine/cnc/toolCondition';
import { flatEndMill } from '@/engine/cnc/tool';
import { TOOL_LIBRARY } from '@/engine/cnc/toolLibrary';
import {
  frozenReleaseSources,
  programVacuumSpan,
  releaseFileName,
  releasePrograms,
  releasePending,
  type ReleaseSource,
} from '@/engine/cnc/engrave/release';
import { freezePackage } from '@/engine/cnc/engrave/package';
import { cutPlan } from '@/engine/cnc/engrave/cutPlan';
import type { RunPlan } from '@/engine/cnc/plan';
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
import { useEngraveJobStore } from '@/store/engraveJobStore';
import {
  resetEngraveRegistrationStore,
  useEngraveRegistrationStore,
} from '@/store/engraveRegistrationStore';
import { clearStoredBaseline, resetLocationStore, useLocationStore } from '@/store/locationStore';
import { facingRegistrationBlocker, releaseBlocker, uploadBlocker } from '@/store/engraveRunGate';
import { planRegistration } from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import type { RegistrationOutcome } from '@/engine/cnc/registration/outcome';
import type { StockItem } from '@/platform/stockClient';
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
const NC_FACE = 'M331\nG1 Z-0.5\nM02\n';
const FACE: EngraveProgram = {
  kind: 'facing',
  setupIndex: 1,
  setupId: 'setup-1',
  toolKey: 'user:facing-3.175',
  nc: NC_FACE,
  verify: VERIFY,
  frameNc: null,
  frameVerify: null,
  programHash: programHash(NC_FACE),
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

/** A job that faces the stock before it engraves (#473), with the depth the face program removes. */
function facedJob(depth = 0.5): EngraveJob {
  const job = defaultEngraveJob();
  job.name = 'Faced job';
  job.toolKey = 'flat-1.0';
  job.facing = { enabled: true, depth };
  return job;
}

/**
 * #494 — the job's FIRST registration, as a registration step would leave it: a plan measured on this
 * machine, with a usable outcome whose `surfaceZ` is the top the face program was posted against.
 */
const FIRST_OUTCOME: RegistrationOutcome = {
  edges: [],
  offset: { x: 0, y: 0 },
  measured: { x: true, y: true },
  centre: { x: 19.05, y: 38.1 },
  rotationDeg: null,
  rotationShiftMm: null,
  withinMargin: true,
  margin: 0.2,
  surfaceZ: -56.172,
  probeRefZ: -80,
  seekFromMachineZ: -3,
  currentG54: { x: -181.55, y: -184.8 },
  correctedG54: { x: -181.55, y: -184.8 },
  xyChecked: true,
  usable: true,
  problems: [],
  notes: [],
};

function seedRegistration(job: EngraveJob, outcome: RegistrationOutcome = FIRST_OUTCOME): void {
  const { settings } = registrationSettings(null);
  const planned = planRegistration(
    {
      stock: { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 },
      mount: 'vise',
      expectedSurface: { machineZ: outcome.surfaceZ, from: 'the faced blank, as registered' },
      seekFromMachineZ: outcome.seekFromMachineZ,
      fixtureBelowSurfaceMm: 0.72,
      cutCentre: { x: 24, y: 43 },
    },
    settings,
  );
  if (!planned.ok) throw new Error(planned.reason);
  useEngraveRegistrationStore.getState().record(job.id, TARGET, planned.plan, outcome);
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
 * play and after it finishes; an abort makes it Idle at once. For #494's post-facing step,
 * `retouchSurfaceZ` is the machine Z every probe touch reports and `m491` the tool-length reply.
 */
function controller(
  finishAfter = 2,
  opts: { retouchSurfaceZ?: number; m491?: string } = {},
): MachineConsoleClient {
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
          } else if (line === 'M491') {
            text = opts.m491 ?? 'ok\n[PRB:0,0,-80.000:1]';
          } else if (opts.retouchSurfaceZ !== undefined && line.startsWith('G38.3')) {
            // Both the fast and the slow touch of the re-touch seek read the same faced top. Every
            // probe is G38.3 since #518; the post-facing re-touch shares seekSurface with registration.
            text = `[PRB:-174.550,-175.800,${opts.retouchSurfaceZ.toFixed(3)}:1]\nok`;
          } else if (line.startsWith('G38.2')) {
            // #518 — the executor must never send G38.2 (the bench alarmed on every miss). Answer an
            // alarm so a regression back to G38.2 fails loudly, as the registration-spec fakes do.
            text = 'ALARM: Probe fail';
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
  resetEngraveRegistrationStore();
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
  resetInventoryConditions();
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

/** #494 — a faced run up to the confirmed bit change after the face program. */
async function facedToChange(job: EngraveJob, engraving: EngraveProgram): Promise<void> {
  renderStep(job, [FACE, engraving]);
  await uploadAndStart();
  await screen.findByTestId('engrave-release-change', undefined, { timeout: 10000 });
  fireEvent.click(screen.getByTestId('engrave-release-change-ok'));
  fireEvent.click(screen.getByTestId('engrave-release-at-machine'));
  fireEvent.click(screen.getByTestId('engrave-release-change-done'));
}

/** The engraving program after a face file: its own NC, the same setup and cutter. */
function engravingProgram(): EngraveProgram {
  const nc = 'G0 X1 Y1\nM332\nM02\n';
  return { ...P1, nc, programHash: programHash(nc) };
}

/** A generated program as a release source: the shape the pure list reader takes. */
function sourcesOf(programs: EngraveProgram[]): ReleaseSource[] {
  return programs.map((p) => ({
    setupIndex: p.setupIndex,
    setupId: p.setupId,
    toolKey: p.toolKey,
    ...(p.kind === undefined ? {} : { kind: p.kind }),
    nc: p.nc,
    hash: p.programHash,
    verify: p.verify,
  }));
}

/**
 * #419 §3 / #425 — the step is fed the FROZEN package's sources and the one Cut plan, exactly as
 * `EngraveCutSurface` feeds it. Building them here through the production helpers keeps the spec
 * from testing a second, looser contract.
 */
function renderStep(job: EngraveJob, programs: EngraveProgram[] = [P1, P2]): RunPlan {
  const made = freezePackage(job, programs, '2026-10-17T14:02:00.000Z');
  if (!made.ok) throw new Error(made.reason);
  // #425 §6 — the release is the OPEN document's run, so its outcome has a document to land in.
  useEngraveJobStore.setState({ job: { ...job, package: made.package } });
  const reports = new Map(programs.map((p) => [p.programHash, p.verify] as const));
  const runPlan = cutPlan({ job, pkg: made.package, finishedHashes: [], defaults: null });
  render(
    <EngraveReleaseStep
      target={TARGET}
      job={job}
      programs={frozenReleaseSources(job, made.package, reports)}
      runPlan={runPlan}
      blocker={null}
    />,
  );
  return runPlan;
}

describe('#469 the release step', () => {
  it('names a one-program job as the run sheet does and a list by cut-order position', () => {
    expect(releaseFileName('My job', 1, 1)).toBe('My-job.nc');
    expect(releaseFileName('My job', 1, 2)).toBe('My-job-p1.nc');
    expect(releaseFileName('My job', 2, 2)).toBe('My-job-p2.nc');
  });

  it('keeps a finished program in the list, marks it done, and leaves it out of what is left to play', () => {
    const files = releasePrograms('Job', sourcesOf([P1, P2]), [P1.programHash]);
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

  it('lifts the single-file refusal for the release step only, and refuses a faced run whose face file is not playable', () => {
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

    // #473 — a faced run is a normal run: the face file is program 1 of the list.
    expect(releaseBlocker({ ...view, generated: generated([FACE, P1], NC_FACE) })).toBeNull();
    // A stored result from before the face file joined the list cannot be played as the run.
    expect(releaseBlocker({ ...view, generated: generated([P1, P2], 'M02\n') })).toContain(
      'the face program is not in the run order',
    );
    // A face program the worker could not produce refuses by its own reason.
    const withheld = { ...generated(), facingNc: 'M02\n', facingError: 'the clamp on the back edge stands over it' };
    expect(releaseBlocker({ ...view, generated: withheld })).toContain(
      'the face program was not produced — the clamp on the back edge stands over it',
    );

    // A result stored before #432 has neither field: absent is "no facing", not a refusal.
    const old = { ...generated() } as unknown as Record<string, unknown>;
    delete old.facingNc;
    delete old.facingError;
    expect(releaseBlocker({ ...view, generated: old as unknown as EngraveGenerated })).toBeNull();

    // #494 — a faced run additionally needs its first registration before the release may start.
    expect(facingRegistrationBlocker(facedJob(), [FACE, P1], null)).toContain(
      'first registration is not in app state',
    );
    // A job that does not face needs none, even with a face file-shaped first program.
    expect(facingRegistrationBlocker(defaultEngraveJob(), [FACE, P1], null)).toBeNull();
  });

  it('uploads every program, plays them in order, and sends no vacuum word between them', async () => {
    renderStep(twoSetupJob());
    await uploadAndStart();

    // #419 decision 4 — every file the release plays owns the vacuum span, including the middle
    // ones: `vacuumOwned` is what stops the runner from bracketing a file it does not own.
    expect(useMachineRunStore.getState().runs[`${TARGET.host}:${TARGET.port}`]?.context).toMatchObject({
      vacuumOwned: true,
      vacuumSpan: 'first',
      nc: NC1,
      programIndex: 1,
      programTotal: 2,
    });

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

    // D-17 — the bit change cleared the at-machine tick: program 2 does not start without it.
    expect((screen.getByTestId('engrave-release-change-done') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-release-change-ok'));
    expect((screen.getByTestId('engrave-release-change-done') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-release-at-machine'));
    fireEvent.click(screen.getByTestId('engrave-release-change-done'));
    expect(useMachineRunStore.getState().runs[`${TARGET.host}:${TARGET.port}`]?.context).toMatchObject({
      vacuumOwned: true,
      vacuumSpan: 'last',
      nc: NC2,
      programIndex: 2,
      programTotal: 2,
    });
    await screen.findByTestId('engrave-release-done', undefined, { timeout: 10000 });

    expect(sent.filter((l) => l.startsWith('play'))).toEqual([
      'play /sd/gcodes/Two-setup-job-p1.nc',
      'play /sd/gcodes/Two-setup-job-p2.nc',
    ]);
    // M332 was in program 2's own text, not sent by the release step between files.
    expect(sent.filter((l) => l === 'M332')).toHaveLength(0);
    // #425 §6 — the DOCUMENT holds the resume fact for both played programs, with their setups.
    const log = useEngraveJobStore.getState().job.runLog ?? [];
    expect(log.map((entry) => [entry.programHash, entry.setupId, entry.outcome])).toEqual([
      [P1.programHash, 'setup-1', 'finished'],
      [P2.programHash, 'setup-2', 'finished'],
    ]);
  }, 30000);

  it('plays a faced run as face file then engraving, and asks for the engraving cutter and a measured re-touch', async () => {
    // #473 — the face file is program 1 of the same list. The bit change after it is the one place
    // the order becomes physical: the engraving cutter goes in, and the faced top is measured.
    const NC_EN = 'G0 X1 Y1\nM332\nM02\n';
    const EN: EngraveProgram = { ...P1, nc: NC_EN, programHash: programHash(NC_EN) };
    const job = facedJob();
    // #494 — a faced release needs the first registration in app state; the step that records it is
    // still the registration UI's (#430), so the test seeds it as that step would.
    seedRegistration(job);
    renderStep(job, [FACE, EN]);

    expect((await screen.findByTestId('engrave-release-facing-note')).textContent).toContain('program 1 is the face file');
    await uploadAndStart();

    await screen.findByTestId('engrave-release-change', undefined, { timeout: 10000 });
    expect(uploaded).toEqual(['Faced-job-p1.nc', 'Faced-job-p2.nc']);
    expect(sent.filter((l) => l.startsWith('play'))).toEqual(['play /sd/gcodes/Faced-job-p1.nc']);
    const change = screen.getByTestId('engrave-release-change').textContent ?? '';
    expect(change).toContain('ENGRAVING cutter');
    expect(change).toContain('re-touches the FACED surface with the wired probe');
    // The facing cutter was program 1's; the change names the engraving cutter for program 2.
    expect(change).toContain('flat-1.0');
  }, 30000);

  it('refuses a faced release with no first registration, then enables it when one is recorded (#494)', async () => {
    const job = facedJob();
    setMachineConsoleLoader(async () => controller(2, { retouchSurfaceZ: -56.666 }));
    renderStep(job, [FACE, engravingProgram()]);
    await uploadOnly();
    fireEvent.click(screen.getByTestId('engrave-release-at-machine'));

    expect(screen.getByTestId('engrave-release-registration-blocker').textContent).toContain(
      'first registration is not in app state',
    );
    const start = () => screen.getByTestId('engrave-release-start') as HTMLButtonElement;
    expect(start().disabled).toBe(true);
    // The store refuses too, not only the button: nothing is played without the reading.
    await act(async () => {
      useEngraveReleaseStore.getState().startRelease(TARGET);
    });
    expect(record()?.phase).toBe('ready');
    expect(sent.filter((l) => l.startsWith('play'))).toEqual([]);

    // The registration step records it; the panel subscribes, so Start unlocks without a remount.
    await act(async () => {
      seedRegistration(job);
    });
    await waitFor(() => expect(start().disabled).toBe(false), { timeout: 5000 });
  }, 20000);

  it('after the face file’s confirmed change, re-touches the faced top and writes Z0 before the engraving program (#494)', async () => {
    const job = facedJob();
    seedRegistration(job);
    setMachineConsoleLoader(async () => controller(2, { retouchSurfaceZ: -56.666 }));
    await facedToChange(job, engravingProgram());

    // The executor asks for the wired probe, measures, then asks for the ENGRAVING cutter.
    await waitFor(
      () => expect(screen.getByTestId('engrave-release-operator-text').textContent).toContain('Fit the wired probe'),
      { timeout: 10000 },
    );
    expect(record()?.phase).toBe('retouch');
    fireEvent.click(screen.getByTestId('engrave-release-operator-continue'));
    await waitFor(
      () =>
        expect(screen.getByTestId('engrave-release-operator-text').textContent).toContain('ENGRAVING cutter'),
      { timeout: 10000 },
    );
    fireEvent.click(screen.getByTestId('engrave-release-operator-continue'));

    await screen.findByTestId('engrave-release-done', undefined, { timeout: 15000 });
    expect(sent.filter((l) => l.startsWith('play'))).toEqual([
      'play /sd/gcodes/Faced-job-p1.nc',
      'play /sd/gcodes/Faced-job-p2.nc',
    ]);
    // Z0 comes from the MEASURED faced top, and the write is ordered before the engraving program.
    const g10 = sent.filter((l) => l.startsWith('G10 L2'));
    expect(g10).toHaveLength(1);
    expect(g10[0]).toContain('Z-56.666');
    expect(sent.indexOf(g10[0]!)).toBeLessThan(sent.indexOf('play /sd/gcodes/Faced-job-p2.nc'));
    const notes = record()?.notes.join('\n') ?? '';
    expect(notes).toContain('faced top measured machine Z -56.666');
    expect(notes).toContain('Z0 for flat-1.0 written');
  }, 30000);

  it('a re-touch outside the band BLOCKS the engraving program and closes the span (#494)', async () => {
    const job = facedJob();
    seedRegistration(job);
    // The faced top should be at −56.672 ± the shop tolerance; this reading is 0.228 mm high.
    setMachineConsoleLoader(async () => controller(2, { retouchSurfaceZ: -56.9 }));
    await facedToChange(job, engravingProgram());

    await waitFor(
      () => expect(screen.getByTestId('engrave-release-operator-text').textContent).toContain('Fit the wired probe'),
      { timeout: 10000 },
    );
    fireEvent.click(screen.getByTestId('engrave-release-operator-continue'));

    await waitFor(() => expect(record()?.phase).toBe('failed'), { timeout: 15000 });
    const notes = record()?.notes.join('\n') ?? '';
    expect(notes).toContain('outside the expected');
    expect(notes).toContain('No engraving program was played');
    expect(sent.filter((l) => l.startsWith('play'))).toEqual(['play /sd/gcodes/Faced-job-p1.nc']);
    expect(sent.filter((l) => l.startsWith('G10 L2'))).toHaveLength(0);
    // The face file is the only program that ran; the vacuum was closed after the refusal.
    expect(sent).toContain('M332');
    expect(screen.queryByTestId('engrave-release-operator-text')).toBeNull();
  }, 30000);

  it('a failed cutter-length correction BLOCKS the engraving program and closes the span (#494)', async () => {
    const job = facedJob();
    seedRegistration(job);
    // The re-touch is in band, but the cutter's M491 carries no PRB: Z0 cannot be written.
    setMachineConsoleLoader(async () => controller(2, { retouchSurfaceZ: -56.666, m491: 'ok' }));
    await facedToChange(job, engravingProgram());

    await waitFor(
      () => expect(screen.getByTestId('engrave-release-operator-text').textContent).toContain('Fit the wired probe'),
      { timeout: 10000 },
    );
    fireEvent.click(screen.getByTestId('engrave-release-operator-continue'));
    await waitFor(
      () =>
        expect(screen.getByTestId('engrave-release-operator-text').textContent).toContain('ENGRAVING cutter'),
      { timeout: 10000 },
    );
    fireEvent.click(screen.getByTestId('engrave-release-operator-continue'));

    await waitFor(() => expect(record()?.phase).toBe('failed'), { timeout: 15000 });
    const notes = record()?.notes.join('\n') ?? '';
    expect(notes).toContain('M491 answered no tool-length reading for the cutter');
    expect(notes).toContain('No engraving program was played');
    expect(sent.filter((l) => l.startsWith('play'))).toEqual(['play /sd/gcodes/Faced-job-p1.nc']);
    expect(sent.filter((l) => l.startsWith('G10 L2'))).toHaveLength(0);
    expect(sent).toContain('M332');
  }, 30000);

  it('a RESUME of the engraving program does not re-touch a top that program has already cut (#494)', async () => {
    const job = facedJob();
    seedRegistration(job);
    setMachineConsoleLoader(async () => controller(2, { retouchSurfaceZ: -56.666 }));
    renderStep(job, [FACE, engravingProgram()]);
    await screen.findByTestId('engrave-release-files');

    // The state a resume after a failed program 2 leaves: the face file done, its bit change
    // confirmed, and the re-touch's Z0 already written for program 2.
    const machine = `${TARGET.host}:${TARGET.port}`;
    const current = record()!;
    await act(async () => {
      useEngraveReleaseStore.setState({
        records: {
          ...useEngraveReleaseStore.getState().records,
          [machine]: {
            ...current,
            phase: 'bit-change',
            active: null,
            next: 2,
            atMachine: true,
            retouchedFor: 2,
            files: current.files.map((f) =>
              f.index === 1 ? { ...f, done: true, upload: 'uploaded' as const } : { ...f, upload: 'uploaded' as const },
            ),
          },
        },
      });
    });
    await act(async () => {
      useEngraveReleaseStore.getState().confirmChange(TARGET);
    });

    await waitFor(
      () => expect(sent.filter((l) => l.startsWith('play'))).toEqual(['play /sd/gcodes/Faced-job-p2.nc']),
      { timeout: 10000 },
    );
    // No probe seek and no second origin write: the top under the re-touch point is now a floor.
    expect(sent.filter((l) => l.startsWith('G38.2'))).toEqual([]);
    expect(sent.filter((l) => l.startsWith('G10 L2'))).toEqual([]);
  }, 30000);

  it('asks “I am at the machine” again for every program: the bit change clears the tick (D-17)', async () => {
    renderStep(twoSetupJob());
    await uploadAndStart();
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 10000 });

    // Program 1 ran with the tick; the pause cleared it, so program 2's start is disabled until
    // the operator standing at the machine says so for THIS program.
    expect(record()?.atMachine).toBe(false);
    const done = () => screen.getByTestId('engrave-release-change-done') as HTMLButtonElement;
    expect(done().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-release-change-ok'));
    expect(done().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-release-at-machine'));
    expect(record()?.atMachine).toBe(true);
    expect(done().disabled).toBe(false);
  }, 30000);

  it('a Stop between programs closes the span: M332 then $H, on an Idle machine', async () => {
    renderStep(twoSetupJob());
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

    renderStep(twoSetupJob());
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
    renderStep(twoSetupJob());
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
    renderStep(twoSetupJob());
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
    // D-17 — the stop cleared the tick, so a resume is a fresh start.
    expect((screen.getByTestId('engrave-release-start') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-release-at-machine'));
    expect((screen.getByTestId('engrave-release-start') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('engrave-release-start'));
    await waitFor(() => expect(sent.filter((l) => l.startsWith('play'))).toEqual(['play /sd/gcodes/Two-setup-job-p1.nc']), {
      timeout: 5000,
    });
    // Let the program finish, so the test does not leave a run in flight at cleanup.
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 10000 });
  }, 30000);

  it('a start that fails after M331 says the vacuum is on and closes the span', async () => {
    renderStep(twoSetupJob());
    await uploadAndStart();
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 10000 });

    // Stop at the change, then resume at program 2: it carries only M332, so the release switches
    // the vacuum on itself before starting.
    await act(async () => {
      useEngraveReleaseStore.getState().stop(TARGET);
    });
    await waitFor(() => expect(record()?.phase).toBe('stopped'), { timeout: 5000 });
    fireEvent.click(screen.getByTestId('engrave-release-at-machine'));
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

  // A run's end writes land AFTER the store says the run finished, and a test that resets the
  // store while one is in flight used to leave a fragment behind: the late `patch` re-created the
  // entry from nothing — no file, no `lines` — and `EngraveMachineRun` crashed on
  // `entry.lines.length`, failing whichever test rendered next (a different one each run). The
  // store now drops a patch for an entry that no longer exists.
  it('a late end-of-run write cannot resurrect a forgotten run', async () => {
    const key = machineKey(TARGET);
    useMachineRunStore.getState().prepare(TARGET, 'job.nc', 'hash-1');
    const prepared = useMachineRunStore.getState().runs[key]!;
    let answer: (r: { ok: boolean; text: string }) => void = () => {};
    useMachineRunStore.setState({
      runs: {
        ...useMachineRunStore.getState().runs,
        [key]: {
          ...prepared,
          end: {
            kind: 'finished',
            lines: [],
            offcut: { item: { id: 'offcut-1' } as StockItem, text: 'offcut', state: 'asked' },
            stockQuestion: null,
          },
        },
      },
    });
    setRunEndIO({
      ...runEndIO([]),
      // The offcut write is the async step: the reset lands while it is in flight.
      addOffcut: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const keeping = useMachineRunStore.getState().keepOffcut(key);
    resetMachineRunStore();
    answer({ ok: true, text: '' });
    await keeping;
    expect(useMachineRunStore.getState().runs[key]).toBeUndefined();
  });
});

// #491 — the bit-change instruction leads with the case colour of the copy the pick would choose,
// in the bench's form: "Yellow case — <full label name> (<code>)". A cutter with no case keeps the
// colourless sentence.
describe('#491 the release step names the cutter’s case', () => {
  const yellow: ToolCopy = {
    id: 'yellow-1',
    condition: 'new',
    whereabouts: { kind: 'box', case: { colour: 'yellow', label: 'yellow base, clear tube' } },
    runtimeWarnMinutes: null,
    notes: null,
    runtimeMinutes: null,
  };

  it('prints the colour word before the next program’s full label name and code', async () => {
    // The shop owns the built-in `flat-3.175x12-metal` in a yellow case: #454's correspondence
    // carries the copies to the key the program names.
    setInventoryConditions(
      [
        {
          id: 'engraver',
          quantity: 1,
          copies: [yellow],
          tool: flatEndMill(3.175, { name: '3.175 mm flat end (Metal)', shoulderLength: 12 }),
        },
      ],
      (id) => `inv:${id}`,
      TOOL_LIBRARY,
    );
    renderStep(twoSetupJob());
    await uploadAndStart();
    const sentence = await screen.findByTestId('engrave-release-change-sentence', undefined, { timeout: 10000 });
    expect(sentence.textContent).toContain(
      'Change the cutter for program 2 of 2: Yellow case — 3.175*12mm Flat End(Metal) (flat-3.175x12-metal).',
    );
  });
});
