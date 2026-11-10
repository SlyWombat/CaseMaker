/**
 * #469 / #419 §3 — THE RELEASE STEP: the ONE owner of a multi-program run.
 *
 * WHY A STEP OF ITS OWN. The single-file upload (#255) writes one program and hands it to the run
 * panel; `uploadBlocker` refuses a job with more than one for exactly that reason (#469, review R2).
 * A multi-program job needs someone to upload the whole list, play it in order, keep the vacuum on
 * across the bit change, and stop honestly if anything fails. This store is that owner. It drives
 * `machineRunStore` one program at a time — so the end-of-run saves (finished hash, stock, runtime)
 * still happen in the one place that owns them — and it owns the things that are only true of the
 * LIST: the order, the pause between files, the vacuum span's edges, and the resume point.
 *
 * THE ORDER OF THE CALLS, and why:
 *
 *   1. PLAN. `releasePrograms` names every file in cut order and marks the ones
 *      `finishedProgramsFor(target)` says this machine finished (#419 §4.5). The plan and the
 *      release sheet read the same list, so a program the plan calls "not new" is one the release
 *      step skips.
 *   2. UPLOAD ALL, BEFORE ANY CUT. `uploadProgram` writes one file and asks the controller for Idle
 *      before each write; there is no file-list API to ask afterwards. Uploading the whole list
 *      first means a transfer that fails (card full, cable, alarm) stops the run before the first
 *      cutter moves, and the pause at the bit change needs no network at all.
 *   3. PLAY IN ORDER, ONE AT A TIME. Each program is `prepare`d and `start`ed through
 *      `machineRunStore`, with `vacuumOwned: true` on every file — the middle ones included, because
 *      they carry no `M331`/`M332` and the runner's text test would otherwise bracket them and
 *      switch the vacuum off at the bit change (#469, review R20).
 *   4. STOP BETWEEN FILES, NOT AT THE END OF EACH. A finished program is followed by the bit-change
 *      pause (a maintainer step) with the vacuum still on; the next program starts only after the
 *      operator confirms the cutter and Z0. On a normal change the release step sends NO vacuum
 *      words: the first file switched the vacuum on and the last switches it off (#419 decision 4).
 *   5. CLOSE THE SPAN WHEN THE RUN STOPS. A Stop at the bit-change pause, or a failure that leaves
 *      no program running, sends `M852` then `$H` — only on a machine that answers Idle with no
 *      alarm (`machineSpan.ts`). A Stop DURING a cut is the run panel's (#424): `abort`, then `M332`
 *      only once the machine reads Idle, and Home is offered rather than sent.
 *   6. THE CLEANING PASS AND THE AIR WALK (#1146, the maintainer's 2026-11-09 ruling). Both are
 *      FILES (`cleanWalkPlan.ts`), uploaded with the programs and verified by the ordinary
 *      verifier. The air walk plays once, before program 1 of a new span; the cleaning pass plays
 *      after every finished program, and the list's continuation waits for its end. AFTER A STOP
 *      NOTHING MOVES ON ITS OWN: the release offers `cleanNow` instead, and the operator runs it
 *      once the machine is Idle and homed.
 *
 * RESUME. A finished program's hash is recorded by `machineRunStore`'s end of run. This store also
 * marks it done immediately, so the next step (and a reload, through `finishedProgramsFor`) skips it
 * and continues at the first unfinished file. A program that was stopped is NOT done: resuming plays
 * it again from its beginning, because a partially cut file has no other honest continuation.
 *
 * NOT A SECOND SOURCE OF TRUTH FOR THE RUN. The machine entry `machineRunStore` prepares still holds
 * progress, the log and Stop; this store holds only the list's state around it. The release panel
 * draws the machine entry through `EngraveMachineRun controlled`.
 */

import { create } from 'zustand';
import type { EngraveJob } from '@/types/engraveJob';
import { alarmLine, uploadProgram, type MachineUploadResult } from '@/platform/machineUpload';
import { describeRun, readProgress, runSettings, type RunOutcome } from '@/platform/machineRun';
import { closeVacuumSpan } from '@/platform/machineSpan';
import { attachConsole } from '@/platform/machineConsole';
import type { CleanWalkMode } from '@/engine/cnc/engrave/cleanWalk';
import { planCleanWalks, type PlannedCleanWalk } from '@/engine/cnc/engrave/cleanWalkPlan';
import { verifyCheck } from '@/engine/cnc/uploadGate';
import {
  retouchAndCorrectAfterFacing,
  type AfterFacingResult,
  type OperatorStep,
} from '@/engine/cnc/registration/execute';
import { getTools } from '@/engine/cnc/toolRegistry';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import {
  carriesVacuumOff,
  carriesVacuumOn,
  jobCarriesVacuumWords,
  programVacuumSpan,
  releaseCheck,
  releaseNext,
  releasePending,
  releasePrograms,
  type ReleaseProgram,
  type ReleaseSource,
} from '@/engine/cnc/engrave/release';
import { machineKey, runContextFor, useMachineRunStore, type RunContext } from './machineRunStore';
import { finishedProgramsFor, localMachine } from './locationStore';
import { readDefault, readFlag } from '@/platform/defaultsClient';
import { useShopDefaultsStore } from './shopDefaultsStore';
import { firstRegistrationFor, setupRegistrationFor } from './engraveRegistrationStore';
import { facingRegistrationBlocker } from './engraveRunGate';
import { recordUploadedFile } from '@/platform/machineFiles';

export type ReleasePhase =
  /** Planned, nothing sent: the upload button is the next press. */
  | 'idle'
  | 'uploading'
  | 'ready'
  /** A program is about to start (the span/pause is being settled). */
  | 'starting'
  | 'running'
  /**
   * #473/#494 — the face program finished and the operator confirmed the bit change: the faced top is
   * being re-touched and Z0 is written for the engraving cutter. NO engraving program is running, and
   * none starts until that succeeds (decision 4's probe → face → re-touch → engrave).
   */
  | 'retouch'
  /** A program finished; the machine is homed and the vacuum stays on for the next cutter. */
  | 'bit-change'
  /** #1146 — the air walk file is playing (before program 1 of a new span). */
  | 'airwalk'
  /** #1146 — the cleaning pass file is playing (after a program, or from a Clean now press). */
  | 'cleaning'
  /**
   * The span is being closed (M852 + $H) and the run must not start until it has: a program
   * started now could re-state its M851 followed by the late M852, switching the vacuum off
   * mid-cut.
   */
  | 'closing'
  | 'stopped'
  | 'done'
  | 'failed';

export type ReleaseUploadState = 'pending' | 'sending' | 'uploaded' | 'present' | 'failed';

export interface ReleaseFile extends ReleaseProgram {
  upload: ReleaseUploadState;
  uploadNote: string | null;
}

/** #1146 — one walk file as this release holds it: planned text, check, and its card state. */
export interface ReleaseWalk extends PlannedCleanWalk {
  upload: ReleaseUploadState;
  uploadNote: string | null;
}

