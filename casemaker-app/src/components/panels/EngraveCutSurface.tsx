/**
 * #419 §3, slice 2 — THE CUT SURFACE, over the FROZEN package.
 *
 * Cut is not a second editor: it is the approval page. The gate (`EngravePreflight`) says whether
 * the job may become a run; this surface shows the run that was approved — the package line, ONE
 * `RunPlan` (its phase table and machine strip), and the controls that play it.
 *
 * FREEZING FOLLOWS GENERATE (#796). With the check clear and a verifiable Generate that still
 * describes this design, the surface freezes the job around its programs, takes its blank and
 * shows what the shelf said — the "moment a person approves a job" the package store describes.
 * It happens once per Generate (a ref, not state, so a re-render cannot double-freeze), never with
 * a red check, and never for a Generate the job has outrun (`staleSince`). A package that no longer
 * matches the design is replaced by the NEXT Generate, so the surface carries no freeze press.
 *
 * A STALE PROGRAM KEEPS ITS BLANK (decision 2). The program card says, in the hub's own words,
 * that the program is older than the design and offers ONE action: Generate — the same action the
 * Design footer carries. The package and its reservation stay untouched until a new program is
 * generated and frozen.
 *
 * THE RUN IS FED FROM THE PACKAGE. `frozenReleaseSources` reads the texts, order and FNV keys from
 * `pkg.programs`; the live Generate contributes only verifier reports, matched by hash, because the
 * package does not carry reports. A frozen text with no matching report is never uploaded — there is
 * no "send anyway" path. `vacuumOwned: true` is set by both run paths (`engraveReleaseStore` and
 * `EngraveMachineUpload`), so the runner never brackets a middle file of the job's span.
 *
 * ONE PLAN, THREE READERS. `cutPlan` builds `RunPlan` from the package; `RunPlanView`,
 * `MachineStrip` and `EngraveReleaseStep` all receive that same value. Nothing here calls `planRun`
 * a second time.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react';
import type { EngraveJob, FrozenPackage } from '@/types/engraveJob';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { MachineObservation } from '@/platform/machineProbe';
import { machineForJob } from '@/platform/bedProfiles';
import type { VerifyReport } from '@/engine/cnc/verify';
import type { FeatureKind, FeatureOverrides } from '@/engine/cnc/plan';
import type { PreflightHubReport } from '@/engine/cnc/preflight/hub';
import { cutPlan } from '@/engine/cnc/engrave/cutPlan';
import { laserLiftFor } from '@/engine/cnc/engrave/laserSurface';
import { packageStaleness } from '@/engine/cnc/engrave/package';
import { formatDuration, registrationTouches } from '@/engine/cnc/plan';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import {
  frozenReleaseSources,
  releaseCheck,
  releaseFileName,
  type ReleaseSource,
} from '@/engine/cnc/engrave/release';
import type { SurfaceProgramCheck } from '@/engine/cnc/uploadGate';
import { DRY_RUN_SAFE_Z, dryRunProgramFor, type DryRunLevel } from '@/engine/cnc/engrave/dryRun';
import { jobMachine } from '@/engine/cnc/calibration';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { flatEndMill } from '@/engine/cnc/tool';
import { useSettingsStore } from '@/store/settingsStore';
import { finishedProgramsFor, useLocationStore } from '@/store/locationStore';
import { machineKey, useMachineRunStore, type RunContext } from '@/store/machineRunStore';
import { useEngravePackageStore } from '@/store/engravePackageStore';
import { useEngraveRegistrationStore, useFirstRegistration, useSurfaceSpread } from '@/store/engraveRegistrationStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import {
  ROTARY_NO_MODULE_REFUSAL,
  ROTARY_UNMEASURED_REFUSAL,
  programFrame,
  requiredAckCodes,
  surfaceRepostBlocker,
  withPeriod,
} from '@/store/engraveRunGate';
import { useManageModeStore } from '@/store/manageModeStore';
import { domeAcceptSentence, surfaceDomeAssumption, surfaceTiltWords } from '@/engine/cnc/engrave/surfaceSpread';
import { pcbSurfaceBudget, pcbSurfaceSentence } from '@/engine/cnc/engrave/pcbBudget';
import { effectiveMargins } from '@/engine/cnc/engrave/depthBounds';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useStockStore } from '@/store/stockStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import {
  formHolds,
  holdCutFaceWords,
  holdWordsFor,
  itemsFaceWords,
  itemsOnTop,
  jobHold,
  partDimsOf,
  sameHold,
} from '@/engine/cnc/engrave/stockHold';
import type { LaserLift } from '@/platform/machineLaser';
import {
  MACHINE_MOUNT_WORDS,
  activeMountOf,
  profileHolds,
  type MachineMountKind,
} from '@/platform/machineChange';
import { openMachineChange } from '@/components/machine-change';
import { EngravePreflight } from './EngravePreflight';
import { EngraveMachineUpload } from './EngraveMachineUpload';
import { EngraveReleaseStep } from './EngraveReleaseStep';
import { MachineStrip } from './MachineStrip';
import { RunPlanView } from './RunPlanView';
import { EngraveRegistrationStep } from './EngraveRegistrationStep';
import { EngraveCutConfirm, DomeChoice, type DomeChoiceProps } from './EngraveCutConfirm';
import { EngraveMachineRun } from './EngraveMachineRun';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const WARN: CSSProperties = { ...MUTED, color: '#f0b8a8' };
const OK = '#9fd19b';
const BOX: CSSProperties = {
  margin: '8px 0',
  padding: 8,
  border: '1px solid #3a4552',
  borderRadius: 4,
  background: '#1b2027',
};

/**
 * #695 — the job's own words for the mount its package was frozen for. The job model's mounts are
 * the setups engine's (`vise`/`bracket`/`tape`); `rotary` is accepted because the machine-change
 * request can carry it even though today's job cannot state it.
 */
function jobMountWords(kind: string | null | undefined): string {
  switch (kind) {
    case 'vise':
      return 'the vise';
    case 'rotary':
      return 'the rotary';
    case 'bracket':
      return 'the bracket and clamps';
    case 'tape':
      return 'tape';
    default:
      return 'mount';
  }
}

/**
 * #695 — the mount the wizard should put on the machine for this frozen job. A bracket and tape
 * both need the pins clear (the bracket's anchors and the taped blank sit on the bare bed), so
 * both ask the wizard for `bed`; the wizard's kinds are the pins states, not the job's wording.
 */
function mountTargetFor(kind: string | null | undefined): MachineMountKind | undefined {
  if (kind === 'vise' || kind === 'rotary' || kind === 'bed') return kind;
  if (kind === 'bracket' || kind === 'tape') return 'bed';
  return undefined;
}

/** #524/#689 — one numbered checklist step: a one-line summary that is always visible, its state
 *  in the marker (✓ done, ● the step the operator is on, ○ still to come), and a body. Only the
 *  current step is open by default, so the next thing to do is the only thing with a body. No new
 *  controls — the browser's own `<details>` is the mechanism — and a step the operator opens to
 *  look back at stays open until the current step moves. */
