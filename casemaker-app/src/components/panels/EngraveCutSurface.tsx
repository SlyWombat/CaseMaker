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
  releaseFileName,
  type ReleaseSource,
} from '@/engine/cnc/engrave/release';
import { finishedProgramsFor } from '@/store/locationStore';
import type { RunContext } from '@/store/machineRunStore';
import { useEngravePackageStore } from '@/store/engravePackageStore';
import { useFirstRegistration } from '@/store/engraveRegistrationStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useStockStore } from '@/store/stockStore';
import type { LaserLift } from '@/platform/machineLaser';
import { EngravePreflight } from './EngravePreflight';
import { EngraveMachineUpload } from './EngraveMachineUpload';
import { EngraveReleaseStep } from './EngraveReleaseStep';
import { MachineStrip } from './MachineStrip';
import { RunPlanView } from './RunPlanView';
import { EngraveRegistrationStep } from './EngraveRegistrationStep';

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
  /** The machine the last check reached, or null. */
  machine: MachineObservation | null;
  /** Desktop build only; in the web build the plan is shown but nothing may be sent. */
  canDriveMachine: boolean;
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

export function EngraveCutSurface({
  job,
  report,
  package: pkg,
  generated,
  staleSince,
  machine,
  canDriveMachine,
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
  const green = report.firstBlocking === null;
  const staleness = pkg === null ? null : packageStaleness(pkg, job);
  const packageCurrent = pkg !== null && staleness?.stale === false;
  const reports = useMemo(() => reportsByHash(generated), [generated]);
  const sources: ReleaseSource[] = useMemo(
    () => (pkg === null ? [] : frozenReleaseSources(job, pkg, reports)),
    [job, pkg, reports],
  );
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
    generated.programs.every((program) => program.verify?.ok === true);
  const missingReport = sources.find((source) => source.verify === null) ?? null;

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

  const reservation = ((): string | null => {
    if (pkg === null) return null;
    if (pkg.stockEntryId === null) return 'This job’s stock is not a shelf entry, so no blank is held.';
    const shelf = shelfItems.find((item) => item.id === pkg.stockEntryId) ?? null;
    const held = shelf?.reservations.find((entry) => entry.jobId === job.id) ?? null;
    if (held === null) return 'The blank is not in this browser’s shelf list — check the shelf before cutting.';
    return `Held for ${job.id}${held.quantity > 1 ? ` · ${held.quantity} blanks` : ''}.`;
  })();

  const missingReportIndex =
    missingReport === null ? -1 : (pkg?.programs.findIndex((program) => program.hash === missingReport.hash) ?? -1);
  const missingReportBlocker =
    missingReport === null
      ? null
      : `program ${missingReportIndex + 1} has no verifier report in this session; generate the job again before sending it`;

  return (
    <div data-testid="engrave-cut-surface">
      {/* #524 — the Cut surface as a four-step checklist: Gate → Package → Register → Run. Each
          step is one line when done and opens when it is the step the operator is on. */}
      <Step
        number={1}
        title="Gate"
        done={green}
        summary={green ? 'clear' : `${report.errorCount} blocking finding${report.errorCount === 1 ? '' : 's'}`}
        defaultOpen={!green}
      >
        <EngravePreflight report={report} onBackToDesign={onBackToDesign} />
      </Step>

      <Step
        number={2}
        title="Package"
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
      >
        <p style={{ fontSize: 12, color: '#e6edf5', margin: '0 0 4px' }}>
          <strong>The package</strong>
          {pkg === null ? (
            <> — not frozen yet. With the gate clear, Cut freezes the job and takes its blank.</>
          ) : (
            <>
              {' '}
              — {pkg.programs.length} program{pkg.programs.length === 1 ? '' : 's'} · {pkg.setups.length} setup
              {pkg.setups.length === 1 ? '' : 's'} · frozen {clockOf(pkg.frozenAt)} · key {pkg.hash.slice(0, 8)}
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
          <p style={MUTED} data-testid="engrave-package-reservation">
            {reservation}
          </p>
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
      </Step>

      {green && packageCurrent && plan !== null && (
        <Step number={4} title="Run" done={false} summary="the plan and the controls" defaultOpen>
          <details style={{ marginTop: 4 }} data-testid="engrave-cut-plan">
            <summary style={{ fontSize: 11, color: '#9aa4b0', cursor: 'pointer' }}>The plan</summary>
            <div style={{ marginTop: 4 }}>
              <RunPlanView plan={plan} />
              <MachineStrip features={plan.features} onToggle={toggle} />
            </div>
          </details>

          {canDriveMachine && target !== null && (
            <section style={{ marginTop: 10 }} data-testid="engrave-cut-run">
              {sources.length > 1 ? (
                <EngraveReleaseStep
                  target={target}
                  job={job}
                  programs={sources}
                  runPlan={plan}
                  blocker={releaseBlocker ?? missingReportBlocker}
                  onProgramLine={onProgramLine}
                />
              ) : (
                <EngraveMachineUpload
                  blocker={uploadBlocker ?? missingReportBlocker}
                  machine={machine}
                  program={
                    sources[0]?.verify === null || sources[0] === undefined
                      ? null
                      : { nc: sources[0].nc, verify: sources[0].verify }
                  }
                  filename={releaseFileName(job.name, 1, 1)}
                  lift={lift}
                  onLiveStatus={onLiveStatus}
                  runContext={runContext}
                  setup={
                    sources[0] === undefined
                      ? undefined
                      : { setupIndex: sources[0].setupIndex, setupId: sources[0].setupId }
                  }
                  jobEdgeMarginMm={job.edgeMargin}
                  onProgramLine={onProgramLine}
                />
              )}
            </section>
          )}
        </Step>
      )}
    </div>
  );
}
