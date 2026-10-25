/**
 * #656 — THE ONE SCREEN BETWEEN THE CUTTER PROMPT AND THE CUT.
 *
 * The maintainer's first cut: from "the cutter is in" to the first chip was six confirmations
 * across three screens and over seven minutes — and two of those confirmations re-asked what the
 * cutter prompt had just established. This screen is the whole of the ordinary path after the
 * registration records: the program named, the cutter named (already confirmed at the prompt),
 * the oracle's verdict, the dome choice when the top is curved, ONE statement that folds the
 * clearance check, the at-the-machine confirmation and the cutter-fitting fact, and ONE button
 * that uploads, prepares and starts.
 *
 * NOTHING HERE IS A SECOND GATE. The upload gate is the caller's `blocker` (asked again at the
 * press), the oracle's sentence is `oracleSentence`'s, the dome words are the verdict's own. The
 * button is disabled until the statement is ticked and the oracle is ok; every refusal keeps its
 * own sentence beside the button. The expert path (manual upload, its cutter selector, the run
 * panel's own ticks, the dry-run choices, the multi-program release flow) lives behind the Cut
 * step's disclosure and is untouched.
 */

import { useState, type CSSProperties, type JSX } from 'react';
import type { EngraveJob } from '@/types/engraveJob';
import type { MachineObservation } from '@/platform/machineProbe';
import { describeUpload } from './engraveUploadCopy';
import { uploadProgram } from '@/platform/machineUpload';
import { programHash, programOwnsVacuum, runSettings } from '@/platform/machineRun';
import { resolveTool } from '@/engine/cnc/toolRegistry';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { useRunConfirmStore, runKey } from '@/store/runConfirmStore';
import { oracleSentence } from '@/store/engraveRunGate';
import { useMachineRunStore, type RunContext } from '@/store/machineRunStore';
import type { OracleReport } from '@/engine/cnc/engrave/oracle';
import type { ReleaseSource } from '@/engine/cnc/engrave/release';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const BOX: CSSProperties = { marginTop: 6, padding: 8, border: '1px solid #3a4552', borderRadius: 4, background: '#1b2027' };
const OK = '#9fd19b';
const BAD = '#f0b4ad';

/** The dome's choice as the Cut surface holds it — the same state the expert path's copy uses. */
export interface DomeChoiceProps {
  /** The verdict's own accept sentence ("write the origin anyway …"), or null when there is none. */
  accept: string | null;
  g32Acked: boolean;
  floorAccepted: boolean;
  onG32: (on: boolean) => void;
  onFloor: (on: boolean) => void;
  /** The recommendation sentence (the G32 recipe), or null. */
  recommendation: string | null;
}

/** The dome verdict's two routes: G32 at the console, or accepting the un-levelled floor. */
export function DomeChoice({ accept, g32Acked, floorAccepted, onG32, onFloor, recommendation }: DomeChoiceProps): JSX.Element {
  return (
    <section style={BOX} data-testid="engrave-cut-dome-g32">
      <p style={{ fontSize: 12, color: '#f0d79b', margin: '0 0 6px' }}>
        The blank's top is a dome — a plane re-post cannot follow it. The machine's own leveling
        follows a curved top; the program uploads FLAT.
      </p>
      {recommendation !== null && (
        <p style={MUTED} data-testid="engrave-cut-dome-g32-recipe">
          {recommendation}
        </p>
      )}
      <label style={{ fontSize: 12, color: '#e6edf5' }}>
        <input
          type="checkbox"
          checked={g32Acked}
          data-testid="engrave-cut-dome-g32-ack"
          onChange={(e) => onG32(e.target.checked)}
        />{' '}
        G32 has been run from the console for this clamping
      </label>
      {accept !== null && (
        <label style={{ fontSize: 12, color: '#e6edf5', display: 'block', marginTop: 8 }}>
          <input
            type="checkbox"
            checked={floorAccepted}
            data-testid="engrave-cut-dome-accept-floor"
            onChange={(e) => onFloor(e.target.checked)}
          />{' '}
          {accept}
        </label>
      )}
    </section>
  );
}

export interface EngraveCutConfirmProps {
  job: EngraveJob;
  machine: MachineObservation;
  /** The one frozen program this job cuts with (a single-program package). */
  source: ReleaseSource;
  /** The file name the upload writes. */
  filename: string;
  /** The run store's oracle for the current package (after any re-post), or null while none. */
  oracle: OracleReport | null;
  /** `uploadBlocker(run)` — the gate, asked again at the press. Null when clear. */
  blocker: string | null;
  /** The dome verdict, when the spread assessment is one; null otherwise. */
  dome: DomeChoiceProps | null;
  /** `domeG32Blocker` — the sentence that holds the cut until the dome route is chosen. */
  domeBlocker: string | null;
  /** The job facts the run's end needs; the cutter key is the FROZEN program's. */
  runContext: Omit<RunContext, 'nc'>;
  onLiveStatus?: (live: { busy: boolean; status: string }) => void;
}

