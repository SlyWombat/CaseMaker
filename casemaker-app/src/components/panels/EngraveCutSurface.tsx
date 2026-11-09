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
import { ProbeFitDiagram } from '@/components/ui/ProbeFitDiagram';
import { probeFor } from '@/engine/cnc/registration/mountContext';
import { probeInstrumentOf } from '@/engine/cnc/registration/plan';
import { planChoiceOf, type EngraveJob, type FrozenPackage } from '@/types/engraveJob';
import type { PlanTradeoff } from '@/engine/cnc/cam/model/tradeoff';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { MachineObservation } from '@/platform/machineProbe';
import { machineForJob } from '@/platform/bedProfiles';
import type { VerifyReport } from '@/engine/cnc/verify';
import type { FeatureKind, FeatureOverrides } from '@/engine/cnc/plan';
import type { PreflightHubReport } from '@/engine/cnc/preflight/hub';
import { cutPlan } from '@/engine/cnc/engrave/cutPlan';
import { laserLiftFor } from '@/engine/cnc/engrave/laserSurface';
import { packageStaleness } from '@/engine/cnc/engrave/package';
import { releaseNext } from '@/engine/cnc/engrave/release';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { formatDuration, registrationTouches } from '@/engine/cnc/plan';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import {
  frozenReleaseSources,
  releaseCheck,
  releaseFileName,
  type ReleaseSource,
} from '@/engine/cnc/engrave/release';
import type { GoalCutIntoReport } from '@/engine/cnc/engrave/designCheck';
import type { SurfaceProgramCheck } from '@/engine/cnc/uploadGate';
import { DRY_RUN_SAFE_Z, dryRunProgramFor, type DryRunLevel } from '@/engine/cnc/engrave/dryRun';
import { jobMachine } from '@/engine/cnc/calibration';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { flatEndMill } from '@/engine/cnc/tool';
import { useSettingsStore } from '@/store/settingsStore';
import { finishedProgramsFor, useLocationStore } from '@/store/locationStore';
import { machineKey, useMachineRunStore, type RunContext } from '@/store/machineRunStore';
import { useEngravePackageStore } from '@/store/engravePackageStore';
import {
  useEngraveRegistrationStore,
  useFirstRegistration,
  useSetupRegistration,
  useSurfaceSpread,
} from '@/store/engraveRegistrationStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import {
  ROTARY_NO_MODULE_REFUSAL,
  ROTARY_UNMEASURED_REFUSAL,
  firstRunError,
  runErrorCodes,
  programFrame,
  requiredAckCodes,
  surfaceRepostBlocker,
  withPeriod,
} from '@/store/engraveRunGate';
import { simErrors } from '@/engine/cnc/simGate';
import { findingFix, fixActionLabel, fixIsOffered } from './findingFix';
import { operatorRunError } from './runErrorWords';
import { useStartWizardStore } from '@/store/startWizardStore';
import { useCncModeStore } from '@/store/cncModeStore';
import { useManageModeStore } from '@/store/manageModeStore';
import { domeAcceptSentence, surfaceDomeAssumption, surfaceTiltWords } from '@/engine/cnc/engrave/surfaceSpread';
import { pcbSurfaceBudget, pcbSurfaceSentence } from '@/engine/cnc/engrave/pcbBudget';
import { effectiveMargins } from '@/engine/cnc/engrave/depthBounds';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useStockStore } from '@/store/stockStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useRunRecordStore } from '@/store/runRecordStore';
import { allRuns, lastTimedRun } from '@/engine/cnc/engrave/runHistory';
import { runSeconds, type RunRecord } from '@/engine/cnc/engrave/runRecord';
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
 *
 * #1123 item 16 (bench, 2026-11-09) — THE EXPANDER WAITS FOR A CUT. Before anything is cut there is
 * nothing turned and nothing to restate; on side 1 of a fresh job the open "I turned the stock…"
 * was noise in the step. `hasCut` is the surface's own finished-program read (the machine's
 * finished list plus the document's run log), so the control appears exactly when a turn is a real
 * next action.
 */
