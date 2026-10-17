/**
 * #469 / #419 §3 — THE RELEASE STEP, from the Cut screen: upload the whole list, play it in order,
 * stop at the bit change, and say what the vacuum is doing across it.
 *
 * The store is `store/engraveReleaseStore.ts`. This component draws its state and makes the physical
 * confirmations the step cannot: the once-per-run "I am at the machine", and the bit-change
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
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { StockFlatness } from '@/platform/stockClient';
import { programBytes } from '@/platform/machineUpload';
import { getTools } from '@/engine/cnc/toolRegistry';
import { jobMachine } from '@/engine/cnc/calibration';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { releaseNext, releasePending } from '@/engine/cnc/engrave/release';
import { planRun } from '@/engine/cnc/plan/phases';
import { finishedProgramsFor } from '@/store/locationStore';
import { useEngraveReleaseStore, type ReleaseFile } from '@/store/engraveReleaseStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { EngraveMachineRun } from './EngraveMachineRun';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const MONO: CSSProperties = { fontSize: 10, fontFamily: 'monospace', maxHeight: 160, overflow: 'auto', margin: '4px 0', color: '#c8d3de' };
const BOX: CSSProperties = { marginTop: 6, padding: 8, border: '1px solid #3a4552', borderRadius: 4, background: '#1b2027' };
const OK = '#9fd19b';

export interface EngraveReleaseStepProps {
  /** Where the machine was last reached, or null. The step cannot do anything without one. */
  target: { host: string; port: number } | null;
  job: EngraveJob;
  generated: EngraveGenerated;
  /** `releaseBlocker(run)` — required, so the panel's gate and this component cannot disagree. */
  blocker: string | null;
  /** Told the source line the machine reports while a program runs (`EngraveMachineRun`). */
  onProgramLine?: (line: number | null) => void;
}

function labelOf(toolKey: string): { name: string; note: string } {
  const entry = getTools().find((e) => e.key === toolKey);
  if (entry === undefined) {
    return { name: toolKey, note: 'the registry has no row for this key — fit the cutter the program was posted for' };
  }
  const t = entry.tool;
  const dia = t.tipDiameter ?? t.diameter;
  return {
    name: t.name,
    note: `${toolKey}${dia === null ? '' : `, ⌀ ${Math.round(dia * 1000) / 1000} mm`} — ${entry.provenance}`,
  };
}

function FileRow({ file }: { file: ReleaseFile }): JSX.Element {
  const label = labelOf(file.toolKey);
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
      Program {file.index} of {file.total} · Setup {file.setupIndex} · <strong>{label.name}</strong> ({file.toolKey})
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
  ok,
  setOk,
  onConfirm,
}: {
  previous: ReleaseFile;
  next: ReleaseFile;
  ok: boolean;
  setOk: (v: boolean) => void;
  onConfirm: () => void;
}): JSX.Element {
  const label = labelOf(next.toolKey);
  return (
    <div style={BOX} data-testid="engrave-release-change">
      <p style={{ fontSize: 12, color: '#e6edf5', margin: '0 0 6px' }}>
        Program {previous.index} of {previous.total} finished; the machine homed and the vacuum is still on.
        Change the cutter for program {next.index} of {next.total}: <strong>{label.name}</strong> ({label.note}).
      </p>
      <ol style={{ ...MUTED, paddingLeft: 18 }}>
        <li>
          Fit the cutter and keep the X and Y origin where it is — <strong>the SAME corner</strong>, the same
          edge. Nothing moves but the Z reference.
        </li>
        <li>
          Calibrate the new cutter’s length the same way as the first (<code>M491</code>) and record its PRB.
          This is a reading of THIS cutter alone.
        </li>
        <li>
          Set Z0 for program {next.index} from those two readings, NOT by touching the surface again:{' '}
          <code>Z0 = surface + (cutter PRB − reference PRB)</code>. The surface has been cut since the origin
          was set, so re-touching it would sink this program’s floors by the last program’s depth.
        </li>
      </ol>
      <label style={MUTED}>
        <input
          type="checkbox"
          checked={ok}
          data-testid="engrave-release-change-ok"
          onChange={(e) => setOk(e.target.checked)}
        />{' '}
        The cutter is changed, calibrated (M491), and Z0 is set from the two readings.
      </label>
      <button
        type="button"
        data-testid="engrave-release-change-done"
        disabled={!ok}
        style={{ width: '100%', padding: 7, marginTop: 6 }}
        onClick={onConfirm}
      >
        Run program {next.index} of {next.total}
      </button>
    </div>
  );
}

