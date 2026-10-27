import { useRef, useState, type CSSProperties, type JSX } from 'react';
import type { MachineObservation } from '@/platform/machineProbe';
import { programBytes, uploadProgram, type MachineUploadResult } from '@/platform/machineUpload';
import type { ProgramCheck } from '@/engine/cnc/uploadGate';
import { describeUpload } from './engraveUploadCopy';
import { EngraveLaserFrame } from './EngraveLaserFrame';
import { EngraveLaserPoint } from './EngraveLaserPoint';
import { useShopDefault } from '@/store/shopDefaultsStore';
import { EngraveMachineRun } from './EngraveMachineRun';
import { machineKey, useMachineRunStore, type RunContext } from '@/store/machineRunStore';
import { programHash, programOwnsVacuum } from '@/platform/machineRun';
import { frameBounds, type LaserLift } from '@/platform/machineLaser';
import { useSettingsStore } from '@/store/settingsStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import { cutterIdentity } from '@/engine/cnc/engrave/cutterCaseLine';
import { withPeriod } from '@/store/engraveRunGate';

/**
 * #255 — send the verified program to the machine, from beside Save in the engrave panel.
 *
 * IT NEEDS A MACHINE, NOT A BUILD TARGET. The panel mounts this only when a machine is connected
 * (#656 review: the bench drives through `/api/v1/machine/*` from a plain browser, and the public
 * web target — where no probe can reach a machine — never has one), so there is never an upload
 * control that exists to explain why it cannot work.
 *
 * TWO PRESSES, ALWAYS. Uploading is the only action in this app that WRITES to the machine
 * (`/Fabrication.md` §8: nothing is sent without an explicit go-ahead), so the first press opens a
 * confirmation naming the machine, its address, the file and its exact size, and only the second
 * press sends it. There is deliberately no "don't ask again": the target is whatever the machine
 * check last reached, and the confirmation is the one moment where a stale or wrong target is
 * visible before anything is written.
 *
 * THE PROGRAM IS ALREADY TRUSTED BY THE TIME THIS RENDERS. The button is gated on the run's own
 * blocker (`uploadBlocker`, which is never weaker than Save's), and `uploadProgram` asks the
 * verified-only predicate again before it loads the bridge. Nothing here re-derives safety from the
 * shape of the report — it reports what the gate already decided.
 *
 * UPLOAD DOES NOT START THE JOB. The bridge writes a file to the machine's card and reports the
 * controller's answer. Once it has gone through, `EngraveMachineRun` offers "Run it" (#423) — a
 * separate press, with its own once-per-job "I am at the machine".
 */

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const OK_COLOR = '#9fd19b';
const BAD_COLOR = '#f0b4ad';
const CONFIRM: CSSProperties = {
  marginTop: 6,
  padding: 8,
  border: '1px solid #3a4552',
  borderRadius: 4,
  background: '#1b2027',
};
const CONFIRM_TEXT: CSSProperties = { fontSize: 11, color: '#c8d3de', lineHeight: 1.5, margin: '0 0 6px' };

export interface EngraveMachineUploadProps {
  /**
   * Why uploading is disabled, or null when it is allowed — `uploadBlocker(run)` from the panel.
   * Passed in rather than derived here so the panel's Save and Upload cannot state two different
   * rules about the same run.
   */
  blocker: string | null;
  /** The machine the last check reached, or null when none has been. */
  machine: MachineObservation | null;
  /** The program to send: the text and the check that gated it, or null if there is none. */
  program: { nc: string; check: ProgramCheck } | null;
  /** The name the machine will receive — `runSheetFileName(job.name)`, so it matches the run sheet. */
  filename: string;
  /**
   * The job's machine travel height with the bounds that make it safe, MACHINE Z — the resolved
   * machine's `toolChange.clearanceZ` and `softEndstop.zMin` (`jobMachine(job)`), handed to the two
   * laser motions (#431) — the frame's traverse and point-to-origin's lift — so their lift is the
   * machine's own clearance, guarded against a bad calibration before anything is sent (#448).
   *
   * REQUIRED, not defaulted: this is a motion height on a safety-relevant path, and a forgotten one
   * must be a typecheck error rather than a silent −3 the head is driven to.
   */
  lift: LaserLift;
  /**
   * Told what the machine said when the upload asked it live and it was not idle (#296), so the
   * stored observation stops claiming otherwise. Optional: a test, or a host with no store, may omit it.
   */
  onLiveStatus?: (live: { busy: boolean; status: string }) => void;
  /**
   * What the run's end needs to know about the job (#414): its id, the shelf entry it reserved, the
   * stock as cut, the cutter. Optional — the job flow (#419) will supply it; without it the run still
   * counts the cutter's runtime from the program, and leaves the shelf alone with a note.
   */
  runContext?: Omit<RunContext, 'nc'>;
  /**
   * #425 §6 — the setup the one frozen program cuts, named as the document names it. The run end
   * records the outcome against it so a reopened job resumes here. Optional: an upload outside the
   * frozen flow has no document fact to add.
   */
  setup?: { setupIndex: number; setupId: string };
  /**
   * The job's own edge margin, mm (#431: laser point-to-origin is refused when it is tighter than the
   * dot). Optional: without it the house's margin setting is used, and the panel says so.
   */
  jobEdgeMarginMm?: number;
  /**
   * Told the source line the machine reports as it runs (#442's #423 item), so the panel drawing the
   * job can follow `P`. Forwarded to `EngraveMachineRun`, which calls it only when the line changes.
   */
  onProgramLine?: (line: number | null) => void;
}

