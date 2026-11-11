/**
 * #495 — THE REGISTRATION STEP, from the Cut screen: run the setup's APPROVED registration plan on
 * the machine, show what every touch found, and — only from a measurement inside the margin — write
 * the origin and record the outcome for the release step.
 *
 * WHERE THE PLAN COMES FROM. `job.setups[0].registration.plan` is the plan the Setups section
 * planned and the operator approved (#471). It is deliberately NOT re-derived here: a location's
 * `registration.*` settings can move, and re-planning would silently replace the steps that were
 * approved. A job with no approved plan shows that sentence and runs nothing.
 *
 * WHAT IT RUNS. `runRegistration(plan)` (#430, J17's executor) — home, fit the wired probe, M491,
 * the surface seek, the edge scans, and home again — over the same `attachConsole` the rest of the
 * app uses. The executor polls `?` and stops on an alarm; this component adds only the operator
 * prompts it cannot make and the display of what came back.
 *
 * WHAT IT WRITES. `applyCorrection(outcome, …)` is called only when the measurement is usable AND
 * every measured deviation is inside the plan's margin (#495 §4: a spread wider than the band is a
 * refusal, not an origin). It writes `G10 L2 P1 X Y Z` in #387's order, after the cutter's own
 * `M491`, and only after the operator presses the button. The outcome is then recorded in
 * `engraveRegistrationStore` — the ONE registration record #494's release gate reads. An unusable
 * or out-of-margin measurement writes nothing and records nothing, so the release stays blocked.
 *
 * #638 — THE PLACEMENT FRAME WAITS FOR THE ACCEPTANCE. The vise placement frame and the surface top
 * are the house records a LATER plan and every later jaw tap are aimed from, so they follow the same
 * rule as the origin: a run whose XY is outside the margin writes neither (the operator is about to
 * re-seat the blank, and "Re-seat it" must not leave the record pointing at where the blank used to
 * be). They are held on the pending result and written when the operator accepts the measurement —
 * "Use the found position" (#620), or the ordinary Write once the margin has cleared. The record's
 * plan is the one the measurement RAN under, stashed at start(), never the render-time one a later
 * edit could have replaced.
 *
 * `RegistrationOutcome` is SESSION state (#495 decision): the document holds the approved plan, not
 * the last measurement.
 *
 * #475 — THE CUT-EXTENT SPREAD. The same run also measures the surface at the cut regions' extents
 * (`surfaceSpreadPlan(job)` at the approved plan's touch count and the house boundary margin the
 * sheet uses), reusing the executor's
 * `seekSurface` and its #430 bounds. The step shows the min/max/spread and the band; Z0 in the
 * recorded outcome is the LOWEST touch. A spread wider than the band is a DOME (#631): the origin
 * is still written (Z0 = lowest) and the machine levels the top itself (`G32`), while the plane
 * re-post is refused and the program uploads FLAT. The measured
 * spread is written to `stock.flatness` (`source: 'measured'`) and kept in the store for the run
 * sheet, which prints the measured landing range.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type JSX } from 'react';
import { useRegistrationPromptStore } from '@/store/registrationPromptStore';
import type { EngraveJob } from '@/types/engraveJob';
import { probeInstrumentOf, type RegistrationPlan } from '@/engine/cnc/registration/plan';
import { expectedTopOf, thicknessNote } from '@/engine/cnc/registration/thicknessNote';
import { readDefault } from '@/platform/defaultsClient';
import { implicitJobSetup, implicitSetupFor, registrationOf } from '@/engine/cnc/registration/implicitSetup';
import type { MountSpec, Setup } from '@/engine/cnc/setups';
import type { RegistrationOutcome } from '@/engine/cnc/registration/outcome';
import { summarizeOutcome, summarizePlan } from '@/engine/cnc/registration/summary';
import { canonicalJson } from '@/engine/cnc/engrave/package';
import {
  applyCorrection,
  runFlipRegistration,
  runRegistration,
  type ApplyResult,
  type OperatorStep,
  type RunResult,
} from '@/engine/cnc/registration/execute';
import { planFlipAttemptForJob, type FlipAttemptResult } from '@/engine/cnc/registration/flipAttempt';
import { flipZ0, type FlipZ0 } from '@/engine/cnc/engrave/flipChoice';
import { attachConsole, STATUS_POLL_TIMING, type ConsoleHandle } from '@/platform/machineConsole';
import { stopProgram, stopSettings, type StopOutcome } from '@/platform/machineStop';
import { controllerState } from '@/platform/machineUpload';
import { effectiveMargins } from '@/engine/cnc/engrave/depthBounds';
import {
  surfaceDomeGuidance,
  surfaceFitForPost,
  surfaceMarginWords,
  surfaceSpreadPlan,
} from '@/engine/cnc/engrave/surfaceSpread';
import { isSideGoal, jobTargetObjects, jobTool } from '@/engine/cnc/engrave/jobSetup';
import { useToolRegistry } from '@/hooks/useToolRegistry';
import { jobVise } from '@/engine/cnc/fixture';
import { cuttingDiameter } from '@/engine/cnc/tool';
import { shopDefault, useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { registrationKey, useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
// #1123-40 — THE REGISTRATION MEMO: the record kept on the house's machine record, restored on a
// reload only while the machine's G54 X/Y still matches the one its origin write left.
import {
  assessRegistrationMemo,
  memoFromRecord,
  registrationMemoFor,
  restoredRegistration,
  withRegistrationMemo,
  type RegistrationAnswer,
  type RegistrationMemoVerdict,
} from '@/platform/registrationMemo';
import { readStatusLine, workOffset } from '@/platform/desktop/protocol';
import {
  createFirstBed,
  machineAt,
  machineRecordByProfile,
  saveMachineWithRetry,
  useLocationStore,
  visePlacementFrameOf,
  type MachineUpdate,
} from '@/store/locationStore';
import {
  accessoryNameFor,
  bracketSeatDatumFor,
  bracketPlacementSeedFor,
  mountDatumFor,
  mountDatumMismatch,
  mountTapFor,
  probeFor,
  probeNameFor,
  recordProbeReading,
  surfaceTopDatumFor,
} from '@/engine/cnc/registration/mountContext';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { registrationTouches } from '@/engine/cnc/plan';
import { faceUpOf, planFromSetups, setupsSettings } from '@/engine/cnc/setups';
import { jobMachine } from '@/engine/cnc/calibration';
import { clearanceZOf, rotaryOf } from '@/engine/cnc/machine';
import { planRegistrationAttempt } from './registrationAttempt';
import { blankScopeFor } from '@/engine/cnc/registration/blankIdentity';
import { RotaryAxisTap } from '@/components/manage/RotaryAxisTap';
import { RotaryFaceAngleTap } from '@/components/manage/RotaryFaceAngleTap';
import type { RegistrationAttempt } from './EngraveSetupRow';
import {
  viseFrameFromRegistration,
  withBracketPlacementSeed,
  withSurfaceTopDatum,
  withVisePlacementFrame,
} from '@/platform/bedProfiles';
import { gridSeeds } from '@/engine/cnc/registration/placing';
import { useMachineTranscriptStore } from '@/store/machineTranscriptStore';
import { useMachineStopReportStore } from '@/store/machineStopReportStore';
// #1187 — a stopped action's own report (the transport/controller error's card action).
import { StopReportAction } from '@/components/panels/StopReportAction';
import { stopIsReportable } from '@/platform/machineStopReport';
// #1202 + #1199 item 3 — the dry line view and the first-run mark.
import { dryFlipRegistration, dryMountTap, dryRegistration, previewHolds, type DryRoutine } from '@/engine/cnc/registration/dryRun';
import { seatTapArgs } from '@/engine/cnc/registration/seatPress';
import { RoutineDryPreview } from './RoutineDryPreview';
import { buildStamp, routineCompleted, withRoutineCompletion } from '@/platform/routineRecord';
import { firstRunAutomationRefusal } from '@/platform/automation';
import { useMachineStore } from '@/store/machineStore';
import { useRegistrationTouchesStore } from '@/store/registrationTouchesStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import { toolNumberFor } from '@/engine/cnc/cam/ir';
import { benchCutterFor } from '@/engine/cnc/toolRegistry';
// #1082 — the proposal is planned through the part plan, which typesets every label; on a cold
// paint of the Cut surface the bundled faces may not be parsed yet and `resolveFont` throws by
// design. Wait for the faces (this card may be the first thing the operator opens) and propose
// once they land — the same guard the Setups section carries.
import { ensureLabelFontsLoaded, facesLoadedEpoch, labelFontsLoaded, subscribeFacesLoaded } from '@/engine/fonts/registry';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };
const BOX: CSSProperties = {
  marginTop: 6,
  padding: 8,
  border: '1px solid #3a4552',
  borderRadius: 4,
  background: '#1b2027',
};
const OK = '#9fd19b';
const BAD = '#f0b4ad';
const WARN = '#e0c07a';


export interface EngraveRegistrationStepProps {
  /** The job whose approved setup-1 registration is run. */
  job: EngraveJob;
  /** Where the machine was last reached, or null. The step cannot do anything without one. */
  target: { host: string; port: number } | null;
  /**
   * #1088 — WHICH SETUP'S PROGRAMS ARE NEXT, 1-based — the Cut screen's own setup source (the index
   * the run sheet prints, from the release's next unfinished program). A flipped setup registers on
   * its bores; any other setup keeps the step's existing path, whose plan is setup 1's. Defaults to
   * setup 1 for every caller that has no such notion.
   */
  setupIndex?: number;
}

type Phase = 'idle' | 'running' | 'measured' | 'writing' | 'recorded' | 'failed';

const n = (v: number): string => String(Math.round(v * 1000) / 1000);

/** #797 follow-up — the plan in one line: where it touches, how many touches, which probe. */
function proposalLine(plan: RegistrationPlan): string {
  // #1200 — a unit the operator restricted says so before the press: "3D probe · top touches only".
  const restricted = plan.probe?.touches === 'z-only';
  const probeWords = `${probeInstrumentOf(plan.probe) === 'xyz' ? '3D probe' : 'wired probe'}${restricted ? ' · top touches only' : ''}`;
  // #1201 — THE GUARDED TOP SEEK: no seat, two touches ON the blank. The machine XY of each is
  // stated before the press (the work points carried by the plan, offset by the bracket's origin).
  if (plan.guarded !== undefined) {
    const p3 = (v: number): string => String(Math.round(v * 1000) / 1000);
    const origin = plan.bracketOrigin;
    const at = (point: { x: number; y: number }): string =>
      origin === null
        ? `(${p3(point.x)}, ${p3(point.y)})`
        : `machine X ${p3(origin.x + point.x)}, Y ${p3(origin.y + point.y)}`;
    const points = (plan.surfaceChecks ?? []).map(at);
    return `the top on the blank — ${points.length === 0 ? 'two touches' : points.join(' and ')} · ${probeWords}`;
  }
  const order = ['left', 'front', 'right', 'back'] as const;
  const edges = order.filter((edge) => plan.scans.some((scan) => scan.edge === edge));
  const touches = registrationTouches({ ok: true, plan });
  const touchWords = `${touches} touch${touches === 1 ? '' : 'es'}`;
  const list =
    edges.length === 0
      ? 'no edge scan'
      : edges.length === 1
        ? `${edges[0]} edge`
        : `${edges.slice(0, -1).join(', ')} and ${edges.at(-1)} edges`;
  // #1179 amendment (2026-11-10) — WHERE it will touch, before the press, so the operator can
  // clear those spots: chips collect against the edges, and the bench's first check was the
  // front-left corner. The inset is the nearest check's distance to any stock edge (the candidates
  // prefer 10 mm; a narrow uncut area relaxes to the 3 mm margin).
  const checks = plan.surfaceChecks ?? [];
  if (checks.length > 0) {
    const inset = Math.round(
      Math.min(
        ...checks.map((c) =>
          Math.min(c.x - plan.stock.xMin, plan.stock.xMax - c.x, c.y - plan.stock.yMin, plan.stock.yMax - c.y),
        ),
      ),
    );
    return `${list}, then the top · ${touchWords} · ${probeWords} — the checks touch at least ${inset} mm in from the stock's edges`;
  }
  return `${list}, then the top · ${touchWords} · ${probeWords}`;
}