export function EngraveReleaseStep({
  target,
  job,
  generated,
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
  const stop = useEngraveReleaseStore((s) => s.stop);
  const setAtMachine = useEngraveReleaseStore((s) => s.setAtMachine);
  const [stage, setStage] = useState<'idle' | 'confirm'>('idle');
  /**
   * The bit-change tick belongs to the program it was made for (`next`): when the release moves on,
   * the panel asks again without an effect resetting state on a prop change.
   */
  const [changeOkFor, setChangeOkFor] = useState<number | null>(null);
  const next = record?.next ?? null;
  const changeOk = changeOkFor !== null && changeOkFor === next;

  useEffect(() => {
    if (host !== undefined && port !== undefined && blocker === null) plan({ host, port }, job, generated);
  }, [host, port, job, generated, blocker, plan]);

  const planView = (() => {
    if (host === undefined || port === undefined) return null;
    const flatness: StockFlatness =
      job.stock.flatness === undefined ? 'unknown' : job.stock.flatness.dome > 0 ? 'domed' : 'flat';
    return planRun({
      setups: jobSetups(job).map((_, i) => ({ index: i + 1, mountStep: i > 0, faced: false, registration: null })),
      programs: generated.programs.map((p, i) => ({
        id: `p${i + 1}`,
        setupIndex: p.setupIndex,
        label: labelOf(p.toolKey).name,
        hash: p.programHash,
      })),
      machine: jobMachine(job),
      mount: job.workholding.kind,
      stock: { flatness },
      shallowestCutMm: null,
      finishedHashes: finishedProgramsFor({ host, port }),
      defaults: useShopDefaultsStore.getState().defaults,
    });
  })();

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
        The release step is disabled — {blocker}.
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
  const bytes = record.files.reduce((n, f) => n + programBytes(f.nc).length, 0);
  const uploading = record.phase === 'uploading';
  const uploadsIncomplete = record.files.some((f) => f.upload === 'pending' || f.upload === 'failed' || f.upload === 'sending');
  const uploadsReady = record.files.every((f) => f.done || f.upload === 'uploaded' || f.upload === 'present');
  const uploadFailed = record.files.some((f) => f.upload === 'failed');
  const atMachine = record.atMachine;
  const mayStart = record.phase === 'ready' && atMachine && uploadsReady;
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
      {generated.facingNc !== null && (
        <p style={{ ...MUTED, color: '#f0d79b' }} data-testid="engrave-release-facing-note">
          This job’s face program is not in the release step’s list. Run it from the run sheet first: the engraving
          files below assume the faced surface, and the face file is what switches the vacuum on.
        </p>
      )}

      {planView !== null && (
        <details data-testid="engrave-release-plan">
          <summary style={MUTED}>The plan ({Math.round(planView.totalSeconds / 60)} min, lower bound where unstated)</summary>
          <ol style={{ ...MUTED, paddingLeft: 18 }}>
            {planView.phases.map((p) => (
              <li key={p.id}>
                {p.title} — {p.who === 'machine' ? 'machine' : 'you'}
                {p.seconds === null ? '' : `, ${Math.round(p.seconds)} s`}
              </li>
            ))}
          </ol>
        </details>
      )}

      <ul style={{ ...MUTED, paddingLeft: 18 }} data-testid="engrave-release-files">
        {record.files.map((f) => (
          <FileRow key={f.index} file={f} />
        ))}
      </ul>
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
            {uploadFailed ? 'Upload the programs again…' : `Upload all ${record.files.length} programs…`}
          </button>
          {stage === 'confirm' && (
            <div style={BOX} data-testid="engrave-release-upload-confirm">
              <p style={{ fontSize: 11, color: '#c8d3de', lineHeight: 1.5, margin: '0 0 6px' }}>
                Send {record.files.length} file{record.files.length === 1 ? '' : 's'} ({bytes} bytes) to{' '}
                <strong>{target.host}:{target.port}</strong>?
              </p>
              <p style={MUTED}>This writes every program to the machine. It does not start the job.</p>
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
          {(record.phase === 'ready' || record.phase === 'stopped' || record.phase === 'failed') &&
            (uploadsReady ? (
              <>
                <label style={MUTED}>
                  <input
                    type="checkbox"
                    checked={atMachine}
                    data-testid="engrave-release-at-machine"
                    onChange={(e) => setAtMachine(target, e.target.checked)}
                  />{' '}
                  I am at the machine, with the head clear and the stock clamped — asked once for the whole release.
                </label>
                <button
                  type="button"
                  data-testid="engrave-release-start"
                  disabled={!mayStart && record.phase === 'ready'}
                  style={{ width: '100%', padding: 7, marginTop: 6 }}
                  onClick={() => startRelease(target)}
                >
                  {record.phase === 'stopped'
                    ? nextFile === null
                      ? 'Nothing left to run'
                      : `Resume — program ${nextFile.index} of ${record.files.length}`
                    : record.phase === 'failed'
                      ? nextFile === null
                        ? 'Nothing left to run'
                        : `Try again — program ${nextFile.index} of ${record.files.length}`
                      : `Run the job — ${record.files.length} programs`}
                </button>
              </>
            ) : (
              <p style={MUTED} data-testid="engrave-release-upload-first">
                Upload the programs before running: a program that is not on the card cannot be played.
              </p>
            ))}

          {record.phase === 'running' && (
            <button
              type="button"
              data-testid="engrave-release-stop"
              disabled={record.stopAsked}
              style={{ width: '100%', padding: 7, marginTop: 6 }}
              onClick={() => stop(target)}
            >
              {record.stopAsked ? 'Stopping…' : 'Stop program — the machine’s red button is the emergency stop'}
            </button>
          )}

          {record.phase === 'bit-change' && previous !== null && nextAtIndex !== null && (
            <>
              <ChangePanel
                previous={previous}
                next={nextAtIndex}
                ok={changeOk}
                setOk={(v) => setChangeOkFor(v ? nextAtIndex.index : null)}
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

          {record.phase === 'done' && (
            <p style={{ ...MUTED, color: OK }} data-testid="engrave-release-done">
              Every program in the job is finished. The last program’s end-of-run lines and offcut question are below.
            </p>
          )}
        </>
      )}

      {record.notes.length > 0 && (
        <pre style={MONO} data-testid="engrave-release-notes">
          {record.notes.join('\n')}
        </pre>
      )}

      <EngraveMachineRun target={target} controlled onProgramLine={onProgramLine} />
      {pending.length === 0 && record.phase !== 'done' && record.phase !== 'idle' && (
        <p style={{ ...MUTED, color: OK }}>Nothing is left to play on this machine.</p>
      )}
    </div>
  );
}
