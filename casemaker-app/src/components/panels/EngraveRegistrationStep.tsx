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
 * `RegistrationOutcome` is SESSION state (#495 decision): the document holds the approved plan, not
 * the last measurement.
 *
 * #475 — THE CUT-EXTENT SPREAD. The same run also measures the surface at the cut regions' extents
 * (`surfaceSpreadPlan(job)` at the approved plan's touch count and the house boundary margin the
 * sheet uses), reusing the executor's
 * `seekSurface` and its #430 bounds. The step shows the min/max/spread and the band; Z0 in the
 * recorded outcome is the LOWEST touch. A spread wider than the band is the `blank-bowed` refusal:
 * the outcome is unusable, so no origin is written and the write button is withheld. The measured
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
import { effectiveMargins } from '@/engine/cnc/engrave/depthBounds';
import { surfaceSpreadPlan, surfaceFitForPost, type SurfaceSpreadAssessment } from '@/engine/cnc/engrave/surfaceSpread';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { cuttingDiameter } from '@/engine/cnc/tool';
import { shopDefault, useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
import { createFirstBed, machineAt, useLocationStore } from '@/store/locationStore';
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
 */
function writerRefusal(
  outcome: RegistrationOutcome,
  spread: SurfaceSpreadAssessment | null = null,
): string | null {
  // #475/#608 — the blank's top is not one plane (the touches miss the fitted plane by more than the
  // depth band): no Z0 can keep every floor past the colour line and clear of the pocket, so this is
  // a refusal before it is an unusable edge scan.
  if (spread !== null && !spread.ok && spread.refusal !== null) {
    return `No origin is written: ${spread.refusal.message}.`;
  }
  if (!outcome.usable) {
    return `No origin is written from this measurement: ${outcome.problems.join('; ')}.`;
  }
  const measuredXY = outcome.bracketCheck !== undefined || outcome.currentG54 !== null;
  if (measuredXY && !outcome.withinMargin) {
    return `No origin is written: the stock is outside the ${n(outcome.margin)} mm margin. ${summarizeOutcome(outcome)} Re-seat it and run the registration again.`;
  }
  return null;
}

/** #620 — the refusal is ONLY the margin: usable, no spread refusal, measured XY but out of margin. */
function marginRefusal(outcome: RegistrationOutcome, spread: SurfaceSpreadAssessment | null): boolean {
  if (!outcome.usable) return false;
  if (spread !== null && !spread.ok && spread.refusal !== null) return false;
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

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      resolverRef.current?.(false);
      resolverRef.current = null;
      const handle = handleRef.current;
      handleRef.current = null;
      void handle?.close();
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
  async function homeAfterStop(handle: ConsoleHandle, reason: string): Promise<string> {
    try {
      if (/alarm/i.test(reason)) await handle.send('$X');
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
    setPhase('running');
    setResult(null);
    setWritten(null);
    setHomeNote(null);
    setError(null);
    setNarration(null);
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
          // The at-machine tick already names the wired probe, so the executor's first prompt is
          // answered by it; every other step (the bracket's clamps, the cutter) is a fresh press.
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
      if (!aliveRef.current) return;
      if (r.ok && r.spread !== undefined) {
        // #519 item 1 — the dock's Touches tab closes with the spread sentence (the rail's detailed
        // spread block stays where the Write decision is).
        useRegistrationTouchesStore
          .getState()
          .setSpreadSentence(
            r.spread.ok
              ? `Surface spread ${n(r.spread.spread)} mm against the ${n(r.spread.plan.band.width)} mm band — within it.`
              : r.spread.refusal?.message ?? null,
          );
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
        const note = await homeAfterStop(handle, r.reason);
        if (!aliveRef.current) return;
        setResult(r);
        setHomeNote(note);
        setPhase('failed');
        handleRef.current = null;
        await handle.close();
        return;
      }
      // #600 — a usable vise registration fixes the placement frame, so the mount tap and the datum
      // path read it instead of falling back to the newest registration record every time.
      if (r.outcome.usable && plan.mount === 'vise') {
        const machine = machineAt(target);
        if (machine !== null) {
          const now = new Date().toISOString();
          const registration = { measuredAt: now, correctedG54: r.outcome.correctedG54 };
          const frame = viseFrameFromRegistration(registration, job.workholding.vise.jawStartY);
          // #613 — a machine with no bed profile gets one here (bare bed, the vise accessory, the
          // pins placement) so the frame write-back has an active profile to land on.
          const withBed = await createFirstBed(machine, registration, now);
          const withFrame = withVisePlacementFrame(withBed, frame, { fixedJawFaceX: `measured:${now}`, jawStartY: 'typed' }, now);
          // #619 — write the measured surface top so the next plan expects the found top, not the ledge.
          const withSurface = withSurfaceTopDatum(
            withFrame,
            { z: r.data.surface.z, at: plan.surfacePoint },
            plan.probe?.id ?? null,
            now,
          );
          await useLocationStore.getState().saveMachine(withSurface);
        }
      }
      // #599/#607 — the mount tap measured a reference: write it into the datum that reference IS.
      if (r.mountTap !== null) {
        const machine = machineAt(target);
        if (machine !== null) {
          const now = new Date().toISOString();
          // #613 — a no-profile machine still needs the bed before the datum can land; the frame is
          // null here (a tap alone does not place the jaw), which a later registration fills.
          const withBed = await createFirstBed(machine, null, now);
          const probeId = plan.probe?.id ?? null;
          const reference = plan.mountTap?.reference ?? 'vise-jaw-top';
          if (reference === 'bracket-seat') {
            // #607 — the reading is the bracket's TOP; the datum is the SEAT it stands on, one
            // bracket height below (`bracketSeatFromTap`). Machine save first, then the shop default
            // the compiler reads — or the next plan refuses a seat this run has just measured.
            // The offset is the arm's MEASURED top (`bracket.armTopMm`), carried on the tap.
            const seat = bracketSeatFromTap(r.mountTap.z, plan.mountTap?.datumOffsetMm ?? 0);
            await useLocationStore
              .getState()
              .saveMachine(withBracketSeatDatum(withBed, { z: seat, at: r.mountTap.at }, probeId, now));
            const saved = await useShopDefaultsStore.getState().set('bracket.seatMachineZ', {
              value: seat,
              source: 'measured',
              setAt: now,
              unit: 'mm',
              note: 'tapped on the bracket’s top face',
            });
            if (!saved) {
              // A note on the RESULT, not a console line: the step renders `outcome.notes` beside
              // its verdict, and a tap whose seat did not stick must be visible there.
              r.outcome.notes.push(
                `the bracket seat was tapped, but the shop default was not saved: ${useShopDefaultsStore.getState().reason ?? 'the write was refused'}`,
              );
            }
          } else {
            // The vise's datum — the path every pre-#607 run took, unchanged.
            await useLocationStore
              .getState()
              .saveMachine(withViseJawTopDatum(withBed, r.mountTap, probeId, now));
          }
        }
      }
      // #601 — the probe's last M491 length and M119 rest ride on the checked-out probe accessory.
      await recordProbeReading(machineAt(target), r.probe);
      setResult(r);
      setPhase('measured');
      if (writerRefusal(r.outcome, r.spread ?? null) !== null) {
        handleRef.current = null;
        await handle.close();
      }
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
      handleRef.current = null;
      await handle.close();
    }
  }

  async function writeOrigin(force = false): Promise<void> {
    if (target === null || plan === null || result?.ok !== true || busy) return;
    // #620 — the margin refusal can be forced (the operator accepts the found position); the
    // unusable and spread refusals never can.
    const refusal = writerRefusal(result.outcome, result.spread ?? null);
    if (refusal !== null && !(force && marginRefusal(result.outcome, result.spread ?? null))) return;
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
      if (!aliveRef.current) return;
      setWritten(a);
      if (!a.ok) {
        setPhase('failed');
        handleRef.current = null;
        await handle.close();
        return;
      }
      record(
        job.id,
        target,
        plan,
        result.outcome,
        // #608 — carry the fitted tilt (plane + reference Z0) on the record when the measurement
        // fits one; a flat fit records null, so the Cut step re-posts only when there is a tilt.
        result.spread === undefined ? null : surfaceFitForPost(result.spread),
      );
      setPhase('recorded');
      handleRef.current = null;
      await handle.close();
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
      handleRef.current = null;
      await handle.close();
    }
  }

  function again(): void {
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
  const refusal = outcome === null ? null : writerRefusal(outcome, spread);
  const marginOnly = outcome !== null && marginRefusal(outcome, spread);
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
                I am at the machine, with the wired probe fitted and the head clear.
              </label>
              <button
                type="button"
                data-testid="engrave-registration-start"
                disabled={!atMachine}
                style={{ width: '100%', padding: 7, marginTop: 6 }}
                onClick={() => void start()}
              >
                {phase === 'idle' ? 'Run the registration' : 'Run the registration again'}
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
                      levelled at the console instead. */}
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
                        : 'flat'}
                    .
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
                    <div data-testid="engrave-registration-spread-refusal" style={{ ...MUTED, color: BAD }}>
                      {spread.refusal?.message}
                    </div>
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
