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
 *      no program running, sends `M332` then `$H` — only on a machine that answers Idle with no
 *      alarm (`machineSpan.ts`). A Stop DURING a cut is the run panel's (#424): `abort`, then `M332`
 *      only once the machine reads Idle, and Home is offered rather than sent.
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
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import { uploadProgram, type MachineUploadResult } from '@/platform/machineUpload';
import { describeRun, runSettings, type RunOutcome } from '@/platform/machineRun';
import { closeVacuumSpan, switchVacuumOn } from '@/platform/machineSpan';
import { getTools } from '@/engine/cnc/toolRegistry';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import {
  carriesVacuumOff,
  carriesVacuumOn,
  jobCarriesVacuumWords,
  programVacuumSpan,
  releaseNext,
  releasePending,
  releasePrograms,
  releaseFileName,
  type ReleaseProgram,
} from '@/engine/cnc/engrave/release';
import { machineKey, runContextFor, useMachineRunStore, type RunContext } from './machineRunStore';
import { finishedProgramsFor } from './locationStore';
import { useShopDefaultsStore } from './shopDefaultsStore';

export type ReleasePhase =
  /** Planned, nothing sent: the upload button is the next press. */
  | 'idle'
  | 'uploading'
  | 'ready'
  /** A program is about to start (the span/pause is being settled). */
  | 'starting'
  | 'running'
  /** A program finished; the machine is homed and the vacuum stays on for the next cutter. */
  | 'bit-change'
  /**
   * The span is being closed (M332 + $H) and the run must not start until it has: a program
   * started now could have its own M331 followed by the late M332, switching the vacuum off
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
  /** The file being written right now, 1-based. */
  uploading: number | null;
  /**
   * What this store believes the vacuum is doing. `unknown` after an alarm/unreachable: it is not a
   * state to claim either way, and the sentence says so.
   */
  vacuum: 'off' | 'on' | 'unknown';
  /**
   * A close (`M332` + `$H`) is in flight. The `closing` phase says this for a Stop; a failure that
   * closes the span keeps its own phase (`failed`) and raises this flag instead, so a Try again
   * cannot start a program underneath the same late `M332`.
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
  plan: (target: { host: string; port: number }, job: EngraveJob, generated: EngraveGenerated) => void;
  /** Upload every program in cut order. Never throws; a failure is a phase and a sentence. */
  uploadAll: (target: { host: string; port: number }) => Promise<void>;
  /** Begin (or resume) the run at the first unfinished program. */
  startRelease: (target: { host: string; port: number }) => void;
  /** Resume after the bit-change pause, at the program the panel named. */
  confirmChange: (target: { host: string; port: number }) => void;
  /** Stop: a running program through the run store; a pause between programs by closing the span. */
  stop: (target: { host: string; port: number }) => void;
  setAtMachine: (target: { host: string; port: number }, at: boolean) => void;
  /** Forget this machine's release (the machine entry, with its end, is left alone). */
  reset: (target: { host: string; port: number }) => void;
}