/**
 * #1146 — what happens when the walk playing now ends. `start-program` continues the release at
 * the program the air walk precedes; `after-program` is the continuation the finished program's
 * settle deferred until the cleaning pass was over; `clean-now` returns to the phase the operator
 * pressed the button in (a Stop's `stopped`, a `done`, a `failed`).
 */
export type WalkAfter =
  | { kind: 'start-program'; index: number }
  | { kind: 'after-program'; index: number; total: number; next: number | null }
  | { kind: 'clean-now'; restore: ReleasePhase };

export interface WalkRun {
  mode: CleanWalkMode;
  after: WalkAfter;
}

export interface ReleaseRecord {
  target: { host: string; port: number };
  jobId: string;
  jobName: string;
  /** The job as planned, for each program's run context and its cutter. */
  job: EngraveJob;
  /** The job's accessory output (`feeds.params.air`): false means no vacuum words anywhere. */
  airOn: boolean;
  phase: ReleasePhase;
  files: ReleaseFile[];
  /**
   * #1146 — the two maintenance files, planned with the list when the shop's switches want them.
   * Null: not wanted, or refused by the generator/verifier (the reason is in `notes`).
   */
  walks: { airwalk: ReleaseWalk | null; clean: ReleaseWalk | null };
  /** The shop's two switches AS THIS PLAN READ THEM (seeded on). */
  airWalk: boolean;
  cleanAfter: boolean;
  /** The air walk has finished for this release — it plays before program 1 and never again. */
  airWalked: boolean;
  /** The walk playing now, with what its end continues into. */
  walk: WalkRun | null;
  /** 1-based cut order of the program the machine entry currently holds. */
  active: number | null;
  /** The next program, when the run is waiting at the bit-change pause. */
  next: number | null;
  /**
   * "I am at the machine" (D-17) — asked once per PROGRAM, not once per release: it is cleared at
   * every bit-change pause and when a stop leaves the run resumable, so the next program's start
   * needs a fresh tick from the operator standing there.
   */
  atMachine: boolean;
  /**
   * #494 — the executor's current request to the operator (fit the probe, fit the engraving cutter),
   * while the post-facing re-touch/correction runs. Null at every other time. The panel answers through
   * `answerOperator`; the promise the executor is awaiting is settled by that answer.
   */
  operatorStep: OperatorStep | null;
  /**
   * #494 — the program whose Z0 was written by the post-facing re-touch, so a RESUME of that same
   * program does not probe the top a second time. The re-touch's surface point is inside the cut
   * area: after the engraving program has cut there, a second touch would measure a floor, not the
   * faced top. Only a fresh run (or a retry of a FAILED retouch, which never set this) re-touches.
   */
  retouchedFor: number | null;
  /** The file being written right now, 1-based. */
  uploading: number | null;
  /**
   * What this store believes the vacuum is doing. `unknown` after an alarm/unreachable: it is not a
   * state to claim either way, and the sentence says so.
   */
  vacuum: 'off' | 'on' | 'unknown';
  /**
   * A close (`M852` + `$H`) is in flight. The `closing` phase says this for a Stop; a failure that
   * closes the span keeps its own phase (`failed`) and raises this flag instead, so a Try again
   * cannot start a program underneath the same late `M852`.
   */
  spanClosing: boolean;
  stopAsked: boolean;
  /** The last Stop was pressed between programs, so the span is this store's to close. */
  stoppedBetween: boolean;
  notes: string[];
  /** Set once the run's end has been handled, so a later end patch (offcut kept) is ignored. */
  settled: boolean;
}

interface ReleaseState {
  records: Record<string, ReleaseRecord>;
  /**
   * (Re)plan the release for a job: name the files, read the finished hashes, and keep the upload
   * results already made for unchanged programs. Safe to call on every render.
   */
  /**
   * Plan (or re-plan) this machine's release from the job's APPROVED programs (#419 §3, #425).
   * `programs` is the frozen package's list, never the live Generate: the texts the machine plays
   * are the texts that were approved.
   */
  plan: (target: { host: string; port: number }, job: EngraveJob, programs: readonly ReleaseSource[]) => void;
  /** Upload every program in cut order. Never throws; a failure is a phase and a sentence. */
  uploadAll: (target: { host: string; port: number }) => Promise<void>;
  /** Begin (or resume) the run at the first unfinished program. */
  startRelease: (target: { host: string; port: number }) => void;
  /** Resume after the bit-change pause, at the program the panel named. */
  confirmChange: (target: { host: string; port: number }) => void;
  /**
   * #494 — answer the post-facing executor's operator prompt. `true` continues, `false` stops it;
   * either way the release waits for the executor's answer before the engraving program can start.
   */
  answerOperator: (target: { host: string; port: number }, ok: boolean) => void;
  /** Stop: a running program through the run store; a pause between programs by closing the span. */
  stop: (target: { host: string; port: number }) => void;
  /**
   * #1146 — run the cleaning pass now, on its own, once nothing is running (the Cut step offers it
   * after a Stop, a failure or a finished job). The machine must read Idle; the run refuses
   * otherwise. Nothing else moves and the release stays in the phase it was in.
   */
  cleanNow: (target: { host: string; port: number }) => void;
  setAtMachine: (target: { host: string; port: number }, at: boolean) => void;
  /** Forget this machine's release (the machine entry, with its end, is left alone). */
  reset: (target: { host: string; port: number }) => void;
}

const sameHashes = (a: readonly ReleaseFile[], b: readonly ReleaseProgram[]): boolean =>
  a.length === b.length && a.every((f, i) => f.hash === b[i]?.hash && f.filename === b[i]?.filename);

/**
 * #1146 — the walks this plan wants, from the shop's two seeded-ON switches and three numbers. A
 * dry-run release (a rehearsal) wants neither: the walk files are real motion, not a rehearsal of
 * one. A walk whose filename and text are unchanged keeps its upload state across a re-plan.
 */
function walksForJob(
  target: { host: string; port: number },
  job: EngraveJob,
  programs: readonly ReleaseSource[],
): { airwalk: PlannedCleanWalk | null; clean: PlannedCleanWalk | null; airWalk: boolean; cleanAfter: boolean; notes: string[] } {
  const defaults = useShopDefaultsStore.getState().defaults;
  const airWalk = readFlag(defaults, 'run.airWalkBeforeCut').value;
  const cleanAfter = readFlag(defaults, 'run.cleanAfterProgram').value;
  const rehearsal = programs.some((p) => p.dryRun === true);
  if (programs.length === 0 || rehearsal) {
    return { airwalk: null, clean: null, airWalk, cleanAfter, notes: [] };
  }
  const settings = {
    clearanceMm: readDefault(defaults, 'clean.clearanceMm').value,
    rowSpacingMm: readDefault(defaults, 'clean.rowSpacingMm').value,
    feedMmPerMin: readDefault(defaults, 'clean.feedMmPerMin').value,
  };
  const plan = planCleanWalks({
    job,
    defaults,
    calibration: localMachine().calibration ?? null,
    surfaceMachineZ: firstRegistrationFor(job.id, target)?.outcome.surfaceZ ?? null,
    settings,
    wanted: { airwalk: airWalk, clean: cleanAfter },
  });
  return { airwalk: plan.airwalk, clean: plan.clean, airWalk, cleanAfter, notes: plan.notes };
}

