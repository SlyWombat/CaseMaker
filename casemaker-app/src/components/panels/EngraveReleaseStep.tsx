/**
 * #469 / #419 §3 — THE RELEASE STEP, from the Cut screen: upload the whole list, play it in order,
 * stop at the bit change, and say what the vacuum is doing across it.
 *
 * The store is `store/engraveReleaseStore.ts`. This component draws its state and makes the physical
 * confirmations the step cannot: the per-program "I am at the machine", and the bit-change
 * confirmation naming the next cutter, its `M491` reading and the Z0 difference. The run itself is
 * still `machineRunStore`'s entry, drawn through `EngraveMachineRun controlled`, so progress, Stop,
 * the end-of-run lines and the offcut question are the same components the single-file run uses.
 *
 * TWO PRESSES FOR THE UPLOAD. It writes N files to the machine's card, so the first press lists the
 * target, every file and the total bytes; only the second sends. A program already on the card is
 * reported as such and is not rewritten.
 */

import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import type { EngraveJob } from '@/types/engraveJob';
import { programBytes } from '@/platform/machineUpload';
import {
  releaseNext,
  releasePending,
  type ReleaseSource,
} from '@/engine/cnc/engrave/release';
import type { RunPlan } from '@/engine/cnc/plan';
import { useEngraveReleaseStore, type ReleaseFile, type ReleaseWalk } from '@/store/engraveReleaseStore';
import { useFirstRegistration } from '@/store/engraveRegistrationStore';
import { facingRegistrationBlocker, withPeriod } from '@/store/engraveRunGate';
import { useMachineTranscriptStore } from '@/store/machineTranscriptStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { readFlag } from '@/platform/defaultsClient';
import { machineKey, useMachineRunStore } from '@/store/machineRunStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { cutterIdentity } from '@/engine/cnc/engrave/cutterCaseLine';
import { cleanWalkPlanSeconds, cleanWalkPlanWords } from '@/engine/cnc/engrave/cleanWalkPlan';
// #1202 field 5 — the walks are motion routines: their identity, mark and statement gate the Start.
import { walkRoutineIdentity } from '@/engine/cnc/engrave/walkIdentity';
import { routineCompleted } from '@/platform/routineRecord';
import { firstRunAutomationRefusal } from '@/platform/automation';
import { useLocationStore } from '@/store/locationStore';
// #1123-42 — the running program's percent, time left and next cutter, from the run watch's own
// status line and the release list's cut order.
import { nextBitChange, runClockSeconds, runningProgramWords } from '@/engine/cnc/engrave/runProgress';
import { EngraveMachineRun } from './EngraveMachineRun';
import { StopReportAction } from '@/components/panels/StopReportAction';
import { stopIsReportable } from '@/platform/machineStopReport';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const BOX: CSSProperties = { marginTop: 6, padding: 8, border: '1px solid #3a4552', borderRadius: 4, background: '#1b2027' };
const OK = '#9fd19b';
const WARN = '#e0c07a';
const BAD = '#f0b4ad';

export interface EngraveReleaseStepProps {
  /** Where the machine was last reached, or null. The step cannot do anything without one. */
  target: { host: string; port: number } | null;
  job: EngraveJob;
  /**
   * The FROZEN programs, in cut order — the only texts the step uploads and plays (#419 §3). The
   * Cut surface builds them with `frozenReleaseSources`; this component never re-reads the
   * document for a program.
   */
  programs: readonly ReleaseSource[];
  /** The one plan the Cut surface shows (`cutPlan`) — not a second derivation made here. */
  runPlan: RunPlan;
  /** `releaseBlocker(run)` — required, so the panel's gate and this component cannot disagree. */
  blocker: string | null;
  /** Told the source line the machine reports while a program runs (`EngraveMachineRun`). */
  onProgramLine?: (line: number | null) => void;
}

function FileRow({ file }: { file: ReleaseFile }): JSX.Element {
  const items = useToolRegistryStore((s) => s.items);
  const label = cutterIdentity(file.toolKey, items);
  const state =
    file.done
      ? 'already finished on this machine — skipped'
      : file.upload === 'uploaded'
        ? 'uploaded'
        : file.upload === 'present'
          ? 'already on the card'
          : file.upload === 'failed'
            ? `upload failed${file.uploadNote === null ? '' : ` — ${file.uploadNote}`}`
            : file.upload === 'sending'
              ? 'uploading…'
              : 'to upload';
  return (
    <li data-testid={`engrave-release-file-${file.index}`} data-state={file.done ? 'done' : file.upload}>
      Program {file.index} of {file.total} · Setup {file.setupIndex} ·{' '}
      {label.casePhrase !== null && <strong>{label.casePhrase}</strong>}
      {label.casePhrase !== null && ' — '}
      <strong>{label.name}</strong> ({label.code})
      <br />
      <span style={MUTED}>
        {file.filename} — {state}
      </span>
    </li>
  );
}