const sameHashes = (a: readonly ReleaseFile[], b: readonly ReleaseProgram[]): boolean =>
  a.length === b.length && a.every((f, i) => f.hash === b[i]?.hash && f.filename === b[i]?.filename);

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
  if (r.kind === 'done') return 'Vacuum switched off (M332) and the machine homed ($H).';
  if (r.kind === 'not-idle') return `No M332 or home was sent: ${r.detail}. Check the vacuum and the machine.`;
  return `No M332 or home was confirmed: ${r.detail}. Check the vacuum and the machine.`;
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

    patch(machine, { phase: 'starting', active: index, next: null, stopAsked: false, settled: false, stoppedBetween: false });
    const span = programVacuumSpan(file.nc, jobCarriesVacuumWords(rec.files));
    let vacuum = rec.vacuum;
    // #473 — the face file is program 1 and carries the span's `M331`, so by the time a later program
    // starts this store's reading is `on`. A file with no `M331` (a resumed middle/last program, or
    // an `air: false` file) still needs the release step to switch it on — the one place this store
    // sends an ON word.
    const needOn = rec.airOn && !carriesVacuumOn(file.nc) && vacuum !== 'on';
    if (needOn) {
      const r = await switchVacuumOn(rec.target);
      if (get().records[machine]?.phase !== 'starting') return; // stopped while the line was in flight
      if (r.kind !== 'done') {
        patch(machine, { phase: 'failed', vacuum: 'unknown' });
        say(machine, `Program ${file.index} did not start: the vacuum could not be switched on — ${r.detail}.`);
        return;
      }
      vacuum = 'on';
      say(machine, `Vacuum switched on (M331) before program ${file.index} of ${file.total}, which does not carry the word itself.`);
    }

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
    };
    const runStore = useMachineRunStore.getState();
    if (!runStore.prepare(rec.target, file.filename, file.hash, context)) {
      patch(machine, { phase: 'failed', vacuum });
      say(machine, `Program ${file.index} did not start: a run is already going on this machine.`);
      // The switch-on has already gone out. Saying only "did not start" would leave the vacuum
      // running with nothing cutting and no sentence about it; close the span (or report why not).
      if (vacuum === 'on') {
        await closeSpan(machine, 'The vacuum was switched on (M331) before this program and is on with nothing cutting.');
      }
      return;
    }
    if (!runStore.start(rec.target, runSettings(useShopDefaultsStore.getState().defaults))) {
      patch(machine, { phase: 'failed', vacuum });
      say(machine, `Program ${file.index} did not start: the machine's run entry could not be started.`);
      if (vacuum === 'on') {
        await closeSpan(machine, 'The vacuum was switched on (M331) before this program and is on with nothing cutting.');
      }
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
    // panel's start button refuse while it is set, so no program begins under a late M332.
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

  /** The machine's entry says a program ended. Work out the list's next move, exactly once. */
  const settle = async (machine: string, index: number, outcome: RunOutcome): Promise<void> => {
    const rec = get().records[machine];
    if (rec === undefined || rec.settled) return;
    const file = findFile(rec, index);
    if (file === null) return;
    patch(machine, { settled: true, stopAsked: false });
    say(machine, describeRun(outcome));

    if (outcome.kind === 'finished') {
      const files = rec.files.map((f) => (f.index === index ? { ...f, done: true } : f));
      const vacuum = carriesVacuumOff(file.nc) ? 'off' : carriesVacuumOn(file.nc) ? 'on' : rec.vacuum;
      const pending = releasePending(files);
      if (pending.length === 0) {
        patch(machine, { files, vacuum, phase: 'done', active: index, next: null });
        say(machine, `Every program in the job is finished (${index} of ${file.total}).`);
        // A last file that carries no M332 leaves the vacuum on; close it only on an Idle machine.
        if (vacuum !== 'off' && rec.airOn) await closeSpan(machine, 'The job’s last program finished without its own M332.');
        return;
      }
      // D-17: the bit change is a new program, so the at-machine tick is asked again.
      patch(machine, { files, vacuum, phase: 'bit-change', active: index, next: pending[0]!.index, atMachine: false });
      say(
        machine,
        `Program ${index} of ${file.total} finished. The machine is homed and the vacuum stays on: change the cutter for program ${pending[0]!.index} before it plays.`,
      );
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
    const vacuum = outcome.kind === 'never-started' && (outcome.span === 'middle' || outcome.span === 'last') ? 'on' : rec.vacuum;
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

    plan: (target, job, generated) => {
      const machine = machineKey(target);
      const current = get().records[machine];
      const done = finishedProgramsFor(target);
      const planned = releasePrograms(job.name, generated.programs, done);
      if (current !== undefined && current.jobId === job.id && sameHashes(current.files, planned)) {
        // A remount, or a refresh after a run finished elsewhere: keep the upload results and the
        // at-machine confirmation, and read the finished list again.
        const merged = releasePrograms(job.name, generated.programs, done).map((f, i) => ({
          ...f,
          upload: current.files[i]!.upload,
          uploadNote: current.files[i]!.uploadNote,
        }));
        patch(machine, { files: merged });
        return;
      }
      // A DIFFERENT PROGRAM LIST is a different run: do not carry upload states or a phase across.
      const feeds = generated.feeds;
      const airOn = feeds !== null && feeds.ok === true ? feeds.params.air : (job.cutOverride?.air ?? true);
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
            files: planned.map((f) => ({
              ...f,
              filename: releaseFileName(job.name, f.index, f.total),
              upload: 'pending' as const,
              uploadNote: null,
            })),
            active: null,
            next: null,
            atMachine: false,
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
    },

    uploadAll: async (target) => {
      const machine = machineKey(target);
      const rec = get().records[machine];
      if (rec === undefined) return;
      if (rec.phase === 'uploading' || rec.phase === 'running' || rec.phase === 'starting') return;
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
        files[i] = { ...f, upload: 'sending', uploadNote: null };
        patch(machine, { files: files.map((x) => ({ ...x })), uploading: f.index });
        let result: MachineUploadResult;
        try {
          result = await uploadProgram(target, { filename: f.filename, nc: f.nc, verify: f.verify });
        } catch (e) {
          result = { kind: 'error', filename: f.filename, detail: e instanceof Error ? e.message : String(e) };
        }
        if (result.kind === 'uploaded') {
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
      patch(machine, { phase: 'ready', uploading: null });
      say(machine, `${files.length} file${files.length === 1 ? '' : 's'} on the card. Nothing has run.`);
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
        rec.phase === 'closing' ||
        rec.phase === 'idle'
      )
        return;
      const next = releaseNext(rec.files);
      if (next === null) {
        patch(machine, { phase: 'done', next: null });
        say(machine, 'Every program was already finished on this machine — there is nothing to play.');
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
      void runFile(machine, rec.next);
    },

    stop: (target) => {
      const machine = machineKey(target);
      const rec = get().records[machine];
      if (rec === undefined) return;
      if (rec.phase === 'running') {
        useMachineRunStore.getState().requestStop(machine);
        patch(machine, { stopAsked: true });
        say(machine, 'Stop pressed: the abort goes out at the next poll, and the run panel offers Home after the machine confirms.');
        return;
      }
      if (rec.phase === 'uploading') {
        patch(machine, { stopAsked: true });
        say(machine, 'Stop pressed: the release step stops after the file being written now.');
        return;
      }
      if (rec.phase === 'bit-change' || rec.phase === 'ready' || rec.phase === 'starting' || rec.phase === 'stopped') {
        // CLOSING IS A PHASE, not a fire-and-forget send: `M332`/`$H` are in flight, and a Resume
        // pressed before they land could start a program whose own `M331` the late `M332` then
        // undoes mid-cut. `startRelease` refuses `closing`, and the panel disables the button.
        patch(machine, { phase: 'closing', next: null, stopAsked: false, stoppedBetween: true });
        void closeSpan(machine, 'Stopped between programs.').finally(() => {
          // D-17: the stop cleared it, so a resume asks for the tick again.
          if (get().records[machine]?.phase === 'closing') patch(machine, { phase: 'stopped', atMachine: false });
        });
      }
    },

    setAtMachine: (target, at) => patch(machineKey(target), { atMachine: at }),

    reset: (target) => {
      const machine = machineKey(target);
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