function Step({
  number,
  title,
  done,
  current,
  summary,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  current: boolean;
  summary: string;
  children: ReactNode;
}) {
  // `null` follows the current step; a boolean is the operator's own fold/unfold since then. When
  // the current step moves, the override resets: the new step opens and the old one folds (#586 —
  // a step that turns current, including after a machine reconnect, opens itself).
  const [manual, setManual] = useState<boolean | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the override is keyed to the step's current-ness; `current` is a boolean, so tagging the override would restore it when the step becomes current again after a round trip, which this reset must not do
    setManual(null);
  }, [current]);
  const open = manual ?? current;
  return (
    <details
      data-testid={`engrave-cut-step-${number}`}
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        setManual(now === current ? null : now);
      }}
      style={{ marginTop: 6, borderTop: '1px solid #2a2f36', paddingTop: 4 }}
    >
      <summary
        data-testid={`engrave-cut-step-${number}-summary`}
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}
      >
        {/* #726 P16 — the step's number and title are one label and never break between them:
            the summary beside them wraps instead ("4 / Run" on two lines read as two steps). */}
        <span
          data-testid={`engrave-cut-step-${number}-title`}
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: done ? OK : current ? '#e6edf5' : '#9aa4b0',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {done ? '✓' : current ? '●' : '○'} {number} {title}
        </span>
        <span style={{ ...MUTED, margin: 0, textAlign: 'right', minWidth: 0 }}>{summary}</span>
      </summary>
      <div style={{ marginTop: 4 }}>{children}</div>
    </details>
  );
}

export interface EngraveCutSurfaceProps {
  /** The document as it is now — the gate was asked about this. */
  job: EngraveJob;
  /** The hub's aggregate for this visit. Its `firstBlocking` is the only "green" this surface uses. */
  report: PreflightHubReport;
  /** The job's frozen package (`job.package` or the store's), or null when none exists yet. */
  package: FrozenPackage | null;
  /** The last Generate — read for verifier reports by hash and for the freeze itself, never for a program's text. */
  generated: EngraveGenerated | null;
  /** The run store's stale mark; a re-freeze is offered only when it is null. */
  staleSince: number | null;
  /** The machine the last check reached, or null. THE gate on everything that sends: the machine
   *  store can only hold a machine a probe reached through the bridge, and the bridge exists
   *  wherever one can be driven — the desktop shell's webview, or the same bundle served to a LAN
   *  browser by the embedded server (#656 review: the build target is not that question). */
  machine: MachineObservation | null;
  /** `runContextFor(job, tool)` — the job facts each played file's end needs (#414). */
  runContext: Omit<RunContext, 'nc'>;
  /** `uploadBlocker(run)` — the single-file path's gate. */
  uploadBlocker: string | null;
  /** `releaseBlocker(run)` — the multi-program path's gate. */
  releaseBlocker: string | null;
  onProgramLine?: (line: number | null) => void;
  onLiveStatus?: (live: { busy: boolean; status: string }) => void;
  /**
   * #796 — THE ONE WAY A PROGRAM IS MADE. A stale program's card presses the same Generate the
   * Design footer offers; freezing follows the generate, so this surface no longer carries a
   * separate re-freeze press.
   */
  onGenerate: () => void;
  /** The Design footer's own blocker sentence for Generate, when there is one (#803: no dead button). */
  generateBlocker: string | null;
}

/** The map from the live Generate: each program's FNV key to the report that gated that text. */
function reportsByHash(generated: EngraveGenerated | null): Map<string, VerifyReport> {
  const reports = new Map<string, VerifyReport>();
  for (const program of generated?.programs ?? []) {
    if (program.verify !== null && program.verify !== undefined) reports.set(program.programHash, program.verify);
  }
  return reports;
}

/** #535 — the same map for SURFACE programs: the dexel check that stands in for the report. */
function surfaceChecksByHash(generated: EngraveGenerated | null): Map<string, SurfaceProgramCheck> {
  const checks = new Map<string, SurfaceProgramCheck>();
  for (const program of generated?.programs ?? []) {
    if (program.surfaceCheck != null) checks.set(program.programHash, program.surfaceCheck);
  }
  return checks;
}

/**
 * #783 — "I turned the stock", in Fit and clamp: the SAME holds Holding asks for, offered at the
 * machine. A turn restates the job's box through the hold; the items stay on their part face (a
 * face turned to a side is stated, with the one press that moves them up), and the frozen program
 * is older than the design from that moment on, with the reason that says the stock was turned.
 */
function TurnStockControl({ job }: { job: EngraveJob }): JSX.Element {
  const current = jobHold(job);
  const form = job.stock.shape === 'disc' ? 'disc' : (job.stockEntry?.form ?? 'plate');
  const holds = formHolds(form);
  const part = partDimsOf(job.stock, current);
  const faceWords = itemsOnTop(current) ? null : itemsFaceWords(current);
  return (
    <details style={{ ...BOX, marginTop: 6 }} data-testid="engrave-cut-turn-stock">
      <summary style={{ fontSize: 12, cursor: 'pointer' }}>I turned the stock…</summary>
      <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: 6 }}>
          {holds.map((hold) => {
            const isSelected = sameHold(current, hold);
            return (
              <button
                key={`${hold.x}-${hold.y}-${hold.z}`}
                type="button"
                aria-pressed={isSelected}
                data-testid={`engrave-cut-turn-${hold.x}-${hold.y}-${hold.z}`}
                onClick={() => useEngraveJobStore.getState().setHold(hold)}
                style={{
                  display: 'grid',
                  gap: 2,
                  textAlign: 'left',
                  padding: 6,
                  borderRadius: 4,
                  border: isSelected ? '1px solid #6aa6c9' : '1px solid #2a2f36',
                  background: isSelected ? '#16222b' : '#10151b',
                  color: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <b style={{ fontSize: 11 }}>{holdWordsFor(form, hold, part)}</b>
                <span style={{ ...MUTED, fontSize: 10, margin: 0 }}>{holdCutFaceWords(form, hold)}</span>
              </button>
            );
          })}
        </div>
        {faceWords !== null && (
          <p style={MUTED} data-testid="engrave-cut-turn-items-face">
            The items are on the part&rsquo;s face that is {faceWords}.{' '}
            <button
              type="button"
              className="btn btn--sm"
              data-testid="engrave-cut-turn-move-items"
              onClick={() => useEngraveJobStore.getState().moveItemsToHoldFace()}
            >
              Move them to the top face
            </button>
          </p>
        )}
        <p style={{ ...MUTED, margin: 0 }} data-testid="engrave-cut-turn-note">
          The program is older than the design from a turn on — Generate again before cutting.
        </p>
      </div>
    </details>
  );
}