export function EngraveCutConfirm({
  job,
  machine,
  source,
  filename,
  oracle,
  blocker,
  dome,
  domeBlocker,
  runContext,
  onLiveStatus,
}: EngraveCutConfirmProps): JSX.Element {
  const [statement, setStatement] = useState(false);
  const [pressing, setPressing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = useMachineRunStore((s) => s.start);
  const prepare = useMachineRunStore((s) => s.prepare);
  const defaults = useShopDefaultsStore((s) => s.defaults);

  // #646/#652 — the cutter the FROZEN program was posted for, by the name every surface uses.
  const tool = resolveTool(source.toolKey);
  const cutterName = tool === null ? source.toolKey : toolDisplayName(tool);
  const toolNumber = tool?.number ?? null;
  const oracleOk = oracle?.ok === true;
  const refused = blocker ?? domeBlocker;

  /**
   * THE ONE PRESS. It carries the three facts the old path asked one at a time — the clearance
   * acknowledgement (the run gate's own), the cutter-fitted confirmation (the statement here), and
   * "I am at the machine" (the once-per-program confirmation) — then uploads, prepares and starts
   * through the same seams the manual path uses.
   */
  async function cut(): Promise<void> {
    if (!statement || pressing || refused !== null || !oracleOk) return;
    setPressing(true);
    setError(null);
    const outcome = await uploadProgram(
      { host: machine.host, port: machine.port },
      { filename, nc: source.nc, verify: source.verify! },
    );
    if (outcome.kind === 'busy') onLiveStatus?.({ busy: true, status: outcome.status });
    else if (outcome.kind === 'uploaded') onLiveStatus?.({ busy: false, status: outcome.status });
    if (outcome.kind !== 'uploaded') {
      setError(`The program was not uploaded: ${describeUpload(outcome, 'the machine')}`);
      setPressing(false);
      return;
    }
    const hash = programHash(source.nc);
    const key = runKey({ host: machine.host, port: machine.port }, hash);
    // The statement covered all three of the old ticks; record them now, so nothing asks again.
    useRunConfirmStore.getState().confirm(key);
    useEngraveRunStore.getState().setAcknowledged(true);
    const prepared = prepare(
      { host: machine.host, port: machine.port },
      outcome.filename,
      hash,
      {
        ...runContext,
        toolKey: source.toolKey,
        setupIndex: source.setupIndex,
        setupId: source.setupId,
        nc: source.nc,
        programHash: hash,
        vacuumOwned: true,
        vacuumSpan: programOwnsVacuum(source.nc) ? 'whole' : 'none',
      },
    );
    if (!prepared) {
      setError('The run could not be prepared — a program is already running on this machine.');
      setPressing(false);
      return;
    }
    if (!start({ host: machine.host, port: machine.port }, runSettings(defaults))) {
      setError('The program was uploaded but the run did not start; it is prepared — press Run in the steps below.');
    }
    setPressing(false);
  }

  return (
    <section style={BOX} data-testid="engrave-cut-confirm">
      <p style={{ fontSize: 12, color: '#e6edf5', margin: 0 }} data-testid="engrave-cut-confirm-program">
        <strong>The program</strong> — {filename}
      </p>
      <p style={MUTED} data-testid="engrave-cut-confirm-cutter" title={tool?.name ?? undefined}>
        <strong>The cutter</strong> — {cutterName}
        {toolNumber === null ? '' : ` (T${toolNumber})`} — the one you fitted at the registration.
      </p>
      <p
        style={{ ...MUTED, color: oracleOk ? OK : BAD }}
        data-testid="engrave-cut-confirm-oracle"
        data-ok={oracleOk ? 'true' : 'false'}
      >
        <strong>The check</strong> —{' '}
        {oracleSentence({ oracle, phase: oracle === null ? 'idle' : oracle.ok ? 'ready' : 'blocked' })}.
      </p>
      {dome !== null && <DomeChoice {...dome} />}
      <label style={{ display: 'block', marginTop: 8, fontSize: 12, color: '#c8d3de' }}>
        <input
          type="checkbox"
          checked={statement}
          data-testid="engrave-cut-statement"
          onChange={(e) => {
            setStatement(e.target.checked);
            // The run gate's own acknowledgement IS this statement, kept in step as it is ticked.
            useEngraveRunStore.getState().setAcknowledged(e.target.checked);
          }}
        />{' '}
        I am at the machine, head clear, stock clamped, and I have checked clearance to the vise and
        the tool's reach.
      </label>
      <button
        type="button"
        data-testid="engrave-cut-go"
        disabled={!statement || pressing || refused !== null || !oracleOk}
        style={{ width: '100%', padding: 8, marginTop: 8, fontWeight: 600 }}
        onClick={() => void cut()}
      >
        {pressing ? 'Uploading and starting…' : `Cut ${job.name}`}
      </button>
      {refused !== null && (
        <p style={{ ...MUTED, color: BAD }} data-testid="engrave-cut-go-blocked">
          {refused}
        </p>
      )}
      {!oracleOk && oracle !== null && (
        <p style={{ ...MUTED, color: BAD }} data-testid="engrave-cut-go-oracle">
          The check is not 0/0 — this program is not cut until it is.
        </p>
      )}
      {error !== null && (
        <p style={{ ...MUTED, color: BAD }} data-testid="engrave-cut-confirm-error">
          {error}
        </p>
      )}
    </section>
  );
}