function TurnStockControl({ job, hasCut }: { job: EngraveJob; hasCut: boolean }): JSX.Element | null {
  if (!hasCut) return null;
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

/**
 * #927 — THE DONE CARD'S ONE TIME LINE: what the cut took against the estimate it was cut under.
 *
 * Both figures are the RECORD's own — the machine's elapsed (or the operator's minutes) and the
 * cycle estimate written when the program was posted — so the sentence can never set one job's
 * clock against another job's prediction. The line says WHICH run it is: this is the last SAVED
 * record, which is the run just finished only when its record was saved afterwards, so it is
 * dated (`cutOn`). The percentage is rounded to the whole number the example uses; a record with
 * no estimate says so rather than printing a bare clock.
 */
function actualTimeSentence(run: RunRecord | null): string {
  if (run === null) return 'No timed run recorded for this job yet.';
  const actual = runSeconds(run);
  if (actual === null) return 'No timed run recorded for this job yet.';
  const when = run.cutOn === null ? 'The recorded run' : `The run recorded on ${run.cutOn}`;
  if (run.estimatedSeconds === null || run.estimatedSeconds <= 0) {
    return `${when} took ${formatDuration(actual)} — no estimate recorded.`;
  }
  const pct = Math.round(((actual - run.estimatedSeconds) / run.estimatedSeconds) * 100);
  const direction = pct === 0 ? 'on the estimate' : `${Math.abs(pct)} % ${pct > 0 ? 'over' : 'under'}`;
  return `${when} took ${formatDuration(actual)} against ${formatDuration(run.estimatedSeconds)} predicted — ${direction}.`;
}

/**
 * #931 — WHAT THE GATE FOUND, in the three states Cut must show.
 *
 * Design's four ticks derive the same facts (`EngravePanel.tsx`'s `rowSimulated`/`rowOracle`); this
 * is their one-sentence form, and the two surfaces must never disagree about the same run.
 *
 * #925 — THE DESIGN CHECK'S SEVERITY JOINS AT THE MARKED LINE: a finding of severity `error` (the
 * sweep's unchecked-air and stall diagnostics are errors now) fails the run on its own, while a
 * `warning` never does — it leaves the oracle's verdict standing. The summary, the body sentence
 * and the fix all read this verdict, so nothing else in the surface changes.
 */
type CutVerdict =
  | 'no-program'
  | 'stale'
  | 'stopped'
  | 'passed'
  /**
   * #948 review — the program checked and the run is not wrong, but the GOAL was never compared
   * (`goalCutInto.ran === false`: a radial or exact-engine sweep the check could not sample). A
   * fourth state so the headline does not read as a pass for a check that did not happen; neutral
   * wherever it is styled.
   */
  | 'goal-unchecked'
  | 'failed'
  | 'not-checked'
  | 'simulating'
  | 'not-simulated';

/**
 * #948 — THE GOAL CHECK'S LINE, in the demo page's card's own words. The page prints the 3D goal
 * verdict beside the 2.5D one ("Matches the design", "cut into the goal … deep"); the app's card
 * says the same three facts in one line: a pass, the worst cut-into WITH where it is, or the check
 * saying it did not run — never a silent pass. The report states all three (`ran`/`reason`/
 * `maxCutIntoAt`): an unchecked goal is `ran: false` with its reason, and a comparison that ran
 * says where its deepest cut-into cell is. No report is not "not checked" — a 2.5D run has no goal
 * line at all.
 *
 * `ran` IS CHECKED BEFORE `ok` (#948 review, A): a report that did not run keeps `ok: true` (the
 * run is not wrong), and a green pass mark must never stand for a check that never happened — the
 * neutral "not checked" state is what an unchecked goal renders.
 */
interface GoalLine {
  text: string;
  state: 'match' | 'cut-into' | 'coverage' | 'not-checked';
}

/** mm, up to three decimals with trailing zeros dropped — the page's own depth format. */
const goalMm = (n: number): string => String(Number(n.toFixed(3)));

/** The page's percentage rounding: two decimals, trailing zeros dropped. */
const goalPct = (fraction: number): number => Math.round(fraction * 10000) / 100;

/**
 * The MEASURED top-surface coverage, in per cent — the page checker's own arithmetic on the
 * report's `leftoverFractions[0]` (`round(100 − round(100 × leftover > 0.1 mm, 2), 2)`), or null
 * when the report carries no leftover band. `passCoverage` is NOT this number: it is the shop's
 * pass line the check judged against.
 */
function goalCoveragePct(report: GoalCutIntoReport): number | null {
  const leftover = report.leftoverFractions[0];
  if (leftover === undefined) return null;
  return Math.round((100 - goalPct(leftover)) * 100) / 100;
}

function goalLine(report: GoalCutIntoReport | undefined): GoalLine | null {
  if (report === undefined) return null;
  if (!report.ran) {
    return {
      text: `Goal not checked: ${report.reason ?? 'the check did not run for this program'}`,
      state: 'not-checked',
    };
  }
  if (report.ok) return { text: 'Matches the design (goal)', state: 'match' };
  // #948 — THE REPORT'S OWN FAILURE. `ok` false with NO cut-into cells is the pass line's
  // coverage failing, not a cut into the part: the cut-into branch would name a 0 mm cut that never
  // happened. State the coverage the check measured against the line it judged, or the report's own
  // sentence when the leftover band is missing.
  // #964 — the card names the cell the pass JUDGED, not the raw deepest one: with the wall and
  // wall-shadow (and any edge break) exclusions the deepest raw cell can be unadjudicable.
  if (report.adjudicatedMaxMm === 0) {
    const coveragePct = goalCoveragePct(report);
    return {
      text:
        coveragePct === null
          ? report.sentence
          : `Covers ${coveragePct} % of the design’s top surface (the pass line is ${goalPct(report.passCoverage)} %)`,
      state: 'coverage',
    };
  }
  const at = report.adjudicatedMaxAt;
  return {
    text:
      at === null
        ? `Cuts ${goalMm(report.adjudicatedMaxMm)} mm into the design`
        : `Cuts ${goalMm(report.adjudicatedMaxMm)} mm into the design at ${goalMm(at.x)}, ${goalMm(at.y)}`,
    state: 'cut-into',
  };
}

/**
 * #948 — THE PAGE'S TOP-SURFACE COVERAGE FACT, in its own words. The demo page's goal cards print
 * it beside the cut-into verdict: the share of the goal's top surface the sweep leaves within 0.1 mm
 * of it — the number the card's 95 % pass line judges. The Cut card states the same one, so the app
 * is the gate and the page its mirror.
 *
 * The MEASURED coverage is the page checker's own arithmetic on the report's
 * `leftoverFractions[0]` (its `coveragePct` = 100 − 100 × leftover > 0.1 mm, rounded as it
 * rounds), because `passCoverage` is NOT the measurement: it is the number the check judged
 * AGAINST — the shop's `goal.passCoverage` default. Both are printed, so the fact states the
 * measurement and the line it is measured against rather than passing the threshold off as the
 * reading. (The page's second coverage fact, the whole-surface reach, has no field in
 * `GoalCutIntoReport`: it is the page's reading of the app's `goal-unreached` warning. A line
 * saying "not stated" on every goal run would be noise, not a fact; it gets one HERE when the
 * report carries a reach field.)
 */
/**
 * #964 — THE RAW READING, printed BESIDE the adjudicated one and never as the pass: every cell the
 * sweep left below the goal before the wall, wall-shadow (and, when the job states one, edge-break)
 * exclusions, with the page's own formats. One line, muted, under the judged line — the page prints
 * its raw line beside its `cutInto0p1` figure the same way, and the two readings differ exactly by
 * the unadjudicable cells. Null when the comparison did not run (there is no raw reading to state).
 */
function goalRawFact(report: GoalCutIntoReport): string | null {
  if (!report.ran) return null;
  const pct = Number((report.cutIntoFraction * 100).toFixed(2));
  const at = report.maxCutIntoAt;
  const where = at === null ? '' : ` at ${goalMm(at.x)}, ${goalMm(at.y)}`;
  return `raw, before exclusions: ${pct} % cut-into, max ${goalMm(report.maxCutIntoMm)} mm${where}`;
}

function goalCoverageFact(report: GoalCutIntoReport): string | null {
  const coveragePct = goalCoveragePct(report);
  if (coveragePct === null) return null;
  return `Top-surface coverage: ${coveragePct} % (the pass line is ${goalPct(report.passCoverage)} %)`;
}

function cutVerdict(v: {
  hasProgram: boolean;
  packageCurrent: boolean;
  staleSince: number | null;
  /** The pipeline refused before a program existed (`generated.ok === false`). */
  runRefused: boolean;
  /** Errors in the document findings and the verifier (not the sweep's design check). */
  errorCount: number;
  /** The design check's own errors — the sweep's diagnostics, severity `error` only (#925). */
  designErrorCount: number;
  simStopped: boolean;
  /** The oracle's verdict, or null when no report was made (not run / not reached). */
  oracleOk: boolean | null;
  /** The goal check's own state: null with no goal report, else whether the comparison ran. */
  goalRan: boolean | null;
  simStatus: string | null;
  phase: string;
}): CutVerdict {
  // An edit since the run makes every verdict below a statement about an older design.
  if (v.staleSince !== null) return 'stale';
  if (v.runRefused || v.errorCount > 0) return 'failed';
  if (!v.hasProgram) return 'no-program';
  if (!v.packageCurrent) return 'stale';
  if (v.simStopped) return 'stopped';
  // #925 — THE DESIGN CHECK'S SEVERITY: only an ERROR fails. A warning the sweep raised (a note
  // that did not undermine the verdict) leaves a passed oracle passed.
  if (v.designErrorCount > 0) return 'failed';
  if (v.oracleOk !== null) {
    if (!v.oracleOk) return 'failed';
    // #948 review (A) — A GOAL NOBODY COMPARED IS NOT A PASS for the goal. The run's `ok` stays
    // true (the program is not wrong), but the headline is what the operator reads first and what
    // the milestone gate quotes, so it must not head with the pass sentence.
    return v.goalRan === false ? 'goal-unchecked' : 'passed';
  }
  if (v.simStatus === 'ready') return 'not-checked';
  if (v.simStatus === 'refused' || v.simStatus === 'error') return 'failed';
  if (v.phase === 'simulating') return 'simulating';
  return 'not-simulated';
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
  // #788 — the probe the job will register with, from the machine it targets: null when no probe
  // is checked out, and the diagram then stays away.
  const jobProbeInstrument = useMemo(() => {
    const probe = probeFor(locationMachine ?? null);
    return probe === null ? null : probeInstrumentOf(probe);
  }, [locationMachine]);
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
  // #927 — the last measured run of THIS job's program, out of the record files this browser has
  // been handed (the panel's "Open run record…", plus whatever the readback committed). The Done
  // card prints its clock beside the estimate the record itself carries.
  const importedRecords = useRunRecordStore((s) => s.imported);
  const lastMeasuredRun = lastTimedRun(job.name, allRuns(importedRecords));
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
  // #961 — THE CARD'S MATERIAL TRADEOFF AND THE OPERATOR'S CHOICE. The run carries `planTradeoff`
  // only when the two plans' measured outcomes differ materially; the line names the outcome that
  // moved, never a cutter. The choice is the job's (`planChoiceOf`, owned by default) and the next
  // Generate posts the chosen plan.
  // #986 (the ruling) — THE IDEAL ARRIVES BEHIND THE OWNED PLAN. While the background comparison
  // runs the card says so; when it lands the line is its own, and when it finds nothing material
  // the card says that rather than nothing at all.
  const idealPlan = useEngraveRunStore((s) => s.idealPlan);
  const planTradeoff =
    idealPlan.status === 'ready'
      ? idealPlan.tradeoff
      : ((generated as { planTradeoff?: PlanTradeoff | null } | null)?.planTradeoff ?? null);
  const comparingPlans = idealPlan.status === 'comparing';
  const planChoice = useEngraveJobStore((s) => planChoiceOf(s.job));
  const setPlanChoice = useEngraveJobStore((s) => s.setPlanChoice);
  // #986 (E's review) — the press RE-RUNS the comparison with the last run's own arguments; it
  // never only records the choice.
  const comparePlans = useEngraveRunStore((s) => s.comparePlans);
  /** #656 — the verdict the one screen prints: the run store's oracle for the current package (a
   * re-post replaces it, and the sentence follows). */
  const runOracle = useEngraveRunStore((s) => s.oracle);
  // #931 — the rest of the run's verdict, for step 1's one sentence: the sweep's own state and its
  // diagnostics (the collision's sentence lives there), and whether the pipeline ever posted.
  const runSimDiagnostics = useEngraveRunStore((s) => s.simDiagnostics);
  const runSimStatus = useEngraveRunStore((s) => s.simStatus);
  const runSimStopped = useEngraveRunStore((s) => s.simStopped);
  const runPhase = useEngraveRunStore((s) => s.phase);
  const runErrorText = useEngraveRunStore((s) => s.error);
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
    // #934 — A TILT WAITS FOR THE OPERATOR. A small tilt in the low-profile vise is a seating fault
    // far more often than a blank property, so the automatic re-post does not fire: the operator
    // re-seats and registers again, or chooses "Follow the tilt". Flat and dome keep the chain.
    if (spreadAssessment?.verdict === 'tilt') return;
    chainReposted.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the one-shot post-registration re-post is guarded by `chainReposted`; the busy state it starts is the re-post's own, launched exactly once per clamping
    repost();
    // `repost` is re-created each render; the ref makes this a one-shot per clamping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstRegistration, registrationSurface, surfaceGate, spreadAssessment?.verdict]);

  /** #934 — "Follow the tilt": the operator's choice runs the re-post the chain withheld. */
  const followTilt = (): void => {
    chainReposted.current = true;
    repost();
  };
  /** #934 — "Register again": the registration's own Start is the control; press it where it stands. */
  const registerAgain = (): void => {
    const start = document.querySelector<HTMLButtonElement>('[data-testid="engrave-registration-start"]');
    start?.scrollIntoView({ block: 'center' });
    start?.click();
  };

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
  /**
   * #1088 — WHICH SETUP'S PROGRAMS ARE NEXT. The release's next unfinished program is the same
   * setupIndex the run sheet prints; with no release planned yet, the first frozen source's setup.
   * The Register card registers THIS setup, and its done state is THIS setup's registration —
   * side 2 of a flip job must not pass on side 1's record.
   */
  const releaseRecord = useEngraveReleaseStore((s) => (target === null ? undefined : s.records[machineKey(target)]));
  const currentSource =
    releaseRecord === undefined || releaseRecord.files.length === 0
      ? (sources[0] ?? null)
      : (releaseNext(releaseRecord.files) ?? releaseRecord.files.at(-1) ?? null);
  const currentSetupIndex = currentSource?.setupIndex ?? 1;
  const currentSetupId = currentSource?.setupId ?? job.setups?.[currentSetupIndex - 1]?.id ?? null;
  const currentSetupRegistration = useSetupRegistration(job.id, currentSetupId, target);
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
      // #1123 item 7 (bench, 2026-11-09) — THE SHELF FACT, NOT A HOLDING CLAIM. The old sentence
      // ("You're supplying this stock yourself, so no blank needs to be held") read as "nothing
      // holds the blank" on a bracket job whose blank is clamped in the bracket. This states only
      // what is true of the shelf: the blank is not on it.
      return { line: 'This blank is not on the shelf — nothing to take from it.', detail: null };
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
  // #931 — WHAT THE SIMULATION SAID, for step 1's summary and its body. One view of the run, so
  // the sentence Cut prints is the same one Design's run rows read (`firstRunError`'s owner).
  const runView = {
    generated,
    oracle: runOracle,
    simDiagnostics: runSimDiagnostics,
    simStatus: runSimStatus,
    phase: runPhase,
    acknowledged,
    staleSince: staleSince ?? null,
    error: runErrorText,
  };
  const firstError = firstRunError(runView);
  // #925 — the sweep's errors are the design check's own, and the verdict names them at its marked
  // line; the document and verifier errors are the rest.
  const designErrorCount = simErrors(runSimDiagnostics).length;
  const otherErrorCount = runErrorCodes({ ...runView, simDiagnostics: [] }).length;
  const goalCheck = runOracle?.goalCutInto ?? null;
  const goalNotComparedWhy = goalCheck?.reason ?? 'the check did not run for this program';
  const verdict = cutVerdict({
    hasProgram: pkg !== null,
    packageCurrent,
    staleSince: staleSince ?? null,
    runRefused: generated !== null && !generated.ok,
    errorCount: otherErrorCount,
    designErrorCount,
    simStopped: runSimStopped,
    oracleOk: runOracle === null ? null : runOracle.ok,
    goalRan: goalCheck === null ? null : goalCheck.ran,
    simStatus: runSimStatus,
    phase: runPhase,
  });
  // #948 — the goal check's line, under the gate's verdict (the cutVerdict three-state is not
  // touched): a pass, the worst cut-into with its location, or why the check did not run — then the
  // page's two coverage facts for a report the comparison actually produced.
  const goal = goalLine(runOracle?.goalCutInto);
  // #964 — the RAW reading beside the judged line (never the pass), stated only for a report the
  // comparison ran on.
  const goalRaw =
    runOracle?.goalCutInto !== undefined && runOracle.goalCutInto.ran
      ? goalRawFact(runOracle.goalCutInto)
      : null;
  const goalCoverage =
    runOracle?.goalCutInto !== undefined && runOracle.goalCutInto.ran
      ? goalCoverageFact(runOracle.goalCutInto)
      : null;
  const verdictFix = verdict === 'failed' && firstError !== null ? findingFix(firstError) : null;
  // The press does what the fix names: a wizard step opens where the fix lives; every other target
  // is a control in the Design panel, so the press shows it.
  const verdictFixLabel =
    verdictFix === null ? null : verdictFix.openWizardStep !== undefined ? fixActionLabel(verdictFix) : 'Show it in Design';
  const applyVerdictFix = (): void => {
    if (verdictFix === null) return;
    if (verdictFix.openWizardStep !== undefined) {
      useStartWizardStore.getState().openWizard(verdictFix.openWizardStep);
    } else {
      useCncModeStore.getState().show('design');
    }
  };
  // Step 1 is DONE only when the gate passed: a program that was never simulated, stopped, or
  // failed keeps the step open — that is the whole point of this issue.
  const fitDone = checked && frozen && verdict === 'passed';
  const registrationPlan = job.setups?.[0]?.registration?.plan ?? null;
  // A registration is a measurement on THIS machine; with no machine connected, a record for this
  // job still says the blank was registered in this session. #1088 — the record must be the
  // SELECTED setup's: setup 2 is not registered because setup 1 is. Setup 1 reads exactly as it
  // always has (`firstRegistration`, the job-keyed entry, including a record written before the
  // per-setup key existed); a later setup reads its own key and nothing else.
  const registeredSetup = currentSetupIndex === 1 ? (currentSetupRegistration ?? firstRegistration) : currentSetupRegistration;
  const registered = registeredSetup !== null || (target === null && currentSetupIndex === 1 && anyRegistration !== null);
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
  // #931 — "matches the design" is the ORACLE's word, earned only by a passed run. `frozen` says
  // the package still describes this job; it says nothing about whether anything checked it.
  if (verdict === 'passed') readiness.push('matches the design');
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
        : verdict === 'goal-unchecked'
          ? `Program checked — the goal was not compared (${goalNotComparedWhy})`
          : verdict === 'failed'
          ? 'did not pass'
          : verdict === 'stopped'
            ? 'the simulation stopped before it finished'
            : verdict === 'simulating'
              ? 'simulating…'
              : verdict === 'not-checked'
                ? 'not checked against the design yet'
                : verdict === 'not-simulated'
                  ? 'not simulated'
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
        {/* #927 — the ONE line the done screen adds: the last measured run's clock against the
            estimate its record carries. Nothing else on the card changes. */}
        <p style={{ margin: '0 0 6px', fontSize: 12, color: '#9aa4b0' }} data-testid="engrave-cut-actual-time">
          {actualTimeSentence(lastMeasuredRun)}
        </p>
        <EngraveMachineRun target={target} onProgramLine={onProgramLine} />
      </div>
    );
  }

  return (
    <div data-testid="engrave-cut-surface">
      {/* #524/#689 — the Cut surface as a four-line checklist: Checked → Frozen → Register the
          blank → Run. Each line is one sentence; only the step the operator is on has a body. */}
      <Step number={1} title="Fit and clamp" done={fitDone} current={currentStep === 1} summary={step1Summary}>
        {/* #931 — THE GATE'S VERDICT, before anything else step 1 asks. Only a passed run earns
            "matches the design"; a failed one says so with the first sentence the run produced and
            the press that resolves it; a run that never finished says which. */}
        {verdict === 'failed' ||
        verdict === 'stopped' ||
        verdict === 'simulating' ||
        verdict === 'not-checked' ||
        verdict === 'not-simulated' ? (
          <div style={{ ...BOX, marginTop: 6 }} data-testid="engrave-cut-verdict" data-state={verdict}>
            <p
              style={verdict === 'failed' ? WARN : MUTED}
              data-testid="engrave-cut-verdict-line"
            >
              {verdict === 'failed'
                ? 'The simulation did not pass.'
                : verdict === 'stopped'
                  ? 'The simulation stopped before it finished.'
                  : verdict === 'simulating'
                    ? 'The simulation is running…'
                    : verdict === 'not-checked'
                      ? 'The program has not been checked against the design yet.'
                      : 'The program has not been simulated.'}
            </p>
            {verdict === 'failed' && firstError !== null && (
              <p style={MUTED} data-testid="engrave-cut-verdict-sentence">
                {operatorRunError(firstError.message)}
              </p>
            )}
            {verdict === 'failed' && verdictFix !== null && fixIsOffered(verdictFix) && verdictFixLabel !== null && (
              <button type="button" data-testid="engrave-cut-verdict-fix" onClick={applyVerdictFix}>
                {verdictFixLabel}
              </button>
            )}
          </div>
        ) : null}
        {/* #948 — THE GOAL CHECK'S LINE, under the gate's verdict. The demo page's cards carry the
            3D goal verdict beside the 2.5D one; this is the same reading in the page's words, so a
            goal run says a pass, the worst cut-into and where it is, or that the check did not run
            (never a silent pass). A 2.5D run has no goal report and gets no line. */}
        {goal !== null && (
          <p
            style={
              goal.state === 'cut-into' || goal.state === 'coverage'
                ? WARN
                : goal.state === 'match'
                  ? { ...MUTED, color: OK }
                  : MUTED
            }
            data-testid="engrave-cut-goal"
            data-state={goal.state}
          >
            {goal.text}
          </p>
        )}
        {/* #964 — the RAW goal reading beside the judged line: one muted fact, labelled, never the
            verdict. The page prints its raw line beside `cutInto0p1` the same way; the difference
            between them is exactly the unadjudicable cells (wall, wall shadow, stated edge break). */}
        {goalRaw !== null && (
          <p style={MUTED} data-testid="engrave-cut-goal-raw">
            {goalRaw}
          </p>
        )}
        {/* #948 — the page's top-surface coverage fact, under the goal line. Only a report the
            comparison ran on states it: an unchecked goal has no coverage to print (its numbers are
            zero by construction), and a 2.5D run has no goal report at all. */}
        {goalCoverage !== null && (
          <p style={MUTED} data-testid="engrave-cut-goal-coverage">
            {goalCoverage}
          </p>
        )}
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
            registration. A turn restates the box; the program goes stale with its own reason.
            #1123 item 16 — only after something has been cut, and only THIS package's programs:
            `finishedHashes` also carries the MACHINE's finished list (every job ever run there),
            so a bare non-empty check would open the expander on a fresh job that never cut. */}
        <TurnStockControl
          job={job}
          hasCut={pkg !== null && pkg.programs.some((program) => finishedHashes.includes(program.hash))}
        />
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
            {/* #788 — the ask above is where the probe is fitted, so the head diagram stands with
                it, drawn for the probe the job will use; a job with no probe checked out gets no
                diagram. */}
            <ProbeFitDiagram compact instrument={jobProbeInstrument} />
          </div>
        )}
        {/* #796 — THE PROGRAM, AS ONE CARD WITH ONE ACTION. Checked and Frozen were two steps;
            the readiness line says the first half, and a program older than the design says the
            second HERE — press Generate (the same button Design's footer carries) and the freeze
            follows it. A program that matches the design needs no card; only the blank's hold is
            stated. */}
        {comparingPlans && (
          <section style={{ ...BOX, marginTop: 6 }} data-testid="engrave-plan-comparing">
            <p style={MUTED}>comparing the plans…</p>
          </section>
        )}
        {idealPlan.status === 'ready' && (planTradeoff === null || !planTradeoff.material) && (
          <section style={{ ...BOX, marginTop: 6 }} data-testid="engrave-plan-no-difference">
            <p style={MUTED}>with every bit the app knows: no material difference</p>
          </section>
        )}
        {planTradeoff?.material && planTradeoff.line !== null && (
          <section style={{ ...BOX, marginTop: 6 }} data-testid="engrave-plan-tradeoff">
            <p style={MUTED}>{planTradeoff.line}</p>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button
                type="button"
                data-testid="engrave-plan-owned"
                aria-pressed={planChoice === 'owned'}
                onClick={() => setPlanChoice('owned')}
                style={{ flex: 1, padding: 7 }}
              >
                My tools{planChoice === 'owned' ? ' — chosen' : ''}
              </button>
              <button
                type="button"
                data-testid="engrave-plan-ideal"
                aria-pressed={planChoice === 'ideal'}
                onClick={() => {
                  setPlanChoice('ideal');
                  comparePlans();
                }}
                style={{ flex: 1, padding: 7 }}
              >
                Every bit the app knows{planChoice === 'ideal' ? ' — chosen' : ''}
              </button>
            </div>
          </section>
        )}
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
        <EngraveRegistrationStep job={job} target={target} setupIndex={currentSetupIndex} />
        {/* #608 / #796 — once the registration measured a tilt, the program made for a flat blank
            must be RE-MADE for the measured tilt before anything is uploaded. A re-make re-runs
            the whole pipeline with the fitted plane and freezes it; a flat fit never shows this
            block, and a program that already follows the tilt shows only the "re-made" line. */}
        {registrationSurface !== null && (
          <section style={BOX} data-testid="engrave-cut-repost">
            {surfaceGate !== null ? (
              spreadAssessment?.verdict === 'tilt' ? (
                <>
                  {/* #934 — RE-SEAT BEFORE THE RE-POST. The automatic chain waits here: a tilt in
                      the vise is a seating fault more often than a blank property. */}
                  <p style={{ fontSize: 12, color: '#f0d79b', margin: '0 0 6px' }} data-testid="engrave-cut-reseat">
                    Re-seat the blank (press down on the low side) and register again — or follow the
                    tilt{tiltWords !== null ? ` (${tiltWords})` : ''}.
                  </p>
                  <p style={WARN} data-testid="engrave-cut-repost-gate">{surfaceGate}.</p>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button type="button" data-testid="engrave-cut-reseat-register" onClick={registerAgain}>
                      Register again
                    </button>
                    <button
                      type="button"
                      data-testid="engrave-cut-reseat-follow"
                      disabled={reposting || !generatedReady}
                      onClick={followTilt}
                    >
                      {reposting ? 'Re-making…' : 'Follow the tilt…'}
                    </button>
                  </div>
                </>
              ) : (
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
              )
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
