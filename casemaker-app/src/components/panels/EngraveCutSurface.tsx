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

import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import type { EngraveJob, FrozenPackage } from '@/types/engraveJob';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { MachineObservation } from '@/platform/machineProbe';
import type { VerifyReport } from '@/engine/cnc/verify';
import type { FeatureKind, FeatureOverrides } from '@/engine/cnc/plan';
import type { PreflightCause } from '@/engine/cnc/preflight';
import type { PreflightHubReport } from '@/engine/cnc/preflight/hub';
import { jobMachine } from '@/engine/cnc/calibration';
import { cutPlan } from '@/engine/cnc/engrave/cutPlan';
import { packageStaleness } from '@/engine/cnc/engrave/package';
import {
  frozenReleaseSources,
  releaseFileName,
  type ReleaseSource,
} from '@/engine/cnc/engrave/release';
import { finishedProgramsFor } from '@/store/locationStore';
import type { RunContext } from '@/store/machineRunStore';
import { useEngravePackageStore } from '@/store/engravePackageStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useStockStore } from '@/store/stockStore';
import { EngravePreflight } from './EngravePreflight';
import { EngraveMachineUpload } from './EngraveMachineUpload';
import { EngraveReleaseStep } from './EngraveReleaseStep';
import { MachineStrip } from './MachineStrip';
import { RunPlanView } from './RunPlanView';

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
  const green = report.firstBlocking === null;
  const staleness = pkg === null ? null : packageStaleness(pkg, job);
  const packageCurrent = pkg !== null && staleness?.stale === false;
  const reports = useMemo(() => reportsByHash(generated), [generated]);
  const sources: ReleaseSource[] = useMemo(
    () => (pkg === null ? [] : frozenReleaseSources(job, pkg, reports)),
    [job, pkg, reports],
  );
  const generatedReady =
    generated !== null &&
    generated.ok === true &&
    generated.programs.length > 0 &&
    generated.programs.every((program) => program.verify?.ok === true);
  const missingReport = sources.find((source) => source.verify === null) ?? null;

  // A NEW PACKAGE IS A NEW RUN: the operator's strip switches are about this package's plan.
  useEffect(() => {
    setOverrides({});
  }, [pkg?.hash]);

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

  const finishedHashes = useMemo(
    () => (target === null ? [] : finishedProgramsFor(target)),
    [target],
  );
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

      <EngravePreflight report={report} onBackToDesign={onBackToDesign} />

      {green && packageCurrent && plan !== null && (
        <>
          <section style={{ marginTop: 10 }} data-testid="engrave-cut-plan">
            <RunPlanView plan={plan} />
            <MachineStrip features={plan.features} onToggle={toggle} />
          </section>

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
                  lift={{
                    zMachine: jobMachine(job).toolChange.clearanceZ,
                    zFloorMachine: jobMachine(job).softEndstop.zMin,
                  }}
                  onLiveStatus={onLiveStatus}
                  runContext={runContext}
                  jobEdgeMarginMm={job.edgeMargin}
                  onProgramLine={onProgramLine}
                />
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
