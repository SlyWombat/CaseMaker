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
import type { VerifyReport } from '@/engine/cnc/verify';
import type { FeatureKind, FeatureOverrides } from '@/engine/cnc/plan';
import type { PreflightCause } from '@/engine/cnc/preflight';
import type { PreflightHubReport } from '@/engine/cnc/preflight/hub';
import { cutPlan } from '@/engine/cnc/engrave/cutPlan';
import { laserLiftFor } from '@/engine/cnc/engrave/laserSurface';
import { packageStaleness } from '@/engine/cnc/engrave/package';
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
import { finishedProgramsFor } from '@/store/locationStore';
import type { RunContext } from '@/store/machineRunStore';
import { useEngravePackageStore } from '@/store/engravePackageStore';
import { useFirstRegistration, useSurfaceSpread } from '@/store/engraveRegistrationStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { surfaceRepostBlocker } from '@/store/engraveRunGate';
import { domeAcceptSentence, surfaceTiltWords } from '@/engine/cnc/engrave/surfaceSpread';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useStockStore } from '@/store/stockStore';
import type { LaserLift } from '@/platform/machineLaser';
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

/** #524 — one numbered checklist step: a one-line summary that is always visible (with a ✓ when
 *  done) and a body that opens when it is the step the operator is on. No new controls — the
 *  browser's own `<details>` is the mechanism. */
