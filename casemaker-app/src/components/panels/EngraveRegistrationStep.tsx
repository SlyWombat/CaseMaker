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

import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import type { EngraveJob } from '@/types/engraveJob';
import { probeInstrumentOf, type RegistrationPlan } from '@/engine/cnc/registration/plan';
import { isSeatPlan, seatTapArgs } from '@/engine/cnc/registration/seatPress';
import { implicitJobSetup, implicitSetupFor, registrationOf } from '@/engine/cnc/registration/implicitSetup';
import type { MountSpec, Setup } from '@/engine/cnc/setups';
import { useMountTap } from '@/hooks/useMountTap';
import type { RegistrationOutcome } from '@/engine/cnc/registration/outcome';
import { summarizeOutcome, summarizePlan } from '@/engine/cnc/registration/summary';
import {
  applyCorrection,
  runRegistration,
  type ApplyResult,
  type OperatorStep,
  type RunResult,
} from '@/engine/cnc/registration/execute';
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
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { jobVise } from '@/engine/cnc/fixture';
import { cuttingDiameter } from '@/engine/cnc/tool';
import { shopDefault, useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
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
  recordMountReading,
  recordProbeReading,
  surfaceTopDatumFor,
} from '@/engine/cnc/registration/mountContext';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { registrationTouches } from '@/engine/cnc/plan';
import { faceUpOf, planFromSetups, setupsSettings } from '@/engine/cnc/setups';
import { jobMachine } from '@/engine/cnc/calibration';
import { clearanceZOf, rotaryOf } from '@/engine/cnc/machine';
import { planRegistrationAttempt } from './registrationAttempt';
import { RotaryAxisTap } from '@/components/manage/RotaryAxisTap';
import { RotaryFaceAngleTap } from '@/components/manage/RotaryFaceAngleTap';
import type { RegistrationAttempt } from './EngraveSetupRow';
import {
  viseFrameFromRegistration,
  withBracketPlacementSeed,
  withBracketSeatDatum,
  withSurfaceTopDatum,
  withViseJawTopDatum,
  withVisePlacementFrame,
} from '@/platform/bedProfiles';
import { bracketSeatFromTap } from '@/engine/cnc/mounts/bracket';
import { gridSeeds } from '@/engine/cnc/registration/placing';
import { useMachineTranscriptStore } from '@/store/machineTranscriptStore';
import { useMachineStore } from '@/store/machineStore';
import { useRegistrationTouchesStore } from '@/store/registrationTouchesStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';

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
}

type Phase = 'idle' | 'running' | 'measured' | 'writing' | 'recorded' | 'failed';

const n = (v: number): string => String(Math.round(v * 1000) / 1000);

/** #797 follow-up — the plan in one line: where it touches, how many touches, which probe. */
function proposalLine(plan: RegistrationPlan): string {
  // #1070 — the seat plan is one touch, named for what it measures.
  if (isSeatPlan(plan)) return 'the bracket seat — one Z seek on the wasteboard beside the front arm · wired probe';
  const order = ['left', 'front', 'right', 'back'] as const;
  const edges = order.filter((edge) => plan.scans.some((scan) => scan.edge === edge));
  const touches = registrationTouches({ ok: true, plan });
  const touchWords = `${touches} touch${touches === 1 ? '' : 'es'}`;
  const probeWords = probeInstrumentOf(plan.probe) === 'xyz' ? '3D probe' : 'wired probe';
  const list =
    edges.length === 0
      ? 'no edge scan'
      : edges.length === 1
        ? `${edges[0]} edge`
        : `${edges.slice(0, -1).join(', ')} and ${edges.at(-1)} edges`;
  return `${list}, then the top · ${touchWords} · ${probeWords}`;
}

/**
 * #1088 — A FLIPPED SETUP IS SIDE 2's, AND SIDE 2 REGISTERS ON THE BORES. This step runs side 1's
 * routine (`runRegistration` over `setups[0].registration.plan`); on a flipped setup those touches
 * would be aimed at a part that is no longer in that pose. The hole-registration executor is
 * #1088's own slice, so until it lands the step REFUSES by name and sends nothing.
 */
