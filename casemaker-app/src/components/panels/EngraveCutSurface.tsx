/**
 * #419 §3, slice 2 — THE CUT SURFACE, over the FROZEN package.
 *
 * Cut is not a second editor: it is the approval page. The gate (`EngravePreflight`) says whether
 * the job may become a run; this surface shows the run that was approved — the package line, ONE
 * `RunPlan` (its phase table and machine strip), and the controls that play it.
 *
 * FREEZE ON GREEN. With the gate clear and no package yet, the surface freezes the job around the
 * programs the Green Generate produced, takes its blank, and shows what the shelf said. That is the
 * "moment a person approves a job" the package store describes. It happens once per Generate (a
 * ref, not state, so a re-render cannot double-freeze) and never with a red gate.
 *
 * A STALE PACKAGE KEEPS ITS BLANK (decision 2). The surface says so in the hub's own words and
 * offers ONE explicit re-freeze press, enabled only when the only blocking row is `package-stale`
 * and the Generate itself is current. If the Generate is stale too, the operator must Generate
 * again first; the package and its reservation stay untouched either way.
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
import type { PreflightCause } from '@/engine/cnc/preflight';
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
import type { RunContext } from '@/store/machineRunStore';
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
import { domeAcceptSentence, surfaceTiltWords } from '@/engine/cnc/engrave/surfaceSpread';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useStockStore } from '@/store/stockStore';
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
        <span style={{ fontSize: 12, fontWeight: 600, color: done ? OK : current ? '#e6edf5' : '#9aa4b0' }}>
          {done ? '✓' : current ? '●' : '○'} {number} {title}
        </span>
        <span style={{ ...MUTED, margin: 0, textAlign: 'right' }}>{summary}</span>
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
  onBackToDesign: (cause: PreflightCause | null) => void;
}

/** "14:02" from the package's ISO timestamp, the hub's own reading. */
function clockOf(iso: string): string {
  const match = /T(\d{2}:\d{2})/.exec(iso);
  return match?.[1] ?? iso;
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
  onBackToDesign,
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
  const [refreezing, setRefreezing] = useState(false);
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
  // #689 — the clearance acknowledgement lives in step 1 now, not under Generate. It is the run
  // gate's own flag; the warning codes that need it come from the Generate (re-post included) and
  // the sweep, so both are subscribed to and the step re-renders when they arrive.
  const acknowledged = useEngraveRunStore((s) => s.acknowledged);
  const setAcknowledged = useEngraveRunStore((s) => s.setAcknowledged);
  const ackGenerated = useEngraveRunStore((s) => s.generated);
  const ackDiagnostics = useEngraveRunStore((s) => s.simDiagnostics);
  const anyRegistration = useEngraveRegistrationStore((s) => s.records[job.id] ?? null);
  const ackCodes = useMemo(
    () => requiredAckCodes({ ...useEngraveRunStore.getState(), generated: ackGenerated ?? generated }),
    [ackGenerated, ackDiagnostics, generated],
  );
  const ackRequired = ackCodes.length > 0;
  // The one sentence that unblocks Run while clearance is unticked. The gate's own saveBlocker says
  // the same thing; it is repeated here because this surface is also driven without the panel's
  // pre-computed blockers (tests, and any caller that hands them in null).
  const ackBlocker = ackRequired && !acknowledged ? 'tick the clearance check in Cut, step 1' : null;
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
  const [g32Acked, setG32Acked] = useState(false);
  // #631 (c) — the operator may skip G32 and accept the un-levelled floor instead: the dome verdict's
  // alternative route, a deliberate decision recorded beside the G32 tick. The consequence (the
  // centre miss) is stated in the label, never hidden.
  const [floorAccepted, setFloorAccepted] = useState(false);
  // A fresh measurement is a fresh clamping: neither tick carries over from the last one.
  useEffect(() => {
    setG32Acked(false);
    setFloorAccepted(false);
  }, [spreadAssessment]);
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

  // FREEZE ON GREEN, once. No package + a clear gate + a verifiable Generate is approval.
  useEffect(() => {
    if (!green || pkg !== null || !generatedReady || generated === null) return;
    if (attempted.current === generated) return;
    attempted.current = generated;
    void freeze(job, generated.programs).then((result) => {
      if (result.ok) {
        setFreezeError(null);
      } else {
        setFreezeError(result.reason);
      }
    });
  }, [green, pkg, generatedReady, generated, job, freeze]);

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

  // Q-2: a re-freeze is a separate press, never automatic. It is offered only when the package is
  // the ONLY thing in the way — a stale Generate needs a new Generate first, not a new freeze.
  const errors = report.rows.filter((row) => row.severity === 'error');
  const onlyPackageStale = errors.length > 0 && errors.every((row) => row.code === 'package-stale');
  const canRefreeze = onlyPackageStale && staleSince === null && generatedReady;

  const refreeze = (): void => {
    if (generated === null || !canRefreeze) return;
    setRefreezing(true);
    void freeze(job, generated.programs).then((result) => {
      setRefreezing(false);
      if (result.ok) {
        setFreezeError(null);
      } else {
        setFreezeError(result.reason);
      }
    });
  };

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

  // #689 — THE FOUR-LINE FLOW: ✓ 1 Checked · ✓ 2 Frozen · ● 3 Register the blank · ○ 4 Run.
  // `checked` is the gate PLUS the clearance acknowledgement that now lives in step 1. A stale
  // package is step 2's business, not a reason to hold step 1 open: with the gate clear otherwise,
  // step 1 is done and step 2 is the one that opens for the re-freeze press. #695 — a frozen
  // mount the machine no longer holds is step 1's business: its sentence and action live there,
  // so step 1 stays open until the machine is right; step 2 reads the same fact as stale.
  const checked = (green || onlyPackageStale) && (!ackRequired || acknowledged) && !mountMismatch;
  const frozen = packageCurrent && !mountMismatch;
  const registrationPlan = job.setups?.[0]?.registration?.plan ?? null;
  // A registration is a measurement on THIS machine; with no machine connected, a record for this
  // job still says the blank was registered in this session.
  const registered = firstRegistration !== null || (target === null && anyRegistration !== null);
  const registeredDone = frozen && registered;
  const ran =
    registeredDone &&
    pkg !== null &&
    pkg.programs.length > 0 &&
    pkg.programs.every((program) => finishedHashes.includes(program.hash));
  const currentStep = !checked ? 1 : !frozen ? 2 : !registeredDone ? 3 : !ran ? 4 : 0;

  // #689 review — STEP 4 STAYS VISIBLE, BUT THE TWO GATES STEP 4 USED TO REQUIRE ARE BLOCKERS
  // AGAIN, ahead of the run gate on every control. Before #689 step 4 rendered only when the
  // pre-flight was green and the package current; now that it always renders with a frozen plan,
  // `saveBlocker` covers neither the report's first blocking finding nor the package's staleness,
  // so a stale package could upload its old programs and a blocking finding would no longer gate
  // the press. Step 1 owns the report (its first finding, in the owner's own words); step 2 owns
  // the package. The package-stale row is step 2's own business, so it never leads the step-1
  // sentence — the freeze sentence does.
  const step1Blocking =
    report.rows.find((row) => row.severity === 'error' && row.code !== 'package-stale') ?? null;
  const step1Blocker =
    step1Blocking?.message ?? (!green && !onlyPackageStale ? 'Clear step 1 first.' : null);
  const step2Blocker = frozen
    ? null
    : pkg === null
      ? 'Freeze the job in step 2 before running it.'
      : mountMismatch
        ? `The machine no longer holds ${jobMountWords(frozenMount)} — use Change the machine… in step 1.`
        : 'Freeze the job again in step 2 — it changed since it was frozen.';

  const programCount = generated?.programs.length ?? pkg?.programs.length ?? 0;
  const noteCount = report.rows.filter((row) => row.severity === 'info').length;
  // #703 — ONE TIME FOR THE CUT (audit B15). The run plan's total is the SETUP plus the cut, and
  // in a package that carries no toolpath the cut's own phase has no number at all — so the
  // 6 min 8 s the two steps printed was that plan total, not this cut's time. The steps print the
  // PROGRAM's cycle estimate instead, in the same words the Generate row and the simulator use
  // (#688); the setup-inclusive total stays in the plan's own fold, where the phase table names it.
  const cutEstimate =
    generated?.cam == null ? null : `about ${formatDuration(generated.cam.estimatedSeconds)} (estimated)`;
  const step1Meta: string[] = [];
  if (programCount > 0) step1Meta.push(`${programCount} program${programCount === 1 ? '' : 's'}`);
  if (cutEstimate !== null) step1Meta.push(cutEstimate);
  if (noteCount > 0) step1Meta.push(`${noteCount} note${noteCount === 1 ? '' : 's'}`);
  if (ackRequired) step1Meta.push(acknowledged ? 'clearance acknowledged' : 'clearance not acknowledged');
  const step1Summary = checked
    ? step1Meta.join(' · ') || 'clear'
    : mountMismatch
      ? `the machine no longer holds ${jobMountWords(frozenMount)}`
      : report.errorCount > 0
        ? `${report.errorCount} blocking finding${report.errorCount === 1 ? '' : 's'}`
        : ackRequired
          ? 'clearance not acknowledged'
          : 'clear';

  const step2Summary =
    pkg === null
      ? 'not frozen yet'
      : frozen
        ? `${clockOf(pkg.frozenAt)} · the programs match the design`
        : 'stale — freeze again';

  const step3Summary = ((): string => {
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

  // #724 W5 — THE RUN STEP CARRIES THE ROTARY BENCH SENTENCE. With no machine connected the
  // one-screen block never renders, and step 4 said only "No machine is connected" — nothing
  // about why the frozen rotary program cannot go. The step quotes the SAME refusal the gates
  // hand it (Save, Upload and the release share it), so the words cannot drift.
  const rotaryGate =
    [uploadBlocker, releaseBlocker].find(
      (b) => b === ROTARY_UNMEASURED_REFUSAL || b === ROTARY_NO_MODULE_REFUSAL,
    ) ?? null;
  const step4Meta: string[] = [];
  if (plan !== null && rotaryGate !== null) step4Meta.push('the rotary’s bench check first');
  if (releaseSources.length > 1) step4Meta.push(`${releaseSources.length} programs`);
  if (plan?.features.find((feature) => feature.feature === 'vacuum')?.on === true) step4Meta.push('vacuum on');
  const cutter = jobTool(job);
  if (cutter !== null && releaseSources.length <= 1) step4Meta.push(`fit the ${toolDisplayName(cutter)}`);
  if (cutEstimate !== null) step4Meta.push(cutEstimate);
  const step4Summary = step4Meta.join(' · ');

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
        holding: `frozen for ${jobMountWords(frozenMount)}`,
        frozen: true,
        frozenMount,
      },
      // The wizard's `refreeze` is its copy of `!profileHolds(newProfile, frozenMount)`. This
      // screen reads the record again rather than keeping a second copy: the refresh re-renders
      // step 1's sentence and step 2's stale state from the new active profile.
      onDone: () => void useLocationStore.getState().refresh(),
    });
  };

  return (
    <div data-testid="engrave-cut-surface">
      {/* #524/#689 — the Cut surface as a four-line checklist: Checked → Frozen → Register the
          blank → Run. Each line is one sentence; only the step the operator is on has a body. */}
      <Step number={1} title="Checked" done={checked} current={currentStep === 1} summary={step1Summary}>
        {/* #695 — the frozen job's mount is gone from the machine. One sentence, one action; the
            same check the wizard makes (`profileHolds`) decides whether this is here at all. */}
        {mountMismatch && (
          <div style={BOX} data-testid="engrave-cut-mount">
            <p style={WARN} data-testid="engrave-cut-mount-sentence">
              This job was frozen for {jobMountWords(frozenMount)}, and the machine now has{' '}
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
          <EngravePreflight report={report} onBackToDesign={onBackToDesign} />
        </details>
        {/* #689 — the clearance acknowledgement moved here from the Generate footer. It is the
            run gate's own flag; the sentence is the one the operator has always ticked. */}
        {ackRequired && (
          <div style={{ ...BOX, marginTop: 8 }} data-testid="engrave-cut-ack">
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: '#e6edf5' }}>
              <input
                type="checkbox"
                data-testid="engrave-ack"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>I have checked clearance to the vise and the tool's reach myself.</span>
            </label>
          </div>
        )}
      </Step>

      <Step number={2} title="Frozen" done={frozen} current={currentStep === 2} summary={step2Summary}>
        <section
          style={BOX}
          data-testid="engrave-package"
          data-state={pkg === null ? 'none' : frozen ? 'current' : 'stale'}
          data-key={pkg?.hash}
        >
          {pkg === null ? (
            <p style={{ fontSize: 12, color: '#e6edf5', margin: 0 }}>
              Once the check is clear, this step freezes the plan and holds its blank.
            </p>
          ) : !packageCurrent ? (
            <p style={WARN} data-testid="engrave-package-state">
              The frozen plan from {clockOf(pkg.frozenAt)} is out of date —{' '}
              {staleness?.reason ?? 'the job changed since it was frozen.'}
            </p>
          ) : mountMismatch ? (
            // #695 — the job itself still matches the package; the MACHINE no longer holds the
            // mount it was frozen for. The fix is step 1's action, not a re-freeze.
            <p style={WARN} data-testid="engrave-package-state">
              The frozen plan from {clockOf(pkg.frozenAt)} is out of date — the machine no longer holds{' '}
              {jobMountWords(frozenMount)} this job was frozen for. Change the machine in step 1.
            </p>
          ) : null}
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
          {pkg !== null && !packageCurrent && (
            <>
              {!canRefreeze && (
                <p style={MUTED} data-testid="engrave-package-refreeze-why">
                  {staleSince !== null || !generatedReady
                    ? 'Generate the job again first — this session’s program no longer matches it.'
                    : 'Clear the blocking findings in step 1 first.'}
                </p>
              )}
              <button
                type="button"
                data-testid="engrave-package-refreeze"
                disabled={!canRefreeze || refreezing}
                title={
                  canRefreeze
                    ? 'Freeze the current job around its current programs. The existing hold moves to the new package; it is not doubled.'
                    : undefined
                }
                style={{ width: '100%', padding: 7, marginTop: 6 }}
                onClick={refreeze}
              >
                {refreezing ? 'Freezing…' : 'Freeze this job again…'}
              </button>
            </>
          )}
          {freezeError !== null && (
            <p style={WARN} data-testid="engrave-package-freeze-error">
              Nothing was frozen — {freezeError}.
            </p>
          )}
        </section>
      </Step>

      <Step
        number={3}
        title="Register the blank"
        done={registeredDone}
        current={currentStep === 3}
        summary={step3Summary}
      >
        <EngraveRegistrationStep job={job} target={target} />
        {/* #608 — once the registration measured a tilt, the frozen (flat) package must be re-posted
            against it before anything is uploaded. A re-post re-runs the whole pipeline with the
            fitted plane and re-freezes; a flat fit never shows this block, and a package that already
            follows the tilt shows only the "re-posted" line. */}
        {registrationSurface !== null && (
          <section style={BOX} data-testid="engrave-cut-repost">
            {surfaceGate !== null ? (
              <>
                <p style={{ fontSize: 12, color: '#f0d79b', margin: '0 0 6px' }}>
                  The blank is tilted{tiltWords !== null ? ` (${tiltWords})` : ''} — the frozen program is still flat.
                </p>
                <p style={WARN} data-testid="engrave-cut-repost-gate">{surfaceGate}.</p>
                <button
                  type="button"
                  data-testid="engrave-cut-repost-button"
                  disabled={reposting || !generatedReady}
                  style={{ width: '100%', padding: 7, marginTop: 6 }}
                  onClick={repost}
                >
                  {reposting ? 'Re-posting…' : 'Re-post against the measured tilt…'}
                </button>
              </>
            ) : (
              <p style={{ fontSize: 12, color: OK, margin: 0 }} data-testid="engrave-cut-repost-done">
                Re-posted against the measured tilt{tiltWords !== null ? ` (${tiltWords})` : ''}.
              </p>
            )}
          </section>
        )}
      </Step>

      <Step number={4} title="Run" done={ran} current={currentStep === 4} summary={step4Summary}>
        {plan === null ? (
          <p style={MUTED} data-testid="engrave-cut-not-ready">
            Freeze the plan in step 2 before running it.
          </p>
        ) : (
          <>
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
                    step1Blocker ?? step2Blocker ?? ackBlocker ?? uploadBlocker ?? missingReportBlocker ?? surfaceGate
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
                        step2Blocker ??
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
                        step2Blocker ??
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