/**
 * #1088 — A FLIPPED SETUP IS SIDE 2's, AND SIDE 2 REGISTERS ON THE BORES. The step's side-1 routine
 * (`runRegistration` over `setups[0].registration.plan`) would aim its touches at a part that is no
 * longer in that pose, so a flipped setup runs `runFlipRegistration` over the flip plan instead —
 * built here from the setup's stored pins and the carried Z0 (see `planFlipAttemptForJob`), never
 * from side 1's plan. A flip this job cannot state (no pins, no measured probe tip, no carried Z0)
 * is refused by name and sends nothing.
 */

/** The plan the Setups section approved for the job's first setup, or why there is none. */
function approvedPlan(job: EngraveJob): { plan: RegistrationPlan | null; why: string | null } {
  if (job.setups === undefined) {
    return {
      plan: null,
      why: 'This job has no saved setup yet. Plan its registration in Design → Setups, approve it, then run it here.',
    };
  }
  const registration = job.setups[0]?.registration;
  if (registration === undefined) {
    return {
      plan: null,
      why: 'Setup 1 has no approved registration plan. Plan and approve it in Design → Setups, then run it here.',
    };
  }
  return { plan: registration.plan, why: null };
}

/**
 * Whether the origin may be written from this measurement.
 *
 * `usable` is the executor's own rule (every edge bracketed, every axis measured, every touch where
 * it was sent). A measurement outside the edge margin is still "usable" but is exactly the refusal
 * #495 §4 names, so it gets no origin. The one exception is the bracket's X/Y taken on trust: there
 * is no measured deviation to be outside a margin when the confirming touch was not taken.
 *
 * #631 — a dome no longer refuses the origin: Z0 is the lowest touch and the machine levels the top
 * itself, so the surface verdict is not part of this question.
 */
function writerRefusal(outcome: RegistrationOutcome): string | null {
  if (!outcome.usable) {
    return `No origin is written from this measurement: ${outcome.problems.join('; ')}.`;
  }
  const measuredXY = outcome.bracketCheck !== undefined || outcome.currentG54 !== null;
  if (measuredXY && !outcome.withinMargin) {
    return `No origin is written: the stock is outside the ${n(outcome.margin)} mm margin. ${summarizeOutcome(outcome)} Re-seat it and run the registration again.`;
  }
  return null;
}

/** #620 — the refusal is ONLY the margin: usable, measured XY but out of margin. */
function marginRefusal(outcome: RegistrationOutcome): boolean {
  if (!outcome.usable) return false;
  const measuredXY = outcome.bracketCheck !== undefined || outcome.currentG54 !== null;
  return measuredXY && !outcome.withinMargin;
}