/** The bit-change steps, in the run sheet's words (#419 §4: the maintainer's routine). */
function ChangePanel({
  previous,
  next,
  flipped,
  ok,
  setOk,
  atMachine,
  setAtMachine,
  onConfirm,
}: {
  previous: ReleaseFile;
  next: ReleaseFile;
  /**
   * #1170 — THE NEXT PROGRAM IS SIDE 2 OF A FLIP. The origin did not stay where it was: the
   * Register step wrote side 2's from the two bores, and telling the operator to keep the SAME
   * corner here would undo the turn the flip card just asked for.
   */
  flipped: boolean;
  ok: boolean;
  setOk: (v: boolean) => void;
  atMachine: boolean;
  setAtMachine: (v: boolean) => void;
  onConfirm: () => void;
}): JSX.Element {
  const items = useToolRegistryStore((s) => s.items);
  const label = cutterIdentity(next.toolKey, items);
  return (
    <div style={BOX} data-testid="engrave-release-change">
      <p style={{ fontSize: 12, color: '#e6edf5', margin: '0 0 6px' }} data-testid="engrave-release-change-sentence">
        Program {previous.index} of {previous.total} finished; the machine homed and the vacuum is still on.
        Change the cutter for program {next.index} of {next.total}:{' '}
        {label.casePhrase !== null && (
          <>
            <strong>{label.casePhrase}</strong> —{' '}
          </>
        )}
        <strong>{label.name}</strong> ({label.code}).
      </p>
      <ol style={{ ...MUTED, paddingLeft: 18 }}>
        {flipped ? (
          <li>
            Fit <strong>the cutter</strong>. Side {next.setupIndex}’s X and Y origin was written by the Register
            step on the two locating bores — it does not move with the cutter. Nothing moves but the Z
            reference.
          </li>
        ) : (
          <li>
            Fit <strong>{previous.kind === 'facing' ? 'the ENGRAVING cutter — not the facing cutter' : 'the cutter'}</strong>{' '}
            and keep the X and Y origin where it is — <strong>the SAME corner</strong>, the same edge. Nothing moves
            but the Z reference.
          </li>
        )}
        {previous.kind === 'facing' ? (
          <>
            <li>
              The release step re-touches the FACED surface with the wired probe — a measured seek, never a fixed
              depth — and writes Z0 for the engraving cutter from that reading. It will ask you to fit the probe,
              then to fit the engraving cutter.
            </li>
            <li>
              No program starts if the re-touch lands outside the shop’s retouch tolerance, or if the
              correction fails: the faced top is not where the skim was posted to leave it.
            </li>
          </>
        ) : (
          <>
            <li>
              Calibrate the new cutter’s length the same way as the first (<code>M491</code>) and record its PRB.
              This is a reading of THIS cutter alone.
            </li>
            <li>
              Set Z0 for program {next.index} from those two readings, NOT by touching the surface again:{' '}
              <code>Z0 = surface + (cutter PRB − reference PRB)</code>. The surface has been cut since the origin
              was set, so re-touching it would sink this program’s floors by the last program’s depth.
            </li>
          </>
        )}
      </ol>
      <label style={MUTED}>
        <input
          type="checkbox"
          checked={ok}
          data-testid="engrave-release-change-ok"
          onChange={(e) => setOk(e.target.checked)}
        />{' '}
        {previous.kind === 'facing'
          ? 'The ENGRAVING cutter is in hand and I am ready for the release step to re-touch the faced top and set Z0 before the program starts.'
          : 'The cutter is changed, calibrated (M491), and Z0 is set from the two readings.'}
      </label>
      {/* D-17 — the at-machine tick is per PROGRAM: the bit-change pause cleared it, and program
          {next.index} does not start until the operator standing there says it again. */}
      <label style={MUTED}>
        <input
          type="checkbox"
          checked={atMachine}
          data-testid="engrave-release-at-machine"
          onChange={(e) => setAtMachine(e.target.checked)}
        />{' '}
        I am at the machine, with the head clear and the stock clamped — for program {next.index}.
      </label>
      <button
        type="button"
        data-testid="engrave-release-change-done"
        disabled={!ok || !atMachine}
        style={{ width: '100%', padding: 7, marginTop: 6 }}
        onClick={onConfirm}
      >
        {previous.kind === 'facing'
          ? `Re-touch and run program ${next.index} of ${next.total}`
          : `Run program ${next.index} of ${next.total}`}
      </button>
    </div>
  );
}