/** ISO → something a person reads, or the raw string when it will not parse. Never "Invalid Date". */
function reachedWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Whether a result reads as a failure the operator should act on. */
function isFailure(result: MachineUploadResult): boolean {
  return result.kind !== 'uploaded';
}

export function EngraveMachineUpload({
  blocker,
  machine,
  program,
  filename,
  lift,
  onLiveStatus,
  runContext,
  setup,
  jobEdgeMarginMm,
  onProgramLine,
}: EngraveMachineUploadProps): JSX.Element {
  const [stage, setStage] = useState<'idle' | 'confirm' | 'sending'>('idle');
  const [result, setResult] = useState<MachineUploadResult | null>(null);
  // #516 — "which cutter is fitted?" is a run-time confirmation, not a setup question: the upload
  // names the cutter this file was posted for, and the operator confirms that cutter is the one in
  // the spindle before the file is sent.
  const [fitted, setFitted] = useState(false);
  // #423 review: while a program runs on this machine, nothing is uploaded to it — and the run panel
  // under this one (which holds Stop) cannot be swapped out from under the operator.
  const runningHere = useMachineRunStore((s) => (machine === null ? false : s.runs[machineKey(machine)]?.running === true));
  const prepareRun = useMachineRunStore((s) => s.prepare);

  const label = machine === null ? 'the machine' : (machine.name ?? machine.host);
  // #431 — the laser frame is a user option, off by default (decision Q21).
  const laserFrameOn = useSettingsStore((s) => s.laserOptions.frame);
  const laserPointOn = useSettingsStore((s) => s.laserOptions.pointToOrigin);
  const houseEdgeMargin = useSettingsStore((s) => s.margins.edgeMargin);
  const laserUncertainty = useShopDefault('laser.originUncertaintyMm');
  // #491 — the cutter this file was posted for, named the way the bench names it: case colour,
  // full label name, box code. `runContext.toolKey` is the same key the run store records.
  const items = useToolRegistryStore((s) => s.items);
  const cutter =
    runContext?.toolKey === undefined ? null : cutterIdentity(runContext.toolKey, items);
  // #537 — the cutter-mismatch SELECTOR. It asks which CUTTER is fitted, in the tool library's
  // `key` space (the same space `job.toolKey` holds), defaulting to the program's recommendation.
  // A different key than `runContext.toolKey` is a mismatch: refused with the #516 item 3 finding,
  // and Send stays disabled. The inventory's codes/case colours still feed the label through
  // `cutterIdentity` above; this value space is the library, not the inventory's `id` space.
  const tools = useToolRegistry();
  const recommendedToolKey = runContext?.toolKey ?? null;
  const [selectedToolKey, setSelectedToolKey] = useState<string | null>(null);
  // The recommended cutter is normally a library entry; a job written for a key whose registry row
  // is absent (not loaded yet) still gets an option so the select always names the default.
  const hasRecommended = recommendedToolKey !== null && tools.some((e) => e.key === recommendedToolKey);
  const mismatch = cutter !== null && selectedToolKey !== null && selectedToolKey !== recommendedToolKey;
  // #516 item 3's fix, for the RECOMMENDED cutter: `fit <colour> — <label>`.
  const mismatchSentence =
    cutter === null
      ? null
      : `fit ${cutter.casePhrase === null ? '' : `${cutter.casePhrase} — `}${cutter.name}`;
  // #538 — `fitted` confirms a SPECIFIC cutter. If the file is (re)posted for a different cutter
  // while the confirmation is open, a checkbox ticked for the previous one must not carry over —
  // and neither must a picked selector answer. Adjusted during render (guarded, so it settles in
  // one extra pass), like the blocked-guard below.
  const fittedCutterKey = runContext?.toolKey ?? null;
  const fittedCutterKeyRef = useRef<string | null>(null);
  if (fittedCutterKeyRef.current !== fittedCutterKey) {
    fittedCutterKeyRef.current = fittedCutterKey;
    if (fitted) setFitted(false);
    if (selectedToolKey !== null) setSelectedToolKey(null);
  }

  // Order matters, and matches `uploadBlocker`'s own reasoning: the run's trust first, then whether
  // there is anywhere to send it. Whether the machine is busy is NOT a clause here (#296): the wizard's
  // `busy` is a memory, and a memory that blocks the button could never be cleared by the very check
  // that now asks the machine. The upload asks it live; this panel only shows what it last heard.
  const blocked =
    (runningHere ? 'a program is running on this machine — stop it or let it finish first' : null) ??
    blocker ??
    (machine === null
      ? 'no machine has been reached'
      : program === null
        ? 'no program has been generated'
        : null);

  // A confirmation belongs to the gate that opened it (#295): once the run is blocked it is closed
  // for good, so a later un-blocking cannot bring back a box nobody pressed. Adjusted during render
  // (guarded, so it settles in one extra pass) rather than in an effect, which would paint the stale
  // box for a frame first.
  if (blocked !== null && stage === 'confirm') setStage('idle');

  const bytes = program === null ? 0 : programBytes(program.nc).length;

  async function send(): Promise<void> {
    // The gate is asked AGAIN at the second press (#295). The first press opened this confirmation
    // under a `blocked` that was null then; the job can go stale, or an acknowledgement be
    // unticked, while the box is open, and the one button that writes to the machine must not be the
    // one that remembers an older answer.
    if (blocked !== null || machine === null || program === null) {
      setFitted(false);
      setSelectedToolKey(null);
      setStage('idle');
      return;
    }
    setStage('sending');
    // `uploadProgram` does not throw; the await is only for the result.
    const outcome = await uploadProgram(
      { host: machine.host, port: machine.port },
      { filename, nc: program.nc, check: program.check },
    );
    // What the machine said NOW replaces what the wizard remembered, in both directions: a busy answer
    // marks it busy, and an upload that went through implies it was idle.
    if (outcome.kind === 'busy') onLiveStatus?.({ busy: true, status: outcome.status });
    else if (outcome.kind === 'uploaded') onLiveStatus?.({ busy: false, status: outcome.status });
    setResult(outcome);
    // The run panel is drawn from the machine's store entry (#423): an upload that went through is
    // what prepares it, with the program's hash for the once-per-program confirmation.
    if (outcome.kind === 'uploaded') {
      // #469 (review R20) — the app's own upload OWNS the vacuum, whatever the text says. The span
      // is the post's decision (#419 decision 4) and this file is the whole of what was uploaded:
      // a file that carries its own `M331`/`M332` says so in words, while an `air: false` job
      // carries none — and the runner's text test would then bracket that file, switching the
      // vacuum ON at the very job that asked for it off. `vacuumOwned` is the context's own answer,
      // so the runner does not have to infer the job from one file of it.
      prepareRun({ host: machine.host, port: machine.port }, outcome.filename, programHash(program.nc), {
        ...runContext,
        ...(setup ?? {}),
        nc: program.nc,
        vacuumOwned: true,
        // #469 — one file is the whole job here, so its span is `whole` when it carries the words
        // and `none` when the job runs with the accessory output off. The runner's finishing
        // sentence can then say what actually happened instead of crediting an absent M332.
        vacuumSpan: programOwnsVacuum(program.nc) ? 'whole' : 'none',
      });
    }
    setFitted(false);
    setSelectedToolKey(null);
    setStage('idle');
  }

  return (
    <div data-testid="engrave-upload-panel">
      {/* Where this would go, said whether or not it can go there. A disabled button with no target
          named is the state where someone presses it and learns nothing. */}
      {machine === null ? (
        <p style={MUTED} data-testid="engrave-upload-target" data-state="none">
          No machine has been reached — run the machine check in the welcome wizard.
        </p>
      ) : (
        <p style={MUTED} data-testid="engrave-upload-target" data-state="found">
          Target: {label} at {machine.host}:{machine.port}, reached {reachedWhen(machine.observedAt)}.
        </p>
      )}

      <button
        type="button"
        data-testid="engrave-upload"
        disabled={blocked !== null || stage === 'sending'}
        title={blocked ?? `Send the verified program to ${label}.`}
        style={{ width: '100%', padding: 7, marginTop: 6 }}
        onClick={() => {
          setResult(null);
          setFitted(false);
          setSelectedToolKey(null);
          setStage('confirm');
        }}
      >
        {stage === 'sending' ? 'Uploading…' : 'Upload to machine…'}
      </button>

      {cutter !== null && (
        <p style={MUTED} data-testid="engrave-upload-cutter">
          Cutter:{' '}
          {cutter.casePhrase !== null && (
            <>
              <strong>{cutter.casePhrase}</strong> —{' '}
            </>
          )}
          <strong>{cutter.name}</strong> ({cutter.code})
        </p>
      )}

      {blocked !== null && (
        <p style={MUTED} data-testid="engrave-upload-blocked">
          Upload is disabled — {withPeriod(blocked)}
        </p>
      )}

      {stage === 'confirm' && blocked === null && machine !== null && program !== null && (
        <div style={CONFIRM} data-testid="engrave-upload-confirm">
          <p style={CONFIRM_TEXT}>
            Send <strong>{filename}</strong> ({bytes} bytes) to <strong>{label}</strong> at{' '}
            {machine.host}:{machine.port}?
          </p>
          <p style={MUTED}>
            This writes the file to the machine. It does not start the job — once it is on the card,
            “Run it” below plays it from this app; Makera Studio at the machine can play the same
            file instead.
          </p>
          {cutter !== null && (
            <>
              <p style={MUTED}>Which cutter is fitted?</p>
              <select
                data-testid="engrave-upload-cutter-select"
                aria-label="Which cutter is fitted?"
                title="The cutter the operator actually fitted, against the program's recommended one."
                value={selectedToolKey ?? recommendedToolKey ?? ''}
                onChange={(e) => setSelectedToolKey(e.target.value)}
                style={{ width: '100%', margin: '0 0 6px' }}
              >
                {!hasRecommended && <option value={cutter.toolKey}>{cutter.name}</option>}
                {tools.map((e) => (
                  <option key={e.key} value={e.key} title={e.provenance}>
                    {e.tool.name}
                  </option>
                ))}
              </select>
              {mismatch && mismatchSentence !== null && (
                <p style={{ ...MUTED, color: BAD_COLOR }} data-testid="engrave-upload-cutter-mismatch">
                  {mismatchSentence}
                </p>
              )}
              <label style={MUTED} data-testid="engrave-upload-fitted">
                <input
                  type="checkbox"
                  checked={fitted}
                  onChange={(e) => setFitted(e.target.checked)}
                />{' '}
                I have fitted this cutter.
              </label>
            </>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              data-testid="engrave-upload-confirm-send"
              style={{ flex: 1, padding: 7 }}
              disabled={cutter !== null && (!fitted || mismatch)}
              onClick={() => void send()}
            >
              Send it
            </button>
            <button
              type="button"
              data-testid="engrave-upload-confirm-cancel"
              style={{ flex: 1, padding: 7 }}
              onClick={() => {
                setFitted(false);
                setSelectedToolKey(null);
                setStage('idle');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result !== null && (
        <p
          data-testid="engrave-upload-result"
          data-state={result.kind}
          style={{ ...MUTED, color: isFailure(result) ? BAD_COLOR : OK_COLOR }}
        >
          {describeUpload(result, label)}
        </p>
      )}

      {/* #423 — the machine's run, from its store entry: present once an upload has prepared it, and
          still there (with its Stop) when this panel is closed and reopened mid-run. */}
      {machine !== null && <EngraveMachineRun target={{ host: machine.host, port: machine.port }} onProgramLine={onProgramLine} />}

      {laserPointOn && machine !== null && (
        <EngraveLaserPoint
          host={machine.host}
          port={machine.port}
          margin={
            jobEdgeMarginMm !== undefined
              ? { mm: jobEdgeMarginMm, from: "the job's edge margin" }
              : { mm: houseEdgeMargin, from: 'the house edge margin (the job did not say its own)' }
          }
          uncertainty={{ mm: laserUncertainty.value, source: laserUncertainty.source }}
          lift={lift}
        />
      )}

      {laserFrameOn && machine !== null && program !== null && (
        <EngraveLaserFrame
          host={machine.host}
          port={machine.port}
          // #535 — the laser frame's outline: the verifier's bbox, or the surface check's own.
          bounds={frameBounds(program.check.kind === 'verify' ? program.check.report.stats.bbox : program.check.bbox)}
          lift={lift}
        />
      )}
    </div>
  );
}