export function EngraveRegistrationStep({ job, target, setupIndex = 1 }: EngraveRegistrationStepProps): JSX.Element {
  const { plan, why } = approvedPlan(job);
  const setupNumber = Number.isInteger(setupIndex) && setupIndex >= 1 ? setupIndex : 1;
  /** The setup the Cut screen says is next; its id is where its registration is filed. */
  const selectedSetup = job.setups?.[setupNumber - 1] ?? null;
  // #797 follow-up — THE REGISTER CARD HOLDS THE ACTION. With no approved plan, the planner's
  // proposal is computed HERE, from the same machine record, shop defaults and engine call the
  // Setups section previews, and shown in one line. One press approves it and starts the run;
  // Design → Setups stays the place to edit it.
  const defaults = useShopDefaultsStore((s) => s.defaults);
  const calibration = useSettingsStore((s) => s.machineCalibration);
  // #1202 — a LIVE subscription: the first-run mark is read from this machine's record, and the
  // location may arrive after the card mounts (a fresh load). A one-shot read left the mark stuck
  // on "never run" even when the record already said it had.
  const machineRecord = useLocationStore((s) =>
    target === null
      ? null
      : s.location?.machines.find((m) => m.address?.host === target.host && m.address.port === target.port) ?? null,
  );
  /**
   * #1179 D/B4 — THE LAST TOP RECORDED FOR THIS BLANK. A finished run of this job keeps the top its
   * origin was accepted at (`registration.surfaceMachineZ`, measured or derived); the derived offer
   * continues from THAT top rather than from seat + stated thickness.
   */
  const lastRecordedTop = useMemo(() => {
    let latest: { at: string; machineZ: number; probeRefZ: number | null } | null = null;
    for (const run of machineRecord?.finishedRuns ?? []) {
      if (run.jobId !== job.id) continue;
      const machineZ = run.registration?.surfaceMachineZ;
      if (machineZ === undefined) continue;
      const at = run.finishedAt ?? '';
      // #1189 — the seating the recorded top was read in; the executor corrects the raw value by
      // today's M491, and refuses to use it at all when the record carries no reference.
      const probeRefZ = run.registration?.probeRefZ ?? null;
      if (latest === null || at >= latest.at) latest = { at, machineZ, probeRefZ };
    }
    return latest;
  }, [machineRecord, job.id]);
  const lastRecordedTopMachineZ = lastRecordedTop?.machineZ ?? null;
  const lastRecordedTopProbeRefZ = lastRecordedTop?.probeRefZ ?? null;
  const probe = useMemo(() => probeFor(machineRecord), [machineRecord]);
  const mountDatum = useMemo(() => mountDatumFor(machineRecord), [machineRecord]);
  const mountDatumMismatchBy = useMemo(() => mountDatumMismatch(machineRecord), [machineRecord]);
  const mountDatumMismatchName = useMemo(
    () => (mountDatumMismatchBy === null ? null : accessoryNameFor(mountDatumMismatchBy)),
    [mountDatumMismatchBy],
  );
  const surfaceTopZ = useMemo(() => surfaceTopDatumFor(machineRecord), [machineRecord]);
  // #509 — the bracket's seat from the ACTIVE bed profile (bracket seat, else surface top).
  const bracketSeat = useMemo(() => bracketSeatDatumFor(machineRecord), [machineRecord]);
  const placedSeed = useMemo(() => bracketPlacementSeedFor(machineRecord), [machineRecord]);
  const registrations = useEngraveRegistrationStore((s) => s.records);
  // #1123-40 — the per-setup records, so a restored side 2 is filed where #1088 reads it.
  const bySetup = useEngraveRegistrationStore((s) => s.bySetup);
  // #1123-40 — THE SETUP THIS CARD IS ABOUT: side 2's flipped setup follows the Cut screen's index;
  // every other card registers setup 1's approved plan. The memo is looked up under BOTH the setup's
  // id (the store's key) and its 1-based index (the Cut screen's name for it).
  const flippedSetup = job.setups?.[setupNumber - 1]?.flip !== undefined;
  const registrationSetup = flippedSetup ? (job.setups?.[setupNumber - 1] ?? null) : (job.setups?.[0] ?? null);
  const registrationSetupIndex =
    registrationSetup === null ? 1 : (job.setups?.findIndex((s) => s.id === registrationSetup.id) ?? 0) + 1;
  // #1179 blank identity (the analyst's fields, issue comment 6776457695) — THE GUARD READS THE
  // BLANK, NOT THE MACHINE. `blankScopeFor` is the one reading of `currentBlank`/`blankId`/`cutMaps`:
  // a job WITH an id scopes to that id (legacy and other-blank entries are out of scope by
  // construction); a job WITHOUT one takes the safe default — legacy finished entries mean the
  // blank MAY have been cut, so the unknown-cuts path runs and the "new blank" press is offered.
  // The same entry feeds stage 2's candidates, so the card cannot say "nothing has cut" and then
  // plan three touches.
  const blankScope = useMemo(
    () =>
      blankScopeFor({
        machine: machineRecord,
        jobId: job.id,
        setupIndex: registrationSetupIndex,
        packageHashes: (job.package?.programs ?? []).map((program) => program.hash),
        runLogFinished: (job.runLog ?? []).some((entry) => entry.outcome === 'finished'),
      }),
    [machineRecord, job.id, registrationSetupIndex, job.package, job.runLog],
  );
  /** True when the next registration measures a blank that has already been cut. */
  const hasFinishedPrograms = blankScope.cutsOnThisBlank;
  // The heartbeat's answer and its status line, for the memo's G54 check — the same 2 s read the
  // status strip draws, never a new socket.
  const heartbeat = useMachineStore((s) => s.heartbeat);
  const liveMachine = useMachineStore((s) => s.machine);
  const restoreJob = useEngraveRegistrationStore((s) => s.restoreJob);
  const restoreSetup = useEngraveRegistrationStore((s) => s.restoreSetup);
  const [restoreVerdict, setRestoreVerdict] = useState<RegistrationMemoVerdict | null>(null);
  /** #1179 — the sentence after the "This is a new blank" / registration mint. */
  const [blankNote, setBlankNote] = useState<string | null>(null);

  // #1123-40 — RESTORE FROM THE HOUSE, ONCE THE MACHINE HAS SAID WHERE ITS G54 IS. The memo is the
  // record this job's setup last wrote — the plan, the outcome, the measuredAt. It is put back only
  // when the machine's live `MPos − WPos` (#933) still equals the X/Y the G10 line wrote. A moved
  // G54, an unreachable machine, or a line without both positions restores nothing: the card says
  // why, and the job is registered again.
  useEffect(() => {
    if (target === null || registrationSetup === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the verdict is derived from the location, registration and machine stores together; there is no render-time seam that sees all three without writing this one piece of view state
      setRestoreVerdict(null);
      return;
    }
    const memo = registrationMemoFor(machineRecord, job.id, registrationSetup.id);
    // BOTH halves of the key must agree: the setup's id (the store's key) and its 1-based index.
    // A reordered setup list moves the index and refuses the restore — safe, never a swapped side.
    if (memo === null || memo.setupIndex !== registrationSetupIndex) {
      setRestoreVerdict(null);
      return;
    }
    const existing = flippedSetup
      ? bySetup[registrationKey(job.id, registrationSetup.id)]
      : registrations[job.id];
    const existingHere =
      existing !== undefined && existing.target.host === target.host && existing.target.port === target.port;
    if (existingHere) {
      // A record for this machine is already in the session — the run's own UI speaks for it. The
      // one this effect restored keeps its provenance line.
      if (existing.restored === undefined) setRestoreVerdict(null);
      return;
    }
    const answer: RegistrationAnswer =
      heartbeat.reachable === null
        ? 'unknown'
        : heartbeat.reachable === false
          ? 'unreachable'
          : liveMachine !== null && liveMachine.host === target.host && liveMachine.port === target.port
            ? 'target'
            : 'elsewhere';
    const line =
      answer === 'target' && liveMachine !== null
        ? (liveMachine.statusLine ?? readStatusLine(liveMachine.status ?? ''))
        : null;
    const verdict = assessRegistrationMemo({
      memo,
      answer,
      liveG54: line === null ? null : workOffset(line),
      now: new Date().toISOString(),
    });
    if (verdict.kind === 'restored') {
      const rec = restoredRegistration(verdict, target);
      if (flippedSetup) restoreSetup(rec);
      else restoreJob(rec);
    }
    // A verdict that says the same thing does not re-render every heartbeat; only a change does.
    setRestoreVerdict((prev) =>
      prev !== null &&
      prev.kind === verdict.kind &&
      prev.words === verdict.words &&
      prev.g54Read?.x === verdict.g54Read?.x &&
      prev.g54Read?.y === verdict.g54Read?.y
        ? prev
        : verdict,
    );
    // The heartbeat and the live line are the check; the memo and the session record are its input.
  }, [
    target,
    machineRecord,
    job.id,
    registrationSetup,
    registrationSetupIndex,
    flippedSetup,
    bySetup,
    registrations,
    heartbeat,
    liveMachine,
    restoreJob,
    restoreSetup,
  ]);
  // #1088 — the cut-extent measurement side 1's run left: its highest reading is side 1's top, the
  // thickness the carried Z0 is stated from (the same source the sheet's flipZ0 reads).
  const surfaces = useEngraveRegistrationStore((s) => s.surfaces);
  // #845 — a stated machine holds no probe and has no clearance to seek from: this step's actions
  // need a connected Makera machine, which is null for one (`MACHINE_RUN_ELSEWHERE` on its card).
  const seekFromMachineZ = useMemo(() => clearanceZOf(jobMachine(job, calibration)) ?? 0, [job, calibration]);
  const mountTap = useMemo(
    () => mountTapFor(machineRecord, Object.values(registrations), seekFromMachineZ, jobVise(job).jawStartY),
    [machineRecord, registrations, seekFromMachineZ, job],
  );
  const regSettings = useMemo(() => registrationSettings(defaults, probe).settings, [defaults, probe]);
  // #797 — the one statement at Cut step 1 covers this step's probe-fitted ask (read before the
  // seat tap is created so the tap can take the same answer the registration executor takes).
  const statementGiven = useEngraveRunStore((s) => s.acknowledged);
  const probeName = useMemo(() => probeNameFor(machineRecord), [machineRecord]);
  const setupSettings = useMemo(() => setupsSettings(defaults), [defaults]);
  const rotaryEnvelope = useMemo(() => rotaryOf(jobMachine(job, calibration))?.envelope, [job, calibration]);
  // #1088 — SIDE 1'S GOAL and the location's tools, for the hold check the generator runs.
  const tools = useToolRegistry();
  // #1179 B — the largest owned cutter's diameter: the fallback a program whose cutter the registry
  // cannot name is grown by (the analyst's ruling).
  const largestOwnedDiameterMm = useMemo(() => {
    let largest = 0;
    for (const entry of tools) {
      const diameter = cuttingDiameter(entry.tool);
      if (diameter !== null && diameter > largest) largest = diameter;
    }
    return largest;
  }, [tools]);
  const flipGoal = useMemo(
    () => {
      const goals = jobTargetObjects(job).filter((g) => isSideGoal(g));
      return goals.find((g) => g.setupId === job.setups?.[0]?.id) ?? goals[0] ?? null;
    },
    [job],
  );
  // #1082 — THE PROPOSAL WAITS FOR THE LABEL FACES. `planRegistrationAttempt` reads the job's cut
  // region (`toPartPlan` → `labelProfile` → `resolveFont`), and on the cold first paint the
  // bundled faces may not be parsed: deriving then throws out of this memo and the Cut surface
  // falls into its boundary. The epoch subscription re-plans once a face lands.
  const facesEpoch = useSyncExternalStore(subscribeFacesLoaded, facesLoadedEpoch);
  useEffect(() => {
    if (labelFontsLoaded(job.labels, job.customFonts ?? [])) return;
    void ensureLabelFontsLoaded(job.labels, job.customFonts ?? []).catch(() => {});
  }, [job.labels, job.customFonts]);
  const proposal = useMemo<RegistrationAttempt | null>(() => {
    // #1123-28 — THE PROPOSAL IS COMPUTED EVEN WHEN A PLAN IS APPROVED: the card has to be able
    // to say that the stored approved plan is not what the planner now proposes for this job.
    if (!labelFontsLoaded(job.labels, job.customFonts ?? [])) return null;
    // #1070 — NO SAVED-SETUP PREREQUISITE: a bed-held job's setup IS the job. With no
    // `job.setups[]` the proposal is planned from the stock + mount derived here; approval
    // materialises that setup with the registration on it, and an unapproved plan writes nothing.
    let derived: Setup | undefined;
    let mountForProposal: MountSpec;
    if (job.setups !== undefined && job.setups.length > 0) {
      const savedPlan = planFromSetups(job, setupSettings, rotaryEnvelope);
      const setup0 = job.setups[0]!;
      derived = savedPlan.setups.find(
        (s) => s.faceUp === faceUpOf(setup0) && s.itemIds.some((id) => setup0.itemIds.includes(id)),
      );
      mountForProposal = setup0.mount;
    } else {
      const implicit = implicitSetupFor(job);
      if (implicit === null) return null;
      derived = implicit;
      mountForProposal = implicit.mount;
    }
    if (derived === undefined) return null;
    return planRegistrationAttempt({
      job,
      setup: derived,
      mount: mountForProposal,
      mountDatum,
      mountDatumMismatch: mountDatumMismatchBy,
      mountDatumMismatchName,
      surfaceTopZ,
      bracketSeat,
      placedSeed,
      probe,
      probeName,
      mountTap,
      defaults,
      calibration,
      settings: regSettings,
      // #1179 B — a blank that has been cut is MEASURED on known depths, not asked about.
      cutBlank: hasFinishedPrograms,
      // #1179 stage 2 — THE MAP, WHEN THE BLANK'S RECORD HAS ONE FOR THIS SETUP. `complete` gives
      // the candidates from the blank's own measured state; `unknown`/absent keeps the package
      // footprint's unknown-cuts path.
      cutBlankMap: blankScope.setupMap?.state === 'complete' ? (blankScope.setupMap.map ?? null) : null,
      largestOwnedDiameterMm,
      finishedHashes: machineRecord?.finishedPrograms ?? [],
      // #1179 B — only the registered setup's own programs are this face's known cuts.
      setupIndex: registrationSetupIndex,
    });
  }, [
    plan,
    job,
    setupSettings,
    rotaryEnvelope,
    mountDatum,
    mountDatumMismatchBy,
    mountDatumMismatchName,
    surfaceTopZ,
    probe,
    probeName,
    mountTap,
    defaults,
    calibration,
    regSettings,
    // #1179 — the cut-blank trigger, its map and the fallback cutter size are plan inputs.
    hasFinishedPrograms,
    blankScope,
    largestOwnedDiameterMm,
    machineRecord,
    registrationSetupIndex,
    // #1082 — a face landing must re-plan (the job object is unchanged when it does).
    facesEpoch,
  ]);
  /**
   * #1088 — SIDE 2'S PLAN, from the job: the flipped setup's stored pins (side 1's bores reflected
   * back — the ONE source), the checked-out probe's measured tip, the machine's travel height, and
   * the carried Z0 the corner touches are the CHECK of (6b's amendment A: seat + measured thickness
   * − side 1's facing, from the same numbers the sheet prints). Null on a job with no flipped setup.
   */
  const flipAttempt = useMemo<FlipAttemptResult>(() => {
    // #1088 — THE CUT SCREEN'S CURRENT SETUP decides: the setup whose programs are next is the one
    // this card registers. A flipped one (the bench's setups[1]) registers on its bores; every other
    // setup keeps the step's existing path below, unchanged.
    if (job.setups?.[setupNumber - 1]?.flip === undefined) return null;
    const seat = bracketSeatDatumFor(machineRecord)?.value;
    const touches = surfaces[job.id]?.assessment.touches ?? [];
    const top = touches.length === 0 ? null : Math.max(...touches.map((t) => t.z));
    const thicknessMm = seat === undefined || top === null ? null : Math.round((top - seat) * 1000) / 1000;
    const carried: FlipZ0 | null =
      seat === undefined || thicknessMm === null || !(thicknessMm > 0)
        ? null
        : flipZ0({
            seatMm: seat,
            thicknessMm,
            facingMm: job.facing?.enabled === true ? job.facing.depth : 0,
            toleranceMm: regSettings.surfaceToleranceMm,
            // #1189 — the side-1 run's M491: the carried top is a raw reading in that seating, and
            // the corner Z band is corrected to today's probe once the flip run measures it. The
            // spread's own record names it; a stored registration is the fallback.
            probeRefZ: surfaces[job.id]?.probeRefZ ?? registrations[job.id]?.outcome.probeRefZ ?? null,
          });
    return planFlipAttemptForJob(
      job,
      {
        settings: regSettings,
        probeTipDiameterMm: probe?.tip?.diameterMm ?? null,
        seekFromMachineZ,
        z0: carried,
        goal: flipGoal,
        tools,
      },
      setupNumber - 1,
    );
  }, [job, machineRecord, surfaces, probe, seekFromMachineZ, regSettings, setupNumber, flipGoal, tools, registrations]);
  // #1123-28 — the stored plan the operator approved, next to the planner's CURRENT proposal.
  // A changed planner (a build, a machine record) can make them differ; the card says so and
  // offers the new plan in place rather than silently running the old one.
  const proposalPlan = proposal?.kind === 'plan' ? proposal : null;
  const planDrift = plan !== null && proposalPlan !== null && canonicalJson(plan) !== canonicalJson(proposalPlan.plan);

  const [proposalOpen, setProposalOpen] = useState(false);
  // #1202 + #1199 item 3 — THE PRESS PREVIEW. The routine the press would run is executed against
  // a RECORDING console (no socket) and every line is shown with the motion-order guard's verdict,
  // BEFORE the press. The same list's shape is the routine's identity: a shape this machine has
  // never completed marks the press as a first run, which needs its own at-machine statement.
  const [preview, setPreview] = useState<DryRoutine | null>(null);
  const [routineTicked, setRoutineTicked] = useState(false);
  const previewPlan: RegistrationPlan | null = plan ?? (proposal?.kind === 'plan' ? proposal.plan : null);
  const previewFloor = jobMachine(job, calibration).envelope.z.min;
  useEffect(() => {
    if (previewPlan === null || target === null) {
      setPreview(null);
      return;
    }
    let live = true;
    const clearanceZ = previewPlan.machineClearanceZ ?? seekFromMachineZ;
    const seat = seatTapArgs(previewPlan);
    void (async () => {
      try {
        const dry =
          seat !== null
            ? await dryMountTap(seat, {
                clearanceZ,
                settings: regSettings,
                workEnvelopeFloorZ: previewFloor,
                mount: 'bracket',
                planTravelMm: seat.planTravelMm,
                routine: 'seat-press',
                liveClearanceZ: seekFromMachineZ,
              })
            : await dryRegistration(previewPlan, { clearanceZ, settings: regSettings, liveClearanceZ: seekFromMachineZ });
        if (live) setPreview(dry);
      } catch {
        if (live) setPreview(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [previewPlan, target, seekFromMachineZ, regSettings, previewFloor]);
  // A fresh statement per routine shape: the tick that satisfied the last press is not this one.
  const previewShape = preview?.identity.shape ?? null;
  useEffect(() => setRoutineTicked(false), [previewShape]);
  const firstRun = preview !== null && !routineCompleted(machineRecord, preview.identity);
  // The press is refused when the guard would refuse a line or the preview could not finish, and
  // held until the operator's own statement when this exact routine has never completed on this
  // machine (#1202 field 2; a truncated preview is not a preview).
  const routineGate = previewHolds(preview, firstRun, routineTicked);
  // #1202 — the FLIP registration's own preview: side 2's frame plan, through the same executor
  // the press runs, against the same live clearance. A routine of its own (its own id and shape).
  const [flipPreview, setFlipPreview] = useState<DryRoutine | null>(null);
  const [flipTicked, setFlipTicked] = useState(false);
  useEffect(() => {
    if (flipAttempt?.kind !== 'plan' || target === null) {
      setFlipPreview(null);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const dry = await dryFlipRegistration(flipAttempt.attempt, { liveClearanceZ: seekFromMachineZ });
        if (live) setFlipPreview(dry);
      } catch {
        if (live) setFlipPreview(null);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipAttempt, target, seekFromMachineZ]);
  const flipShape = flipPreview?.identity.shape ?? null;
  useEffect(() => setFlipTicked(false), [flipShape]);
  const flipFirstRun = flipPreview !== null && !routineCompleted(machineRecord, flipPreview.identity);
  const flipGate = previewHolds(flipPreview, flipFirstRun, flipTicked);
  // #1202 field 4 — the same refusal for the flip's own first run.
  const flipHeadlessRefusal = firstRunAutomationRefusal({ firstRun: flipFirstRun });
  // #1202 field 4 — a first run under automation against a real controller is REFUSED, in words.
  const headlessRefusal = firstRunAutomationRefusal({ firstRun });
  // #1070 (C8) — the placed bracket's position press (the bed profile's seed, from the hole grid).
  const [gridBusy, setGridBusy] = useState(false);
  const [gridNote, setGridNote] = useState<string | null>(null);
  const stateBracketFromGrid = async (): Promise<void> => {
    const seeds = gridSeeds();
    const rec = machineRecord ?? machineRecordByProfile(job.machineId);
    if (rec === null || seeds.length !== 1) return;
    const seed = seeds[0]!;
    setGridBusy(true);
    setGridNote(null);
    try {
      const now = new Date().toISOString();
      const outcome = await saveMachineWithRetry(rec, (current) => withBracketPlacementSeed(current, { x: seed.x, y: seed.y, by: 'grid' }, now));
      setGridNote(
        outcome === 'ok'
          ? `Stated: the bracket’s corner at machine X ${seed.x} Y ${seed.y}, from the bed’s hole grid.`
          : 'The bed profile was not saved — check the house connection and try again.',
      );
    } catch (e) {
      setGridNote(e instanceof Error ? e.message : String(e));
    } finally {
      setGridBusy(false);
    }
  };

  /**
   * #1070 — write an approval onto the open job's first setup (materialising the derived setup
   * when the job saved none), without starting anything. #1123-28 uses the same write for "Use
   * the new plan": the stored plan is replaced in place, then Start runs the new one.
   */
  function approvePlan(attempt: Extract<RegistrationAttempt, { kind: 'plan' }>): void {
    const setups = job.setups ?? [];
    useEngraveJobStore.getState().setSetups(
      setups.length === 0
        ? [implicitJobSetup(job, registrationOf(attempt))]
        : setups.map((setup, i) =>
            i === 0
              ? { ...setup, registration: { method: attempt.method, plan: attempt.plan, expected: attempt.expected } }
              : setup,
          ),
    );
  }

  /** #797 follow-up — approve the planner's proposal and start the run in ONE press. */
  async function approveAndStart(attempt: Extract<RegistrationAttempt, { kind: 'plan' }>): Promise<void> {
    approvePlan(attempt);
    await start(attempt.plan);
  }

  const record = useEngraveRegistrationStore((s) => s.record);
  /** #1088 — a later setup's registration is filed under its own setup id, never the job's. */
  const recordSetup = useEngraveRegistrationStore((s) => s.recordSetup);
  const measureSurface = useEngraveRegistrationStore((s) => s.measureSurface);
  const houseMargins = useSettingsStore((s) => s.margins);
  const [phase, setPhase] = useState<Phase>('idle');
  const [prompt, setPrompt] = useState<OperatorStep | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  /**
   * #1179 D — THE PLAN THIS RUN MEASURED UNDER, as state rather than the ref: the thickness note
   * reads the same plan the result's top was compared with, even if the setup edits after the run.
   */
  const [runPlanUsed, setRunPlanUsed] = useState<RegistrationPlan | null>(null);
  const [written, setWritten] = useState<ApplyResult | null>(null);
  const [homeNote, setHomeNote] = useState<string | null>(null);
  /**
   * #1197 — THE HOME'S OWN FAILURE SENTENCE, kept apart from the operator note: the note says what
   * to do by hand, the report carries what the console actually answered.
   */
  const [homeFailure, setHomeFailure] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * #743 D-2 — the operator's answer to a disc more than 1 % off the stated diameter: resize the
   * job to the measured size, or cut as is. Held per measurement, so a re-run asks again.
   */
  const [discAnswer, setDiscAnswer] = useState<'resize' | 'as-is' | null>(null);
  const scaleJobAboutStockCentre = useEngraveJobStore((s) => s.scaleJobAboutStockCentre);
  /** #587 — the executor's latest step narration, shown instead of a blanket "Talking…". */
  const [narration, setNarration] = useState<string | null>(null);
  /**
   * #933 — THE OPERATOR'S STOP. The flag is what the executor checks before every line; the
   * outcome is what the stop's own session reported, shown beside the run's failed sentence.
   */
  const stopRef = useRef(false);
  const [stopOutcome, setStopOutcome] = useState<StopOutcome | null>(null);

  const handleRef = useRef<ConsoleHandle | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);
  const aliveRef = useRef(true);
  /** #638 — the plan the measurement RAN under (not the render-time one), for its write-backs. */
  const runPlanRef = useRef<RegistrationPlan | null>(null);
  /** #638 — whether the run's placement frame landed at measurement time. */
  const frameSavedRef = useRef(false);
  /** #652 — the vise's typed jaw start the run measured against, so a later edit cannot move it. */
  const runJawStartYRef = useRef<number | null>(null);
  /**
   * #1088 — whether the measurement that is showing came from the FLIP executor. Side 2's G54 is
   * not the vise's placement frame (that record describes where the bed's fixed jaw is), so the
   * acceptance must not write it back as one, and the result block says what was recorded.
   */
  const [flipRun, setFlipRun] = useState(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // #653 — CANCEL ONLY A PENDING PROMPT. Answering No is the executor's own stop path (the
      // #495 policy), and it homes and closes as it unwinds. Mid-motion there is no prompt to
      // answer: the machine may be between a touch and its closing `$H`, and closing the console
      // here does not stop the move — a later line simply reopens the session. The run finishes and
      // its own epilogue (home on a stop, then close) runs instead, below.
      const answer = resolverRef.current;
      if (answer !== null) {
        resolverRef.current = null;
        answer(false);
      }
      // BENCH BLOCKER 2026-11-10 — AND CLOSE THE SESSION. Leaving the app while the card sits at
      // `measured` (the run ended, its origin not yet written) stranded this console: `again()` and
      // the write press close it, but an unmount had no path that did. The Rust relay keeps a
      // connection until `tcpClose`, so that stranded one showed as an ESTABLISHED socket to the
      // controller (the analyst's leak). The executor's own epilogue still runs where it can, and
      // closing twice is safe (`close()` is idempotent).
      const handle = handleRef.current;
      handleRef.current = null;
      if (handle !== null) void handle.close();
    };
  }, []);

  const busy = phase === 'running' || phase === 'writing';

  // #527 — the viewport draws the machine layer's wired probe instead of the cutter while the run
  // is touching off. Only `running` is a probe run: `writing` has already asked for the cutter, and
  // every other phase has no instrument in the spindle.
  const setRegistrationActive = useMachineStore((s) => s.setRegistrationActive);
  useEffect(() => {
    setRegistrationActive(phase === 'running');
    return () => setRegistrationActive(false);
  }, [phase, setRegistrationActive]);

  // #519 item 3 — the runner's step sentence is live only while the run is; the strip reads it.
  useEffect(() => {
    if (phase !== 'running') useRegistrationTouchesStore.getState().setStep(null);
  }, [phase]);

  // #528 — the transcript no longer renders in the rail; the dock's Transcript tab reads the store.
  // Write the SAME text the old rail `<pre>`s rendered (`> line\nreply` per entry) so nothing changes
  // but the home of the element. The old render could show the registration run's transcript AND the
  // origin write's transcript at once (the touches block kept rendering after `written` landed), so
  // the dock's one section is the two conversations in the order the rail printed them.
  const setRegistrationTranscript = useMachineTranscriptStore((s) => s.setRegistration);
  useEffect(() => {
    const transcript = [
      ...(result !== null ? result.transcript : []),
      ...(written !== null ? written.transcript : []),
    ];
    setRegistrationTranscript(
      transcript.length > 0 ? transcript.map((t) => `> ${t.line}\n${t.reply}`).join('\n') : null,
    );
  }, [written, result, setRegistrationTranscript]);

  // #hotfix — publish the one boolean the Cut surface needs: a live prompt is waiting. The Step
  // that holds this card forces itself open while it is set, whatever `currentStep` says.
  useEffect(() => {
    useRegistrationPromptStore.getState().setPending(busy && prompt !== null);
    return () => useRegistrationPromptStore.getState().setPending(false);
  }, [busy, prompt]);

  function askOperator(step: OperatorStep): Promise<boolean> {
    if (!aliveRef.current) return Promise.resolve(false);
    setPrompt(step);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = (ok) => {
        resolverRef.current = null;
        if (aliveRef.current) setPrompt(null);
        resolve(ok);
      };
    });
  }

  function answer(ok: boolean): void {
    resolverRef.current?.(ok);
  }


  /**
   * #933 — THE STOP PRESS. It sets the executor's flag FIRST — from that moment the run sends no
   * further line — then answers a pending prompt (the executor's own stop path), then stops
   * whatever is MOVING on a console of its own: the executor's session has a `G38.3` in flight, and
   * a second `send` on that session would interleave on its single frame channel. What `abort` does
   * to an in-flight probe move is the S1 question; the outcome says what the machine reported.
   */
  /**
   * #1179 — "THIS IS A NEW BLANK". The operator's statement, minted on the machine record (E's
   * `mintBlank`): a fresh id for this job, written through the guarded machine PUT. Old records
   * keep their own ids as history and stop matching; the card re-plans to the single touch.
   */
  async function newBlank(): Promise<void> {
    if (target === null) return;
    const machine = machineAt(target);
    if (machine === null) return;
    const minted = await useLocationStore.getState().mintBlank(machine.id, job.id);
    setBlankNote(
      minted.ok
        ? 'A new blank — this registration takes the single surface touch.'
        : `The blank was not saved: ${minted.text}`,
    );
  }

  async function pressStop(): Promise<void> {
    if (stopRef.current) return;
    stopRef.current = true;
    answer(false);
    if (target === null) return;
    setStopOutcome(null);
    setStopOutcome(await stopProgram(target, undefined, stopSettings(useShopDefaultsStore.getState().defaults)));
  }

  /** #933 — the Home press after a Stop: the app never sends `$H` by itself after one. */
  async function homeNow(): Promise<void> {
    if (target === null) return;
    const handle = attachConsole(target);
    try {
      const home = await homeAfterStop(handle);
      setHomeNote(home.note);
      setHomeFailure(home.failure);
    } finally {
      await handle.close();
    }
  }

  /** #933 — what the stop reported, in the panel's words. */
  function stopWords(o: StopOutcome): string {
    switch (o.kind) {
      case 'stopped':
        return 'The stop was sent and the machine reads Idle.';
      case 'draining':
        return o.detail;
      case 'not-running':
        return 'The run stopped between moves — nothing was moving.';
      case 'alarm':
        return o.detail;
      case 'timeout':
        return `The stop was not answered: ${o.detail}`;
      case 'error':
        return `The stop failed: ${o.detail}`;
      case 'unavailable':
        return o.detail;
    }
  }

  /**
   * Stop, then home. The executor's stop sentence has already cleared G90/$X where it could. The
   * note is what the operator is told; the failure is the console's own sentence, kept for #1197's
   * report — the note alone ("home it by hand") is the app's words, not the machine's.
   */
  async function homeAfterStop(handle: ConsoleHandle): Promise<{ note: string; failure: string | null }> {
    try {
      // #588 — "in alarm" is the machine's State, not a sentence. `$X` to an Idle machine is a no-op
      // with no reply, so it would sit out the console's 60 s first-reply window before `$H` (the
      // 2026-10-24 58 s park). Read `?` and clear only a controller that answers `<Alarm|…>`.
      // #933 — on the STATUS window: a silent link costs 3 s, not the console's 60.
      const status = await handle.send('?', STATUS_POLL_TIMING);
      if (status.kind === 'sent' && controllerState(status.text) === 'Alarm') {
        await handle.send('$X');
      }
      const reply = await handle.send('$H');
      return reply.kind === 'sent'
        ? { note: 'The machine was homed after the stop.', failure: null }
        : {
            note: `The machine did not answer the home command (${reply.kind}) — home it by hand.`,
            failure: reply.detail,
          };
    } catch (e) {
      return {
        note: 'The machine could not be homed — home it by hand.',
        failure: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * #1088 — SIDE 2'S RUN. The same console, prompts, Stop, narration and touch recording as side 1,
   * over `runFlipRegistration` and the setup's own frame — and nothing of side 1's bed writes: the
   * origin this run states is written by the operator's press (`writeOrigin`), never as the vise's
   * placement frame.
   */
  async function startFlip(attempt: Extract<FlipAttemptResult, { kind: 'plan' }>): Promise<void> {
    if (target === null || !statementGiven || busy) return;
    // #1088 — NOTHING OF SIDE 1'S RECORD IS CLEARED. It is what the carried Z0 was stated from and
    // what the release gate reads; a second side's run is a new measurement of the SAME blank, not
    // a new clamping of it.
    setPhase('running');
    setResult(null);
    setWritten(null);
    setHomeNote(null);
    setHomeFailure(null);
    setError(null);
    setNarration(null);
    stopRef.current = false;
    setStopOutcome(null);
    runPlanRef.current = attempt.attempt.ctx;
    setFlipRun(true);
    frameSavedRef.current = false;
    useRegistrationTouchesStore.getState().reset(job.id);
    const handle = attachConsole(target);
    handleRef.current = handle;
    try {
      const r = await runFlipRegistration(
        attempt.attempt.plan,
        { ctx: attempt.attempt.ctx, z0: attempt.attempt.z0 },
        {
          console: { send: (line, timing) => handle.send(line, timing) },
          // #1199 item 2 — the LIVE machine's clearance, so the plan is proven against the machine
          // as it is now, not only against the value it was planned with.
          liveClearanceZ: seekFromMachineZ,
          // #933 — the operator's Stop is checked before every line, exactly as side 1's run.
          stopRequested: () => stopRef.current,
          // The Cut step-1 statement already names the probe, so the fit-probe ask is answered by it.
          operator: (step) => (step.kind === 'fit-probe' ? Promise.resolve(true) : askOperator(step)),
          onStep: (sentence) => {
            if (aliveRef.current) setNarration(sentence);
            useRegistrationTouchesStore.getState().setStep(sentence);
          },
          onTouch: (touch) => useRegistrationTouchesStore.getState().add(touch),
        },
      );
      if (!aliveRef.current) {
        if (!r.ok) await homeAfterStop(handle);
        handleRef.current = null;
        await handle.close();
        return;
      }
      if (!r.ok) {
        const home = stopRef.current ? null : await homeAfterStop(handle);
        if (!aliveRef.current) {
          handleRef.current = null;
          await handle.close();
          return;
        }
        setResult(r);
        setHomeNote(home?.note ?? null);
        setHomeFailure(home?.failure ?? null);
        setPhase('failed');
        handleRef.current = null;
        await handle.close();
        return;
      }
      // #1202 — THE FLIP REGISTRATION COMPLETED: its identity is recorded on the machine (the
      // guarded PUT). A refused write only means the next press marks the routine again. The
      // card's preview is the identity's source; a press taken before it resolved computes the
      // same identity from the same plan (the dry console never touches the wire).
      if (target !== null) {
        const flipMachine = machineAt(target);
        if (flipMachine !== null) {
          const flipIdentity =
            flipPreview?.identity ??
            (await dryFlipRegistration(attempt.attempt, { liveClearanceZ: seekFromMachineZ })).identity;
          void saveMachineWithRetry(flipMachine, (current) =>
            withRoutineCompletion(current, {
              routine: 'flip-registration',
              shape: flipIdentity.shape,
              at: new Date().toISOString(),
              build: buildStamp(),
            }),
          );
        }
      }
      setResult(r);
      setPhase('measured');
      if (writerRefusal(r.outcome) !== null) {
        handleRef.current = null;
        await handle.close();
      }
    } catch (e) {
      if (!aliveRef.current) {
        handleRef.current = null;
        await handle.close();
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
      handleRef.current = null;
      await handle.close();
    }
  }

  async function start(planOverride?: RegistrationPlan): Promise<void> {
    // #1088 — a flipped setup has its own executor: never side 1's routine on side 2.
    if (flipAttempt?.kind === 'plan') {
      await startFlip(flipAttempt);
      return;
    }
    if (flipAttempt?.kind === 'refused') return;
    // #1187 — a new run starts its stop report clean: the last stop's "Sent …" line belongs to
    // THAT stop, never to the card this press may earn.
    useMachineStopReportStore.getState().reset();
    // #797 follow-up — the Register card approves the planner's proposal and starts in ONE press:
    // the plan it approved is handed here, because the render-time `plan` is still null.
    const effectivePlan = planOverride ?? plan;
    // #797 — the ONE statement at Cut step 1 replaced this step's own at-machine tick.
    const acknowledged = useEngraveRunStore.getState().acknowledged;
    if (target === null || effectivePlan === null || !acknowledged || busy) return;
    // #1179 — THE PACKAGE IS FINISHED ON THIS BLANK. Registering again begins a NEW blank: mint it,
    // say so, and stop — the card re-plans against the fresh blank and the next press runs the
    // single touch. The mint is the operator's statement; no old record is rewritten.
    if (blankScope.packageFinishedUnderBlank) {
      const machine = machineAt(target);
      if (machine === null) return;
      const minted = await useLocationStore.getState().mintBlank(machine.id, job.id);
      setBlankNote(
        minted.ok
          ? 'The last blank was finished — this is a new blank. Press Register again to measure its top.'
          : `The blank was not saved: ${minted.text}`,
      );
      return;
    }
    // #639 — A NEW RUN FORGETS THE LAST CLAMPING. The record and the surface assessment belong to
    // the blank as it was; keeping them through a re-run (which may alarm out or be stopped) left
    // the Cut step claiming "Registration recorded", the dome tick ticked, and Upload enabled
    // against a blank that had moved.
    useEngraveRegistrationStore.getState().clear(job.id);
    setPhase('running');
    setResult(null);
    setWritten(null);
    setHomeNote(null);
    setHomeFailure(null);
    setError(null);
    setNarration(null);
    stopRef.current = false;
    setStopOutcome(null);
    // #638 — the plan this run is measured under travels with its result: a later setup edit must
    // not change what the record says was approved and run.
    runPlanRef.current = effectivePlan;
    setRunPlanUsed(effectivePlan);
    frameSavedRef.current = false;
    setFlipRun(false);
    runJawStartYRef.current = jobVise(job).jawStartY;
    // #519 item 1 — a new run's readings replace the last run's dots and table, and they are
    // stamped with this job so a layer left from another job is never drawn as this one's.
    useRegistrationTouchesStore.getState().reset(job.id);
    const handle = attachConsole(target);
    handleRef.current = handle;
    // #475 — the cut regions' extents, at the touch count the APPROVED plan carries (a shop default
    // that may have moved since is not allowed to change what the operator approved). The margin is
    // resolved exactly as the run sheet resolves it, so the band the assessment refuses on and the
    // band the sheet prints for the same readings cannot be two different numbers.
    const spreadPlan = surfaceSpreadPlan(job, {
      touchCount: effectivePlan.settings.surfaceTouchCount,
      margin: effectiveMargins(job, houseMargins).boundaryMargin,
      // #501 — the console G32 recipe's shape, when the measurement comes back a TILT: the cutter's
      // radius (the grid grows by it), the APPROVED plan's own probe clearance, and the shop's grid
      // points. Absent when the cutter's diameter is unknown, and then no recipe is offered.
      level: (() => {
        const cutter = jobTool(job);
        const diameter = cutter === null ? null : cuttingDiameter(cutter);
        return diameter === null
          ? null
          : {
              toolRadiusMm: diameter / 2,
              clearanceMm: effectivePlan.settings.parkAboveSurfaceMm,
              points: shopDefault('plan.autoLevelPoints').value,
            };
      })(),
    });
    try {
      const r = await runRegistration(
        effectivePlan,
        {
          console: { send: (line, timing) => handle.send(line, timing) },
          // #1199 item 2 — the LIVE machine's clearance at run time.
          liveClearanceZ: seekFromMachineZ,
          // #933 — the operator's Stop: checked before every line, and the flag outlives the
          // prompt it may also decline.
          stopRequested: () => stopRef.current,
          // #933 — THE G54 PRE-FLIGHT's expected origin, from the bed's own recorded placement:
          // the fixed jaw face is the G54 X a registration writes, and the bar's start less this
          // job's jaw start is its Y (`viseFrameFromRegistration`'s arithmetic, read backwards).
          expectedG54: (() => {
            const machine = machineAt(target);
            const frame = machine === null ? null : visePlacementFrameOf(machine);
            return frame === null ? null : { x: frame.fixedJawFaceX, y: frame.jawStartY - jobVise(job).jawStartY };
          })(),
          // The at-machine tick already names the probe, so the executor's first prompt is answered
          // by it; every other step (the bracket's clamps, the cutter) is a fresh press.
          operator: (step) => (step.kind === 'fit-probe' ? Promise.resolve(true) : askOperator(step)),
          // #1166 — the bracket's surface seek may offer the DERIVED top (seat + stock thickness)
          // when the plan's point has been cut away, but only if this job has actually cut here.
          hasFinishedPrograms,
          // #1179 D/B4 — the blank's last recorded top, so the derived offer continues from it.
          lastRecordedTopMachineZ,
          // #1189 — the probe's reference at the run that recorded it (null: not used across a refit).
          lastRecordedTopProbeRefZ,
          // #587 — the executor narrates each step as it moves; surface it live.
          onStep: (sentence) => {
            if (aliveRef.current) setNarration(sentence);
            // #519 item 3 — the strip prints the same sentence while a registration owns the machine.
            useRegistrationTouchesStore.getState().setStep(sentence);
          },
          // #519 item 1 — each reading as it lands: the viewport's dots and the dock's table.
          onTouch: (touch) => useRegistrationTouchesStore.getState().add(touch),
        },
        spreadPlan ?? undefined,
      );
      if (!aliveRef.current) {
        // #653 — the host has gone but the run has not: finish its epilogue rather than abandon
        // the console. Only the UI writes below are skipped.
        if (!r.ok) await homeAfterStop(handle);
        handleRef.current = null;
        await handle.close();
        return;
      }
      if (r.ok && r.spread !== undefined) {
        // #519 item 1 — the dock's Touches tab closes with the spread sentence (the rail's detailed
        // spread block stays where the Write decision is). #630 — the transcript line carries the
        // residual against the band, not the raw spread: the margin is the verdict.
        useRegistrationTouchesStore
          .getState()
          .setSpreadSentence(`Surface ${r.spread.verdict} — ${surfaceMarginWords(r.spread)}.`);
        // The measurement is session data for the sheet even when the blank is refused; the job's
        // flatness record is the measured pair, which is what #432 R9 reads and what the depth
        // recommendation and the material scan plan from (#496). Both spans travel with the count
        // of touches that produced them and the date they were taken: a figure with no provenance
        // is the assumed dome #496 removed.
        // #1189 — with the seating the raw Z values were read in.
        measureSurface(job.id, target, r.spread, r.data.probeRefZ);
        const store = useEngraveJobStore.getState();
        if (store.job.id === job.id) {
          const measuredAt = new Date().toISOString();
          store.setStock(
            {
              flatness: {
                xMm: r.spread.drops.xMm,
                yMm: r.spread.drops.yMm,
                source: 'measured',
                touchCount: r.spread.touches.length,
                measuredAt,
              },
              // #943 — the touch set itself, on the job: the facing depth runs from the spread
              // (highest reading starts the cut, one row step below the lowest is the target), and
              // a reload must keep what the operator measured, not just the two-drop summary.
              surfaceTouches: {
                touches: r.spread.touches.map((t) => ({ id: t.id, x: t.x, y: t.y, z: t.z, at: t.at, source: t.source })),
                measuredAt,
                machine: { host: target.host, port: target.port },
              },
            },
            'measured',
          );
        }
      }
      if (!r.ok) {
        // #933 — AFTER AN OPERATOR STOP THE MACHINE IS NOT HOMED BY THE APP. `$H` is a rapid, and
        // the whole point of a Stop is that nothing moves until the person says so; the panel
        // offers Home as its own press. Every other failure keeps the #588 epilogue.
        const home = stopRef.current ? null : await homeAfterStop(handle);
        if (!aliveRef.current) {
          handleRef.current = null;
          await handle.close();
          return;
        }
        setResult(r);
        setHomeNote(home?.note ?? null);
        setHomeFailure(home?.failure ?? null);
        setPhase('failed');
        handleRef.current = null;
        await handle.close();
        return;
      }
      // #1202 — THE REGISTRATION COMPLETED. Its routine identity (the line sequence the press
      // sent) is recorded on the machine BEFORE any house write that may fail: the MOTION finished
      // without a stop, which is what the record claims, and an unreadable save only means the
      // next press marks the routine again — the safe direction.
      if (preview !== null && target !== null) {
        const recordMachine = machineAt(target);
        if (recordMachine !== null) {
          void saveMachineWithRetry(recordMachine, (current) =>
            withRoutineCompletion(current, {
              routine: preview.identity.routine,
              shape: preview.identity.shape,
              at: new Date().toISOString(),
              build: buildStamp(),
            }),
          );
        }
      }
      // #636 — THE MEASUREMENT IS ON SCREEN BEFORE ANY HOUSE WRITE. A throw or a refused save in
      // the chain below used to land in the outer catch as `failed`, and the successful probe result
      // was never shown; it is set first here, and every write's ANSWER is read below, with the
      // failure stated on the result rather than swallowed.
      setResult(r);
      const writeNotes: string[] = [];
      try {
        const machine = machineAt(target);
        if (machine !== null && r.outcome.usable) {
          const now = new Date().toISOString();
          // #638 — a measurement outside the margin writes NO frame and NO surface top: the blank
          // is to be re-seated, and `mountTapFor` prefers this frame for every later tap point, so
          // writing it here would aim them where this run found the jaw, not where it now is. The
          // operator's acceptance (`writeOrigin`) writes them from the held result instead.
          const frameRegistration =
            r.outcome.usable && r.outcome.withinMargin && effectivePlan.mount === 'vise'
              ? { measuredAt: now, correctedG54: r.outcome.correctedG54 }
              : null;
          // #613/#636 — ONE bed for the whole run: the frame and the datum land in ONE save, not two
          // beds in a row (a 'failed' first save could otherwise create a second, frame-less bed).
          // #650 — the bed and the datums are an UPDATE folded onto the record the service holds, so
          // a stale guard re-applies them to the re-read record instead of overwriting another
          // window's change with this run's pre-read copy.
          const bed = await createFirstBed(machine, frameRegistration, now);
          const probeId = effectivePlan.probe?.id ?? null;
          const update: MachineUpdate = (current) => {
            let rec = bed(current);
            if (frameRegistration !== null) {
              const frame = viseFrameFromRegistration(frameRegistration, jobVise(job).jawStartY);
              rec = withVisePlacementFrame(rec, frame, { fixedJawFaceX: `measured:${now}`, jawStartY: 'typed' }, now);
              // #619 — write the measured surface top so the next plan expects the found top.
              // #1189 — with the seating it was read in, so a later refit is corrected.
              rec = withSurfaceTopDatum(rec, { z: r.data.surface.z, at: effectivePlan.surfacePoint }, probeId, now, r.data.probeRefZ);
            }
            // #1199 field 7 (e) — NO JOB-TIME JAW DATUM IS WRITTEN. The jaw top is a bed-setup
            // measurement (Manage › the machine); a job refreshes the FRAME and the surface top,
            // never the datum the tap used to re-measure.
            return rec;
          };
          // #653 — NOTHING TO WRITE, NO WRITE. An out-of-margin vise run builds nothing (no frame,
          // no top; #1199 field 7 (e) — a job writes no mount datum either), and a PUT of it could
          // earn a 412 that this code would report as "the record was not saved" for a run that had
          // nothing to record.
          const outcome = update(machine) === machine ? ('ok' as const) : await saveMachineWithRetry(machine, update);
          if (outcome !== 'ok') {
            // Never "recorded" without 'ok': the measurement stands on screen, the datum does not.
            writeNotes.push(
              `the measurement was taken, but the record was not saved: ${useLocationStore.getState().writeNote ?? 'the service refused the write'}. Run the registration again to write it.`,
            );
          } else {
            // #638 — the frame is on the house record only when the save that carried it landed;
            // otherwise the acceptance write tries again from the held result.
            if (frameRegistration !== null) frameSavedRef.current = true;
          }
        }
        // #601 — the probe's last M491 length and M119 rest ride on the checked-out probe accessory.
        await recordProbeReading(machineAt(target), r.probe);
        // #1199 field 7 (e) — a job writes no mount reading: the jaw/seat datum is measured in the
        // bed setup (the standalone tap), never by a job's registration.
      } catch (e) {
        writeNotes.push(
          `the measurement was taken, but the record was not saved: ${e instanceof Error ? e.message : String(e)}. Run the registration again to write it.`,
        );
      }
      for (const note of writeNotes) r.outcome.notes.push(note);
      setResult(r);
      setPhase('measured');
      if (writerRefusal(r.outcome) !== null) {
        handleRef.current = null;
        await handle.close();
      }
    } catch (e) {
      if (!aliveRef.current) {
        handleRef.current = null;
        await handle.close();
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
      handleRef.current = null;
      await handle.close();
    }
  }

  async function writeOrigin(force = false): Promise<void> {
    // #638 — the plan the measurement ran under, not the render's (a setup edit between the run and
    // the press must not rewrite what was measured; the outcome and its record travel together).
    const runPlan = runPlanRef.current;
    if (target === null || runPlan === null || result?.ok !== true || busy) return;
    // #620 — the margin refusal can be forced (the operator accepts the found position); the
    // unusable refusals never can.
    const refusal = writerRefusal(result.outcome);
    if (refusal !== null && !(force && marginRefusal(result.outcome))) return;
    setPhase('writing');
    setError(null);
    const handle = handleRef.current ?? attachConsole(target);
    handleRef.current = handle;
    // #1123 items 31/34 — THE CUTTER THE PROGRAM RUNS, named and numbered. The write's M491
    // calibrates the fitted cutter; `M493.2 T<n>` records its number so the program's first
    // `T<n> M6` is a no-op (the bench stopped in `<Tool|>` holding the probe's 8888), and the fit
    // sentence names the same cutter. The first program's own tool wins; the job's cutter is the
    // fallback for a run whose programs are not in hand.
    const writeCutter = (() => {
      const firstKey = useEngraveRunStore.getState().generated?.programs?.[0]?.toolKey;
      return (firstKey === undefined ? null : benchCutterFor(firstKey)) ?? jobTool(job);
    })();
    const writeConsent = {
      confirmed: true as const,
      ...(writeCutter === null ? {} : { cutter: toolDisplayName(writeCutter), toolNumber: toolNumberFor(writeCutter) }),
    };
    try {
      const a = await applyCorrection(
        result.outcome,
        {
          console: { send: (line, timing) => handle.send(line, timing) },
          operator: askOperator,
          // #1199 — the live machine's clearance, even for the origin write's session.
          liveClearanceZ: seekFromMachineZ,
          // #933 — the Stop is live while the origin is written too: the button is on screen for
          // the whole phase, and a press that did nothing would be a dead press.
          stopRequested: () => stopRef.current,
        },
        writeConsent,
      );
      if (!aliveRef.current) {
        handleRef.current = null;
        await handle.close();
        return;
      }
      if (!a.ok) {
        setWritten(a);
        setPhase('failed');
        handleRef.current = null;
        await handle.close();
        return;
      }
      // #1123-40 — THE RECORD FIRST, THEN THE MEMO IS ITS COPY. The session record stamps its own
      // measuredAt and holds the plan/outcome the release gate reads; the memo is built FROM that
      // record, so the session and the house can never disagree about what was measured.
      // #1088 — SIDE 2'S ORIGIN IS WRITTEN, BUT NOT INTO SIDE 1'S RECORD. `FirstRegistration` is
      // keyed by JOB and its plan/outcome are what the release gate and the post-facing re-touch
      // read for side 1; side 2 is filed under its own setup id.
      if (flipRun) {
        if (selectedSetup !== null) {
          recordSetup(job.id, selectedSetup.id, target, runPlan, result.outcome, null);
        }
      } else {
        record(
          job.id,
          target,
          runPlan,
          result.outcome,
          // #608 — carry the fitted tilt (plane + reference Z0) on the record when the measurement
          // fits one; a flat fit records null, so the Cut step re-posts only when there is a tilt.
          result.spread === undefined ? null : surfaceFitForPost(result.spread),
          // #1088 — the setup this registration measured, so a per-setup reader asks and gets setup 1.
          job.setups?.[0]?.id ?? null,
        );
      }
      const memoSetup = flipRun ? selectedSetup : (job.setups?.[0] ?? null);
      const memoIndex = memoSetup === null ? 0 : (job.setups?.findIndex((s) => s.id === memoSetup.id) ?? -1) + 1;
      const stored =
        memoSetup === null
          ? null
          : flipRun
            ? (useEngraveRegistrationStore.getState().bySetup[registrationKey(job.id, memoSetup.id)] ?? null)
            : (useEngraveRegistrationStore.getState().records[job.id] ?? null);
      const memo =
        stored !== null && memoSetup !== null && memoIndex >= 1
          ? memoFromRecord(stored, memoSetup.id, memoIndex, new Date().toISOString())
          : null;
      // #638 — THE FRAME FOLLOWS THE ACCEPTANCE … and the memo rides the SAME write, so an ordinary
      // acceptance is one PUT, never two. A record's setup has no frame to write when the run is
      // side 2's (#1088) or the mount is not the vise; the memo still lands.
      const machine = target === null ? null : machineAt(target);
      const wantsFrame = !frameSavedRef.current && !flipRun && runPlan.mount === 'vise';
      if (machine !== null && (wantsFrame || memo !== null)) {
        const now = new Date().toISOString();
        const registration = { measuredAt: now, correctedG54: result.outcome.correctedG54 };
        const bed = wantsFrame ? await createFirstBed(machine, registration, now) : null;
        // #650 — folded onto the record the service holds, re-applied after a stale guard.
        const update: MachineUpdate = (current) => {
          let rec = bed === null ? current : bed(current);
          if (bed !== null) {
            rec = withVisePlacementFrame(
              rec,
              // #652 — the jaw start THIS run was measured with (stashed at start), not the render's:
              // a typed value edited between the measurement and the acceptance must not move the face.
              viseFrameFromRegistration(registration, runJawStartYRef.current ?? jobVise(job).jawStartY),
              { fixedJawFaceX: `measured:${now}`, jawStartY: 'typed' },
              now,
            );
            // #619 — the surface top the next plan expects is the one this run measured.
            rec = withSurfaceTopDatum(
              rec,
              { z: result.data.surface.z, at: runPlan.surfacePoint },
              runPlan.probe?.id ?? null,
              now,
              // #1189 — the seating this reading was taken in.
              result.data.probeRefZ,
            );
          }
          return memo === null ? rec : withRegistrationMemo(rec, memo);
        };
        const answer = await saveMachineWithRetry(machine, update);
        if (answer === 'ok') {
          if (bed !== null) frameSavedRef.current = true;
        } else if (bed !== null) {
          result.outcome.notes.push(
            `the origin was written, but the placement frame was not saved: ${useLocationStore.getState().writeNote ?? 'the service refused the write'}. Run the registration again to write it.`,
          );
        } else if (memo !== null) {
          result.outcome.notes.push(
            `the origin was written, but the registration was not saved on the house: ${useLocationStore.getState().writeNote ?? 'the service refused the write'}. A reload will ask you to register again.`,
          );
        }
      }
      setWritten(a);
      setPhase('recorded');
      handleRef.current = null;
      await handle.close();
    } catch (e) {
      if (!aliveRef.current) {
        handleRef.current = null;
        await handle.close();
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
      handleRef.current = null;
      await handle.close();
    }
  }

  function again(): void {
    // #639 — "Run it again" is a new clamping too: the last run's record and surface go with it.
    useEngraveRegistrationStore.getState().clear(job.id);
    // A measurement that was not written still holds the console open: release it before a new run.
    const handle = handleRef.current;
    handleRef.current = null;
    void handle?.close();
    setPhase('idle');
    setResult(null);
    setWritten(null);
    setHomeNote(null);
    setHomeFailure(null);
    setError(null);
    setPrompt(null);
    setDiscAnswer(null);
    setFlipRun(false);
  }

  const outcome = result?.ok === true ? result.outcome : null;
  const spread = result?.ok === true ? (result.spread ?? null) : null;
  const refusal = outcome === null ? null : writerRefusal(outcome);
  const marginOnly = outcome !== null && marginRefusal(outcome);
  const data = result?.ok === true ? result.data : null;
  /**
   * #1179 D — THE THICKNESS THE MEASURED TOP IMPLIES, against the job's stated thickness. Only a
   * MEASURED top speaks (`surfaceDerived` means nothing touched it, F's record keeps it absent);
   * over the shop's `registration.thicknessNoteMm`, the sentence names both numbers and the
   * difference. The job is never edited — the measured top is recorded against the blank.
   */
  const thickness = useMemo(() => {
    if (outcome === null || outcome.surfaceDerived !== undefined || runPlanUsed === null) return null;
    return thicknessNote({
      statedThicknessMm: runPlanUsed.stockThicknessMm ?? job.stock.thickness,
      expectedTopMachineZ: expectedTopOf(runPlanUsed),
      measuredTopMachineZ: outcome.surfaceZ,
      thresholdMm: readDefault(defaults, 'registration.thicknessNoteMm').value,
    });
  }, [outcome, runPlanUsed, job.stock.thickness, defaults]);

  // #1088 — a flipped setup the job cannot state (no pins, no measured tip, no carried Z0) keeps the
  // refusal card: no plan, no press, nothing sent.
  if (flipAttempt?.kind === 'refused') {
    return (
      <div data-testid="engrave-registration" data-phase="idle" data-state="flipped" style={{ ...BOX, marginTop: 8 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#c8d3de' }}>
          Registration — find the stock, then set the origin
        </h3>
        <p style={{ ...MUTED, color: WARN }} data-testid="engrave-registration-flip-refusal">
          {flipAttempt.reason}
        </p>
      </div>
    );
  }

  // #1202 + #1199 item 3 — WHAT WILL BE SENT, the first-run mark, and the press's own statement.
  const routinePreview =
    preview === null ? null : (
      <RoutineDryPreview
        preview={preview}
        firstRun={firstRun}
        ticked={routineTicked}
        onTick={setRoutineTicked}
        headless={headlessRefusal}
      />
    );

  const flipRoutinePreview =
    flipPreview === null ? null : (
      <RoutineDryPreview
        preview={flipPreview}
        firstRun={flipFirstRun}
        ticked={flipTicked}
        onTick={setFlipTicked}
        headless={flipHeadlessRefusal}
      />
    );

  return (
    <div
      data-testid="engrave-registration"
      data-phase={phase}
      data-state={plan === null ? 'no-plan' : busy ? 'busy' : phase}
      style={{ ...BOX, marginTop: 8 }}
    >
      <h3 style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#c8d3de' }}>
        Registration — find the stock, then set the origin
      </h3>

      {/* #1123-40 — WHAT THE HOUSE HELD, AND WHAT COULD BE CHECKED. Restored / refusing / waiting is
          the memo's verdict, in its own words; the X/Y scope of the check is stated in the sentence. */}
      {restoreVerdict !== null && restoreVerdict.words !== null && (
        <p
          data-testid="engrave-registration-restore"
          data-kind={restoreVerdict.kind}
          style={{ ...MUTED, color: restoreVerdict.kind === 'restored' ? OK : restoreVerdict.kind === 'mismatch' ? WARN : MUTED.color }}
        >
          {restoreVerdict.words}
        </p>
      )}

      {target === null && (
        <p style={{ ...MUTED, color: WARN }} data-testid="engrave-registration-no-machine">
          No machine is connected. Reach it first, then come back to register.
        </p>
      )}

      {/* #607 — A CHUCK JOB MEASURES ITS 4TH AXIS HERE. The axis is a datum of the MACHINE, not of
          this job's registration plan (which a rotary holding has none of), so the row stands
          beside the plan's own paths rather than inside them: the same shared tap the module's card
          in Manage › Machines offers. Hidden while a registration run owns the machine. */}
      {(phase === 'idle' || phase === 'failed' || phase === 'recorded') &&
        machineRecord !== null &&
        job.workholding.kind === 'rotary-chuck' && (
          <RotaryAxisTap machine={machineRecord} testIdPrefix="engrave-rotary-tap" />
        )}

      {/* #1059 — THE SQUARE'S FACE ANGLE, under the axis row it measures against: two touches level
          the stock and the levelled position becomes its A zero. The row offers itself only for
          square stock (a rod has no face to level). Hidden with the axis row while a run owns the
          machine. */}
      {(phase === 'idle' || phase === 'failed' || phase === 'recorded') &&
        machineRecord !== null &&
        job.workholding.kind === 'rotary-chuck' && (
          <RotaryFaceAngleTap machine={machineRecord} job={job} testIdPrefix="engrave-rotary-face-angle" />
        )}

  {/* #1179 — THE BLANK, SAID PLAINLY, WITH THE PRESS. Offered whenever the cut-blank path
          is active (`cutsOnThisBlank`): the no-id legacy machine and a blank with cuts alike. */}
      {hasFinishedPrograms && (
        <div data-testid="engrave-registration-blank" style={{ marginTop: 6 }}>
          <p style={{ ...MUTED, margin: '0 0 4px' }}>
            {blankScope.reason === 'legacy-maybe-cut'
              ? 'Earlier programs were cut on this machine, and this job has no blank of its own yet — its blank may have been cut. The registration measures the top on the wood that is still there.'
              : 'This job’s blank has been cut — the registration measures the top on the wood that is still there.'}
          </p>
          <button
            type="button"
            data-testid="engrave-registration-new-blank"
            style={{ padding: 6 }}
            disabled={busy}
            onClick={() => void newBlank()}
          >
            This is a new blank
          </button>
        </div>
      )}
      {/* #1179 — the note OUTLIVES the banner: a mint makes the blank fresh, which hides the
          banner, and the operator still has to read what just happened. */}
      {blankNote !== null && (
        <p style={{ ...MUTED, margin: '4px 0 0' }} data-testid="engrave-registration-blank-note">
          {blankNote}
        </p>
      )}
      {flipAttempt === null && plan === null && proposal !== null && proposal.kind === 'plan' && (
        <div
          data-testid="engrave-registration-proposal"
          style={{ border: '1px solid #2a2f36', borderRadius: 4, padding: 8, margin: '6px 0' }}
        >
          <p style={{ ...MUTED, margin: 0 }} data-testid="engrave-registration-proposal-line">
            {proposalLine(proposal.plan)}{' '}
            <button
              type="button"
              data-testid="engrave-registration-proposal-open"
              aria-expanded={proposalOpen}
              aria-label="Show the plan"
              style={{ font: 'inherit', padding: 0, border: 0, background: 'none', color: '#8ab4f8', cursor: 'pointer' }}
              onClick={() => setProposalOpen((v) => !v)}
            >
              ›
            </button>
          </p>
          {proposal.plan.guarded !== undefined && (
            <p style={{ ...MUTED, margin: '4px 0 0' }} data-testid="engrave-registration-top-on-blank">
              {proposal.plan.guarded.seatIgnored === 'legacy'
                ? 'The top is measured on the blank; the bed’s seat was last measured before this probe was fitted and is not used.'
                : 'The top is measured on the blank; the bed states no seat.'}
            </p>
          )}
          {proposalOpen && (
            <p style={MUTED} data-testid="engrave-registration-proposal-detail">
              {summarizePlan(proposal.plan)}
            </p>
          )}
          {routinePreview}
          <button
            type="button"
            data-testid="engrave-registration-approve-start"
            // #1201 — REGISTER, never a seat press: the seat is a bed-setup datum now. The
            // statement is still required (the executor moves the probe only on the operator's word).
            // #1202 — and a FIRST-RUN routine is refused at the guard level (a marked line) or
            // held until its own statement, whichever press this is.
            disabled={busy || !statementGiven || routineGate || headlessRefusal !== null}
            style={{ width: '100%', padding: 7, marginTop: 6, fontWeight: 600 }}
            onClick={() => void approveAndStart(proposal)}
          >
            Register
          </button>
          <p style={MUTED} data-testid="engrave-registration-proposal-where">
            This is the planner’s proposal; Design → Setups is where it is edited.
          </p>
        </div>
      )}
      {flipAttempt === null && plan === null && proposal !== null && proposal.kind !== 'plan' && (
        <p style={{ ...MUTED, color: WARN }} data-testid="engrave-registration-no-plan">
          {proposal.kind === 'refused' ? proposal.reason : proposal.message}
        </p>
      )}
      {/* #1070 (C8) — THE PLACED BRACKET'S POSITION, stored where it lives: the bed profile.
          The grid's one admitting corner is offered when the bracket is off the pins; the touch
          route needs the machine and lands with the first bench session (named follow-up). */}
      {flipAttempt === null &&
        plan === null &&
        proposal !== null &&
        proposal.kind === 'refused' &&
        job.workholding.kind === 'bracket' &&
        (job.workholding.bracket as { placement?: 'anchored' | 'placed' }).placement === 'placed' && (
          <>
            <button
              type="button"
              data-testid="engrave-state-bracket-from-grid"
              disabled={gridBusy || gridSeeds().length !== 1 || machineRecordByProfile(job.machineId) === null}
              style={{ marginTop: 6 }}
              onClick={() => void stateBracketFromGrid()}
            >
              {gridSeeds().length === 1 ? 'State the bracket’s position from the bed’s hole grid' : 'The hole grid admits no single position — measure the bracket by hand'}
            </button>
            {gridNote !== null && (
              <p style={MUTED} data-testid="engrave-state-bracket-note">
                {gridNote}
              </p>
            )}
          </>
        )}
      {flipAttempt === null && plan === null && proposal === null && why !== null && (
        <p style={{ ...MUTED, color: WARN }} data-testid="engrave-registration-no-plan">
          {why}
        </p>
      )}

      {/* #1088 — SIDE 2'S PLAN AND PRESS. The bores side 1 left, the four sideways touches each, and
          the carried Z0 the corner touches are checked against; the press runs the flip executor. */}
      {flipAttempt?.kind === 'plan' && (
        <div
          data-testid="engrave-registration-flip"
          style={{ border: '1px solid #2a2f36', borderRadius: 4, padding: 8, margin: '6px 0' }}
        >
          <p style={{ ...MUTED, margin: 0, color: '#c8d3de' }} data-testid="engrave-registration-flip-plan">
            Side 2 · {flipAttempt.attempt.plan.notes[0] ?? 'the two locating bores side 1 left'}
          </p>
          {flipAttempt.attempt.plan.notes.slice(1).map((note, i) => (
            <p key={i} style={MUTED} data-testid="engrave-registration-flip-note">
              {note}
            </p>
          ))}
          <p style={MUTED} data-testid="engrave-registration-flip-z0">
            {flipAttempt.attempt.z0 === null || flipAttempt.attempt.z0.checkBand === null
              ? 'No carried Z0 with a tolerance is stated, so the corner Z touches are not checked against one — register side 1 first.'
              : `The corner Z touches check the carried side-2 top ${flipAttempt.attempt.z0.topMachineZ} ± ${Math.round(((flipAttempt.attempt.z0.checkBand.maxMm - flipAttempt.attempt.z0.checkBand.minMm) / 2) * 1000) / 1000} mm; a reading outside that band stops the run before a bore is entered.`}
          </p>
          {(phase === 'idle' || phase === 'failed' || phase === 'recorded') && target !== null && (
            <>
              {flipRoutinePreview}
              <button
                type="button"
                data-testid="engrave-registration-start"
                disabled={!statementGiven || flipGate || flipHeadlessRefusal !== null}
                style={{ width: '100%', padding: 7, marginTop: 6 }}
                onClick={() => void start()}
              >
                {phase === 'idle' ? 'Register side 2' : 'Register side 2 again'}
              </button>
            </>
          )}
        </div>
      )}

      {(plan !== null || flipAttempt?.kind === 'plan') && (
        <>
          {flipAttempt === null && plan !== null && (
            <>
              <p style={{ ...MUTED, color: '#c8d3de' }} data-testid="engrave-registration-plan">
                Setup 1 · {job.setups?.[0]?.registration?.expected ?? 'the approved plan'}
              </p>
              <p style={MUTED} data-testid="engrave-registration-plan-summary">
                {summarizePlan(plan)}
              </p>
              {planDrift && proposalPlan !== null && (
                <div
                  data-testid="engrave-registration-plan-drift"
                  style={{ border: '1px solid #6b5a2a', borderRadius: 4, padding: 8, margin: '6px 0' }}
                >
                  <p style={{ ...MUTED, color: WARN, margin: 0 }} data-testid="engrave-registration-plan-drift-sentence">
                    This approved plan is not the one the planner now proposes for this job.
                    Approved: {summarizePlan(plan)}
                  </p>
                  <p style={MUTED} data-testid="engrave-registration-plan-drift-now">
                    Now proposed: {summarizePlan(proposalPlan.plan)}
                  </p>
                  <button
                    type="button"
                    data-testid="engrave-registration-use-new-plan"
                    style={{ marginTop: 6 }}
                    onClick={() => approvePlan(proposalPlan)}
                  >
                    Use the new plan
                  </button>
                </div>
              )}
            </>
          )}

          {/* #934 — THE CENTRE-FIND (bore / boss / round part) is a 3D-probe routine the bench has
              not run; the planner refuses the instrument and the entry is hidden with it. The
              component and its plan stay in the tree for the branch's own bench issue. */}

          {flipAttempt === null && (phase === 'idle' || phase === 'failed' || phase === 'recorded') && target !== null && (
            <>
              {/* #797 — the at-machine statement is the ONE statement at Cut step 1 (which names
                  the probe), so this step asks nothing of its own; it reads whether it was given. */}
              {routinePreview}
              <button
                type="button"
                data-testid="engrave-registration-start"
                disabled={!statementGiven || routineGate || headlessRefusal !== null}
                style={{ width: '100%', padding: 7, marginTop: 6 }}
                onClick={() => void start()}
              >
                {phase === 'idle' ? 'Start registering' : 'Start registering again'}
              </button>
            </>
          )}

          {busy && (
            <div data-testid="engrave-registration-waiting">
              <p style={MUTED} data-testid="engrave-registration-step">
                {phase === 'writing' ? 'Writing the origin…' : narration ?? 'Talking to the machine…'}
              </p>
              {prompt !== null && (
                <div data-testid="engrave-registration-operator" style={{ marginTop: 6 }}>
                  <p style={{ fontSize: 12, color: '#e6edf5', margin: '0 0 4px' }}>
                    {prompt.text}
                  </p>
                  <button
                    type="button"
                    data-testid="engrave-registration-continue"
                    style={{ padding: 6, marginRight: 6 }}
                    onClick={() => answer(true)}
                  >
                    Continue
                  </button>
                </div>
              )}
              {/* #933 — THE STOP IS LIVE FOR THE WHOLE RUN, not only at a prompt: a probe move in
                  flight has no prompt to decline, and the press flags the executor and stops the
                  machine on its own session. */}
              <button
                type="button"
                data-testid="engrave-registration-stop"
                style={{ padding: 6, marginTop: 6 }}
                onClick={() => void pressStop()}
              >
                Stop
              </button>
              {/* #933 — what the stop's own session reported, while the run unwinds (the failed
                  block shows the same line once it has). */}
              {stopOutcome !== null && (
                <p style={MUTED} data-testid="engrave-registration-stop-outcome">
                  {stopWords(stopOutcome)}
                </p>
              )}
            </div>
          )}

          {result !== null && !result.ok && (
            <div data-testid="engrave-registration-failed" style={{ marginTop: 6 }}>
              <p style={{ fontSize: 12, color: BAD, margin: '0 0 4px' }}>{result.reason}</p>
              {/* #1187 — a stop on a transport or controller error carries its OWN report: this
                  press's transcript, the error, the machine's last status, the build, the job and
                  its package. A refusal of the app's own (measurement, settings, operator Stop)
                  never shows it. Nothing leaves the machine without this press. */}
              {target !== null && stopIsReportable(result.reason) && (
                <StopReportAction
                  action="register"
                  target={target}
                  error={result.reason}
                  transcript={result.transcript}
                  job={{ id: job.id, name: job.name, packageHash: job.package?.hash ?? null }}
                />
              )}
              {homeNote !== null && (
                <p style={MUTED} data-testid="engrave-registration-home-note">
                  {homeNote}
                </p>
              )}
              {/* #1197 — the home that failed on the transport (or that the controller refused) gets
                  the same report as the run's own stop, carrying the CONSOLE's sentence, not the
                  panel's "home it by hand" note (#1187 rule 3). */}
              {target !== null && homeFailure !== null && stopIsReportable(homeFailure) && (
                <StopReportAction
                  action="home"
                  target={target}
                  error={homeFailure}
                  transcript={[]}
                  job={{ id: job.id, name: job.name, packageHash: job.package?.hash ?? null }}
                />
              )}
              {stopOutcome !== null && (
                <p style={MUTED} data-testid="engrave-registration-stop-outcome">
                  {stopWords(stopOutcome)}
                </p>
              )}
              {/* #933 — a stop outcome IS the record of the press (state, not the ref): the Home
                  press is offered only when the machine's state is known and not still moving. */}
              {stopOutcome !== null &&
                (stopOutcome.kind === 'stopped' || stopOutcome.kind === 'not-running' || stopOutcome.kind === 'alarm') && (
                  <button
                    type="button"
                    data-testid="engrave-registration-home"
                    style={{ padding: 6, marginTop: 6 }}
                    onClick={() => void homeNow()}
                  >
                    Home the machine
                  </button>
                )}
            </div>
          )}

          {outcome !== null && data !== null && (
            <div style={{ marginTop: 6 }}>
              {/* #519 item 1 — the surface line and the per-scan readings moved to the dock's
                  Touches tab (`engrave-registration-touches`, `-surface`, `-scan-*` travel with
                  them), fed live by the runner. The verdict, its problems, the spread assessment
                  and the Write decision stay here, where the operator acts on them (§4). */}

              <div
                data-testid="engrave-registration-verdict"
                data-usable={outcome.usable ? 'true' : 'false'}
                data-within-margin={outcome.withinMargin ? 'true' : 'false'}
                style={{ fontSize: 12, color: refusal === null ? OK : BAD, marginTop: 6 }}
              >
                {summarizeOutcome(outcome)}
              </div>
              {outcome.problems.length > 0 && (
                <ul style={{ ...MUTED, paddingLeft: 18 }} data-testid="engrave-registration-problems">
                  {outcome.problems.map((problem, i) => (
                    <li key={i}>{problem}</li>
                  ))}
                </ul>
              )}
              {/* #607 — the outcome's NOTES, where the operator acts on it: a partial write (the
                  bracket seat tapped but its shop default refused) is neither a refusal nor a
                  console line, and the row has to show it. `proudNote` (#619) lands here too. */}
              {outcome.notes.length > 0 && (
                <ul style={{ ...MUTED, paddingLeft: 18 }} data-testid="engrave-registration-notes">
                  {outcome.notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              )}

              {/* #1179 D — THE MEASURED TOP IMPLIES A THICKNESS. Over the shop's threshold the
                  step states both numbers and the difference; the job keeps its stated thickness,
                  and the measured top is what the blank's record keeps. */}
              {thickness !== null && outcome.withinMargin && (
                <p style={{ ...MUTED, color: WARN }} data-testid="engrave-registration-thickness-note">
                  {thickness.text}
                </p>
              )}

              {/* #743 D-2 — THE DISC'S SIZE QUESTION. A blank more than 1 % off the stated ⌀ is
                  not a refusal: the origin is the measured centre either way, and the operator
                  answers — resize the job to what was measured, or cut as is. The origin waits for
                  the answer so neither outcome is taken by accident. */}
              {outcome.disc !== undefined && outcome.disc.askResize && phase === 'measured' && (
                <div
                  data-testid="engrave-registration-disc-question"
                  data-answer={discAnswer ?? 'none'}
                  style={{ ...BOX, borderColor: WARN }}
                >
                  <p style={{ fontSize: 12, color: WARN, margin: '0 0 6px' }}>{outcome.disc.question}</p>
                  {discAnswer === null ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        data-testid="engrave-registration-disc-resize"
                        style={{ flex: 1, padding: 7 }}
                        onClick={() => {
                          scaleJobAboutStockCentre(outcome.disc!.measuredMm / outcome.disc!.statedMm);
                          setDiscAnswer('resize');
                        }}
                      >
                        Resize the job to ⌀{n(outcome.disc.measuredMm)} mm
                      </button>
                      <button
                        type="button"
                        data-testid="engrave-registration-disc-as-is"
                        style={{ flex: 1, padding: 7 }}
                        onClick={() => setDiscAnswer('as-is')}
                      >
                        Cut as is
                      </button>
                    </div>
                  ) : (
                    <p style={{ ...MUTED, color: OK }} data-testid="engrave-registration-disc-answer">
                      {discAnswer === 'resize'
                        ? `The job was resized to ⌀${n(outcome.disc.measuredMm)} mm: the design covers the same fraction of the blank it was drawn for.`
                        : `Cutting as is: the design keeps its drawn size, centred on the measured disc.`}
                    </p>
                  )}
                </div>
              )}

              {spread !== null && (
                <div
                  data-testid="engrave-registration-spread"
                  data-ok={spread.ok ? 'true' : 'false'}
                  style={{ marginTop: 6 }}
                >
                  <div style={{ fontSize: 11, color: spread.ok ? OK : BAD }}>
                    <strong>Surface spread</strong> — lowest {n(spread.min.z)} at {spread.min.at} (
                    {spread.min.source}), highest {n(spread.max.z)} at {spread.max.at} (
                    {spread.max.source}); spread {n(spread.spread)} mm against the{' '}
                    {n(spread.plan.band.width)} mm band.
                  </div>
                  {/* #501 — WHAT the top is, in one word: a dome (curved over a flat colour line)
                      keeps the refusal, a tilt is followed by the re-posted program and may be
                      levelled at the console instead. #630 — the verdict also says the margin: how
                      far the residual sits inside (flat/tilt) or outside (dome) the band. */}
                  <div
                    data-testid="engrave-registration-shape"
                    data-verdict={spread.verdict}
                    style={{ fontSize: 11, color: spread.verdict === 'dome' ? BAD : '#d1d5db' }}
                  >
                    Surface{' '}
                    {spread.verdict === 'dome'
                      ? 'dome — a curved top, not a tilt'
                      : spread.verdict === 'tilt'
                        ? `tilt (${n(spread.slopeDeg)}°)`
                        : 'flat'}{' '}
                    — {surfaceMarginWords(spread)}.
                  </div>
                  {spread.recommendation !== null && (
                    <p data-testid="engrave-registration-g32" style={MUTED}>
                      {spread.recommendation.sentence}
                    </p>
                  )}
                  {spread.ok && spread.landing !== null ? (
                    <div data-testid="engrave-registration-landing" style={{ ...MUTED, color: OK }}>
                      Z0 is the lowest reading ({n(spread.z0.z)}), so the floors may land from{' '}
                      {n(spread.landing.lower)} to {n(spread.landing.upper)} mm below Z0 and nowhere
                      else.
                    </div>
                  ) : (
                    <div data-testid="engrave-registration-dome" style={{ ...MUTED, color: WARN }}>
                      Z0 is still the lowest reading ({n(spread.z0.z)}): the plane re-post cannot follow
                      a dome, so the machine levels the top itself (G32) and the program uploads FLAT.
                    </div>
                  )}
                  {spread.verdict === 'dome' && (
                    <p data-testid="engrave-registration-dome-guidance" style={MUTED}>
                      {surfaceDomeGuidance(spread)}
                    </p>
                  )}
                </div>
              )}

              {phase === 'measured' && refusal === null && (outcome.disc?.askResize !== true || discAnswer !== null) && (
                <>
                  <p style={MUTED}>
                    Writing the origin also asks you to take the probe out and fit the cutter; its{' '}
                    <code>M491</code> sets Z0 in this order.
                  </p>
                  <button
                    type="button"
                    data-testid="engrave-registration-write"
                    style={{ width: '100%', padding: 7, marginTop: 4 }}
                    onClick={() => void writeOrigin()}
                  >
                    Write the origin from this measurement
                  </button>
                </>
              )}
              {/* #743 — the disc's question is the one thing that holds the origin: it changes what
                  the program will cut, so it is answered before the origin is written. */}
              {phase === 'measured' && outcome.disc?.askResize === true && discAnswer === null && (
                <p style={{ ...MUTED, color: WARN }} data-testid="engrave-registration-disc-wait">
                  Answer the disc’s size question first — resize the job or cut as is — then write
                  the origin.
                </p>
              )}
              {refusal !== null && (
                <p style={{ ...MUTED, color: BAD }} data-testid="engrave-registration-refusal">
                  {refusal}
                </p>
              )}
              {phase === 'measured' && marginOnly && (
                <button
                  type="button"
                  data-testid="engrave-registration-use-found"
                  style={{ width: '100%', padding: 7, marginTop: 4 }}
                  onClick={() => void writeOrigin(true)}
                >
                  Use the found position
                </button>
              )}
            </div>
          )}

          {written !== null && written.ok && (
            <div data-testid="engrave-registration-written" style={{ marginTop: 6 }}>
              <p style={{ fontSize: 12, color: OK, margin: '0 0 4px' }}>
                Origin written: <code>{written.line}</code>
              </p>
              <p style={MUTED} data-testid="engrave-registration-recorded">
                {flipRun
                  ? `Setup ${setupNumber}’s registration recorded for the release step — side 2’s origin is written from the bores and the front pair.`
                  : 'Registration recorded for the release step, with the plan that was approved.'}
              </p>
            </div>
          )}
          {written !== null && !written.ok && (
            <div data-testid="engrave-registration-write-failed" style={{ marginTop: 6 }}>
              <p style={{ fontSize: 12, color: BAD, margin: '0 0 4px' }}>{written.reason}</p>
            </div>
          )}

          {error !== null && (
            <>
              <p style={{ ...MUTED, color: BAD }} data-testid="engrave-registration-error">
                {error}
              </p>
              {/* #1197 — a THROWN failure is a stop the app did not read as an outcome: its own
                  sentence is the report's error, and the transcript is whichever half ran last.
                  The gate is #1187's rule 3 — never a refusal of the app's own. */}
              {target !== null && stopIsReportable(error) && (
                <StopReportAction
                  action="register"
                  target={target}
                  error={error}
                  transcript={result?.transcript ?? written?.transcript ?? []}
                  job={{ id: job.id, name: job.name, packageHash: job.package?.hash ?? null }}
                />
              )}
            </>
          )}

          {(phase === 'measured' || phase === 'failed' || phase === 'recorded') && (
            <button
              type="button"
              data-testid="engrave-registration-again"
              style={{ width: '100%', padding: 5, marginTop: 6 }}
              onClick={again}
            >
              Run it again
            </button>
          )}
        </>
      )}
    </div>
  );
}