export function EngraveReleaseStep({
  target,
  job,
  programs,
  runPlan,
  blocker,
  onProgramLine,
}: EngraveReleaseStepProps): JSX.Element {
  const machine = target === null ? null : `${target.host}:${target.port}`;
  const host = target?.host;
  const port = target?.port;
  const record = useEngraveReleaseStore((s) => (machine === null ? undefined : s.records[machine]));
  const plan = useEngraveReleaseStore((s) => s.plan);
  const uploadAll = useEngraveReleaseStore((s) => s.uploadAll);
  const startRelease = useEngraveReleaseStore((s) => s.startRelease);
  const confirmChange = useEngraveReleaseStore((s) => s.confirmChange);
  const answerOperator = useEngraveReleaseStore((s) => s.answerOperator);
  const stop = useEngraveReleaseStore((s) => s.stop);
  const cleanNow = useEngraveReleaseStore((s) => s.cleanNow);
  const setAtMachine = useEngraveReleaseStore((s) => s.setAtMachine);
  const [stage, setStage] = useState<'idle' | 'confirm'>('idle');
  /**
   * The bit-change tick belongs to the program it was made for (`next`): when the release moves on,
   * the panel asks again without an effect resetting state on a prop change.
   */
  const [changeOkFor, setChangeOkFor] = useState<number | null>(null);
  const next = record?.next ?? null;
  const changeOk = changeOkFor !== null && changeOkFor === next;
  // #494 — the job's first registration, and whether the release may start without one. The gate is
  // the same function the store calls, so the button's disabled state and the start refusal agree.
  const firstRegistration = useFirstRegistration(job.id, target);
  const facingGate = facingRegistrationBlocker(job, programs, firstRegistration);
  // #934 — THE POST-FACING RE-TOUCH IS HIDDEN until its bench run. A job that still has facing on
  // cannot be released: the re-touch is what makes the engraving program's frame true, and the one
  // registration procedure this milestone ships does not include it.
  const hiddenRetouch =
    job.facing?.enabled === true
      ? 'the post-facing re-touch has not been run on this machine yet — turn facing off in Design and generate again'
      : null;
  // #618 — whether the machine's run is suspended, so the Pause button becomes Resume. A boolean
  // selector: the run entry itself changes on every progress poll, and only this bit matters here.
  const runPaused = useMachineRunStore((s) => (target === null ? false : s.runs[machineKey(target)]?.paused === true));
  // #1123-42 — the same run entry's progress (the `P:` reading the watch folds in every poll). The
  // object is new per poll; this line is the one thing here that should follow it.
  const liveProgress = useMachineRunStore((s) => (target === null ? null : (s.runs[machineKey(target)]?.progress ?? null)));
  // #1145 — the time left is OUR clock's: the run watch's first `P:` stamp, never `P:` field 3.
  const runClock = useMachineRunStore((s) => (target === null ? null : (s.runs[machineKey(target)] ?? null)));
  const toolItems = useToolRegistryStore((s) => s.items);

  // #1202 field 5 — THE WALKS ARE ROUTINES. Their identity is the generator's step sequence (never
  // the posted bytes: every job's file differs in its geometry), checked against this machine's
  // completed set. ONE statement names the walks that are new and gates the single Start; a walk
  // already run here is listed without the mark.
  const machineRecord = useLocationStore((s) =>
    target === null
      ? null
      : s.location?.machines.find((m) => m.address?.host === target.host && m.address.port === target.port) ?? null,
  );
  const walkRoutines = (record === undefined ? [] : [record.walks.airwalk, record.walks.clean])
    .filter((walk): walk is ReleaseWalk => walk !== null)
    .map((walk) => {
      const identity = walkRoutineIdentity(walk.mode === 'airwalk' ? 'air-walk' : 'clean-walk', walk.steps);
      return { walk, identity, fresh: !routineCompleted(machineRecord, identity) };
    });
  const newWalkRoutines = walkRoutines.filter((w) => w.fresh);
  const newWalkShapes = newWalkRoutines.map((w) => `${w.identity.routine}:${w.identity.shape}`).join(',');
  const [walkTicked, setWalkTicked] = useState(false);
  // A fresh statement per routine set: the tick that satisfied the last plan is not this one's.
  useEffect(() => setWalkTicked(false), [newWalkShapes]);
  const walkHeadless = firstRunAutomationRefusal({ firstRun: newWalkRoutines.length > 0 });
  const walkNamesOf = (walks: typeof walkRoutines): string => {
    const names = walks.map((w) => (w.walk.mode === 'airwalk' ? 'the air walk' : 'the cleaning pass'));
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  };

  useEffect(() => {
    if (host !== undefined && port !== undefined && blocker === null) plan({ host, port }, job, programs);
  }, [host, port, job, programs, blocker, plan]);

  // #528 — the release notes no longer render in the rail; the dock's Transcript tab reads the
  // store. The text is the same join the old rail `<pre>` rendered, so the content is unchanged.
  const setReleaseTranscript = useMachineTranscriptStore((s) => s.setReleaseNotes);
  useEffect(() => {
    const notes = record?.notes ?? [];
    setReleaseTranscript(notes.length > 0 ? notes.join('\n') : null);
  }, [record?.notes, setReleaseTranscript]);

  if (target === null) {
    return (
      <p style={MUTED} data-testid="engrave-release-no-machine">
        The release step needs a machine: run the machine check in the welcome wizard first.
      </p>
    );
  }
  if (blocker !== null) {
    return (
      <p style={MUTED} data-testid="engrave-release-blocked">
        The release step is disabled — {withPeriod(blocker)}
      </p>
    );
  }
  if (record === undefined) {
    return <p style={MUTED}>Planning the release…</p>;
  }

  const pending = releasePending(record.files);
  const nextFile = releaseNext(record.files);
  const previousIndex = record.active ?? (record.next === null ? null : record.next - 1);
  const previous = previousIndex === null ? null : (record.files.find((f) => f.index === previousIndex) ?? null);
  const nextAtIndex = record.next === null ? null : (record.files.find((f) => f.index === record.next) ?? null);
  // #1146 — the cleaning pass and the air walk are files too: they go on the card with the
  // programs, and a Start waits for them exactly as it waits for the programs.
  const walkFiles = [record.walks.airwalk, record.walks.clean].filter((w): w is ReleaseWalk => w !== null);
  const bytes = [...record.files.map((f) => f.nc), ...walkFiles.map((w) => w.nc)].reduce(
    (n, nc) => n + programBytes(nc).length,
    0,
  );
  const plannedFiles = record.files.length + walkFiles.length;
  // #1146 — the walks' time: one cleaning pass per program, one air walk, from the files' own
  // cycle estimates (the seeded F1500 raster), stated separately on the plan line.
  const walkSeconds = cleanWalkPlanSeconds(record.files.length, record.walks, {
    airWalk: record.airWalk,
    cleanAfter: record.cleanAfter,
  });
  const uploading = record.phase === 'uploading';
  const walkIncomplete = (w: { upload: string }): boolean =>
    w.upload === 'pending' || w.upload === 'failed' || w.upload === 'sending';
  const uploadsIncomplete = record.files.some(walkIncomplete) || walkFiles.some(walkIncomplete);
  const uploadsReady =
    record.files.every((f) => f.done || f.upload === 'uploaded' || f.upload === 'present') &&
    walkFiles.every((w) => w.upload === 'uploaded' || w.upload === 'present');
  const uploadFailed = record.files.some((f) => f.upload === 'failed');
  // #1197 — THE UPLOAD'S ONE REPORT, from the FIRST failed file's own sentence: the upload is one
  // press, so its failure is one stop, not a row per file (#1187 rule 3 gates the action).
  const failedUpload = record.files.find((f) => f.upload === 'failed') ?? null;
  const uploadFailure =
    failedUpload?.uploadNote != null && stopIsReportable(failedUpload.uploadNote) ? failedUpload.uploadNote : null;
  const atMachine = record.atMachine;
  // #1123-42 — the running program's sentence and the next cutter change. Null at every phase but
  // a playing program: at the bit-change pause the ChangePanel already names the next cutter.
  const playing = record.phase === 'running' && record.active !== null;
  const liveWords = playing
    ? runningProgramWords({
        active: record.active as number,
        total: record.files.length,
        percent: liveProgress?.percent ?? null,
        // eslint-disable-next-line react-hooks/purity -- wall-clock arithmetic against the run's first-`P:` stamp; recomputed on every poll-driven render, never memoised
        elapsedS: runClock === null ? null : runClockSeconds(runClock, Date.now()),
        paused: runPaused,
      })
    : null;
  const change = playing ? nextBitChange(record.files, record.active) : null;
  const changeLabel = change?.kind === 'change' ? cutterIdentity(change.file.toolKey, toolItems) : null;
  // The tick gates EVERY start, resume and try-again alike: an operator at the machine is what
  // the confirmation means, and the run panel's own tick does not carry across to this step.
  const mayStart =
    (record.phase === 'ready' || record.phase === 'stopped' || record.phase === 'failed') &&
    atMachine &&
    uploadsReady &&
    !record.spanClosing &&
    facingGate === null &&
    hiddenRetouch === null &&
    // #1202 field 5 — a walk that is new on this machine needs the operator's own statement, and
    // an automated instance may not start it at all.
    (newWalkRoutines.length === 0 || walkTicked) &&
    walkHeadless === null;
  const finished = record.files.filter((f) => f.done).length;
  const showUpload = (record.phase === 'idle' || record.phase === 'stopped' || record.phase === 'failed') && uploadsIncomplete;

  return (
    <div data-testid="engrave-release" data-phase={record.phase}>
      <p style={{ fontSize: 12, color: '#e6edf5', margin: '4px 0' }}>
        <strong>Release step</strong> — {record.files.length} program{record.files.length === 1 ? '' : 's'}, played in
        cut order on {target.host}:{target.port}.
      </p>
      <p style={MUTED} data-testid="engrave-release-vacuum">
        The vacuum goes on with the job’s first program and stays on across every bit change; only the job’s last
        program turns it off. A Stop between programs sends M332 and homes.
      </p>
      {/* #1060 — THE SPINDLE BLOWER'S OWN SWITCH. It follows the vacuum (M331.1 on with it, M332.1
          off before it) unless this job turns it off; the shop's run.blowWithVacuum is the default. */}
      {(() => {
        const blowOn = job.blowWithVacuum ?? readFlag(useShopDefaultsStore.getState().defaults, 'run.blowWithVacuum').value;
        return (
          <p style={MUTED} data-testid="engrave-release-blow">
            Air blow with the vacuum: <strong>{blowOn ? 'on' : 'off'}</strong>{' '}
            <button
              type="button"
              data-testid="engrave-release-blow-toggle"
              onClick={() => useEngraveJobStore.getState().setBlowWithVacuum(!blowOn)}
            >
              {blowOn ? 'Turn it off' : 'Turn it on'}
            </button>
          </p>
        );
      })()}
      {job.facing?.enabled === true && (
        <p style={{ ...MUTED, color: '#f0b8a8' }} data-testid="engrave-release-facing-blocker">
          The release is blocked — {hiddenRetouch}.
        </p>
      )}

      {facingGate !== null && (
        <p style={{ ...MUTED, color: '#f0b8a8' }} data-testid="engrave-release-registration-blocker">
          The release is blocked — {facingGate}.
        </p>
      )}

      <details data-testid="engrave-release-plan">
        {/* #1146 — THE WALKS' SHARE OF THE TIME. The cleaning pass follows every program and the air
            walk opens the run, so the plan's figure is the machine time the operator is committing
            to; the walks are stated as their own term so the line says where it came from. */}
        <summary style={MUTED} data-walk-seconds={walkSeconds > 0 ? Math.round(walkSeconds) : undefined}>
          The plan ({Math.round((runPlan.totalSeconds + walkSeconds) / 60)} min, lower bound where unstated
          {walkSeconds > 0 ? `; cleaning and air walk: ${cleanWalkPlanWords(walkSeconds)}` : ''})
        </summary>
        <ol style={{ ...MUTED, paddingLeft: 18 }}>
          {runPlan.phases.map((p) => (
            <li key={p.id}>
              {p.title} — {p.who === 'machine' ? 'machine' : 'you'}
              {p.seconds === null ? '' : `, ${Math.round(p.seconds)} s`}
            </li>
          ))}
        </ol>
      </details>

      <ul style={{ ...MUTED, paddingLeft: 18 }} data-testid="engrave-release-files">
        {record.files.map((f) => (
          <FileRow key={f.index} file={f} />
        ))}
      </ul>
      {/* #1202 field 5 — the walks' own files, as routines: name, line count and the full posted
          text. "New on this machine" is what the Start's one statement answers; a walk already
          completed is listed without the mark. */}
      {walkRoutines.length > 0 && (
        <div data-testid="engrave-release-walks">
          {walkRoutines.map(({ walk, identity, fresh }) => (
            <details
              key={walk.mode}
              data-testid={`engrave-release-walk-${walk.mode}`}
              data-shape={identity.shape}
              data-first-run={fresh ? 'true' : undefined}
              style={{ ...MUTED, marginTop: 4 }}
            >
              <summary>
                {walk.mode === 'airwalk' ? 'The air walk' : 'The cleaning pass'} — {walk.filename} (
                {walk.nc.split('\n').length} lines){fresh ? ' — new on this machine' : ''}
              </summary>
              <pre
                data-testid={`engrave-release-walk-${walk.mode}-text`}
                style={{ ...MUTED, whiteSpace: 'pre-wrap', margin: '4px 0 0', maxHeight: 220, overflow: 'auto' }}
              >
                {walk.nc}
              </pre>
            </details>
          ))}
        </div>
      )}
      {/* #1197 — the failed upload's report: the console's sentence, the release's notes, and the
          record's job facts. One action, under the list it belongs to. #1208 — THE NOTES ARE THE
          APP'S OWN SENTENCES, not a machine conversation: they go out as the line the app said,
          with no reply, so the report never presents them as something the machine answered. */}
      {uploadFailure !== null && failedUpload !== null && (
        <StopReportAction
          action="upload"
          target={target}
          error={uploadFailure}
          transcript={record.notes.map((s) => ({ line: s, reply: '' }))}
          job={{ id: record.jobId, name: record.jobName, packageHash: record.job.package?.hash ?? null }}
        />
      )}
      <p style={MUTED} data-testid="engrave-release-progress">
        {finished} of {record.files.length} finished on this machine.
        {nextFile === null ? ' Nothing is left to play.' : ` Next: program ${nextFile.index} (${nextFile.filename}).`}
      </p>

      {showUpload && (
        <>
          <button
            type="button"
            data-testid="engrave-release-upload"
            disabled={uploading}
            style={{ width: '100%', padding: 7, marginTop: 6 }}
            onClick={() => {
              setStage('confirm');
            }}
          >
            {uploadFailed
              ? 'Upload the files again…'
              : walkFiles.length === 0
                ? `Upload all ${record.files.length} programs…`
                : `Upload all ${plannedFiles} files…`}
          </button>
          {stage === 'confirm' && (
            <div style={BOX} data-testid="engrave-release-upload-confirm">
              <p style={{ fontSize: 11, color: '#c8d3de', lineHeight: 1.5, margin: '0 0 6px' }}>
                Send {plannedFiles} file{plannedFiles === 1 ? '' : 's'} ({bytes} bytes) to{' '}
                <strong>{target.host}:{target.port}</strong>?
              </p>
              <p style={MUTED}>This writes every program and walk file to the machine. It does not start the job.</p>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  data-testid="engrave-release-upload-confirm-send"
                  style={{ flex: 1, padding: 7 }}
                  onClick={() => {
                    setStage('idle');
                    void uploadAll(target);
                  }}
                >
                  Send them
                </button>
                <button
                  type="button"
                  data-testid="engrave-release-upload-confirm-cancel"
                  style={{ flex: 1, padding: 7 }}
                  onClick={() => setStage('idle')}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {uploading && (
        <p style={MUTED} data-testid="engrave-release-uploading">
          Uploading program {record.uploading ?? '…'} of {record.files.length}…
        </p>
      )}

      {record.phase !== 'idle' && record.phase !== 'uploading' && !uploadFailed && (
        <>
          {(record.phase === 'ready' || record.phase === 'stopped' || record.phase === 'failed' || record.phase === 'closing') &&
            (uploadsReady ? (
              <>
                <label style={MUTED}>
                  <input
                    type="checkbox"
                    checked={atMachine}
                    data-testid="engrave-release-at-machine"
                    onChange={(e) => setAtMachine(target, e.target.checked)}
                  />{' '}
                  I am at the machine, with the head clear and the stock clamped — asked for each program, and
                  again after a stop.
                </label>
                {/* #1202 field 5 — ONE statement for the walks this machine has never run: it names
                    each of them and gates the single Start (the walks are part of this press). */}
                {newWalkRoutines.length > 0 && (
                  <p style={{ ...MUTED, color: WARN }} data-testid="engrave-release-first-run">
                    First run on this machine: {walkNamesOf(newWalkRoutines)} — stay at the Stop.
                  </p>
                )}
                {newWalkRoutines.length > 0 && (
                  <label style={MUTED} data-testid="engrave-release-first-run-statement">
                    <input
                      type="checkbox"
                      checked={walkTicked}
                      data-testid="engrave-release-first-run-tick"
                      onChange={(e) => setWalkTicked(e.target.checked)}
                    />{' '}
                    I am at the machine —{' '}
                    {newWalkRoutines.length === 1 ? 'the walk’s path is clear' : 'the walks’ paths are clear'}, and I
                    will stay at the Stop.
                  </label>
                )}
                {walkHeadless !== null && (
                  <p style={{ ...MUTED, color: BAD }} data-testid="engrave-release-first-run-headless">
                    {walkHeadless}
                  </p>
                )}
                <button
                  type="button"
                  data-testid="engrave-release-start"
                  disabled={!mayStart}
                  style={{ width: '100%', padding: 7, marginTop: 6 }}
                  onClick={() => startRelease(target)}
                >
                  {record.phase === 'closing'
                    ? 'Stopping — switching the vacuum off before anything else can start…'
                    : record.phase === 'stopped'
                      ? nextFile === null
                        ? 'Nothing left to run'
                        : `Resume — program ${nextFile.index} of ${record.files.length}`
                      : record.phase === 'failed'
                        ? nextFile === null
                          ? 'Nothing left to run'
                          : `Try again — program ${nextFile.index} of ${record.files.length}`
                        : // #1123 item 39 — a release with finished programs (a reload, or a
                          // resumed session) continues at the next one, named; never a blanket
                          // "run the job" that hides which program comes next.
                          finished > 0 && nextFile !== null
                          ? `Run program ${nextFile.index} of ${record.files.length}`
                          : `Run the job — ${record.files.length} programs`}
                </button>
              </>
            ) : (
              <p style={MUTED} data-testid="engrave-release-upload-first">
                Upload the programs before running: a program that is not on the card cannot be played.
              </p>
            ))}

          {record.phase === 'running' && target !== null && (
            <>
              {/* #1123-42 — THE RUNNING PROGRAM, ON THE CUT STEP. The percent and clock are the
                  controller's `P:` reading (the run watch's own poll); the next bit change is the
                  release list's cut order. Nothing here estimates anything the machine did not. */}
              {liveWords !== null && (
                <p
                  data-testid="engrave-release-live-progress"
                  data-percent={liveProgress?.percent ?? undefined}
                  style={{ fontSize: 12, color: '#e6edf5', lineHeight: 1.5, margin: '6px 0 0' }}
                >
                  {liveWords}
                </p>
              )}
              {change !== null && (
                <p style={MUTED} data-testid="engrave-release-next-change">
                  {change.kind === 'last' || changeLabel === null
                    ? 'No further bit change — this is the job’s last cutter.'
                    : `Next bit change: program ${change.file.index} of ${record.files.length} — ${changeLabel.name} (${changeLabel.code}).`}
                </p>
              )}
              {/* #618 — Pause beside Stop while a program runs; the same button resumes it. The
                  suspend/resume words are `platform/machinePause.ts`'s one function, sent by the
                  run's watch at its next poll boundary. */}
              <button
                type="button"
                data-testid="engrave-release-pause"
                disabled={record.stopAsked}
                style={{ width: '100%', padding: 7, marginTop: 6 }}
                onClick={() => {
                  if (runPaused) useMachineRunStore.getState().requestResume(machineKey(target));
                  else useMachineRunStore.getState().requestPause(machineKey(target));
                }}
              >
                {runPaused ? 'Resume program' : 'Pause program — suspend goes out at the next status poll'}
              </button>
              <button
                type="button"
                data-testid="engrave-release-stop"
                disabled={record.stopAsked}
                style={{ width: '100%', padding: 7, marginTop: 6 }}
                onClick={() => stop(target)}
              >
                {record.stopAsked ? 'Stopping…' : 'Stop program — the machine’s red button is the emergency stop'}
              </button>
            </>
          )}

          {/* #1146 — a walk is playing: motion at the sweep height, nothing cutting. Stop is the
              same red-button route as a program's; nothing moves after it. */}
          {(record.phase === 'airwalk' || record.phase === 'cleaning') && (
            <div data-testid="engrave-release-walk" data-walk={record.walk?.mode ?? ''}>
              <p style={{ fontSize: 12, color: '#e6edf5', lineHeight: 1.5, margin: '6px 0 0' }}>
                {record.phase === 'airwalk'
                  ? 'The air walk is tracing the stock outline at the sweep height — nothing is cutting.'
                  : 'The cleaning pass is sweeping the stock at the sweep height — nothing is cutting.'}
              </p>
              <button
                type="button"
                data-testid="engrave-release-stop"
                disabled={record.stopAsked}
                style={{ width: '100%', padding: 7, marginTop: 6 }}
                onClick={() => stop(target)}
              >
                {record.stopAsked ? 'Stopping…' : `Stop the ${record.phase === 'airwalk' ? 'air walk' : 'cleaning pass'}`}
              </button>
            </div>
          )}

          {record.phase === 'bit-change' && previous !== null && nextAtIndex !== null && (
            <>
              <ChangePanel
                previous={previous}
                next={nextAtIndex}
                flipped={
                  nextAtIndex.setupIndex !== previous.setupIndex &&
                  record.job.setups?.[nextAtIndex.setupIndex - 1]?.flip !== undefined
                }
                ok={changeOk}
                setOk={(v) => setChangeOkFor(v ? nextAtIndex.index : null)}
                atMachine={atMachine}
                setAtMachine={(v) => setAtMachine(target, v)}
                onConfirm={() => confirmChange(target)}
              />
              <button
                type="button"
                data-testid="engrave-release-stop"
                style={{ width: '100%', padding: 7, marginTop: 6 }}
                onClick={() => stop(target)}
              >
                Stop here — the vacuum goes off and the machine homes
              </button>
            </>
          )}

          {record.phase === 'retouch' && (
            <div style={BOX} data-testid="engrave-release-retouch">
              <p style={{ fontSize: 12, color: '#e6edf5', margin: '0 0 6px' }}>
                The faced top is being re-touched and Z0 written for the engraving cutter. No program
                has started; it starts only after this succeeds.
              </p>
              {record.operatorStep !== null ? (
                <>
                  <p style={MUTED} data-testid="engrave-release-operator-text">
                    {record.operatorStep.text}
                  </p>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      data-testid="engrave-release-operator-continue"
                      style={{ flex: 1, padding: 7 }}
                      onClick={() => answerOperator(target, true)}
                    >
                      Continue
                    </button>
                    <button
                      type="button"
                      data-testid="engrave-release-operator-stop"
                      style={{ flex: 1, padding: 7 }}
                      onClick={() => answerOperator(target, false)}
                    >
                      Stop
                    </button>
                  </div>
                </>
              ) : (
                <p style={MUTED}>Waiting for the machine…</p>
              )}
            </div>
          )}

          {record.phase === 'done' && (
            <p style={{ ...MUTED, color: OK }} data-testid="engrave-release-done">
              Every program in the job is finished. The last program’s end-of-run lines and offcut question are below.
            </p>
          )}

          {/* #1146 — AFTER A STOP NOTHING MOVES ON ITS OWN. Once the operator has the machine
              Idle and homed, this runs the cleaning pass as its own file; the run refuses a
              machine that is not Idle, and the release stays in the phase it was in. */}
          {(record.phase === 'stopped' || record.phase === 'failed' || record.phase === 'done') &&
            record.walks.clean !== null && (
              <div data-testid="engrave-release-clean-now-box">
                <p style={{ ...MUTED, marginTop: 6 }}>
                  Nothing moves on its own after a stop. Once the machine reads Idle and is homed (Home above, if the
                  stop left it unhomed), Clean now sweeps the stock once more.
                </p>
                <button
                  type="button"
                  data-testid="engrave-release-clean-now"
                  style={{ width: '100%', padding: 7, marginTop: 6 }}
                  onClick={() => cleanNow(target)}
                >
                  Clean now — sweep the stock once more
                </button>
              </div>
            )}
        </>
      )}

      <EngraveMachineRun target={target} controlled onProgramLine={onProgramLine} />
      {pending.length === 0 && record.phase !== 'done' && record.phase !== 'idle' && (
        <p style={{ ...MUTED, color: OK }}>Nothing is left to play on this machine.</p>
      )}
    </div>
  );
}