/** A planned walk as the record holds it: a fresh plan starts with its card state pending. */
const freshWalk = (walk: PlannedCleanWalk | null): ReleaseWalk | null =>
  walk === null ? null : { ...walk, upload: 'pending', uploadNote: null };

/** A re-plan keeps the upload state only when it is the same FILE (name and text). */
function mergeWalk(previous: ReleaseWalk | null, next: PlannedCleanWalk | null): ReleaseWalk | null {
  if (next === null) return null;
  if (previous !== null && previous.filename === next.filename && previous.hash === next.hash) {
    return { ...next, upload: previous.upload, uploadNote: previous.uploadNote };
  }
  return freshWalk(next);
}

/**
 * #425 §6 — the programs the DOCUMENT says finished. The machine's own list
 * (`finishedProgramsFor`) is the bench's answer; the document's run log travels with a saved job,
 * so a reopened package resumes where the last session left it. Both are finished-only: a
 * `stopped` or `failed` program is played again.
 */
const finishedLogged = (job: Pick<EngraveJob, 'runLog'>): string[] =>
  (job.runLog ?? []).filter((entry) => entry.outcome === 'finished').map((entry) => entry.programHash);

const findFile = (rec: ReleaseRecord, index: number | null): ReleaseFile | null =>
  index === null ? null : (rec.files.find((f) => f.index === index) ?? null);

const said = (r: MachineUploadResult): string => {
  switch (r.kind) {
    case 'uploaded':
      return r.alreadyPresent
        ? `${r.filename} is already on the card and matches this build (${r.bytes} bytes).`
        : `${r.filename} uploaded (${r.bytes} bytes).`;
    case 'unavailable':
      return `${r.filename} was NOT uploaded: ${r.reason}`;
    default:
      return `${r.filename} was NOT uploaded: ${r.detail}`;
  }
};

const spanNote = (r: Awaited<ReturnType<typeof closeVacuumSpan>>): string => {
  if (r.kind === 'done') return 'Vacuum switched off (M852) and the machine homed ($H).';
  if (r.kind === 'not-idle') return `No M852 or home was sent: ${r.detail}. Check the vacuum and the machine.`;
  return `No M852 or home was confirmed: ${r.detail}. Check the vacuum and the machine.`;
};

