import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import type { MachineObservation } from '@/platform/machineProbe';
import { programBytes, uploadProgram, type MachineUploadResult } from '@/platform/machineUpload';
import type { VerifyReport } from '@/engine/cnc/verify';

/**
 * #255 — send the verified program to the machine, from beside Save in the engrave panel.
 *
 * DESKTOP BUILD ONLY. The panel mounts this behind `canDriveMachine`, so the web build has no
 * upload control at all — rather than a button that exists to explain why it cannot work. That is
 * the same boundary `capabilities.ts` draws for the bridge itself (#181).
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
 * WHAT IT DOES NOT DO: start the job. The bridge writes a file to the machine's card and reports
 * the controller's answer. Makera's own Studio then opens a five-step Machining Wizard; nothing in
 * this panel may imply that step has happened.
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
  /** The program to send: the verified text and the report that gated it, or null if there is none. */
  program: { nc: string; verify: VerifyReport } | null;
  /** The name the machine will receive — `runSheetFileName(job.name)`, so it matches the run sheet. */
  filename: string;
  /**
   * Told what the machine said when the upload asked it live and it was not idle (#296), so the
   * stored observation stops claiming otherwise. Optional: a test, or a host with no store, may omit it.
   */
  onLiveStatus?: (live: { busy: boolean; status: string }) => void;
}

/** ISO → something a person reads, or the raw string when it will not parse. Never "Invalid Date". */
function reachedWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * The sentence for one result. Exported because it is the part worth testing: the panel's honesty
 * about what happened is copy, and copy that drifts from the outcome is how a refusal starts
 * reading as a success.
 */
export function describeUpload(result: MachineUploadResult, label: string): string {
  switch (result.kind) {
    case 'uploaded':
      return result.alreadyPresent
        ? `${label} already had ${result.filename} — the same file, byte for byte, so no data was sent.`
        : `${label} received ${result.filename} — ${result.bytes} bytes in ${result.packets} packets.`;
    case 'refused':
      return `${label} declined ${result.filename}: ${result.detail}`;
    case 'busy':
      return `${label} is not idle — ${result.detail}. Wait for it to finish, then upload again.`;
    case 'timeout':
      return `The transfer of ${result.filename} timed out: ${result.detail}`;
    case 'error':
      return `${result.filename} was not uploaded — ${result.detail}.`;
    case 'unavailable':
      return `This build cannot reach a machine: ${result.reason}`;
  }
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
  onLiveStatus,
}: EngraveMachineUploadProps): JSX.Element {
  const [stage, setStage] = useState<'idle' | 'confirm' | 'sending'>('idle');
  const [result, setResult] = useState<MachineUploadResult | null>(null);

  const label = machine === null ? 'the machine' : (machine.name ?? machine.host);

  // Order matters, and matches `uploadBlocker`'s own reasoning: the run's trust first, then whether
  // there is anywhere to send it, then whether the machine wants it right now.
  const blocked =
    blocker ??
    (machine === null
      ? 'no machine has been reached'
      : machine.busy === true
        ? 'the machine reported it is busy'
        : program === null
          ? 'no program has been generated'
          : null);

  // A confirmation belongs to the gate that opened it (#295): once the run is blocked it is closed
  // for good, so a later un-blocking cannot bring back a box nobody pressed.
  useEffect(() => {
    if (blocked !== null && stage === 'confirm') setStage('idle');
  }, [blocked, stage]);

  const bytes = program === null ? 0 : programBytes(program.nc).length;

  async function send(): Promise<void> {
    // The gate is asked AGAIN at the second press (#295). The first press opened this confirmation
    // under a `blocked` that was null then; the job can go stale, or an acknowledgement be
    // unticked, while the box is open, and the one button that writes to the machine must not be the
    // one that remembers an older answer.
    if (blocked !== null || machine === null || program === null) {
      setStage('idle');
      return;
    }
    setStage('sending');
    // `uploadProgram` does not throw; the await is only for the result.
    const outcome = await uploadProgram(
      { host: machine.host, port: machine.port },
      { filename, nc: program.nc, verify: program.verify },
    );
    if (outcome.kind === 'busy') onLiveStatus?.({ busy: true, status: outcome.status });
    setResult(outcome);
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
        title={blocked ?? `Send the verified program to ${label} (#255).`}
        style={{ width: '100%', padding: 7, marginTop: 6 }}
        onClick={() => {
          setResult(null);
          setStage('confirm');
        }}
      >
        {stage === 'sending' ? 'Uploading…' : 'Upload to machine…'}
      </button>

      {blocked !== null && (
        <p style={MUTED} data-testid="engrave-upload-blocked">
          Upload is disabled — {blocked}.
        </p>
      )}

      {stage === 'confirm' && blocked === null && machine !== null && program !== null && (
        <div style={CONFIRM} data-testid="engrave-upload-confirm">
          <p style={CONFIRM_TEXT}>
            Send <strong>{filename}</strong> ({bytes} bytes) to <strong>{label}</strong> at{' '}
            {machine.host}:{machine.port}?
          </p>
          <p style={MUTED}>
            This writes the file to the machine. It does not start the job — that is step 2 in
            Makera Studio, at the machine.
          </p>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              data-testid="engrave-upload-confirm-send"
              style={{ flex: 1, padding: 7 }}
              onClick={() => void send()}
            >
              Send it
            </button>
            <button
              type="button"
              data-testid="engrave-upload-confirm-cancel"
              style={{ flex: 1, padding: 7 }}
              onClick={() => setStage('idle')}
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
    </div>
  );
}