export function EngraveCutSurface({
  job,
  report,
  package: pkg,
  generated,
  staleSince,
  machine,
  runContext,
  uploadBlocker,
  releaseBlocker,
  onProgramLine,
  onLiveStatus,
  onGenerate,
  generateBlocker,
}: EngraveCutSurfaceProps): JSX.Element {
  const freeze = useEngravePackageStore((s) => s.freeze);
  const openManage = useManageModeStore((s) => s.openManage);
  const shelfItems = useStockStore((s) => s.items);
  const defaults = useShopDefaultsStore((s) => s.defaults);
  // #695 — the machine RECORD (not the LAN observation): the bed profile the wizard writes is the
  // one the job's frozen mount is checked against. #730 — the JOB's machine (`machineId` is a
  // profile id), not the house's first: two machines hold two beds.
  const locationView = useLocationStore((s) => s.location);
  const locationMachine = useMemo(() => machineForJob(locationView, job.machineId), [locationView, job.machineId]);
  const [overrides, setOverrides] = useState<FeatureOverrides>({});
  /** #726 W20 — whether step 1's detail fold is open; null = follow the gate (open while blocked). */
  const [detailsOpen, setDetailsOpen] = useState<boolean | null>(null);
  const [freezeError, setFreezeError] = useState<string | null>(null);
  /** The Generate a freeze was attempted for; a re-render must not freeze the same one twice. */
  const attempted = useRef<EngraveGenerated | null>(null);

  const target = useMemo(
    () => (machine === null ? null : { host: machine.host, port: machine.port }),
    [machine],
  );
  /**
   * #457 — the surface this job's registration measured on THIS machine, and what stands above it.
   * Session state (#494): a reload forgets it, and the lasers then say "no registration recorded"
   * rather than pretend a fixed clearance checked a top nobody measured.
   */
  const firstRegistration = useFirstRegistration(job.id, target);
  // #819 — THE RUN'S END IS THE SCREEN. When this machine's run has ended (finished or stopped),
  // the three steps were about getting a program onto the machine, and that is done: the card
  // owns the state, and the steps' two run buttons and the register card fold away with them.
  // A refused run (`nothing` was cut) keeps the steps — its card says why, and the operator needs
  // the press to try again.
  const machineRun = useMachineRunStore((s) => (target === null ? null : s.runs[machineKey(target)] ?? null));
  // The machine holds ONE entry, so a run that belongs to ANOTHER job (its context names that job)
  // must not take this job's screen: job B's Cut would otherwise open on job A's Done card. An entry
  // with no job id was prepared outside the job flow (an upload with no job, the e2e seam), and has
  // no other job to belong to.
  const runOver =
    machineRun !== null &&
    !machineRun.running &&
    machineRun.end !== null &&
    machineRun.end.kind !== 'nothing' &&
    (machineRun.context?.jobId === undefined || machineRun.context.jobId === job.id);
  // #689 — the clearance acknowledgement lives in step 1 now, not under Generate. It is the run
  // gate's own flag; the warning codes that need it come from the Generate (re-post included) and
  // the sweep, so both are subscribed to and the step re-renders when they arrive.
  const acknowledged = useEngraveRunStore((s) => s.acknowledged);
  const acknowledgedFor = useEngraveRunStore((s) => s.acknowledgedFor);
  const setAcknowledged = useEngraveRunStore((s) => s.setAcknowledged);
  const acknowledgeProgram = useEngraveRunStore((s) => s.acknowledgeProgram);
  const ackGenerated = useEngraveRunStore((s) => s.generated);
  const ackDiagnostics = useEngraveRunStore((s) => s.simDiagnostics);
  const anyRegistration = useEngraveRegistrationStore((s) => s.records[job.id] ?? null);
  const ackCodes = useMemo(
    () => requiredAckCodes({ ...useEngraveRunStore.getState(), generated: ackGenerated ?? generated }),
    [ackGenerated, ackDiagnostics, generated],
  );
  const ackRequired = ackCodes.length > 0;
  // #797 — ONE STATEMENT, ASKED ONCE PER PROGRAM. The clearance tick, "the probe is fitted" and
  // both "I am at the machine" boxes were four asks for one fact; they are this one statement,
  // and its tick carries the program (the package's hash) it was given for. A new program asks
  // again; editing a label does not.
  const programKey = pkg?.hash ?? generated?.programs[0]?.programHash ?? null;
  const statementTicked = programKey !== null && acknowledgedFor === programKey;
  // The one sentence that unblocks Start cut while the statement is unticked. The gate's own
  // saveBlocker says the same thing; it is repeated here because this surface is also driven
  // without the panel's pre-computed blockers (tests, and any caller that hands them in null).
  // The statement is about the MACHINE, so it is asked whenever there is a program to run, not
  // only when one of the gate's warning codes wants a clearance tick (#797).
  const ackBlocker = programKey !== null && !statementTicked ? 'tick the statement in Cut, step 1' : null;
  // #608 — the cut-extent measurement this machine took: its tilt feeds the re-post step line, and
  // the registration's fitted plane is what the release gate compares the frozen package against.
  const spreadMeasurement = useSurfaceSpread(job.id, target);
  const generate = useEngraveRunStore((s) => s.generate);
  // #656 — the verdict the one screen prints: the run store's oracle for the current package (a
  // re-post replaces it, and the sentence follows).
  const runOracle = useEngraveRunStore((s) => s.oracle);
  // #535 — a goal program is checked by the dexel sweep, not the 2.5D oracle; the one screen's
  // verdict line states that check and the grid it ran on, never the oracle's vacuous 0/0.
  const runSurfaceProgram = useEngraveRunStore((s) => s.generated?.surface3d != null);
  const runGridPitchMm = useEngraveRunStore((s) => s.simGridPitchMm);
  const [reposting, setReposting] = useState(false);
  const registrationSurface = firstRegistration?.surface ?? null;
  const surfaceGate = surfaceRepostBlocker(pkg, firstRegistration);
  const tiltWords = spreadMeasurement === null ? null : surfaceTiltWords(spreadMeasurement.assessment.tilt);
  // #631 — a dome verdict: the plane re-post cannot follow a curved top, so the machine levels it
  // itself (G32 from the console). The recipe and the operator's confirmation live here; Upload is
  // gated on the tick until it lands, and the statement is recorded in the run sheet (G32 is never
  // in a file).
  const spreadAssessment = spreadMeasurement?.assessment ?? null;
  const domeStanding = spreadAssessment?.verdict === 'dome';
  // #743 P-6 — A BOARD'S ISOLATION HAS A FLATNESS BUDGET (design §3.6). The plane the program is
  // posted against follows a tilt; the residual is what it cannot. The isolation needs the top
  // within `depth − copper − Z budget` of that plane, and the Cut surface states the miss with the
  // measured numbers and the physical fix — never as a refusal (a tolerance fact, 2026-10-29 rule).
  const houseMarginSettings = useSettingsStore((s) => s.margins);
  const pcbBudget = pcbSurfaceBudget(job, effectiveMargins(job, houseMarginSettings).zTolerance);
  const surfaceResidualMm =
    spreadAssessment === null ? null : (spreadAssessment.fit?.residual ?? spreadAssessment.spread);
  const pcbSurfaceOver =
    pcbBudget !== null && surfaceResidualMm !== null && surfaceResidualMm > pcbBudget.budgetMm + 1e-9;
  // A fresh measurement is a fresh clamping: neither tick carries over from the last one. The
  // ticks are TAGGED with the assessment they were made on rather than reset in an effect
  // (react-hooks/set-state-in-effect): a different assessment reads as unticked, exactly as the
  // reset did, and the assessment is one object per measurement so identity is the right key.
  const [ticks, setTicks] = useState<{ forAssessment: typeof spreadAssessment; g32: boolean; floor: boolean }>({
    forAssessment: null,
    g32: false,
    floor: false,
  });
  const ticksApply = ticks.forAssessment === spreadAssessment;
  const g32Acked = ticksApply && ticks.g32;
  // #631 (c) — the operator may skip G32 and accept the un-levelled floor instead: the dome verdict's
  // alternative route, a deliberate decision recorded beside the G32 tick. The consequence (the
  // centre miss) is stated in the label, never hidden.
  const floorAccepted = ticksApply && ticks.floor;
  const setG32Acked = (on: boolean): void =>
    setTicks((t) => ({ forAssessment: spreadAssessment, g32: on, floor: t.forAssessment === spreadAssessment ? t.floor : false }));
  const setFloorAccepted = (on: boolean): void =>
    setTicks((t) => ({ forAssessment: spreadAssessment, g32: t.forAssessment === spreadAssessment ? t.g32 : false, floor: on }));
  const domeG32Blocker =
    domeStanding && !g32Acked && !floorAccepted
      ? 'confirm how the dome is handled before uploading — run G32 from the console for this clamping and tick the box, or write the origin anyway and accept the un-levelled floor'
      : null;
  const domeAccept = spreadAssessment === null ? null : domeAcceptSentence(spreadAssessment);

  /**
   * #608 — re-post the package against the registration's measured tilt: re-run the whole pipeline
   * (generate → verify → simulate → oracle) with the fitted plane, then re-freeze so the frozen
   * texts follow the tilt. #577's determinism means only the lifted feeds move; a flat fit never
   * reaches this (the button is gated on a non-null `registrationSurface`).
   */
  const repost = (): void => {
    if (registrationSurface === null) return;
    setReposting(true);
    void generate(registrationSurface).then(() => {
      const fresh = useEngraveRunStore.getState().generated;
      setReposting(false);
      if (fresh === null || !fresh.ok || fresh.programs.length === 0) return;
      void freeze(job, fresh.programs, registrationSurface).then((result) => {
        if (result.ok) {
          setFreezeError(null);
        } else {
          setFreezeError(result.reason);
        }
      });
    });
  };

  /**
   * #656 — CONTINUE ON OUR OWN. The operator's Continue at the cutter prompt is the last
   * confirmation of the ordinary path: once the registration records, a package that does not yet
   * follow a measured tilt is re-posted here — once — and the one screen waits for the oracle.
   */
  const chainReposted = useRef(false);
  useEffect(() => {
    if (firstRegistration === null || chainReposted.current) return;
    if (registrationSurface === null || surfaceGate === null) return;
    chainReposted.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the one-shot post-registration re-post is guarded by `chainReposted`; the busy state it starts is the re-post's own, launched exactly once per clamping
    repost();
    // `repost` is re-created each render; the ref makes this a one-shot per clamping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstRegistration, registrationSurface, surfaceGate]);

  const green = report.firstBlocking === null;
  const staleness = pkg === null ? null : packageStaleness(pkg, job);
  // #695 — THE FROZEN JOB'S MOUNT, AGAINST THE MACHINE'S ACTIVE BED. The package stores the
  // setup's mount (`JobSetup.mount`); the machine record's active profile either holds it or does
  // not, read by the SAME predicate #693's wizard uses (`profileHolds`). A package whose mount has
  // gone must not read as current: step 1 names the disagreement with the one action that can fix
  // it, and step 2 treats the package as stale. With no location read there is no profile to
  // judge, and nothing is claimed.
  // #724 W6 — THE FROZEN MOUNT READS THE FRAME. A rotary job's derived setup carries the setups
  // engine's word for it, and that vocabulary has no rotary (#240): it said `vise`, so step 1 read
  // a chuck job as "frozen for the vise" and called it GONE on a machine holding exactly the right
  // thing. The frame each frozen program states is the recorded fact, and it decides the mount.
  const frozenSetupMount = pkg?.setups[0]?.mount.kind ?? null;
  const frozenRotary = (pkg?.programs ?? []).some((p) => programFrame(p) === 'rotary');
  const frozenMount = frozenRotary ? 'rotary' : frozenSetupMount;
  const activeProfile =
    locationMachine === null
      ? null
      : ((locationMachine.bedProfiles ?? []).find((p) => p.id === locationMachine.activeBedProfileId) ?? null);
  const mountMismatch =
    pkg !== null && frozenMount !== null && activeProfile !== null && !profileHolds(activeProfile, frozenMount);
  // The machine's own words for what it holds now, for step 1's sentence and the record it asks
  // the wizard to change ("Nothing on the pins" reads as "nothing on the pins" mid-sentence).
  const machineNow = locationMachine === null ? null : MACHINE_MOUNT_WORDS[activeMountOf(locationMachine)];
  const machineNowWords =
    machineNow === null
      ? null
      : machineNow === 'Nothing on the pins'
        ? 'nothing on the pins'
        : `the ${machineNow.toLowerCase()}`;
  const packageCurrent = pkg !== null && staleness?.stale === false;
  const reports = useMemo(() => reportsByHash(generated), [generated]);
  const surfaceChecks = useMemo(() => surfaceChecksByHash(generated), [generated]);
  const sources: ReleaseSource[] = useMemo(
    () => (pkg === null ? [] : frozenReleaseSources(job, pkg, reports, surfaceChecks)),
    [job, pkg, reports, surfaceChecks],
  );

  // #547 — the dry-run selector: `off` (cut for real), `traverse` (one lifted air pass) or `full`
  // (the whole lifted list through the ordinary release flow). Default `off` — the maintainer left
  // the default TBD, and a rehearsal must be chosen on purpose, never by accident.
  const [dryRunLevel, setDryRunLevel] = useState<DryRunLevel | 'off'>('off');
  // The verifier context for the LIFTED text. The tool never affects a dry-run check (no spindle,
  // no cuts), so the job's cutter — or a minimal flat mill when none resolves — is an honest stand-in.
  const calibration = useSettingsStore((s) => s.machineCalibration) ?? null;
  const dryRunDeps = useMemo(() => {
    const mill = jobMachine(job, calibration);
    return { setup: toSetup(job, mill), machine: mill, tool: jobTool(job) ?? flatEndMill(1) };
  }, [job, calibration]);
  /** The program list the run controls play: the frozen texts, or their lifted dry-run variants. */
  const runSources: ReleaseSource[] = useMemo(() => {
    if (dryRunLevel === 'off') return sources;
    return sources.map((s) => {
      // #535 — a surface source has no verifier report but its check is the surface one; the
      // missing-check blocker already refuses a source with NEITHER, so it stays visible here. A
      // surface program IS lifted like any other: the lifted text is a genuine 2D air program, and
      // the dry-run verifier's report becomes the lifted source's check.
      if (releaseCheck(s) === null) return s;
      const dry = dryRunProgramFor(s.nc, dryRunDeps);
      return { ...s, nc: dry.nc, verify: dry.verify, surfaceCheck: null, hash: dry.hash, dryRun: true };
    });
  }, [sources, dryRunLevel, dryRunDeps]);
  // A traverse plays ONE lifted program (a fast head/progress rehearsal); a full dry run plays all.
  const traverseOnly = dryRunLevel === 'traverse';
  const releaseSources = traverseOnly ? runSources.slice(0, 1) : runSources;
  const singleSource = releaseSources[0];
  // #547 — a dry run must never consume the blank: the single-file run context says so, and the
  // release path sets the same flag per file from `ReleaseProgram.dryRun`.
  const runContextWithDry = dryRunLevel === 'off' ? runContext : { ...runContext, dryRun: true as const };
  // #656 — THE ORDINARY PATH IS ONE SCREEN. It needs a machine to drive, the real (not dry-run)
  // single program, and its report; multi-program jobs keep the release flow in the disclosure.
  //
  // THE MACHINE IS THE GATE, NOT THE BUILD TARGET (#656 review). The bench runs the desktop
  // bundle in a plain browser at http://<host>:8000, driving through `/api/v1/machine/*`; the web
  // target is the PUBLIC site, where no probe can ever reach a machine, so `machine !== null`
  // already excludes it. Keying on the build made the one screen depend on how the bundle was
  // built rather than on whether a machine can be driven.
  const oneScreen =
    target !== null &&
    machine !== null &&
    dryRunLevel === 'off' &&
    releaseSources.length === 1 &&
    singleSource !== undefined &&
    // #535 — a goal program has no verifier report; its surface check is the one that gates it.
    releaseCheck(singleSource) !== null;
  const [expertOpen, setExpertOpen] = useState(false);
  const domeProps: DomeChoiceProps | null = domeStanding
    ? {
        accept: domeAccept,
        g32Acked,
        floorAccepted,
        onG32: setG32Acked,
        onFloor: setFloorAccepted,
        recommendation: spreadAssessment?.recommendation?.sentence ?? null,
        assumption: spreadAssessment === null ? null : surfaceDomeAssumption(spreadAssessment),
      }
    : null;
  /**
   * #457 — the surface this job's registration measured on THIS machine, and what stands above it.
   * Session state (#494): a reload forgets it, and the lasers then say "no registration recorded"
   * rather than pretend a fixed clearance checked a top nobody measured. The setup is the one the
   * single-program upload is about, so its mount (vise, bracket, tape) is the one the laser flies in.
   */
  const setupIndex = sources[0]?.setupIndex ?? 0;
  const lift = useMemo<LaserLift>(
    () =>
      laserLiftFor(
        job,
        firstRegistration === null
          ? null
          : { surfaceMachineZ: firstRegistration.outcome.surfaceZ, measuredAt: firstRegistration.measuredAt },
        defaults,
        setupIndex,
      ),
    [job, defaults, firstRegistration, setupIndex],
  );
  const generatedReady =
    generated !== null &&
    generated.ok === true &&
    generated.programs.length > 0 &&
    // #535 — a program passes on its verifier report OR its surface check; never neither.
    generated.programs.every((program) => program.verify?.ok === true || program.surfaceCheck != null);
  const missingReport = sources.find((source) => releaseCheck(source) === null) ?? null;

  // A NEW PACKAGE IS A NEW RUN: the operator's strip switches are about this package's plan.
  // Adjusted during render (guarded, so it settles in one extra pass) rather than in an effect,
  // which would paint the previous package's switches for a frame first.
  const [overridesFor, setOverridesFor] = useState<string | null>(pkg?.hash ?? null);
  if ((pkg?.hash ?? null) !== overridesFor) {
    setOverridesFor(pkg?.hash ?? null);
    setOverrides({});
  }

  // #796 — FREEZING FOLLOWS GENERATE. A clear check over a verifiable Generate that still
  // describes this design freezes once; a STALE package is replaced by the same rule on the next
  // Generate, which is why there is no separate re-freeze press any more. `staleSince` keeps a
  // Generate that the job has outrun from freezing: that program describes an older design.
  useEffect(() => {
    if (!green || !generatedReady || generated === null || staleSince !== null) return;
    if (pkg !== null && packageCurrent) return;
    if (attempted.current === generated) return;
    attempted.current = generated;
    void freeze(job, generated.programs).then((result) => {
      if (result.ok) {
        setFreezeError(null);
      } else {
        setFreezeError(result.reason);
      }
    });
  }, [green, pkg, packageCurrent, generatedReady, generated, job, staleSince, freeze]);

  const finishedHashes = useMemo(() => {
    // #425 §6 — the machine's finished list and the DOCUMENT's run log both answer "not new". The
    // document's answer travels with a saved job; the machine's survives a forgotten release.
    const logged = (job.runLog ?? [])
      .filter((entry) => entry.outcome === 'finished')
      .map((entry) => entry.programHash);
    const machineFinished = target === null ? [] : finishedProgramsFor(target);
    return [...new Set([...machineFinished, ...logged])];
  }, [target, job.runLog]);
  const plan = useMemo(
    () =>
      pkg === null
        ? null
        : cutPlan({ job, pkg, finishedHashes, defaults, overrides }),
    [job, pkg, finishedHashes, defaults, overrides],
  );

  // #796 — a stale program has ONE action: Generate. There is no re-freeze press; the generate
  // that replaces the program freezes it (see the freeze effect above).
  const errors = report.rows.filter((row) => row.severity === 'error');
  const onlyPackageStale = errors.length > 0 && errors.every((row) => row.code === 'package-stale');

  const toggle = (feature: FeatureKind, on: boolean): void => {
    const key = feature === 'air-run' ? 'airRun' : feature === 'auto-level' ? 'autoLevel' : feature;
    setOverrides((current) => ({ ...current, [key]: on }));
  };

  const reservation = ((): { line: string; detail: string | null } | null => {
    if (pkg === null) return null;
    if (pkg.stockEntryId === null) {
      return { line: 'You’re supplying this stock yourself, so no blank needs to be held.', detail: null };
    }
    const shelf = shelfItems.find((item) => item.id === pkg.stockEntryId) ?? null;
    const held = shelf?.reservations.find((entry) => entry.jobId === job.id) ?? null;
    if (held === null) {
      return {
        line: 'No blank is held for this job — check you have one before cutting.',
        detail: `Shelf entry ${pkg.stockEntryId} has no hold for this job.`,
      };
    }
    return {
      line: `This job’s blank is held for you${held.quantity > 1 ? ` · ${held.quantity} blanks` : ''}.`,
      detail: `Held for job ${job.id} under shelf entry ${pkg.stockEntryId}.`,
    };
  })();

  // #796 — THREE STEPS, NOT FOUR: ✓ 1 Fit and clamp · ● 2 Register · ○ 3 Start cut.
  // `checked` is the check PLUS the clearance acknowledgement; `frozen` is the program that
  // matches this design. They were steps 1 and 2; they are ONE readiness line now, because the
  // operator does one thing (press Generate) and reads one fact (the program is this design's).
  // #695 — a frozen mount the machine no longer holds is step 1's business: its sentence and
  // action live there, so step 1 stays open until the machine is right.
  const checked = (green || onlyPackageStale) && (!ackRequired || acknowledged) && !mountMismatch;
  const frozen = packageCurrent && !mountMismatch;
  const fitDone = checked && frozen;
  const registrationPlan = job.setups?.[0]?.registration?.plan ?? null;
  // A registration is a measurement on THIS machine; with no machine connected, a record for this
  // job still says the blank was registered in this session.
  const registered = firstRegistration !== null || (target === null && anyRegistration !== null);
  const registeredDone = fitDone && registered;
  const ran =
    registeredDone &&
    pkg !== null &&
    pkg.programs.length > 0 &&
    pkg.programs.every((program) => finishedHashes.includes(program.hash));
  const currentStep = !fitDone ? 1 : !registeredDone ? 2 : !ran ? 3 : 0;

  // #689 review — THE START-CUT STEP STAYS VISIBLE, BUT WHAT IT USED TO REQUIRE IS A BLOCKER on
  // every control. Since #689 the step renders even when the check is red or the program is stale;
  // `saveBlocker` covers neither, so an old program could be uploaded and a blocking finding would
  // no longer gate the press. Step 1 owns both facts now: the report's first finding (in the
  // owner's own words) and the program that is this design's. The `package-stale` row is the
  // program card's own business, so it never leads the step-1 sentence.
  const step1Blocking =
    report.rows.find((row) => row.severity === 'error' && row.code !== 'package-stale') ?? null;
  const step1Blocker =
    step1Blocking?.message ?? (!green && !onlyPackageStale ? 'Clear step 1 first.' : null);
  // #796 — one name for "the program that is this design's": the Start cut screen and the one
  // press both read it, and it is a program now, not a frozen package.
  const programBlocker = frozen
    ? null
    : pkg === null
      ? 'Generate the program in step 1 before starting it.'
      : mountMismatch
        ? `The machine no longer holds ${jobMountWords(frozenMount)} — use Change the machine… in step 1.`
        : 'The program is older than the design — press Generate in step 1.';

  const noteCount = report.rows.filter((row) => row.severity === 'info').length;
  // #747 review — A WARNING IS NOT FOLDED AWAY. A green check with a withheld frame carries its
  // `no-frame` warning in the closed details fold, where nobody would look; the readiness line
  // counts it, so the operator knows to open the fold and read it.
  const warningCount = report.warningCount;
  const warningWords = warningCount > 0 ? `${warningCount} warning${warningCount === 1 ? '' : 's'}` : null;
  // #703 — ONE TIME FOR THE CUT (audit B15). The run plan's total is the SETUP plus the cut, and
  // in a package that carries no toolpath the cut's own phase has no number at all — so the
  // 6 min 8 s the two steps printed was that plan total, not this cut's time. The steps print the
  // PROGRAM's cycle estimate instead, in the same words the Generate row and the simulator use
  // (#688); the setup-inclusive total stays in the plan's own fold, where the phase table names it.
  const cutEstimate =
    generated?.cam == null ? null : `about ${formatDuration(generated.cam.estimatedSeconds)}`;

  // #796 — THE ONE READINESS LINE. Checked and Frozen were two steps whose summaries said the
  // same thing twice ("1 program · about 13 min 25 s" and "12:46 · the programs match the
  // design"); they are one line now: the program is checked, it is this design's, and it takes
  // this long. Warnings, notes and the clearance state still ride it.
  const readiness: string[] = [];
  if (checked) readiness.push('Program checked');
  if (frozen) readiness.push('matches the design');
  if (cutEstimate !== null) readiness.push(cutEstimate);
  if (warningWords !== null) readiness.push(warningWords);
  if (noteCount > 0) readiness.push(`${noteCount} note${noteCount === 1 ? '' : 's'}`);
  if (ackRequired) readiness.push(acknowledged ? 'clearance acknowledged' : 'clearance not acknowledged');
  const readinessWords = readiness.join(' · ');
  const step1Summary = fitDone
    ? readinessWords || 'clear'
    : mountMismatch
      ? `the machine no longer holds ${jobMountWords(frozenMount)}`
      : onlyPackageStale
        ? 'the program is older than the design'
        : report.errorCount > 0
          ? `${report.errorCount} blocking finding${report.errorCount === 1 ? '' : 's'}` +
            (warningWords === null ? '' : ` · ${warningWords}`)
          : ackRequired
            ? 'clearance not acknowledged'
            : 'clear';

  const step2Summary = ((): string => {
    if (registrationPlan === null) return '';
    const order = ['left', 'front', 'right', 'back'] as const;
    const edges = order.filter((edge) => registrationPlan.scans.some((scan) => scan.edge === edge));
    const touches = registrationTouches({ ok: true, plan: registrationPlan });
    const touchWords = `${touches} touch${touches === 1 ? '' : 'es'}`;
    if (edges.length === 0) return touchWords;
    const list =
      edges.length === 1
        ? `${edges[0]} edge`
        : `${edges.slice(0, -1).join(', ')} and ${edges[edges.length - 1]} edges`;
    return `${list}, then the top face · ${touchWords}`;
  })();

  // #724 W5 — THE START-CUT STEP CARRIES THE ROTARY BENCH SENTENCE. With no machine connected the
  // one-screen block never renders, and the step said only "No machine is connected" — nothing
  // about why the rotary program cannot go. The step quotes the SAME refusal the run gates hand it
  // (Save, Upload and the release share it), so the words cannot drift.
  const rotaryGate =
    [uploadBlocker, releaseBlocker].find(
      (b) => b === ROTARY_UNMEASURED_REFUSAL || b === ROTARY_NO_MODULE_REFUSAL,
    ) ?? null;
  const step3Meta: string[] = [];
  if (plan !== null && rotaryGate !== null) step3Meta.push('the rotary’s bench check first');
  if (releaseSources.length > 1) step3Meta.push(`${releaseSources.length} programs`);
  if (plan?.features.find((feature) => feature.feature === 'vacuum')?.on === true) step3Meta.push('vacuum on');
  const cutter = jobTool(job);
  if (cutter !== null && releaseSources.length <= 1) step3Meta.push(`fit the ${toolDisplayName(cutter)}`);
  if (cutEstimate !== null) step3Meta.push(cutEstimate);
  const step3Summary = step3Meta.join(' · ');

  const missingReportIndex =
    missingReport === null ? -1 : (pkg?.programs.findIndex((program) => program.hash === missingReport.hash) ?? -1);
  const missingReportBlocker =
    missingReport === null
      ? null
      : `program ${missingReportIndex + 1} has no verifier report in this session; generate the job again before sending it`;

  /** #695 — ask the wizard for the mount the frozen job needs. */
  const changeMachineForMount = (): void => {
    const targetMount = mountTargetFor(frozenMount);
    openMachineChange({
      ...(targetMount === undefined ? {} : { target: targetMount }),
      forJob: {
        name: job.name,
        holding: `made for ${jobMountWords(frozenMount)}`,
        frozen: true,
        frozenMount,
      },
      // The wizard's `refreeze` is its copy of `!profileHolds(newProfile, frozenMount)`. This
      // screen reads the record again rather than keeping a second copy: the refresh re-renders
      // step 1's sentence and its program card from the new active profile.
      onDone: () => void useLocationStore.getState().refresh(),
    });
  };

  // #819 — the ended run's screen: the Done card and its one action, nothing else.
  if (runOver && target !== null) {
    return (
      <div data-testid="engrave-cut-surface">
        <EngraveMachineRun target={target} onProgramLine={onProgramLine} />
      </div>
    );
  }

  return (
    <div data-testid="engrave-cut-surface">
      {/* #524/#689 — the Cut surface as a four-line checklist: Checked → Frozen → Register the
          blank → Run. Each line is one sentence; only the step the operator is on has a body. */}
      <Step number={1} title="Fit and clamp" done={fitDone} current={currentStep === 1} summary={step1Summary}>
        {/* #695 — the frozen job's mount is gone from the machine. One sentence, one action; the
            same check the wizard makes (`profileHolds`) decides whether this is here at all. */}
        {mountMismatch && (
          <div style={BOX} data-testid="engrave-cut-mount">
            <p style={WARN} data-testid="engrave-cut-mount-sentence">
              This job was made for {jobMountWords(frozenMount)}, and the machine now has{' '}
              {machineNowWords ?? 'a different mount'}.
            </p>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="engrave-cut-change-machine"
              onClick={changeMachineForMount}
            >
              Change the machine…
            </button>
          </div>
        )}
        {/* #783 — I TURNED THE STOCK: the holds, at the machine, in the step that runs before
            registration. A turn restates the box; the program goes stale with its own reason. */}
        <TurnStockControl job={job} />
        {/* #795 — THE STATEMENT IS THE STEP'S FIRST LINE. The clearance acknowledgement used to sit
            at the foot of the step, under the gate's fold; it is what the operator must say about
            THIS step, so it reads before the details rather than after them. */}
        {programKey !== null && (
          <div style={{ ...BOX, marginTop: 6 }} data-testid="engrave-cut-ack">
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: '#e6edf5' }}>
              <input
                type="checkbox"
                data-testid="engrave-ack"
                checked={statementTicked}
                onChange={(e) => {
                  if (!e.target.checked) setAcknowledged(false);
                  else if (programKey !== null) acknowledgeProgram(programKey);
                  else setAcknowledged(true);
                }}
                style={{ marginTop: 2 }}
              />
              <span>
                I am at the machine — the probe is fitted, the head is clear, and the stock is
                clamped — and I have checked clearance to the vise and the tool's reach myself.
              </span>
            </label>
          </div>
        )}
        {/* #796 — THE PROGRAM, AS ONE CARD WITH ONE ACTION. Checked and Frozen were two steps;
            the readiness line says the first half, and a program older than the design says the
            second HERE — press Generate (the same button Design's footer carries) and the freeze
            follows it. A program that matches the design needs no card; only the blank's hold is
            stated. */}
        <section
          style={{ ...BOX, marginTop: 6 }}
          data-testid="engrave-package"
          data-state={pkg === null ? 'none' : packageCurrent && !mountMismatch ? 'current' : 'stale'}
          data-key={pkg?.hash}
        >
          {pkg !== null && !packageCurrent && !mountMismatch && (
            <p style={WARN} data-testid="engrave-package-state">
              The program is older than the design —{' '}
              {staleness?.reason ?? 'the job changed since it was generated.'}
            </p>
          )}
          {pkg !== null && !packageCurrent && !mountMismatch && (
            <button
              type="button"
              data-testid="engrave-package-generate"
              disabled={generateBlocker !== null}
              style={{ width: '100%', padding: 7, marginTop: 6 }}
              onClick={onGenerate}
            >
              Generate
            </button>
          )}
          {pkg !== null && !packageCurrent && !mountMismatch && generateBlocker !== null && (
            <p style={MUTED} data-testid="engrave-package-generate-blocker">
              {generateBlocker}
            </p>
          )}
          {reservation !== null && (
            <div style={MUTED} data-testid="engrave-package-reservation">
              {reservation.line}
              {reservation.detail !== null && (
                <details style={{ marginTop: 2 }}>
                  <summary style={{ cursor: 'pointer' }}>shelf details</summary>
                  <span>{reservation.detail}</span>
                </details>
              )}
            </div>
          )}
          {freezeError !== null && (
            <p style={WARN} data-testid="engrave-package-freeze-error">
              Nothing was made — {freezeError}.
            </p>
          )}
        </section>
        {/* #726 W20 — STEP 1 IS ONE LINE; the gate's rows are its DETAIL (§3.7: "▸ details").
            It opens by itself while something blocks, and stays where the operator left it after. */}
        <details
          data-testid="engrave-cut-details"
          open={detailsOpen ?? !checked}
          style={{ marginTop: 6 }}
        >
          <summary
            style={{ ...MUTED, cursor: 'pointer' }}
            onClick={(event) => {
              // #726 W20 review — only the OPERATOR moves the fold. The browser fires `toggle` for
              // a change of the `open` prop too (at mount while the gate is blocked, and again
              // when it clears), so recording onToggle latched step 1 open for the whole job. The
              // summary's own activation is cancelled and the state moved here, so a click (or
              // Enter/Space on the focused summary, which fires a click) is the only thing that
              // counts.
              event.preventDefault();
              setDetailsOpen(!(detailsOpen ?? !checked));
            }}
          >
            details
          </summary>
          <EngravePreflight report={report} />
        </details>
      </Step>

      <Step
        number={2}
        title="Register"
        done={registeredDone}
        current={currentStep === 2}
        summary={step2Summary}
      >
        <EngraveRegistrationStep job={job} target={target} />
        {/* #608 / #796 — once the registration measured a tilt, the program made for a flat blank
            must be RE-MADE for the measured tilt before anything is uploaded. A re-make re-runs
            the whole pipeline with the fitted plane and freezes it; a flat fit never shows this
            block, and a program that already follows the tilt shows only the "re-made" line. */}
        {registrationSurface !== null && (
          <section style={BOX} data-testid="engrave-cut-repost">
            {surfaceGate !== null ? (
              <>
                <p style={{ fontSize: 12, color: '#f0d79b', margin: '0 0 6px' }}>
                  The blank is tilted{tiltWords !== null ? ` (${tiltWords})` : ''} — the program was made for a flat blank.
                </p>
                <p style={WARN} data-testid="engrave-cut-repost-gate">{surfaceGate}.</p>
                <button
                  type="button"
                  data-testid="engrave-cut-repost-button"
                  disabled={reposting || !generatedReady}
                  style={{ width: '100%', padding: 7, marginTop: 6 }}
                  onClick={repost}
                >
                  {reposting ? 'Re-making…' : 'Re-make for the measured tilt…'}
                </button>
              </>
            ) : (
              <p style={{ fontSize: 12, color: OK, margin: 0 }} data-testid="engrave-cut-repost-done">
                Re-made for the measured tilt{tiltWords !== null ? ` (${tiltWords})` : ''}.
              </p>
            )}
          </section>
        )}
      </Step>

      <Step number={3} title="Start cut" done={ran} current={currentStep === 3} summary={step3Summary}>
        {plan === null ? (
          <p style={MUTED} data-testid="engrave-cut-not-ready">
            Generate the program in step 1 before starting it.
          </p>
        ) : (
          <>
            {pcbSurfaceOver && pcbBudget !== null && surfaceResidualMm !== null && (
              <section style={{ ...BOX, borderColor: '#a08040', marginBottom: 8 }} data-testid="engrave-cut-pcb-surface">
                <p style={{ fontSize: 12, color: '#f0d79b', margin: '0 0 6px' }}>
                  {pcbSurfaceSentence(pcbBudget, surfaceResidualMm)}
                </p>
                <button
                  type="button"
                  data-testid="engrave-cut-pcb-register-again"
                  onClick={() => {
                    const el = document.querySelector<HTMLElement>('[data-testid="engrave-registration"]');
                    if (el !== null && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
                  }}
                >
                  Register again
                </button>
              </section>
            )}
            {rotaryGate !== null && (
              <p style={MUTED} data-testid="engrave-cut-rotary-bench">{withPeriod(rotaryGate)}</p>
            )}
            {target === null && (
              <p style={MUTED} data-testid="engrave-cut-no-machine">
                No machine is connected —{' '}
                <button
                  type="button"
                  data-testid="engrave-cut-open-machines"
                  onClick={() => openManage('machines')}
                  style={{
                    font: 'inherit',
                    padding: 0,
                    border: 0,
                    background: 'none',
                    color: '#8ab4f8',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  connect one in Manage › Machines
                </button>
                .
              </p>
            )}
            {/* #656 — THE ONE SCREEN. The ordinary path: the program, the cutter (already confirmed
                at the prompt), the check's verdict, the dome choice when the top is curved, ONE
                statement and ONE Cut press that uploads, prepares and starts. */}
            {oneScreen && machine !== null && target !== null && singleSource !== undefined && (
              <>
                <EngraveCutConfirm
                  job={job}
                  machine={machine}
                  source={singleSource}
                  filename={releaseFileName(job.name, 1, 1, false)}
                  oracle={runOracle}
                  blocker={
                    step1Blocker ?? programBlocker ?? ackBlocker ?? uploadBlocker ?? missingReportBlocker ?? surfaceGate
                  }
                  dome={domeProps}
                  domeBlocker={domeG32Blocker}
                  runContext={runContextWithDry}
                  surfaceCheck={runSurfaceProgram ? { gridPitchMm: runGridPitchMm } : null}
                  onLiveStatus={onLiveStatus}
                />
                <EngraveMachineRun target={target} onProgramLine={onProgramLine} />
              </>
            )}
            {/* #656 — THE EXPERT PATH, unchanged behind a disclosure: the plan, the dry-run
                choices, the manual upload with its own confirmation and cutter selector, and the
                multi-program run. It is open by default when the one screen is not offered (a
                multi-program job, the web build, or no machine). */}
            <details
              style={{ marginTop: 6 }}
              data-testid="engrave-cut-expert"
              open={oneScreen ? expertOpen : true}
              onToggle={(e) => setExpertOpen(e.currentTarget.open)}
            >
              <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>
                The plan and the steps
              </summary>
              {!oneScreen && domeProps !== null && <DomeChoice {...domeProps} />}
              <details style={{ marginTop: 4 }} data-testid="engrave-cut-plan">
                <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>The plan</summary>
                <div style={{ marginTop: 4 }}>
                  <RunPlanView plan={plan} />
                  <MachineStrip features={plan.features} onToggle={toggle} />
                </div>
              </details>

              {target !== null && (
                <section style={{ marginTop: 10 }} data-testid="engrave-cut-run">
                  {/* #547 — the dry-run selector. Both levels fly the real XY path at a safe Z with
                      the spindle off; `traverse` plays one program, `full` the whole list. */}
                  <div style={BOX} data-testid="engrave-dry-run">
                    <label style={{ fontSize: 12, color: '#e6edf5' }}>
                      <strong>Dry run</strong>{' '}
                      <select
                        value={dryRunLevel}
                        data-testid="engrave-dry-run-level"
                        aria-label="Dry-run level"
                        style={{ marginLeft: 6 }}
                        onChange={(e) => setDryRunLevel(e.target.value as DryRunLevel | 'off')}
                      >
                        <option value="off">Off — cut for real</option>
                        <option value="traverse">Traverse only — one air pass, no stock</option>
                        <option value="full">Full dry run — whole flow, spindle off, in the air</option>
                      </select>
                    </label>
                    {dryRunLevel !== 'off' && (
                      <p style={MUTED} data-testid="engrave-dry-run-note">
                        The spindle stays off and every move flies at Z {DRY_RUN_SAFE_Z} above the top face —
                        nothing is clamped, nothing is cut, and no stock, runtime or finished program is
                        recorded. {traverseOnly
                          ? 'A single traverse of the first program — the fastest way to light up the progress bar and head view.'
                          : 'The whole program list plays in order, bit-change prompts included.'}
                      </p>
                    )}
                  </div>

                  {releaseSources.length > 1 ? (
                    <EngraveReleaseStep
                      target={target}
                      job={job}
                      programs={releaseSources}
                      runPlan={plan}
                      blocker={
                        step1Blocker ??
                        programBlocker ??
                        ackBlocker ??
                        releaseBlocker ??
                        missingReportBlocker ??
                        surfaceGate ??
                        domeG32Blocker
                      }
                      onProgramLine={onProgramLine}
                    />
                  ) : (
                    <EngraveMachineUpload
                      blocker={
                        step1Blocker ??
                        programBlocker ??
                        ackBlocker ??
                        uploadBlocker ??
                        missingReportBlocker ??
                        surfaceGate ??
                        domeG32Blocker
                      }
                      machine={machine}
                      program={
                        singleSource === undefined
                          ? null
                          : (() => {
                              const check = releaseCheck(singleSource);
                              return check === null ? null : { nc: singleSource.nc, check };
                            })()
                      }
                      filename={releaseFileName(job.name, 1, 1, singleSource?.dryRun === true)}
                      lift={lift}
                      onLiveStatus={onLiveStatus}
                      runContext={runContextWithDry}
                      setup={
                        singleSource === undefined
                          ? undefined
                          : { setupIndex: singleSource.setupIndex, setupId: singleSource.setupId }
                      }
                      jobEdgeMarginMm={job.edgeMargin}
                      onProgramLine={onProgramLine}
                    />
                  )}
                </section>
              )}
            </details>
          </>
        )}
      </Step>
    </div>
  );
}