function flipRefusal(job: EngraveJob): string | null {
  if (job.setups?.[0]?.flip === undefined) return null;
  return (
    'This setup flips the part, so its registration is side 2’s — and side 2’s hole registration isn’t built yet. ' +
    'Nothing was sent: the touches here would be side 1’s, aimed at a part that is no longer in that pose.'
  );
}

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

export function EngraveRegistrationStep({ job, target }: EngraveRegistrationStepProps): JSX.Element {
  const { plan, why } = approvedPlan(job);
  // #797 follow-up — THE REGISTER CARD HOLDS THE ACTION. With no approved plan, the planner's
  // proposal is computed HERE, from the same machine record, shop defaults and engine call the
  // Setups section previews, and shown in one line. One press approves it and starts the run;
  // Design → Setups stays the place to edit it.
  const defaults = useShopDefaultsStore((s) => s.defaults);
  const calibration = useSettingsStore((s) => s.machineCalibration);
  const machineRecord = target === null ? null : machineAt(target);
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
  // #845 — a stated machine holds no probe and has no clearance to seek from: this step's actions
  // need a connected Makera machine, which is null for one (`MACHINE_RUN_ELSEWHERE` on its card).
  const seekFromMachineZ = useMemo(() => clearanceZOf(jobMachine(job, calibration)) ?? 0, [job, calibration]);
  const mountTap = useMemo(
    () => mountTapFor(machineRecord, Object.values(registrations), seekFromMachineZ, jobVise(job).jawStartY),
    [machineRecord, registrations, seekFromMachineZ, job],
  );
  const regSettings = useMemo(() => registrationSettings(defaults, probe).settings, [defaults, probe]);
  // #1070, 6b's ruling — THE FIRST-RUN SEAT PRESS: a seat plan (one bracket-seat mount tap, no
  // scans) runs through the STANDALONE tap with the plan's own seek bound, not the registration
  // executor; its reading is written as the bed profile's bracket seat by the same hook.
  const seatTapApi = useMountTap({
    target,
    settings: regSettings,
    floor: jobMachine(job, calibration).envelope.z.min,
    probeId: probe?.id ?? null,
    successNote: 'the bracket seat is recorded — plan the registration again',
  });
  const probeName = useMemo(() => probeNameFor(machineRecord), [machineRecord]);
  const setupSettings = useMemo(() => setupsSettings(defaults), [defaults]);
  const rotaryEnvelope = useMemo(() => rotaryOf(jobMachine(job, calibration))?.envelope, [job, calibration]);
  const proposal = useMemo<RegistrationAttempt | null>(() => {
    if (plan !== null) return null;
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
  ]);
  const [proposalOpen, setProposalOpen] = useState(false);
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

  /** #797 follow-up — approve the planner's proposal and start the run in ONE press. */
  async function approveAndStart(attempt: Extract<RegistrationAttempt, { kind: 'plan' }>): Promise<void> {
    // #1070 — the seat press measures, it does not register: run the one bounded seek and stop
    // (the hook writes the datum); the registration is planned again against the reading.
    const seatTap = seatTapArgs(attempt.plan);
    if (seatTap !== null) {
      await seatTapApi.tapJaw(seatTap);
      return;
    }
    const setups = job.setups ?? [];
    // #1070 — the approval MATERIALISES the derived first setup when the job saved none: the
    // registration lands on it, and nothing is written before this press.
    useEngraveJobStore.getState().setSetups(
      setups.length === 0
        ? [implicitJobSetup(job, registrationOf(attempt))]
        : setups.map((setup, i) =>
            i === 0
              ? { ...setup, registration: { method: attempt.method, plan: attempt.plan, expected: attempt.expected } }
              : setup,
          ),
    );
    await start(attempt.plan);
  }

  const record = useEngraveRegistrationStore((s) => s.record);
  // #797 — the one statement at Cut step 1 covers this step's probe-fitted ask.
  const statementGiven = useEngraveRunStore((s) => s.acknowledged);
  const measureSurface = useEngraveRegistrationStore((s) => s.measureSurface);
  const houseMargins = useSettingsStore((s) => s.margins);
  const [phase, setPhase] = useState<Phase>('idle');
  const [prompt, setPrompt] = useState<OperatorStep | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [written, setWritten] = useState<ApplyResult | null>(null);
  const [homeNote, setHomeNote] = useState<string | null>(null);
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
      setHomeNote(await homeAfterStop(handle));
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

  /** Stop, then home. The executor's stop sentence has already cleared G90/$X where it could. */
  async function homeAfterStop(handle: ConsoleHandle): Promise<string> {
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
        ? 'The machine was homed after the stop.'
        : `The machine did not answer the home command (${reply.kind}) — home it by hand.`;
    } catch {
      return 'The machine could not be homed — home it by hand.';
    }
  }

  async function start(planOverride?: RegistrationPlan): Promise<void> {
    // #1088 — a flipped setup has no executor yet: never attach the console for side 1's routine.
    if (flipRefusal(job) !== null) return;
    // #797 follow-up — the Register card approves the planner's proposal and starts in ONE press:
    // the plan it approved is handed here, because the render-time `plan` is still null.
    const effectivePlan = planOverride ?? plan;
    // #1070 — a stored seat plan still runs as the seat press (the standalone tap, bounded).
    const seatTap = effectivePlan === null ? null : seatTapArgs(effectivePlan);
    if (seatTap !== null) {
      await seatTapApi.tapJaw(seatTap);
      return;
    }
    // #797 — the ONE statement at Cut step 1 replaced this step's own at-machine tick.
    const acknowledged = useEngraveRunStore.getState().acknowledged;
    if (target === null || effectivePlan === null || !acknowledged || busy) return;
    // #639 — A NEW RUN FORGETS THE LAST CLAMPING. The record and the surface assessment belong to
    // the blank as it was; keeping them through a re-run (which may alarm out or be stopped) left
    // the Cut step claiming "Registration recorded", the dome tick ticked, and Upload enabled
    // against a blank that had moved.
    useEngraveRegistrationStore.getState().clear(job.id);
    setPhase('running');
    setResult(null);
    setWritten(null);
    setHomeNote(null);
    setError(null);
    setNarration(null);
    stopRef.current = false;
    setStopOutcome(null);
    // #638 — the plan this run is measured under travels with its result: a later setup edit must
    // not change what the record says was approved and run.
    runPlanRef.current = effectivePlan;
    frameSavedRef.current = false;
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
        measureSurface(job.id, target, r.spread);
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
        const note = stopRef.current ? null : await homeAfterStop(handle);
        if (!aliveRef.current) {
          handleRef.current = null;
          await handle.close();
          return;
        }
        setResult(r);
        setHomeNote(note);
        setPhase('failed');
        handleRef.current = null;
        await handle.close();
        return;
      }
      // #636 — THE MEASUREMENT IS ON SCREEN BEFORE ANY HOUSE WRITE. A throw or a refused save in
      // the chain below used to land in the outer catch as `failed`, and the successful probe result
      // was never shown; it is set first here, and every write's ANSWER is read below, with the
      // failure stated on the result rather than swallowed.
      setResult(r);
      const writeNotes: string[] = [];
      try {
        const machine = machineAt(target);
        if (machine !== null && (r.outcome.usable || r.mountTap !== null)) {
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
          const reference = effectivePlan.mountTap?.reference ?? 'vise-jaw-top';
          const mountTap = r.mountTap;
          // #607 — the reading is the bracket's TOP; the datum is the SEAT it stands on, one bracket
          // height below (`bracketSeatFromTap`), using the arm's measured top.
          const bracketSeat =
            mountTap !== null && reference === 'bracket-seat' ? bracketSeatFromTap(mountTap.z, effectivePlan.mountTap?.datumOffsetMm ?? 0) : null;
          const update: MachineUpdate = (current) => {
            let rec = bed(current);
            if (frameRegistration !== null) {
              const frame = viseFrameFromRegistration(frameRegistration, jobVise(job).jawStartY);
              rec = withVisePlacementFrame(rec, frame, { fixedJawFaceX: `measured:${now}`, jawStartY: 'typed' }, now);
              // #619 — write the measured surface top so the next plan expects the found top.
              rec = withSurfaceTopDatum(rec, { z: r.data.surface.z, at: effectivePlan.surfacePoint }, probeId, now);
            }
            if (mountTap !== null) {
              rec =
                bracketSeat !== null
                  ? withBracketSeatDatum(rec, { z: bracketSeat, at: mountTap.at }, probeId, now)
                  : withViseJawTopDatum(rec, mountTap, probeId, now);
            }
            return rec;
          };
          // #653 — NOTHING TO WRITE, NO WRITE. An out-of-margin vise run with no mount tap builds
          // nothing (no frame, no top, no datum, no bed — every step of the update above answers the
          // SAME record when it changes nothing), and a PUT of it could earn a 412 that this code
          // would report as "the record was not saved" for a run that had nothing to record.
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
            if (bracketSeat !== null) {
              // The shop default the compiler reads moves with the seat the run just measured.
              const saved = await useShopDefaultsStore.getState().set('bracket.seatMachineZ', {
                value: bracketSeat,
                source: 'measured',
                setAt: now,
                unit: 'mm',
                note: 'tapped on the bracket’s top face',
              });
              if (!saved) {
                writeNotes.push(
                  `the bracket seat was tapped, but the shop default was not saved: ${useShopDefaultsStore.getState().reason ?? 'the write was refused'}`,
                );
              }
            }
          }
        }
        // #601 — the probe's last M491 length and M119 rest ride on the checked-out probe accessory.
        await recordProbeReading(machineAt(target), r.probe);
        // #595 — a mount tap's reading rides on the mount checked out to the machine as well: the
        // vise's jaw top or the bracket's arm top, in the unit's own record (the one `mountDatumFor`
        // prefers). The bed datum above is the machine's copy of the same reading.
        if (r.mountTap !== null) {
          await recordMountReading(
            machineAt(target),
            effectivePlan.mountTap?.reference === 'bracket-seat' ? 'bracket' : 'vise',
            r.mountTap,
            effectivePlan.probe?.id ?? null,
          );
        }
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
    try {
      const a = await applyCorrection(
        result.outcome,
        {
          console: { send: (line, timing) => handle.send(line, timing) },
          operator: askOperator,
          // #933 — the Stop is live while the origin is written too: the button is on screen for
          // the whole phase, and a press that did nothing would be a dead press.
          stopRequested: () => stopRef.current,
        },
        { confirmed: true },
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
      // #638 — THE FRAME FOLLOWS THE ACCEPTANCE. A run outside the margin wrote no placement frame
      // and no surface top at measurement time (see `start`); pressing this button IS the operator
      // accepting the found position, so both land here, with the origin they belong to. A frame
      // whose measurement-time save failed is retried the same way. `frameSavedRef` is what keeps
      // the ordinary in-margin write from landing twice.
      if (!frameSavedRef.current && runPlan.mount === 'vise') {
        const machine = machineAt(target);
        if (machine !== null) {
          const now = new Date().toISOString();
          const registration = { measuredAt: now, correctedG54: result.outcome.correctedG54 };
          const bed = await createFirstBed(machine, registration, now);
          // #650 — folded onto the record the service holds, re-applied after a stale guard.
          const update: MachineUpdate = (current) => {
            let rec = bed(current);
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
            );
            return rec;
          };
          const answer = await saveMachineWithRetry(machine, update);
          if (answer === 'ok') frameSavedRef.current = true;
          else {
            result.outcome.notes.push(
              `the origin was written, but the placement frame was not saved: ${useLocationStore.getState().writeNote ?? 'the service refused the write'}. Run the registration again to write it.`,
            );
          }
        }
      }
      record(
        job.id,
        target,
        runPlan,
        result.outcome,
        // #608 — carry the fitted tilt (plane + reference Z0) on the record when the measurement
        // fits one; a flat fit records null, so the Cut step re-posts only when there is a tilt.
        result.spread === undefined ? null : surfaceFitForPost(result.spread),
      );
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
    setError(null);
    setPrompt(null);
    setDiscAnswer(null);
  }

  const outcome = result?.ok === true ? result.outcome : null;
  const spread = result?.ok === true ? (result.spread ?? null) : null;
  const refusal = outcome === null ? null : writerRefusal(outcome);
  const marginOnly = outcome !== null && marginRefusal(outcome);
  const data = result?.ok === true ? result.data : null;

  // #1088 — the flipped setup's refusal replaces the whole card: no plan, no proposal, no press.
  const flipWhy = flipRefusal(job);
  if (flipWhy !== null) {
    return (
      <div data-testid="engrave-registration" data-phase="idle" data-state="flipped" style={{ ...BOX, marginTop: 8 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#c8d3de' }}>
          Registration — find the stock, then set the origin
        </h3>
        <p style={{ ...MUTED, color: WARN }} data-testid="engrave-registration-flip-refusal">
          {flipWhy}
        </p>
      </div>
    );
  }

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

      {plan === null && proposal !== null && proposal.kind === 'plan' && (
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
          {proposalOpen && (
            <p style={MUTED} data-testid="engrave-registration-proposal-detail">
              {summarizePlan(proposal.plan)}
            </p>
          )}
          <button
            type="button"
            data-testid="engrave-registration-approve-start"
            disabled={!statementGiven || busy}
            style={{ width: '100%', padding: 7, marginTop: 6, fontWeight: 600 }}
            onClick={() => void approveAndStart(proposal)}
          >
            {seatTapArgs(proposal.plan) === null ? 'Register' : 'Measure the bracket seat'}
          </button>
          <p style={MUTED} data-testid="engrave-registration-proposal-where">
            This is the planner’s proposal; Design → Setups is where it is edited.
          </p>
        </div>
      )}
      {plan === null && proposal !== null && proposal.kind !== 'plan' && (
        <p style={{ ...MUTED, color: WARN }} data-testid="engrave-registration-no-plan">
          {proposal.kind === 'refused' ? proposal.reason : proposal.message}
        </p>
      )}
      {/* #1070 (C8) — THE PLACED BRACKET'S POSITION, stored where it lives: the bed profile.
          The grid's one admitting corner is offered when the bracket is off the pins; the touch
          route needs the machine and lands with the first bench session (named follow-up). */}
      {plan === null &&
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
      {plan === null && proposal === null && why !== null && (
        <p style={{ ...MUTED, color: WARN }} data-testid="engrave-registration-no-plan">
          {why}
        </p>
      )}

      {plan !== null && (
        <>
          <p style={{ ...MUTED, color: '#c8d3de' }} data-testid="engrave-registration-plan">
            Setup 1 · {job.setups?.[0]?.registration?.expected ?? 'the approved plan'}
          </p>
          <p style={MUTED} data-testid="engrave-registration-plan-summary">
            {summarizePlan(plan)}
          </p>

          {/* #934 — THE CENTRE-FIND (bore / boss / round part) is a 3D-probe routine the bench has
              not run; the planner refuses the instrument and the entry is hidden with it. The
              component and its plan stay in the tree for the branch's own bench issue. */}

          {(phase === 'idle' || phase === 'failed' || phase === 'recorded') && target !== null && (
            <>
              {/* #797 — the at-machine statement is the ONE statement at Cut step 1 (which names
                  the probe), so this step asks nothing of its own; it reads whether it was given. */}
              <button
                type="button"
                data-testid="engrave-registration-start"
                disabled={!statementGiven}
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
              {homeNote !== null && <p style={MUTED}>{homeNote}</p>}
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
                Registration recorded for the release step, with the plan that was approved.
              </p>
            </div>
          )}
          {written !== null && !written.ok && (
            <div data-testid="engrave-registration-write-failed" style={{ marginTop: 6 }}>
              <p style={{ fontSize: 12, color: BAD, margin: '0 0 4px' }}>{written.reason}</p>
            </div>
          )}

          {error !== null && (
            <p style={{ ...MUTED, color: BAD }} data-testid="engrave-registration-error">
              {error}
            </p>
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