function Step({
  number,
  title,
  done,
  summary,
  defaultOpen,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  summary: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  // #586 — `defaultOpen` names the step the operator is on (the first non-✓). It is re-applied
  // whenever it becomes true, so a step that turns current — including after a remount or a machine
  // reconnect that briefly left it folded — opens itself. A step that stops being current is not
  // force-folded, and a manual fold stays folded until the step becomes current again.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  return (
    <details
      data-testid={`engrave-cut-step-${number}`}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      style={{ marginTop: 6, borderTop: '1px solid #2a2f36', paddingTop: 4 }}
    >
      <summary
        data-testid={`engrave-cut-step-${number}-summary`}
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: done ? OK : '#c8d3de' }}>
          {done ? '✓' : '●'} {number} {title}
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
  const shelfItems = useStockStore((s) => s.items);
  const defaults = useShopDefaultsStore((s) => s.defaults);
  const [overrides, setOverrides] = useState<FeatureOverrides>({});
  const [freezeNote, setFreezeNote] = useState<string | null>(null);
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
          setFreezeNote(result.reservation.text);
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
        setFreezeNote(result.reservation.text);
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
        setFreezeNote(result.reservation.text);
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

  const missingReportIndex =
    missingReport === null ? -1 : (pkg?.programs.findIndex((program) => program.hash === missingReport.hash) ?? -1);
  const missingReportBlocker =
    missingReport === null
      ? null
      : `program ${missingReportIndex + 1} has no verifier report in this session; generate the job again before sending it`;

  return (
    <div data-testid="engrave-cut-surface">
      {/* #524 — the Cut surface as a four-step checklist: Check the job → Freeze the plan →
          Register the blank → Run the job. Each step is one line when done and opens when it is
          the step the operator is on (#550 — the titles are operator actions, not internal jargon). */}
      <Step
        number={1}
        title="Check the job"
        done={green}
        summary={green ? 'clear' : `${report.errorCount} blocking finding${report.errorCount === 1 ? '' : 's'}`}
        defaultOpen={!green}
      >
        <EngravePreflight report={report} onBackToDesign={onBackToDesign} />
      </Step>

      <Step
        number={2}
        title="Freeze the plan"
        done={packageCurrent}
        summary={
          pkg === null
            ? 'not frozen yet'
            : packageCurrent
              ? `${pkg.programs.length} program${pkg.programs.length === 1 ? '' : 's'} · frozen ${clockOf(pkg.frozenAt)}`
              : 'stale — freeze again'
        }
        defaultOpen={!packageCurrent}
      >
      <section
        style={BOX}
        data-testid="engrave-package"
        data-state={pkg === null ? 'none' : packageCurrent ? 'current' : 'stale'}
        data-key={pkg?.hash}
      >
        <p
          style={{ fontSize: 12, color: '#e6edf5', margin: '0 0 4px' }}
          title={pkg === null ? undefined : `package key ${pkg.hash}`}
        >
          <strong>The package</strong>
          {pkg === null ? (
            <> — not frozen yet. Once the check is clear, this step freezes the plan and holds its blank.</>
          ) : (
            <>
              {' '}
              — {pkg.programs.length} program{pkg.programs.length === 1 ? '' : 's'} · {pkg.setups.length} setup
              {pkg.setups.length === 1 ? '' : 's'} · frozen {clockOf(pkg.frozenAt)}
            </>
          )}
        </p>
        {pkg !== null && (
          <p
            style={packageCurrent ? { ...MUTED, color: OK } : WARN}
            data-testid="engrave-package-state"
          >
            {packageCurrent
              ? 'The frozen programs still describe this job.'
              : `The package of ${clockOf(pkg.frozenAt)} is stale — ${staleness?.reason ?? 'the job changed since it was frozen.'} Its blank stays held for this job.`}
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
        {pkg !== null && !packageCurrent && (
          <button
            type="button"
            data-testid="engrave-package-refreeze"
            disabled={!canRefreeze || refreezing}
            title={
              canRefreeze
                ? 'Freeze the current job around its current programs. The existing hold moves to the new package; it is not doubled.'
                : 'Generate again first: the generated program is stale too, or the package is not the only blocker.'
            }
            style={{ width: '100%', padding: 7, marginTop: 6 }}
            onClick={refreeze}
          >
            {refreezing ? 'Freezing…' : 'Freeze this job again…'}
          </button>
        )}
        {freezeError !== null && (
          <p style={WARN} data-testid="engrave-package-freeze-error">
            The package was not frozen — {freezeError}.
          </p>
        )}
        {freezeNote !== null && (
          <p style={{ ...MUTED, color: OK }} data-testid="engrave-package-reservation-note">
            {freezeNote}.
          </p>
        )}
      </section>
      </Step>

      <Step number={3} title="Register the blank" done={false} summary="left edge, then the top face" defaultOpen={green && packageCurrent}>
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

      {green && packageCurrent && plan !== null && (
        <Step
          number={4}
          title="Cut"
          done={false}
          summary={oneScreen ? 'one press' : 'the plan and the controls'}
          defaultOpen
        >
          {/* #656 — THE ONE SCREEN. The ordinary path: the program, the cutter (already confirmed at
              the prompt), the check's verdict, the dome choice when the top is curved, ONE statement
              and ONE Cut press that uploads, prepares and starts. */}
          {oneScreen && machine !== null && target !== null && singleSource !== undefined && (
            <>
              <EngraveCutConfirm
                job={job}
                machine={machine}
                source={singleSource}
                filename={releaseFileName(job.name, 1, 1, false)}
                oracle={runOracle}
                blocker={uploadBlocker ?? missingReportBlocker ?? surfaceGate}
                dome={domeProps}
                domeBlocker={domeG32Blocker}
                runContext={runContextWithDry}
                surfaceCheck={runSurfaceProgram ? { gridPitchMm: runGridPitchMm } : null}
                onLiveStatus={onLiveStatus}
              />
              <EngraveMachineRun target={target} onProgramLine={onProgramLine} />
            </>
          )}
          {/* #656 — THE EXPERT PATH, unchanged behind a disclosure: the plan, the dry-run choices,
              the manual upload with its own confirmation and cutter selector, and the multi-program
              release flow. It is open by default when the one screen is not offered (a multi-program
              job, the web build, or no machine). */}
          <details
            style={{ marginTop: 6 }}
            data-testid="engrave-cut-expert"
            open={oneScreen ? expertOpen : true}
            onToggle={(e) => setExpertOpen(e.currentTarget.open)}
          >
            <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>
              The steps — plan, dry run, manual upload and the release flow
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
              {/* #547 — the dry-run selector. Both levels fly the real XY path at a safe Z with the
                  spindle off; `traverse` plays one program, `full` the whole list. */}
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
                      : 'The whole program list plays through the release flow, bit-change prompts included.'}
                  </p>
                )}
              </div>

              {releaseSources.length > 1 ? (
                <EngraveReleaseStep
                  target={target}
                  job={job}
                  programs={releaseSources}
                  runPlan={plan}
                  blocker={releaseBlocker ?? missingReportBlocker ?? surfaceGate ?? domeG32Blocker}
                  onProgramLine={onProgramLine}
                />
              ) : (
                <EngraveMachineUpload
                  blocker={uploadBlocker ?? missingReportBlocker ?? surfaceGate ?? domeG32Blocker}
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
        </Step>
      )}
    </div>
  );
}
