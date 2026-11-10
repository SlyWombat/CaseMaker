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
import { describeRun, programHash, runSettings } from '@/platform/machineRun';
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

/**
 * #1088 — a LATER setup's registration (side 2's), filed under its own setup id. The Run gate
 * requires THIS record for a program whose setupIndex is above 1; setup 1's job-keyed record does
 * not stand in for it.
 */
function seedSetupRegistration(job: EngraveJob, setupId: string, outcome: RegistrationOutcome = FIRST_OUTCOME): void {
  const { settings } = registrationSettings(null);
  const planned = planRegistration(
    {
      stock: { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 },
      mount: 'vise',
      expectedSurface: { machineZ: outcome.surfaceZ, from: 'the turned blank, as registered' },
      seekFromMachineZ: outcome.seekFromMachineZ,
      fixtureBelowSurfaceMm: 0.72,
      cutCentre: { x: 24, y: 43 },
    },
    settings,
  );
  if (!planned.ok) throw new Error(planned.reason);
  useEngraveRegistrationStore.getState().recordSetup(job.id, setupId, TARGET, planned.plan, outcome);
}

const sent: string[] = [];
const uploaded: string[] = [];

/**
 * A gate for the span close, so a test can hold `M852`/`$H` in flight and try to start a program
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
 * play and after it finishes; an abort makes it Idle at once. `alarmOnPlay` is the red button: the
 * controller is in an alarm from the moment a program is played, and it stays there (an abort does
 * not clear it) — an explicit state, not a poll count (#1153). For #494's post-facing step,
 * `retouchSurfaceZ` is the machine Z every probe touch reports and `m491` the tool-length reply.
 */
