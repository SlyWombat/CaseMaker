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

import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import type { EngraveJob } from '@/types/engraveJob';
import type { RegistrationPlan } from '@/engine/cnc/registration/plan';
import type { RegistrationOutcome } from '@/engine/cnc/registration/outcome';
import { summarizeOutcome, summarizePlan } from '@/engine/cnc/registration/summary';
import {
  applyCorrection,
  runRegistration,
  type ApplyResult,
  type OperatorStep,
  type RunResult,
} from '@/engine/cnc/registration/execute';
import { attachConsole, type ConsoleHandle } from '@/platform/machineConsole';
import { controllerState } from '@/platform/machineUpload';
import { effectiveMargins } from '@/engine/cnc/engrave/depthBounds';
import {
  surfaceDomeGuidance,
  surfaceFitForPost,
  surfaceMarginWords,
  surfaceSpreadPlan,
} from '@/engine/cnc/engrave/surfaceSpread';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { cuttingDiameter } from '@/engine/cnc/tool';
import { shopDefault, useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
import { createFirstBed, machineAt, saveMachineWithRetry, useLocationStore, type MachineUpdate } from '@/store/locationStore';
import { recordProbeReading } from '@/engine/cnc/registration/mountContext';
import {
  viseFrameFromRegistration,
  withBracketSeatDatum,
  withSurfaceTopDatum,
  withViseJawTopDatum,
  withVisePlacementFrame,
} from '@/platform/bedProfiles';
import { bracketSeatFromTap } from '@/engine/cnc/mounts/bracket';
import { useMachineTranscriptStore } from '@/store/machineTranscriptStore';
import { useMachineStore } from '@/store/machineStore';
import { useRegistrationTouchesStore } from '@/store/registrationTouchesStore';
import { useSettingsStore } from '@/store/settingsStore';

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
  const record = useEngraveRegistrationStore((s) => s.record);
  const measureSurface = useEngraveRegistrationStore((s) => s.measureSurface);
  const houseMargins = useSettingsStore((s) => s.margins);
  const [phase, setPhase] = useState<Phase>('idle');
  const [atMachine, setAtMachine] = useState(false);
  const [prompt, setPrompt] = useState<OperatorStep | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [written, setWritten] = useState<ApplyResult | null>(null);
  const [homeNote, setHomeNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** #587 — the executor's latest step narration, shown instead of a blanket "Talking…". */
  const [narration, setNarration] = useState<string | null>(null);

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

  /** Stop, then home. The executor's stop sentence has already cleared G90/$X where it could. */
  async function homeAfterStop(handle: ConsoleHandle): Promise<string> {
    try {
      // #588 — "in alarm" is the machine's State, not a sentence. `$X` to an Idle machine is a no-op
      // with no reply, so it would sit out the console's 60 s first-reply window before `$H` (the
      // 2026-10-24 58 s park). Read `?` and clear only a controller that answers `<Alarm|…>`.
      const status = await handle.send('?');
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

  async function start(): Promise<void> {
    if (target === null || plan === null || !atMachine || busy) return;
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
    // #638 — the plan this run is measured under travels with its result: a later setup edit must
    // not change what the record says was approved and run.
    runPlanRef.current = plan;
    frameSavedRef.current = false;
    runJawStartYRef.current = job.workholding.vise.jawStartY;
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
      touchCount: plan.settings.surfaceTouchCount,
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
              clearanceMm: plan.settings.parkAboveSurfaceMm,
              points: shopDefault('plan.autoLevelPoints').value,
            };
      })(),
    });
    try {
      const r = await runRegistration(
        plan,
        {
          console: { send: (line, timing) => handle.send(line, timing) },
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
          store.setStock(
            {
              flatness: {
                xMm: r.spread.drops.xMm,
                yMm: r.spread.drops.yMm,
                source: 'measured',
                touchCount: r.spread.touches.length,
                measuredAt: new Date().toISOString(),
              },
            },
            'measured',
          );
        }
      }
      if (!r.ok) {
        const note = await homeAfterStop(handle);
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
            r.outcome.usable && r.outcome.withinMargin && plan.mount === 'vise'
              ? { measuredAt: now, correctedG54: r.outcome.correctedG54 }
              : null;
          // #613/#636 — ONE bed for the whole run: the frame and the datum land in ONE save, not two
          // beds in a row (a 'failed' first save could otherwise create a second, frame-less bed).
          // #650 — the bed and the datums are an UPDATE folded onto the record the service holds, so
          // a stale guard re-applies them to the re-read record instead of overwriting another
          // window's change with this run's pre-read copy.
          const bed = await createFirstBed(machine, frameRegistration, now);
          const probeId = plan.probe?.id ?? null;
          const reference = plan.mountTap?.reference ?? 'vise-jaw-top';
          const mountTap = r.mountTap;
          // #607 — the reading is the bracket's TOP; the datum is the SEAT it stands on, one bracket
          // height below (`bracketSeatFromTap`), using the arm's measured top.
          const bracketSeat =
            mountTap !== null && reference === 'bracket-seat' ? bracketSeatFromTap(mountTap.z, plan.mountTap?.datumOffsetMm ?? 0) : null;
          const update: MachineUpdate = (current) => {
            let rec = bed(current);
            if (frameRegistration !== null) {
              const frame = viseFrameFromRegistration(frameRegistration, job.workholding.vise.jawStartY);
              rec = withVisePlacementFrame(rec, frame, { fixedJawFaceX: `measured:${now}`, jawStartY: 'typed' }, now);
              // #619 — write the measured surface top so the next plan expects the found top.
              rec = withSurfaceTopDatum(rec, { z: r.data.surface.z, at: plan.surfacePoint }, probeId, now);
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
        { console: { send: (line, timing) => handle.send(line, timing) }, operator: askOperator },
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
              viseFrameFromRegistration(registration, runJawStartYRef.current ?? job.workholding.vise.jawStartY),
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
  }

  const outcome = result?.ok === true ? result.outcome : null;
  const spread = result?.ok === true ? (result.spread ?? null) : null;
  const refusal = outcome === null ? null : writerRefusal(outcome);
  const marginOnly = outcome !== null && marginRefusal(outcome);
  const data = result?.ok === true ? result.data : null;

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

      {why !== null && (
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

          {(phase === 'idle' || phase === 'failed' || phase === 'recorded') && target !== null && (
            <>
              <label style={MUTED}>
                <input
                  type="checkbox"
                  checked={atMachine}
                  data-testid="engrave-registration-at-machine"
                  onChange={(e) => setAtMachine(e.target.checked)}
                />{' '}
                I am at the machine, the probe is fitted.
              </label>
              <button
                type="button"
                data-testid="engrave-registration-start"
                disabled={!atMachine}
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
                  <button
                    type="button"
                    data-testid="engrave-registration-stop"
                    style={{ padding: 6 }}
                    onClick={() => answer(false)}
                  >
                    Stop
                  </button>
                </div>
              )}
            </div>
          )}

          {result !== null && !result.ok && (
            <div data-testid="engrave-registration-failed" style={{ marginTop: 6 }}>
              <p style={{ fontSize: 12, color: BAD, margin: '0 0 4px' }}>{result.reason}</p>
              {homeNote !== null && <p style={MUTED}>{homeNote}</p>}
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

              {phase === 'measured' && refusal === null && (
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