export const useEngraveReleaseStore = create<ReleaseState>((set, get) => {
  const patch = (machine: string, p: Partial<ReleaseRecord>) =>
    set((s) => {
      const rec = s.records[machine];
      return rec === undefined ? s : { records: { ...s.records, [machine]: { ...rec, ...p } } };
    });

  const say = (machine: string, line: string) => {
    const rec = get().records[machine];
    if (rec !== undefined) patch(machine, { notes: [...rec.notes, line] });
  };

  /** Run one program, after settling the span and saying what is about to happen. */
  const runFile = async (machine: string, index: number): Promise<void> => {
    const rec = get().records[machine];
    if (rec === undefined || rec.phase === 'running' || rec.phase === 'uploading') return;
    const file = findFile(rec, index);
    if (file === null || file.done) return;

    // #1088 — A LATER SETUP'S PROGRAM NEEDS THAT SETUP'S REGISTRATION. Side 2 is a different
    // clamping on the turned blank: setup 1's origin does not describe it, and before this gate
    // nothing stopped the program — a non-facing flip job would cut side 2 with no registration at
    // all. Refuse by name, before the vacuum or any line.
    if (file.setupIndex > 1) {
      const reg = setupRegistrationFor(rec.jobId, file.setupId, rec.target);
      if (reg === null || !reg.outcome.usable) {
        patch(machine, { phase: 'failed', active: null, next: null });
        say(
          machine,
          `Program ${file.index} did not start: setup ${file.setupIndex} is not registered — run the Register step for setup ${file.setupIndex} first.`,
        );
        return;
      }
    }

    patch(machine, { phase: 'starting', active: index, next: null, stopAsked: false, settled: false, stoppedBetween: false });
    const span = programVacuumSpan(file.nc, jobCarriesVacuumWords(rec.files));
    // #1123 item 41 — THE RUN RE-STATES THE SPAN'S ON WORD on every start (platform/machineRun.ts),
    // so this store no longer sends M851 itself: one decision, one seam. What the run leaves for a
    // span that wants the vacuum on is 'on'; an `air: false` job (span none) has nothing switched.
    const vacuum = span === 'none' ? rec.vacuum : 'on';

    // The program's own cutter, so the runtime and the offcut footprint are this file's (#414).
    const tool =
      getTools().find((e) => e.key === file.toolKey)?.tool ?? (file.toolKey === rec.job.toolKey ? jobTool(rec.job) : null);
    const context: RunContext = {
      ...runContextFor(rec.job, tool),
      // `runContextFor` describes the JOB's cutter; this file is one setup and one tool (Q15).
      toolKey: file.toolKey,
      nc: file.nc,
      vacuumOwned: true,
      vacuumSpan: span,
      programHash: file.hash,
      programIndex: file.index,
      programTotal: file.total,
      // #425 §6 — the document's own name for the setup this file cuts, so the run end can record
      // the outcome against the frozen program rather than against its position in today's list.
      setupIndex: file.setupIndex,
      setupId: file.setupId,
      // #1060 — the job's own choice wins, else the shop's flag (on by default). The capability is
      // checked where the machine is known (the run store's start).
      blow: rec.job.blowWithVacuum ?? readFlag(useShopDefaultsStore.getState().defaults, 'run.blowWithVacuum').value,
      // #547 — a lifted dry-run file records nothing at its end (no stock, no runtime, no finished hash).
      ...(file.dryRun ? { dryRun: true } : {}),
    };
    const runStore = useMachineRunStore.getState();
    if (!runStore.prepare(rec.target, file.filename, file.hash, context)) {
      // #1123 item 41 — nothing was sent by this store and the run never started, so no word of
      // this store's is outstanding: the vacuum is exactly where the last program left it.
      patch(machine, { phase: 'failed', vacuum: rec.vacuum });
      say(machine, `Program ${file.index} did not start: a run is already going on this machine.`);
      return;
    }
    if (!runStore.start(rec.target, runSettings(useShopDefaultsStore.getState().defaults))) {
      patch(machine, { phase: 'failed', vacuum: rec.vacuum });
      say(machine, `Program ${file.index} did not start: the machine's run entry could not be started.`);
      return;
    }
    patch(machine, { phase: 'running', vacuum, settled: false, stopAsked: false });
    say(machine, `Playing program ${file.index} of ${file.total}: ${file.filename} (${file.toolKey}).`);
  };

  /** Close the span when no program is running and the vacuum may still be on. */
  const closeSpan = async (machine: string, reason: string): Promise<void> => {
    const rec = get().records[machine];
    if (rec === undefined) return;
    if (rec.vacuum === 'off') {
      say(machine, `${reason} The vacuum is already off.`);
      return;
    }
    // Every close is an in-flight state, whichever phase asked for it: `startRelease` and the
    // panel's start button refuse while it is set, so no program begins under a late M852.
    patch(machine, { spanClosing: true });
    try {
      const r = await closeVacuumSpan(rec.target);
      if (r.kind === 'done') {
        patch(machine, { vacuum: 'off' });
      } else {
        patch(machine, { vacuum: 'unknown' });
      }
      say(machine, `${reason} ${spanNote(r)}`);
    } finally {
      patch(machine, { spanClosing: false });
    }
  };

  /**
   * #494 — the executor's operator prompts are PROMISES: it asks, a person answers, it continues.
   * Each machine has at most one pending prompt; the resolver is kept here (not in the record, which
   * React renders) and `answerOperator` settles it. A reset resolves it `false`, so an executor whose
   * release was forgotten cannot sit waiting on a panel that is gone.
   */
  const operatorAnswers = new Map<string, (ok: boolean) => void>();
  const askOperator = (machine: string, step: OperatorStep): Promise<boolean> => {
    if (get().records[machine] === undefined) return Promise.resolve(false);
    return new Promise((resolve) => {
      operatorAnswers.set(machine, resolve);
      patch(machine, { operatorStep: step });
    });
  };
  const abandonOperator = (machine: string): void => {
    const resolve = operatorAnswers.get(machine);
    operatorAnswers.delete(machine);
    resolve?.(false);
  };

  /** One sentence for a post-facing stop, whichever half refused: nothing engraves from it. */
  const afterFacingNote = (r: Extract<AfterFacingResult, { ok: false }>): string => {
    const what = r.step === 're-touch' ? 'The re-touch of the faced top refused' : 'Writing Z0 for the engraving cutter failed';
    const sep = /[.!?]$/.test(r.reason) ? ' ' : '. ';
    return `${what}: ${r.reason}${sep}No program was played.`;
  };

  /**
   * #494 — THE CONFIRMED BIT CHANGE AFTER A FACING pass, in decision 4's order: the faced top is
   * RE-TOUCHED and Z0 is written for the ENGRAVING cutter before that cutter's program plays.
   *
   * The call is #473's executor, not a second copy of it: `retouchAndCorrectAfterFacing` owns the
   * sequence, the band (`facing.retouchToleranceMm`) and the consent rule. This store supplies the
   * run's context — the first registration measured before the face cut, the depth the face program
   * removed, the location's defaults, the cutter named in the fit step — and BLOCKS the engraving
   * program on any refusal: a band miss means the skim is not where it was posted to leave the top.
   *
   * The vacuum stays ON through the probe change (the face file switched it on; the engraving file
   * switches it off). A refusal closes the span, because no further program will run.
   */
  const runAfterFacing = async (machine: string, index: number): Promise<void> => {
    const rec = get().records[machine];
    if (rec === undefined) return;
    const file = findFile(rec, index);
    if (file === null) return;
    const first = firstRegistrationFor(rec.jobId, rec.target);
    const blocked = facingRegistrationBlocker(rec.job, rec.files, first);
    if (blocked !== null || first === null) {
      patch(machine, { phase: 'failed', active: null, next: null, atMachine: false, operatorStep: null });
      say(machine, `The program did not start: ${blocked ?? 'the first registration is not in app state'}.`);
      await closeSpan(machine, 'No program is running after the face program.');
      return;
    }
    const removedMm = rec.job.facing?.enabled === true ? rec.job.facing.depth : Number.NaN;
    patch(machine, { phase: 'retouch', active: null, next: null, operatorStep: null, atMachine: false, stopAsked: false });
    say(
      machine,
      `Re-touching the faced top and writing Z0 for the engraving cutter (${file.toolKey}); no program has started.`,
    );
    const handle = attachConsole(rec.target);
    try {
      const r = await retouchAndCorrectAfterFacing(
        first.plan,
        first.outcome,
        { removedMm, defaults: useShopDefaultsStore.getState().defaults, engravingCutter: file.toolKey },
        { console: { send: (line, timing) => handle.send(line, timing) }, operator: (step) => askOperator(machine, step) },
        { confirmed: true },
      );
      if (get().records[machine] === undefined) return;
      if (!r.ok) {
        patch(machine, { phase: 'failed', active: null, next: null, atMachine: false, operatorStep: null });
        say(machine, afterFacingNote(r));
        await closeSpan(machine, 'The program was not played, so the release step is closing the vacuum span.');
        return;
      }
      patch(machine, { operatorStep: null, retouchedFor: index });
      say(machine, `The faced top measured machine Z ${r.surface.z}; Z0 for ${file.toolKey} written (${r.correction}).`);
      await runFile(machine, index);
    } catch (e) {
      if (get().records[machine] === undefined) return;
      patch(machine, { phase: 'failed', active: null, next: null, atMachine: false, operatorStep: null });
      say(
        machine,
        `The post-facing step could not run: ${e instanceof Error ? e.message : String(e)}. No program was played.`,
      );
      await closeSpan(machine, 'The program was not played, so the release step is closing the vacuum span.');
    } finally {
      await handle.close();
    }
  };

  /**
   * #1146 — ASK UNTIL IDLE before a walk starts. A program's own ending sends `$H`; for a moment
   * afterwards the controller reports Home, and the run's start refuses anything but Idle — so the
   * walk waits for the machine to settle rather than failing on the program's own home.
   */
  const waitIdle = async (target: { host: string; port: number }, tries = 12, gapMs = 1000): Promise<boolean> => {
    const handle = attachConsole(target);
    try {
      for (let i = 0; i < tries; i += 1) {
        const q = await handle.send('?');
        if (q.kind === 'sent' && alarmLine(q.text) === null) {
          const p = readProgress(q.text);
          if (p.state === 'Idle' && (p.percent === null || p.percent >= 100)) return true;
        }
        if (i + 1 < tries) await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
      return false;
    } finally {
      await handle.close();
    }
  };

  /**
   * #1146 — PLAY A WALK FILE through the one run store, like any program. The vacuum is the run's
   * (item 41's direct outputs): on before the file for a cleaning pass that rides a span, off at
   * the span's own end; the air walk touches no accessory at all. A Stop during it is the run's red
   * button and this store does nothing further on its own.
   */
  const runWalk = async (machine: string, mode: CleanWalkMode, after: WalkAfter): Promise<void> => {
    const rec = get().records[machine];
    if (rec === undefined || rec.walk !== null) return;
    const walk = rec.walks[mode];
    const what = mode === 'clean' ? 'cleaning pass' : 'air walk';
    const restore = after.kind === 'clean-now' ? after.restore : 'failed';
    if (walk === null) {
      patch(machine, { phase: restore, walk: null });
      say(machine, `The ${what} did not start: it was not planned for this release.`);
      return;
    }
    if (walk.upload !== 'uploaded' && walk.upload !== 'present') {
      patch(machine, { phase: restore, walk: null });
      say(machine, `The ${what} did not start: ${walk.filename} is not on the card. Press Upload first.`);
      return;
    }
    if (!(await waitIdle(rec.target))) {
      patch(machine, { phase: restore, walk: null, atMachine: false });
      say(machine, `The ${what} did not start: the machine did not answer Idle — check it at the machine.`);
      return;
    }
    const current = get().records[machine];
    if (current === undefined || current.walk !== null) return;
    // The plan may have moved while the machine settled: play the file the record holds NOW, or
    // refuse — a prepared entry the record no longer names would never be matched at its end.
    const walkNow = current.walks[mode];
    if (walkNow === null || (walkNow.upload !== 'uploaded' && walkNow.upload !== 'present')) {
      patch(machine, { phase: restore, walk: null });
      say(machine, `The ${what} did not start: its file changed or is not on the card — press Upload first.`);
      return;
    }
    // The cleaning pass rides the job's span: MIDDLE while programs remain (the vacuum stays on
    // across the bit change), WHOLE when it is the span's own end (after the last program, or a
    // Clean now press). The air walk switches nothing, and a job that runs without its accessory
    // output (`airOn` false — the same fact the programs' span is read from) gets no vacuum words
    // for the clean either: `none` sends nothing.
    const lastProgram = after.kind === 'after-program' && after.next === null;
    const span: 'none' | 'middle' | 'whole' =
      mode === 'airwalk' || !rec.airOn ? 'none' : lastProgram || after.kind === 'clean-now' ? 'whole' : 'middle';
    const context: RunContext = {
      nc: walkNow.nc,
      toolKey: current.job.toolKey,
      vacuumOwned: true,
      vacuumSpan: span,
      // The clean file carries its own M811/M812; the vacuum words stay the run's.
      blow: false,
      maintenance: mode,
    };
    const runStore = useMachineRunStore.getState();
    if (!runStore.prepare(rec.target, walkNow.filename, walkNow.hash, context)) {
      patch(machine, { phase: restore, walk: null });
      say(machine, `The ${what} did not start: a run is already going on this machine.`);
      return;
    }
    // The walk state goes in BEFORE the start: the end subscription must find it.
    patch(machine, { phase: mode === 'airwalk' ? 'airwalk' : 'cleaning', walk: { mode, after }, stopAsked: false });
    if (!runStore.start(rec.target, runSettings(useShopDefaultsStore.getState().defaults))) {
      patch(machine, { phase: restore, walk: null });
      say(machine, `The ${what} did not start: the machine's run entry could not be started.`);
      return;
    }
    say(
      machine,
      mode === 'airwalk'
        ? `Playing the air walk (${walkNow.filename}) over the stock outline at work Z ${walkNow.sweepZ.toFixed(2)}.`
        : `Playing the cleaning pass (${walkNow.filename}): ${walkNow.rows} row${walkNow.rows === 1 ? '' : 's'} at work Z ${walkNow.sweepZ.toFixed(2)}.`,
    );
  };

  /** #1146 — the list's continuation after a finished program, with or without a cleaning pass. */
  const completeProgram = async (
    machine: string,
    after: Extract<WalkAfter, { kind: 'after-program' }>,
    vacuum: ReleaseRecord['vacuum'],
    cleaned: boolean,
  ): Promise<void> => {
    const rec = get().records[machine];
    if (rec === undefined) return;
    const cleanedWords = cleaned ? ' The cleaning pass ran after it.' : '';
    if (after.next === null) {
      patch(machine, { phase: 'done', active: after.index, next: null, vacuum });
      say(machine, `Every program in the job is finished (${after.index} of ${after.total}).${cleanedWords}`);
      // #1123 item 41 — the RUN switches the span off at its end (M852/M812); a program the run
      // could not switch off (a refusal it reported) leaves the vacuum on, and this closes it on
      // an Idle machine only.
      if (vacuum !== 'off' && rec.airOn) await closeSpan(machine, 'The job’s last program finished with the vacuum still on.');
      return;
    }
    // D-17: the bit change is a new program, so the at-machine tick is asked again.
    patch(machine, { phase: 'bit-change', active: after.index, next: after.next, atMachine: false, vacuum });
    say(
      machine,
      `Program ${after.index} of ${after.total} finished.${cleanedWords} The machine is homed${
        vacuum === 'on' ? ' and the vacuum stays on' : ''
      }: change the cutter for program ${after.next} before it plays.`,
    );
  };

  /** #1146 — a walk's own end. After a Stop nothing moves on its own; every other path continues. */
  const endWalk = async (machine: string, outcome: RunOutcome): Promise<void> => {
    const rec = get().records[machine];
    if (rec === undefined || rec.walk === null) return;
    const { mode, after } = rec.walk;
    const what = mode === 'clean' ? 'cleaning pass' : 'air walk';
    patch(machine, { walk: null, stopAsked: false });
    // A walk's own sentence: `describeRun`'s finished wording is the job span's (vacuum, air),
    // which a walk does not own. Every other outcome's sentence is true of it as written.
    say(
      machine,
      outcome.kind === 'finished'
        ? `The ${what} finished${outcome.last.elapsedS !== null ? ` in ${Math.round(outcome.last.elapsedS)} s` : ''}.`
        : describeRun(outcome),
    );

    if (outcome.kind === 'finished') {
      const whole =
        mode === 'clean' && (after.kind === 'clean-now' || (after.kind === 'after-program' && after.next === null));
      // #1123 item 41 — the run's own words first: a span's end switched the vacuum off itself; a
      // middle-span clean leaves it on; an unconfirmed off is not claimed either way. A walk that
      // sent no vacuum word (the air walk, or a clean over an air-off job) leaves it where it was.
      const vacuum: ReleaseRecord['vacuum'] =
        outcome.vacuumOff === true
          ? 'off'
          : mode === 'airwalk' || !rec.airOn
            ? rec.vacuum
            : whole
              ? 'unknown'
              : 'on';
      if (mode === 'airwalk') {
        patch(machine, { airWalked: true, phase: 'starting', vacuum });
        if (after.kind === 'start-program') {
          say(machine, `The air walk finished. Playing program ${after.index}.`);
          await runFile(machine, after.index);
        }
        return;
      }
      if (after.kind === 'after-program') {
        await completeProgram(machine, after, vacuum, true);
      } else if (after.kind === 'clean-now') {
        patch(machine, { phase: after.restore, vacuum });
        say(machine, `The cleaning pass finished; the release is back where it was (${after.restore}).`);
      }
      return;
    }

    if (outcome.kind === 'aborted' || outcome.kind === 'stopped-unconfirmed') {
      const vacuum =
        outcome.kind === 'aborted' && outcome.stop.kind === 'stopped' ? (outcome.stop.vacuumOff ? 'off' : 'unknown') : 'unknown';
      patch(machine, { phase: 'stopped', vacuum, atMachine: false, next: null });
      say(
        machine,
        `The ${what} did not finish. Nothing moves on its own after a stop: once the machine reads Idle and is homed, Clean now runs the cleaning pass again.`,
      );
      return;
    }

    const vacuum = outcome.kind === 'alarm' || outcome.kind === 'unreachable' ? 'unknown' : rec.vacuum;
    patch(machine, { phase: 'failed', vacuum, atMachine: false });
    say(machine, `The ${what} did not finish. The vacuum may still be on, and it was not switched off from here: check it at the machine.`);
  };

  /** The machine's entry says a program ended. Work out the list's next move, exactly once. */  const settle = async (machine: string, index: number, outcome: RunOutcome): Promise<void> => {
    const rec = get().records[machine];
    if (rec === undefined || rec.settled) return;
    const file = findFile(rec, index);
    if (file === null) return;
    patch(machine, { settled: true, stopAsked: false });
    say(machine, describeRun(outcome));

    if (outcome.kind === 'finished') {
      const files = rec.files.map((f) => (f.index === index ? { ...f, done: true } : f));
      // #1123 item 41 — WHAT THE RUN JUST DID, first: a span's end switches the vacuum off itself
      // (M852), so a 'last'/'whole' finish reports vacuumOff and the span must not be closed twice.
      const vacuum =
        outcome.vacuumOff === true || carriesVacuumOff(file.nc)
          ? 'off'
          : carriesVacuumOn(file.nc)
            ? 'on'
            : rec.vacuum;
      const pending = releasePending(files);
      const after: WalkAfter = {
        kind: 'after-program',
        index,
        total: file.total,
        next: pending.length === 0 ? null : pending[0]!.index,
      };
      patch(machine, { files });
      // #1146 — THE CLEANING PASS AFTER EVERY PROGRAM (the maintainer's ruling): the list's
      // continuation waits for the FILE's end, so a stop during the clean leaves the release
      // stopped rather than announcing a bit change that never happened. A dry run never cleans.
      if (rec.cleanAfter && rec.walks.clean !== null && file.dryRun !== true) {
        say(
          machine,
          `Program ${index} of ${file.total} finished. The cleaning pass runs ${
            after.next === null ? 'before the job is done' : `before program ${after.next}`
          }.`,
        );
        await runWalk(machine, 'clean', after);
        return;
      }
      await completeProgram(machine, after, vacuum, false);
      return;
    }

    if (outcome.kind === 'aborted' || outcome.kind === 'stopped-unconfirmed') {
      const vacuum =
        outcome.kind === 'aborted' && outcome.stop.kind === 'stopped' ? (outcome.stop.vacuumOff ? 'off' : 'unknown') : 'unknown';
      // D-17: a resume plays a program again, so it is a fresh start and asks for the tick again.
      patch(machine, { phase: 'stopped', active: index, next: null, vacuum, stoppedBetween: false, atMachine: false });
      say(
        machine,
        `Program ${index} of ${file.total} did not finish. The stock stays reserved; resuming plays program ${index} again from its beginning.`,
      );
      return;
    }

    // refused / alarm / unreachable / never-started: no program is running. A machine that answered
    // Idle can be closed from here; an alarm or silence cannot, and the sentence says so.
    // #1123 item 41 — AN ALARM OR SILENCE LEAVES THE OUTPUTS UNKNOWN (the red button cuts them):
    // the record must not claim 'on', or the retry's card and the next close would both be guessing
    // from a word that died with the alarm. The next start re-states the span regardless.
    const vacuum =
      outcome.kind === 'alarm' || outcome.kind === 'unreachable'
        ? 'unknown'
        : outcome.kind === 'never-started' && (outcome.span === 'middle' || outcome.span === 'last')
          ? 'on'
          : rec.vacuum;
    patch(machine, { phase: 'failed', active: index, next: null, vacuum });
    if (outcome.kind === 'refused' || outcome.kind === 'never-started') {
      await closeSpan(machine, 'The run did not start, so the release step is closing the vacuum span.');
    } else {
      say(machine, 'The vacuum may still be on, and it was not switched off from here: check it at the machine.');
    }
  };

  /**
   * The machine store is the run's truth. This subscription notices the moment a prepared entry has
   * an OUTCOME AND AN END — both, because `running:false` is set before the end-of-run saves finish,
   * and starting the next program then would race the shelf write.
   */
  useMachineRunStore.subscribe((state) => {
    for (const [machine, rec] of Object.entries(get().records)) {
      // #1146 — a walk is the machine entry while it plays; its end continues the release.
      if ((rec.phase === 'airwalk' || rec.phase === 'cleaning') && rec.walk !== null) {
        const walk = rec.walks[rec.walk.mode];
        const entry = state.runs[machine];
        if (walk === null || entry === undefined || entry.running || entry.outcome === null || entry.end === null) continue;
        if (entry.filename !== walk.filename || entry.programHash !== walk.hash) continue;
        void endWalk(machine, entry.outcome);
        continue;
      }
      if (rec.phase !== 'running' || rec.active === null || rec.settled) continue;
      const entry = state.runs[machine];
      if (entry === undefined || entry.running || entry.outcome === null || entry.end === null) continue;
      const file = findFile(rec, rec.active);
      if (file === null || entry.filename !== file.filename || entry.programHash !== file.hash) continue;
      void settle(machine, rec.active, entry.outcome);
    }
  });

  return {
    records: {},

    plan: (target, job, programs) => {
      const machine = machineKey(target);
      const current = get().records[machine];
      const done = [...finishedProgramsFor(target), ...finishedLogged(job)];
      const planned = releasePrograms(job.name, programs, done);
      const walks = walksForJob(target, job, programs);
      if (current !== undefined && current.jobId === job.id && sameHashes(current.files, planned)) {
        // A remount, or a refresh after a run finished elsewhere: keep the upload results and the
        // at-machine confirmation, and read the finished list again.
        const merged = releasePrograms(job.name, programs, done).map((f, i) => ({
          ...f,
          upload: current.files[i]!.upload,
          uploadNote: current.files[i]!.uploadNote,
        }));
        // #1146 — a walk is mid-flight: its file is the text the running entry was prepared with,
        // so the record keeps that pair until the walk ends. The next plan after it settles picks
        // up a changed setting.
        if (current.walk !== null) {
          patch(machine, { files: merged });
          return;
        }
        patch(machine, {
          files: merged,
          airWalk: walks.airWalk,
          cleanAfter: walks.cleanAfter,
          walks: {
            airwalk: mergeWalk(current.walks.airwalk, walks.airwalk),
            clean: mergeWalk(current.walks.clean, walks.clean),
          },
        });
        return;
      }
      // A DIFFERENT PROGRAM LIST is a different run: do not carry upload states or a phase across.
      // #419 decision 4 — the vacuum span is the frozen post's own words, so it is read from the
      // text that will be played, not from the Generate that happened to produce it.
      const airOn = jobCarriesVacuumWords(programs);
      set((s) => ({
        records: {
          ...s.records,
          [machine]: {
            target: { host: target.host, port: target.port },
            jobId: job.id,
            jobName: job.name,
            job,
            airOn,
            phase: 'idle',
            walks: { airwalk: freshWalk(walks.airwalk), clean: freshWalk(walks.clean) },
            airWalk: walks.airWalk,
            cleanAfter: walks.cleanAfter,
            airWalked: false,
            walk: null,
            files: planned.map((f) => ({
              ...f,
              // #1093 — the name `releasePrograms` planned is THE name (one naming function for
              // Save, sheet, release, record and CLI). Re-deriving it here with a cut-order index
              // renamed a faced run's skim to `-p1` and shifted every engraving by one.
              upload: 'pending' as const,
              uploadNote: null,
            })),
            active: null,
            next: null,
            atMachine: false,
            operatorStep: null,
            retouchedFor: null,
            uploading: null,
            vacuum: 'unknown',
            stopAsked: false,
            stoppedBetween: false,
            spanClosing: false,
            notes: [],
            settled: false,
          },
        },
      }));
      // #1146 — a wanted walk the plan could not make says why, once, in the release notes.
      for (const note of walks.notes) say(machine, note);
    },

    uploadAll: async (target) => {
      const machine = machineKey(target);
      const rec = get().records[machine];
      if (rec === undefined) return;
      if (
        rec.phase === 'uploading' ||
        rec.phase === 'running' ||
        rec.phase === 'starting' ||
        rec.phase === 'retouch' ||
        rec.phase === 'airwalk' ||
        rec.phase === 'cleaning'
      )
        return;
      const files = rec.files.map((f) => ({ ...f }));
      patch(machine, { phase: 'uploading', uploading: null, stopAsked: false });
      say(machine, `Uploading ${files.length} program${files.length === 1 ? '' : 's'} in cut order — nothing has run.`);

      for (let i = 0; i < files.length; i += 1) {
        const f = files[i]!;
        if (f.upload === 'uploaded' || f.upload === 'present') continue;
        if (get().records[machine]?.stopAsked === true) {
          patch(machine, { phase: 'stopped', uploading: null, atMachine: false });
          say(machine, 'Uploading stopped. The files already written stay on the card.');
          return;
        }
        // #419 §3 — VERIFIED ONLY. The package carries texts, not verifier reports; the Cut surface
        // matched this session's reports by hash. A frozen program with no match is refused here,
        // with the file's own number, rather than being sent on the strength of a report about some
        // other text. There is no "send anyway" path.
        // #535 — the check is the verifier's report, or a goal program's surface check. A frozen
        // text with neither is refused here, with the file's own number, never sent on trust.
        const check = releaseCheck(f);
        if (check === null) {
          files[i] = { ...f, upload: 'failed', uploadNote: 'no verifier report for this frozen text in this session' };
          patch(machine, { files: files.map((x) => ({ ...x })), uploading: null, phase: 'failed' });
          say(
            machine,
            `Program ${f.index} was NOT uploaded: this session holds no verifier report for its frozen text. Generate the job again before running it.`,
          );
          say(machine, 'No program was played.');
          return;
        }
        files[i] = { ...f, upload: 'sending', uploadNote: null };
        patch(machine, { files: files.map((x) => ({ ...x })), uploading: f.index });
        let result: MachineUploadResult;
        try {
          result = await uploadProgram(target, { filename: f.filename, nc: f.nc, check });
        } catch (e) {
          result = { kind: 'error', filename: f.filename, detail: e instanceof Error ? e.message : String(e) };
        }
        if (result.kind === 'uploaded') {
          // #772 — the card's Files view deletes only what this app put there; the ledger is how it
          // knows. Recording after the machine accepted the file, before the state flips.
          recordUploadedFile(target.host, f.filename);
          files[i] = {
            ...f,
            upload: result.alreadyPresent ? 'present' : 'uploaded',
            uploadNote: result.alreadyPresent ? 'already on the card, matching this build' : `${result.bytes} bytes`,
          };
          say(machine, said(result));
        } else {
          files[i] = { ...f, upload: 'failed', uploadNote: 'detail' in result ? result.detail : result.reason };
          patch(machine, { files: files.map((x) => ({ ...x })), uploading: null, phase: 'failed' });
          say(machine, said(result));
          say(machine, 'No program was played. Fix the upload and press Upload again; the files already written are kept.');
          return;
        }
        patch(machine, { files: files.map((x) => ({ ...x })) });
      }

      // #1146 — THE WALKS GO ON THE CARD WITH THE PROGRAMS, before anything runs: a walk the
      // release wants that is not uploaded refuses the start rather than failing mid-run.
      let walkFiles = 0;
      for (const mode of ['airwalk', 'clean'] as const) {
        const now = get().records[machine];
        if (now === undefined) return;
        const walk = now.walks[mode];
        if (walk === null) continue;
        walkFiles += 1;
        if (walk.upload === 'uploaded' || walk.upload === 'present') continue;
        if (now.stopAsked) {
          patch(machine, { phase: 'stopped', uploading: null, atMachine: false });
          say(machine, 'Uploading stopped. The files already written stay on the card.');
          return;
        }
        patch(machine, {
          walks: { ...now.walks, [mode]: { ...walk, upload: 'sending', uploadNote: null } },
        });
        let result: MachineUploadResult;
        try {
          // The check is the verifier's own report on this exact text — no exemption because the
          // release step wrote it (the verified-only wall).
          result = await uploadProgram(target, { filename: walk.filename, nc: walk.nc, check: verifyCheck(walk.verify) });
        } catch (e) {
          result = { kind: 'error', filename: walk.filename, detail: e instanceof Error ? e.message : String(e) };
        }
        const after = get().records[machine];
        if (after === undefined) return;
        if (result.kind === 'uploaded') {
          recordUploadedFile(target.host, walk.filename);
          patch(machine, {
            walks: {
              ...after.walks,
              [mode]: {
                ...walk,
                upload: result.alreadyPresent ? 'present' : 'uploaded',
                uploadNote: result.alreadyPresent ? 'already on the card, matching this build' : `${result.bytes} bytes`,
              },
            },
          });
          say(machine, said(result));
        } else {
          patch(machine, {
            walks: { ...after.walks, [mode]: { ...walk, upload: 'failed', uploadNote: 'detail' in result ? result.detail : result.reason } },
            uploading: null,
            phase: 'failed',
          });
          say(machine, said(result));
          say(machine, 'No program was played. Fix the upload and press Upload again; the files already written are kept.');
          return;
        }
      }
      patch(machine, { phase: 'ready', uploading: null });
      say(
        machine,
        `${files.length} file${files.length === 1 ? '' : 's'}${walkFiles > 0 ? ` and ${walkFiles} walk file${walkFiles === 1 ? '' : 's'}` : ''} on the card. Nothing has run.`,
      );
    },

    startRelease: (target) => {
      const machine = machineKey(target);
      const rec = get().records[machine];
      if (
        rec === undefined ||
        rec.spanClosing ||
        rec.phase === 'running' ||
        rec.phase === 'starting' ||
        rec.phase === 'uploading' ||
        rec.phase === 'retouch' ||
        rec.phase === 'closing' ||
        rec.phase === 'idle'
      )
        return;
      // #494 — a faced job cannot start its face file without the registration that the post-facing
      // re-touch will need. Refuse before anything moves and name the missing step.
      const first = firstRegistrationFor(rec.jobId, rec.target);
      const blocked = facingRegistrationBlocker(rec.job, rec.files, first);
      if (blocked !== null) {
        say(machine, `The release did not start: ${blocked}.`);
        return;
      }
      const next = releaseNext(rec.files);
      if (next === null) {
        patch(machine, { phase: 'done', next: null });
        say(machine, 'Every program was already finished on this machine — there is nothing to play.');
        return;
      }
      // #1146 — both walks are FILES: one that is not on the card refuses the start here, not
      // halfway through the run.
      const missingWalk = (w: ReleaseWalk | null) => w !== null && w.upload !== 'uploaded' && w.upload !== 'present';
      const wantAir = rec.airWalk && !rec.airWalked && next.index === 1 && rec.walks.airwalk !== null;
      const wantClean = rec.cleanAfter && rec.walks.clean !== null;
      if ((wantAir && missingWalk(rec.walks.airwalk)) || (wantClean && missingWalk(rec.walks.clean))) {
        say(machine, 'The release did not start: its cleaning pass or air walk is not on the card — press Upload first.');
        return;
      }
      if (wantAir) {
        say(
          machine,
          `The air walk runs before the first cut (${rec.walks.airwalk!.filename}), then program ${next.index} of ${next.total}.`,
        );
        void runWalk(machine, 'airwalk', { kind: 'start-program', index: next.index });
        return;
      }
      if (next.index > 1) {
        patch(machine, { phase: 'bit-change', next: next.index, active: null });
        say(machine, `Program ${next.index} of ${next.total} is the first unfinished file: set the cutter and Z0 for it before it plays.`);
        return;
      }
      if (rec.phase === 'stopped') {
        say(machine, `Program ${next.index} did not finish; it will play again from its beginning.`);
      }
      void runFile(machine, next.index);
    },

    confirmChange: (target) => {
      const machine = machineKey(target);
      const rec = get().records[machine];
      if (rec === undefined || rec.phase !== 'bit-change' || rec.next === null) return;
      const next = findFile(rec, rec.next);
      const previous = next === null ? null : findFile(rec, next.index - 1);
      // #494 — when the file that just finished is the FACING pass, the bit change is not the whole
      // step: the faced top is re-touched and Z0 written for the engraving cutter first. The
      // engraving file starts only if that succeeds (decision 4). A RESUME of an engraving program
      // whose Z0 this step already wrote does not touch the top again: by then the program may have
      // cut through the re-touch's own surface point.
      if (
        next !== null &&
        previous?.kind === 'facing' &&
        rec.job.facing?.enabled === true &&
        rec.retouchedFor !== next.index
      ) {
        void runAfterFacing(machine, next.index);
        return;
      }
      void runFile(machine, rec.next);
    },

    answerOperator: (target, ok) => {
      const machine = machineKey(target);
      const rec = get().records[machine];
      if (rec === undefined || rec.phase !== 'retouch' || rec.operatorStep === null) return;
      const resolve = operatorAnswers.get(machine);
      operatorAnswers.delete(machine);
      patch(machine, { operatorStep: null });
      resolve?.(ok);
      say(machine, ok ? 'Operator continued the post-facing step.' : 'Operator stopped the post-facing step; it will not write the origin or start the program.');
    },

    stop: (target) => {
      const machine = machineKey(target);
      const rec = get().records[machine];
      if (rec === undefined) return;
      if (rec.phase === 'running' || rec.phase === 'airwalk' || rec.phase === 'cleaning') {
        useMachineRunStore.getState().requestStop(machine);
        patch(machine, { stopAsked: true });
        say(
          machine,
          rec.phase === 'running'
            ? 'Stop pressed: the abort goes out at the next poll, and the run panel offers Home after the machine confirms.'
            : `Stop pressed during the ${rec.phase === 'airwalk' ? 'air walk' : 'cleaning pass'}: the abort goes out at the next poll, and nothing moves after it.`,
        );
        return;
      }
      if (rec.phase === 'uploading') {
        patch(machine, { stopAsked: true });
        say(machine, 'Stop pressed: the release step stops after the file being written now.');
        return;
      }
      if (rec.phase === 'retouch') {
        // The executor owns the conversation and cannot abort a line already on the wire. If it is
        // waiting on a person, answer Stop; if the probe is moving, only the machine can stop it.
        if (rec.operatorStep !== null) {
          get().answerOperator(target, false);
        } else {
          say(
            machine,
            'Stop pressed while the post-facing probe or correction is moving. Nothing is sent from here mid-line: use the machine’s own stop, then Reset the release.',
          );
        }
        return;
      }
      if (rec.phase === 'bit-change' || rec.phase === 'ready' || rec.phase === 'starting' || rec.phase === 'stopped') {
        // CLOSING IS A PHASE, not a fire-and-forget send: `M852`/`$H` are in flight, and a Resume
        // pressed before they land could start a program whose re-stated `M851` the late `M852` then
        // undoes mid-cut. `startRelease` refuses `closing`, and the panel disables the button.
        patch(machine, { phase: 'closing', next: null, stopAsked: false, stoppedBetween: true });
        void closeSpan(machine, 'Stopped between programs.').finally(() => {
          // D-17: the stop cleared it, so a resume asks for the tick again.
          if (get().records[machine]?.phase === 'closing') patch(machine, { phase: 'stopped', atMachine: false });
        });
      }
    },

    cleanNow: (target) => {
      const machine = machineKey(target);
      const rec = get().records[machine];
      if (rec === undefined) return;
      if (rec.walk !== null || rec.spanClosing) {
        say(machine, 'Clean now is not available while the machine is working or closing.');
        return;
      }
      if (rec.phase !== 'stopped' && rec.phase !== 'failed' && rec.phase !== 'done') {
        say(machine, 'Clean now is offered once no program is running.');
        return;
      }
      if (rec.walks.clean === null) {
        say(machine, 'No cleaning pass is planned for this release.');
        return;
      }
      const restore = rec.phase;
      say(machine, 'Clean now pressed: the cleaning pass runs on its own, then the release stays where it was.');
      void runWalk(machine, 'clean', { kind: 'clean-now', restore });
    },

    setAtMachine: (target, at) => patch(machineKey(target), { atMachine: at }),

    reset: (target) => {
      const machine = machineKey(target);
      // An executor waiting on an operator prompt must not wait forever for a panel that is gone.
      abandonOperator(machine);
      set((s) => {
        const records = { ...s.records };
        delete records[machine];
        return { records };
      });
    },
  };
});

/** Test seam: forget every release. The machine subscription stays (it reads the store's records). */
export function resetEngraveReleaseStore(): void {
  useEngraveReleaseStore.setState({ records: {} });
}