function controller(
  finishAfter = 2,
  opts: { retouchSurfaceZ?: number; m491?: string; playError?: boolean; alarmOnPlay?: boolean } = {},
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
          if (holdClose && (line === 'M852' || line === '$H')) await closeGate;
          let text = 'ok';
          if (line === '?') {
            if (playing === null) text = '<Idle|MPos:0,0,0>';
            else if (opts.alarmOnPlay === true) {
              // #1123 item 41 — the red button: the controller alarms mid-program and its outputs
              // are cut. #1153 — the alarm is a STATE entered by `play`, not a count of polls, so
              // the run's end cannot depend on how many polls it fits into a wall-clock window.
              text = 'ALARM: Kill switch';
            } else if (aborted) text = '<Idle|MPos:0,0,0>';
            else text = playing.polls++ < finishAfter ? '<Run|MPos:0,0,0|P:10,20,5>' : '<Idle|P:9,100,4>';
          } else if (line.startsWith('play')) {
            if (opts.playError === true) {
              // #1123 item 41 — a controller that refuses the file AFTER the run re-stated M851:
              // the release must close the span it left on with nothing cutting.
              text = 'error: file not found';
            } else {
              playing = { polls: 0 };
              aborted = false;
              text = 'File size 10';
            }
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
afterEach(async () => {
  // #1153 — NO RUN MAY CROSS A TEST BOUNDARY. `resetMachineRunStore` in the next `beforeEach` is a
  // test seam: it forgets a run that is still polling, but the run itself keeps going, and its late
  // `outcome`/`end` then land on whatever entry exists for that machine — the NEXT test's, which
  // prepared the same key. Under load this settled the alarm test 'finished' in 90 ms ('bit-change'
  // from a program it never played): the resume test above it ends milliseconds after its `play`,
  // leaving its run to poll on. Stop an in-flight run and wait for its whole end (outcome AND the
  // end-of-run write) here, while the test's fake console is still installed.
  const machine = machineKey(TARGET);
  if (useMachineRunStore.getState().runs[machine]?.running === true) {
    useMachineRunStore.getState().requestStop(machine);
    await waitFor(
      () => {
        const entry = useMachineRunStore.getState().runs[machine];
        expect(entry === undefined || (entry.running === false && entry.end !== null)).toBe(true);
      },
      { timeout: 30000 },
    );
  }
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
  const reports = new Map(
    programs.filter((p) => p.verify !== null).map((p) => [p.programHash, p.verify!] as const),
  );
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

  it('uploads every program, plays them in order, and re-states M851 before each — never M852 between them', async () => {
    const job = twoSetupJob();
    // #1088 — program 2 is setup 2's, and a later setup's program now needs that setup's record.
    seedSetupRegistration(job, 'setup-2');
    renderStep(job);
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
    // #1123 item 41 — the run RE-STATES M851 before every program (the maintainer's bench rule):
    // the file's own word died with the alarm on the first attempt, so the retry cannot rely on
    // it. Nothing switches off between programs.
    expect(sent.filter((l) => l === 'M851')).toHaveLength(1);
    expect(sent).not.toContain('M852');
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
    // The second program's start re-states M851 too, and NOTHING switches off BETWEEN the files;
    // the span's end is the run's own M852 (the file's M332 is an auto mode the controller ignores).
    expect(sent.filter((l) => l === 'M851')).toHaveLength(2);
    const secondPlay = sent.lastIndexOf('play /sd/gcodes/Two-setup-job-p2.nc');
    expect(sent.slice(0, secondPlay)).not.toContain('M852');
    expect(sent.filter((l) => l === 'M852')).toHaveLength(1);
    expect(sent.lastIndexOf('M852')).toBeGreaterThan(secondPlay);
    // #425 §6 — the DOCUMENT holds the resume fact for both played programs, with their setups.
    const log = useEngraveJobStore.getState().job.runLog ?? [];
    expect(log.map((entry) => [entry.programHash, entry.setupId, entry.outcome])).toEqual([
      [P1.programHash, 'setup-1', 'finished'],
      [P2.programHash, 'setup-2', 'finished'],
    ]);
  }, 30000);

  it('#1123-42 — shows the running program’s percent, time left and the next bit change on the Cut step', async () => {
    // Program 1 reports `P:10,20,5` for four polls: 20 % at 5 s elapsed → about 20 s left, long
    // enough to read before the bit change (polls are 2 s apart).
    setMachineConsoleLoader(async () => controller(4));
    renderStep(twoSetupJob());
    await uploadAndStart();

    // The line exists at once ("running, no percentage yet"); the first poll brings the reading.
    const live = await screen.findByTestId('engrave-release-live-progress', undefined, { timeout: 10000 });
    await waitFor(() => expect(live.textContent).toBe('Program 1 of 2 is 20 % done — about 20 s left.'), { timeout: 10000 });
    expect(live.getAttribute('data-percent')).toBe('20');
    // The next program needs the other cutter; the line names the program and the cutter.
    const next = screen.getByTestId('engrave-release-next-change');
    expect(next.textContent).toContain('Next bit change: program 2 of 2');
    expect(next.textContent).toContain('flat-3.175x12-metal');

    // At the pause the progress line belongs to the run that just ended, not the one being set up.
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 20000 });
    expect(screen.queryByTestId('engrave-release-live-progress')).toBeNull();
    expect(screen.queryByTestId('engrave-release-next-change')).toBeNull();
  }, 30000);

  // #934 — THE POST-FACING RE-TOUCH IS HIDDEN until its bench run. The faced-run branch below is
  // skipped, not deleted, and returns behind its own issue; a job with facing on is refused at the
  // release with the sentence this test pins.
  it('#934 — a job with facing on is refused at the release, and nothing is played', async () => {
    const job = facedJob();
    seedRegistration(job);
    renderStep(job, [FACE, engravingProgram()]);
    expect((await screen.findByTestId('engrave-release-facing-blocker')).textContent).toContain(
      'the post-facing re-touch has not been run on this machine yet',
    );
    // Nothing is at the machine and nothing plays: the refusal is the release's own sentence.
    expect(screen.queryByTestId('engrave-release-start')).toBeNull();
    expect(sent.filter((l) => l.startsWith('play'))).toEqual([]);
  }, 20000);

  it.skip('plays a faced run as face file then engraving, and asks for the engraving cutter and a measured re-touch', async () => {
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
    expect(uploaded).toEqual(['Faced-job-face.nc', 'Faced-job.nc']);
    expect(sent.filter((l) => l.startsWith('play'))).toEqual(['play /sd/gcodes/Faced-job-face.nc']);
    const change = screen.getByTestId('engrave-release-change').textContent ?? '';
    expect(change).toContain('ENGRAVING cutter');
    expect(change).toContain('re-touches the FACED surface with the wired probe');
    // The facing cutter was program 1's; the change names the engraving cutter for program 2.
    expect(change).toContain('flat-1.0');
  }, 30000);

  it.skip('refuses a faced release with no first registration, then enables it when one is recorded (#494)', async () => {
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

  it.skip('after the face file’s confirmed change, re-touches the faced top and writes Z0 before the engraving program (#494)', async () => {
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
    // #789 — the re-touch is a probe session of its own: the supply goes on before its first
    // touch and off once the last is done (before the cutter is asked for).
    const touches = sent.map((line, i) => (line.startsWith('G38.3') ? i : -1)).filter((i) => i >= 0);
    const supplyOn = sent.indexOf('M831');
    expect(touches.length).toBeGreaterThan(0);
    expect(supplyOn).toBeGreaterThan(-1);
    expect(supplyOn).toBeLessThan(touches[0]!);
    expect(sent.filter((line) => line === 'M832')).toHaveLength(1);
    expect(sent.indexOf('M832')).toBeGreaterThan(touches.at(-1)!);
    fireEvent.click(screen.getByTestId('engrave-release-operator-continue'));

    await screen.findByTestId('engrave-release-done', undefined, { timeout: 15000 });
    expect(sent.filter((l) => l.startsWith('play'))).toEqual([
      'play /sd/gcodes/Faced-job-face.nc',
      'play /sd/gcodes/Faced-job.nc',
    ]);
    // Z0 comes from the MEASURED faced top, and the write is ordered before the engraving program.
    const g10 = sent.filter((l) => l.startsWith('G10 L2'));
    expect(g10).toHaveLength(1);
    expect(g10[0]).toContain('Z-56.666');
    expect(sent.indexOf(g10[0]!)).toBeLessThan(sent.indexOf('play /sd/gcodes/Faced-job.nc'));
    const notes = record()?.notes.join('\n') ?? '';
    expect(notes).toContain('faced top measured machine Z -56.666');
    expect(notes).toContain('Z0 for flat-1.0 written');
  }, 30000);

  it.skip('a re-touch outside the band BLOCKS the engraving program and closes the span (#494)', async () => {
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
    expect(notes).toContain('No program was played');
    expect(sent.filter((l) => l.startsWith('play'))).toEqual(['play /sd/gcodes/Faced-job-face.nc']);
    expect(sent.filter((l) => l.startsWith('G10 L2'))).toHaveLength(0);
    // The face file is the only program that ran; the vacuum was closed after the refusal.
    expect(sent).toContain('M852');
    expect(screen.queryByTestId('engrave-release-operator-text')).toBeNull();
  }, 30000);

  it.skip('a failed cutter-length correction BLOCKS the engraving program and closes the span (#494)', async () => {
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
    expect(notes).toContain('No program was played');
    expect(sent.filter((l) => l.startsWith('play'))).toEqual(['play /sd/gcodes/Faced-job-face.nc']);
    expect(sent.filter((l) => l.startsWith('G10 L2'))).toHaveLength(0);
    expect(sent).toContain('M852');
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
      () => expect(sent.filter((l) => l.startsWith('play'))).toEqual(['play /sd/gcodes/Faced-job.nc']),
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

  it('a Stop between programs closes the span: M852 then $H, on an Idle machine', async () => {
    renderStep(twoSetupJob());
    await uploadAndStart();
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 10000 });

    const before = sent.length;
    fireEvent.click(screen.getByTestId('engrave-release-stop'));
    await waitFor(() => expect(sent.slice(before)).toContain('M852'), { timeout: 5000 });
    const tail = sent.slice(before);
    expect(tail.filter((l) => l === 'M852')).toHaveLength(1);
    expect(tail.indexOf('M852')).toBeLessThan(tail.lastIndexOf('$H'));
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
          build: 'v-test',
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

    const job = twoSetupJob();
    // #1088 — the resume plays program 2, which is setup 2's and needs setup 2's record.
    seedSetupRegistration(job, 'setup-2');
    renderStep(job);
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
    // Program 2 carries M852 only; the vacuum was off before the resume, so the step switches it on.
    expect(sent).toContain('M851');
  }, 30000);

  it('#1088 — setup 2’s program refuses by name until setup 2 is registered, and nothing is played', async () => {
    // Setup 1 is registered; setup 2 is NOT. Before this gate, program 2 played with no registration
    // at all — a non-facing flip job would cut side 2 off side 1's record, or off nothing.
    const job = twoSetupJob();
    seedRegistration(job);
    renderStep(job, [P1, P2]);
    await uploadAndStart();
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 10000 });
    fireEvent.click(screen.getByTestId('engrave-release-change-ok'));
    fireEvent.click(screen.getByTestId('engrave-release-at-machine'));
    const before = sent.length;
    fireEvent.click(screen.getByTestId('engrave-release-change-done'));

    await waitFor(() => expect(record()?.phase).toBe('failed'), { timeout: 5000 });
    expect(record()?.notes.join('\n')).toContain('setup 2 is not registered — run the Register step for setup 2 first.');
    // NOTHING SENT AT ALL: no play line, no vacuum word, no home — the gate is before every line.
    expect(sent.slice(before)).toEqual([]);
    expect(sent.filter((l) => l.startsWith('play'))).toEqual(['play /sd/gcodes/Two-setup-job-p1.nc']);
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

    // `M852`/`$H` are in flight. The button is disabled, and the store refuses a direct press too:
    // starting now could put a program's own M851 underneath the late M852.
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

  it('#1123 item 41 — a red-button alarm, then Try again: the retry re-states M851 before it plays', async () => {
    const job = twoSetupJob();
    seedSetupRegistration(job, 'setup-2');
    // The red button is a STATE, not a poll count (#1153): the controller is in an alarm from the
    // moment the program is played, and stays there. The release ends failed with the vacuum's
    // state UNKNOWN — no claim survives the alarm.
    setMachineConsoleLoader(async () => controller(2, { alarmOnPlay: true }));
    renderStep(job);
    await uploadAndStart();
    await waitFor(() => expect(record()?.phase).toBe('failed'), { timeout: 10000 });
    expect(record()?.vacuum).toBe('unknown');
    expect(sent.filter((l) => l === 'M851')).toHaveLength(1);

    // The alarm is cleared at the controller; the operator presses Try again. This machine reports
    // the program complete on its FIRST status poll after `play` — one explicit step, not a race.
    setMachineConsoleLoader(async () => controller(0));
    fireEvent.click(screen.getByTestId('engrave-release-start'));
    await waitFor(() => expect(record()?.phase).toBe('bit-change'), { timeout: 10000 });
    // THE RETRY RE-STATED THE ON WORD: the first attempt's M851 died with the alarm (finding 38).
    expect(sent.filter((l) => l === 'M851')).toHaveLength(2);
  }, 30000);

  it('a play refused AFTER the run re-stated M851 closes the span it left on', async () => {
    const job = twoSetupJob();
    seedSetupRegistration(job, 'setup-2'); // #1088 — setup 2 is registered; this test is not the gate.
    renderStep(job);
    await uploadAndStart();
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 10000 });

    // Stop at the change, then resume at program 2. #1123 item 41 — the RUN re-states M851 before
    // every program; this time the controller refuses the file after that word went out.
    await act(async () => {
      useEngraveReleaseStore.getState().stop(TARGET);
    });
    await waitFor(() => expect(record()?.phase).toBe('stopped'), { timeout: 5000 });
    fireEvent.click(screen.getByTestId('engrave-release-at-machine'));
    fireEvent.click(screen.getByTestId('engrave-release-start'));
    await screen.findByTestId('engrave-release-change', undefined, { timeout: 5000 });
    setMachineConsoleLoader(async () => controller(2, { playError: true }));
    const before = sent.length;
    fireEvent.click(screen.getByTestId('engrave-release-change-ok'));
    fireEvent.click(screen.getByTestId('engrave-release-change-done'));

    await waitFor(() => expect(record()?.phase).toBe('failed'), { timeout: 5000 });
    const tail = sent.slice(before);
    // The run stated M851 and the file never played, so the vacuum is on with nothing cutting and
    // the release closes the span (M852 then $H).
    expect(tail).toContain('M851');
    expect(tail).toContain('M852');
    expect(tail).toContain('$H');
    expect(tail.indexOf('M851')).toBeLessThan(tail.indexOf('M852'));
    expect(record()?.notes.join('\n')).toContain('closing the vacuum span');
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

  // #1153 — THE SAME MACHINE KEY IS NOT THE SAME RUN. The bench shape is Stop, then Try again
  // quickly: the stopped run's end-of-run write is still in flight (it runs after the console is
  // closed) when the retry is prepared under the same key. Without a run identity that late write
  // landed on the RETRY's entry — the mechanism behind the flaky #1123-41 alarm test. The tail must
  // be dropped; the retry keeps its own (still empty) end.
  it('a previous run’s late end cannot touch the next run’s entry', async () => {
    const key = machineKey(TARGET);
    const calls: string[] = [];
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    setRunEndIO({
      ...runEndIO([]),
      // A known machine, so the finished-program record is actually written (and can be held).
      machineIdFor: () => 'm-1',
      // Run A's end-of-run write is held mid-flight here. (B's context has no stock, so its end
      // never calls this; the marker below shows A's end reached its last awaited step.)
      recordFinishedProgram: async () => {
        await gate;
        return { ok: true, added: true, text: '' };
      },
      consume: async () => {
        calls.push('A:consume');
        return { ok: true, text: '' };
      },
    });

    // A plays and finishes; its outcome is set, its end-of-run write is still held.
    const ctxA: RunContext = { nc: 'G0 X1 Y1\nM02\n', programHash: 'hash-A', jobId: 'job-A', stockEntryId: 'stock-A' };
    expect(useMachineRunStore.getState().prepare(TARGET, 'A.nc', 'hash-A', ctxA)).toBe(true);
    expect(useMachineRunStore.getState().start(TARGET, runSettings(null))).toBe(true);
    await waitFor(() => expect(useMachineRunStore.getState().runs[key]?.running).toBe(false), { timeout: 15000 });
    expect(useMachineRunStore.getState().runs[key]?.outcome?.kind).toBe('finished');
    expect(useMachineRunStore.getState().runs[key]?.end).toBeNull();

    // The retry is prepared under the same key while A's write is held; its program keeps running
    // for the length of this test, so nothing of B's own can fill B's end.
    setMachineConsoleLoader(async () => controller(200));
    const ctxB: RunContext = { nc: 'G0 X1 Y1\nM02\n', programHash: 'hash-B' };
    expect(useMachineRunStore.getState().prepare(TARGET, 'B.nc', 'hash-B', ctxB)).toBe(true);
    expect(useMachineRunStore.getState().start(TARGET, runSettings(null))).toBe(true);

    // A's write lands now, after B was prepared. It belongs to A: B's entry must be untouched.
    openGate();
    await waitFor(() => expect(calls).toContain('A:consume'), { timeout: 10000 });
    const b = useMachineRunStore.getState().runs[key]!;
    expect(b.filename).toBe('B.nc');
    expect(b.end).toBeNull();
    expect(b.outcome).toBeNull();
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

  it('#535 — a surface program uploads under its dexel check', async () => {
    const job = defaultEngraveJob();
    job.name = 'Goal job';
    job.toolKey = 'flat-1.0';
    const setupId = jobSetups(job)[0]!.id;
    const nc = ';@MKR|BEGIN\nG1 Z-0.5\nM02\n';
    const check = {
      kind: 'surface' as const,
      gridPitchMm: 0.1,
      roughingLayers: 2,
      resolutionNote: 'sampled on a 0.1 mm grid',
      bbox: { min: [0, 0] as [number, number], max: [10, 10] as [number, number] },
    };
    const surfaceProgram: EngraveProgram = {
      setupIndex: 1,
      setupId,
      toolKey: 'flat-1.0',
      nc,
      verify: null,
      surfaceCheck: check,
      frameNc: null,
      frameVerify: null,
      programHash: programHash(nc),
      cam: null,
    };
    const made = freezePackage(job, [surfaceProgram], '2026-10-17T14:02:00.000Z');
    if (!made.ok) throw new Error(made.reason);
    const sources = frozenReleaseSources(
      job,
      made.package,
      new Map(),
      new Map([[surfaceProgram.programHash, check]]),
    );

    await act(async () => {
      useEngraveReleaseStore.getState().plan(TARGET, job, sources);
      await useEngraveReleaseStore.getState().uploadAll(TARGET);
    });
    // The file went: its check is the sweep, and the verified-only refusal never fired.
    expect(uploaded).toEqual([releaseFileName('Goal job', 1, 1)]);
    const rec = record();
    expect(rec?.files[0]?.upload).toBe('uploaded');
    expect((rec?.notes ?? []).join('\n')).not.toContain('no verifier report');
  });
});
