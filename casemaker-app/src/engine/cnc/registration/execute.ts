/**
 * The registration executor (#430 phase 1): runs a plan on the machine through the typed console
 * (`platform/machineConsole.ts`'s `ConsoleHandle`), one command per line, as the 2026-10-15 bench did.
 *
 * THE SEQUENCE.
 *   1. `?` must answer `Idle` — nothing moves a machine that is busy or alarmed.
 *   2. `$H`; `G54` selected explicitly; `G92.1` clears any G92 offset (this firmware has no way to
 *      read one, so none is left to sit silently between the touches and the origin).
 *   3. The OPERATOR fits the wired probe (a callback — a person, not this code). `M491`: its last
 *      `[PRB:…]` is the probe's tool-length reading, the Z0 reference.
 *   4. #1199 — EVERY XY MOVE IS TAKEN AT THE MACHINE'S CLEARANCE, and every descent AT the point to
 *      be probed. The surface at the plan's own point: lift to the clearance (`seek.fromMachineZ`,
 *      the plan's required machine travel height), move XY there, descend to the band's approach
 *      ONLY at that point, then a fast `G38.3` that travels only to the expected surface −
 *      tolerance, `G0 Z1`, a slow `G38.3`. BOTH readings must land inside the expected surface ±
 *      tolerance, or the run stops. The probe then PARKS at surface + park.
 *   5. Each edge scan, touch by touch: lift to the clearance, `G0 X Y`, descend to the park AT the
 *      point, `?` until Idle, `G91`, `G38.3 Z-(park + cap)` — so a touch can never go below the
 *      surface − cap — `G90`, the lift to park. Coarse, then fine; the scan stops at the first
 *      touch off the stock, then takes ONE touch midway back toward the stock to halve the last
 *      step (never further out than the miss). A scan whose FIRST touch misses the stock steps
 *      inward by the coarse step until it finds the stock (bounded by the opposite edge), then
 *      runs the outward fine pass (#593). The guard at {@link session} refuses any XY line below
 *      the clearance, so a routine cannot reintroduce a park-height traverse.
 *
 * EVERY PROBE IS `G38.3`, NEVER `G38.2` (#518, maintainer 2026-10-18: "why do we need to error, it causes
 * user panic that something bad happened"). A scan touch past the edge is the EXPECTED answer of a scan,
 * and `G38.2` turns it into `ALARM: Probe fail` with the machine locked until `$X` — observed on the
 * bench, every miss an alarm. `G38.3` reports the same miss as `[PRB:…:0]` and leaves the machine Idle
 * (2026-10-18, the laminate scans), so no `$X` is sent and the transcript shows each miss as a reading.
 * A surface seek that finds nothing is still a stop — this code's own, with the machine not in alarm.
 *   6. Lift to the plan's seek height (`G53 G0 Z` — the resolved machine's `toolChange.clearanceZ`) and
 *      `$H`.
 *
 * `?` IS POLLED UNTIL IDLE BEFORE EVERY `G38.3`, as the bench did: a probe sent while a move is still
 * settling is not a probe of where the move was meant to end.
 *
 * IT STOPS AT THE FIRST UNEXPECTED ANSWER — a refusal, a timeout, an error, any alarm that is not a
 * scan touch's expected miss, and anything alarming in the output that arrives BETWEEN lines (the
 * console's `carried`). It sends nothing more, except — when it stopped in relative mode — `$X` (if it
 * may be in alarm) and then `G90`, and says how low the probe may be at that step and how to recover.
 *
 * WRITING THE ORIGIN ({@link applyCorrection}) needs `confirmed: true` (Q12) AND a usable outcome — every
 * edge found, every axis measured, every touch where it was sent — and runs in #387's order: home,
 * the CUTTER in, its `M491`, `G10 L2 P1 X Y Z` with Z0 = surface + (cutter PRB − probe PRB), home.
 *
 * THE RE-TOUCH AFTER FACING (#432 slice 4, decision 4: probe → face → re-touch → engrave) is
 * {@link retouchSurface}: the same surface seek, at the plan's own point, against the surface the
 * skim was POSTED to leave. It returns an outcome whose `surfaceZ` is that MEASURED reading, and
 * `applyCorrection` writes it — the depth is never subtracted from the first reading to stand in
 * for a measurement, because a skim does not remove exactly its nominal depth.
 *
 * THE CUT-EXTENT SPREAD (#475) is an optional half of {@link runRegistration}: AFTER the edge scans
 * (#591 — the scans say where the stock is, and the touch points are placed by that offset), the
 * same `seekSurface` measures the plan's cut-extent touch points from just above the band (#590),
 * the readings are assessed against the depth band (`assessSurfaceReadings`), Z0 becomes the LOWEST
 * touch, and a RESIDUAL wider than the band after a plane fit (#608 — a top that is not one plane)
 * is a DOME (#631): the origin is still written and the machine levels the top itself; a mere tilt
 * fits the plane and is followed. The touches stay inside the registration's own validated seek
 * band, so the #430 cap and tolerance hold unchanged.
 */

import { controllerState } from '@/platform/machineUpload';
import { STATUS_POLL_TIMING, type ConsoleSendResult, type ConsoleTiming } from '@/platform/machineConsole';
// #933 — the pure status-line parser and the work-offset reading (`MPos − WPos`). This module has no
// socket in it (`protocol.ts`'s only import is the console gate), the same functions the status
// strip and the machine store already call.
import { readStatusLine, workOffset } from '@/platform/desktop/protocol';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { facingRetouchTolerance } from '@/engine/cnc/stockStart';
import {
  assessSurfaceReadings,
  type SurfaceReading,
  type SurfaceSpreadAssessment,
  type SurfaceSpreadPlan,
} from '@/engine/cnc/engrave/surfaceSpread';
import { type EdgeScan, type ProbeSpec, type RegistrationPlan, probeInstrumentOf, type FlipRegistrationPlan } from './plan';
import { probeColletWords } from '@/engine/cnc/probeFitWords';
import { classifyTouch, lastPrb, type Prb } from './readings';
import { sideCentreWork, sideTouchSelected, sideTouchSetup } from './probe3d';
import { centrePair, readCentrePair, type CentreFindPlan, type CentrePairReading } from './centreFind';
import {
  chordResidualMm,
  solveRotaryCircle,
  ROTARY_CHORD_TOLERANCE_MM,
  type ChordReading,
  type RotaryCircle,
} from './rotaryTap';
import type { LiveTouch } from './liveTouch';
import {
  faceAngleLimitProblem,
  solveFaceAngle,
  FACE_ANGLE_LEVEL_BAND_MM,
  FACE_ANGLE_MAX_CORRECTIONS,
  type FaceAnglePlan,
} from './faceAngle';
import {
  computeOutcome,
  correctionLine,
  edgeFrom,
  type RegistrationOutcome,
  type RunData,
  type ScanRecord,
  type ScanTouch,
} from './outcome';
import type { FlipZ0 } from '@/engine/cnc/engrave/flipChoice';
import { referenceOutcome } from './references';
import { correctedPlanForProbe, probeShiftMm, shiftedRecordedTopMachineZ } from './probeShift';
import { motionOrderGuard, planTravelProblem } from './motionOrder';
import {
  CUT_BLANK_ABOVE_BAND_FALLBACK_MM,
  CUT_BLANK_AGREE_FALLBACK_MM,
  settingsProblem,
  SURFACE_LIFT_MM,
  type RegistrationSettings,
} from './settings';

export interface RegistrationConsole {
  send(line: string, timing?: Partial<ConsoleTiming>): Promise<ConsoleSendResult>;
}

/**
 * The reply window for the `M491` two-touch macro (#563): the fast probe gap is ~13 s (108 mm at
 * F500), so the default 800 ms quiet would close the reply long before the slow `[PRB]` reading
 * lands. A longer quiet keeps the reader open across the probe moves.
 */
// #1123 item 17 — EXPORTED so the bench harness's restatement (`tools/z1/probeTiming.mjs`) can be
// held to it by a spec: a probe line's default reply window must be the app's own length.
export const PROBE_TIMING: Partial<ConsoleTiming> = { quietMs: 20_000 };

/**
 * #789 — THE PROBE CONNECTOR'S SUPPLY. `M831`/`M832` switch the toolsensor output (`switch.toolsensor`,
 * pin 2.13) — the supply the probe's connector draws on. The Makera 3D probe is electronic and reads
 * as permanently open while it is off, so a `G38.3` descends on a probe that cannot trigger (bench,
 * 2026-10-30: the ring lights and `P:` starts moving only after `M831`). The wired V2 is a mechanical
 * switch and runs the same either way, so BOTH kinds of probe session bracket their probe moves:
 * ON once the operator says the probe is fitted (before the rest check, which an electronic probe
 * can only answer while powered), OFF in a finally once the last touch is done, whatever happened
 * in between. The firmware's own macros do the same around their probe cycles.
 */
export const PROBE_SUPPLY_ON = 'M831';
export const PROBE_SUPPLY_OFF = 'M832';

export type OperatorStep = {
  kind: 'fit-probe' | 'fit-cutter' | 'confirm-mount' | 'search-lower' | 'derived-surface';
  text: string;
};

/**
 * #1166 (c1) — THE TOP QUESTION's answer, when earlier programs may have cut the plan's surface
 * point away. Exactly one of:
 *  - `typed` — a machine Z the operator measured before (the card's field; never pre-filled);
 *  - `derived` — the bracket's own top (the plan's seat + the stock's thickness);
 *  - `seek` — today's surface seek, unchanged (including the after-miss offer);
 *  - `stop` — not offered by the card: an unmount/abort answers it, and nothing moves.
 */
export type TopChoice =
  | { kind: 'seek' }
  | { kind: 'derived' }
  | { kind: 'typed'; machineZ: number }
  | { kind: 'stop' };

/** #1166 (c1) — what the top question asks, in the numbers the card prints. */
export interface TopQuestion {
  /** The plan's surface point, WORK XY — the spot the seek would touch. */
  surfacePoint: { x: number; y: number };
  /** The band a typed answer must fall inside, MACHINE Z (`expected ± surfaceToleranceMm`). */
  band: { min: number; max: number };
  /**
   * The bracket's own top: the plan's expected surface (its seat + the stock's thickness), the seat
   * that arithmetic implies, and the thickness. `seat`/`thickness` are null only when the plan does
   * not carry the stock's thickness — the sum is then stated alone.
   */
  derived: { machineZ: number; seat: number | null; thickness: number | null };
}

/**
 * The sentence the operator confirms before anything moves sideways on the bracket (#427 review): the
 * plan's scan lines and travel are clear only of the clamps where the PLAN puts them.
 */
export function mountConfirmText(plan: RegistrationPlan): string {
  const clamps = plan.mountObstacles.filter((o) => o.kind === 'clamp').map((o) => o.label);
  const where = clamps.length === 0 ? 'no clamps at all on the stock' : clamps.join('; ');
  return `Check the clamps before the probe moves: the plan assumes ${where}. Continue only if that is what is on the machine — a clamp anywhere else may be in the probe's path.`;
}

export interface ExecDeps {
  console: RegistrationConsole;
  operator: (step: OperatorStep) => Promise<boolean>;
  /** #587 — the latest step narration, so the section shows what is running, not a blanket "Talking…". */
  onStep?: (sentence: string) => void;
  /**
   * #519 item 1 — each reading AS IT LANDS, so the viewport draws the touch and the dock lists it
   * while the run goes. Optional, and the executor never depends on a listener: a caller that omits
   * it gets exactly the behaviour it had (the readings still come back in `RunResult`).
   */
  onTouch?: (touch: LiveTouch) => void;
  /**
   * #933 — the operator's Stop. Checked before every line the run sends, exactly as the run
   * screen's player does (`machineRun.ts`): the line in flight finishes, but no further line goes
   * out and the stop path releases the stylus before the run returns.
   */
  stopRequested?: () => boolean;
  /**
   * #933 — the work origin (G54 X/Y) this bed was last registered to, when the caller has one. The
   * run checks the machine's own G54 against it before the first touch and stops with a sentence
   * when they disagree; null/absent means there is nothing to compare (a first registration).
   */
  expectedG54?: { x: number; y: number } | null;
  /**
   * #1166 — THE JOB HAS FINISHED PROGRAMS on this machine. The caller reads the machine record and
   * the job's run log; the executor never touches a store. On a bracket hold whose plan exists only
   * off a MEASURED seat (`bracketExpectedSurface` refuses without one, so the plan's expected
   * surface IS seat + the stock's thickness), a surface seek that finds nothing — or reads BELOW its
   * band, because an earlier program cut that spot away — then offers ONE press: use the bracket's
   * own top as a DERIVED surface, recorded as derived, never as a touch. Absent/false keeps today's
   * stop, and that is every vise and tape run.
   */
  hasFinishedPrograms?: boolean;
  /**
   * #1166 (c1) — THE TOP QUESTION, asked once after the probe's M491 and BEFORE any probe motion,
   * under the same guard as `hasFinishedPrograms`. The card offers a typed top (measured before),
   * the bracket's own top, or today's seek; absent, the run keeps today's seek (the after-miss offer
   * still applies). A typed Z outside `band` is refused here as well as on the card.
   */
  askTop?: (question: TopQuestion) => Promise<TopChoice>;
  /**
   * #1179 D/B4 — THE LAST TOP RECORDED FOR THIS BLANK on this machine (F's finished run:
   * `registration.surfaceMachineZ`, the top its origin was accepted at). The derived offer
   * continues from THIS top rather than seat + stated thickness; absent/null keeps the arithmetic.
   */
  lastRecordedTopMachineZ?: number | null;
  /**
   * #1189 — the probe's `M491` reference at the run that recorded that top. The record is a raw
   * machine Z, so it is corrected by `today's M491 − this`; null/absent means the record cannot be
   * separated from the probe's seating and is not used across a fitting.
   */
  lastRecordedTopProbeRefZ?: number | null;
  /**
   * #1199 item 2 — THE LIVE MACHINE'S CLEARANCE at RUN time (`toolChange.clearanceZ` of the
   * resolved machine/profile), read by the caller when the run starts. The executor refuses when
   * the plan's travel height or its recorded clearance sits below this, and builds the safe-Z
   * guard from it. REQUIRED: a run proves its plan against the machine as it is now, and tsc
   * makes every caller state the value (a test may pass the plan's own clearance).
   */
  liveClearanceZ: number;
}

/**
 * #1199 item 2 — the clearance a plan may run under, proven against the LIVE machine when the
 * caller supplies it. Returns the value to build the guard from, or the refusal sentence.
 */
function liveClearanceFor(plan: RegistrationPlan, deps: ExecDeps): { clearanceZ: number; problem: string | null } {
  const live = Number.isFinite(deps.liveClearanceZ as number) ? (deps.liveClearanceZ as number) : (plan.machineClearanceZ ?? Number.NaN);
  const problem =
    planTravelProblem(plan.seek.fromMachineZ, live, 'plan’s travel height') ??
    planTravelProblem(plan.machineClearanceZ ?? Number.NaN, live, 'plan’s recorded clearance');
  return { clearanceZ: live, problem };
}

export interface Transcript {
  line: string;
  reply: string;
}

export type RunResult =
  | {
      ok: true;
      data: RunData;
      outcome: RegistrationOutcome;
      /**
       * #475 — the cut-extent measurement, when the caller asked for one. Its `z0` is the outcome's
       * `surfaceZ` (the lowest touch) and its `refusal` is already in `outcome.problems`, so an
       * origin cannot be written from a refused blank by accident.
       */
      spread?: SurfaceSpreadAssessment;
      /**
       * #599 — the mount tap's reading (the fixed-jaw top, machine Z) and where it was taken, or null
       * when the plan carried no tap. The executor only measures it; writing the datum is the caller's.
       */
      mountTap: { z: number; at: { x: number; y: number } } | null;
      /** #601 — the probe's M491 length and M119 rest reading, for the caller to write onto the accessory. */
      probe: { lengthZ: number; rest: string };
      transcript: Transcript[];
    }
  | { ok: false; reason: string; transcript: Transcript[] };

/**
 * How many `?` polls to wait for Idle before a probe — each is a round trip of about a second. The
 * labelled NO-SERVICE FALLBACK only: the run uses the plan's `registration.idlePollLimit` (#449).
 */
export const MAX_IDLE_POLLS = 30;

/**
 * #933 — how many status polls a late `$H` is given before its home is called failed. The bench's
 * homes are 22–31 s (2026-10-15) and a cold start's auto-home has never been timed, so the reply
 * window is the console's, and this is the wait AFTER it for the controller to say Idle: 20 polls at
 * the 3 s status window ≈ 60 s — bounded, and never a line sent into a moving machine.
 */
export const HOME_POLLS = 20;

/**
 * #933 — how far the machine's G54 may be from the bed's recorded origin before a run refuses to
 * touch. A WRONG-ORIGIN guard, not a precision check: a different job's origin is tens of mm away,
 * while a registration's own accuracy is sub-0.1 mm.
 */
export const G54_PREFLIGHT_MM = 1;

const f = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';
const r3 = (n: number) => Math.round(n * 1000) / 1000;

class Stop extends Error {}

/**
 * One machine conversation, stopping at the first answer it did not expect. `seekFromMachineZ` is
 * REQUIRED: it is the height the recovery sentence tells the operator to lift to (the resolved
 * machine's `toolChange.clearanceZ`), and a forgotten argument must be a typecheck error, never a
 * silent −3 that could send the head somewhere the machine does not call clear.
 */
function session(
  deps: ExecDeps,
  seekFromMachineZ: number,
  idlePollLimit: number = MAX_IDLE_POLLS,
  /**
   * #933 — the run's probe is the 3D one (see {@link probeNeedsRelease}): a stop that lands with
   * the stylus still deflected must release it before the epilogue's home, or that rapid alarms.
   */
  releaseProbeOnStop = false,
  /**
   * #1199 field 7 — WHERE A DESCENT BELOW THE CLEARANCE MAY HAPPEN for this session (the plan's
   * stock box, its edge-find windows and its tap target). Absent: the clearance/order rules apply
   * without a footprint check.
   */
  descentAllowed?: (machine: boolean, x: number, y: number) => boolean,
) {
  // A bounded wait whatever the location says: a whole number of polls, at least one (#449).
  const idlePolls = Number.isInteger(idlePollLimit) && idlePollLimit >= 1 ? idlePollLimit : MAX_IDLE_POLLS;
  const transcript: Transcript[] = [];
  let relative = false;
  /** How low the probe may be right now, in a sentence — set by each step that moves it down. */
  let depth = 'at a safe height';
  /** #588 — whether the run reached its own home step before it stopped. */
  let homed = false;
  /**
   * #933 — the last probe move that went out and has NOT been released: its axis and the sign of
   * the travel that deflected the stylus (a `G38.3` always moves INTO the material's direction).
   * Cleared when a `G38.5` goes out. This is what lets a Stop between a triggered touch and its
   * release still back the stylus off.
   */
  let probeDown: { axis: 'X' | 'Y' | 'Z'; travelSign: number } | null = null;
  /**
   * #1199 — THE SAFE-Z INVARIANT, at the one layer every probing routine shares. `seekFromMachineZ`
   * is the machine's clearance (see the parameter's contract above), and the guard refuses any XY
   * line sent from below it — so a routine that lifts to a band height and traverses is stopped
   * before the line reaches the wire, and a descent is only ever taken at the point to be probed.
   */
  const motion = motionOrderGuard(seekFromMachineZ, descentAllowed === undefined ? {} : { descentAllowed });

  /** The operator's Stop, checked before every line the run sends (#933, `machineRun.ts`'s shape). */
  function stoppedByOperator(): boolean {
    return deps.stopRequested?.() === true;
  }

  async function send(line: string, opts: { missOk?: boolean; timing?: Partial<ConsoleTiming> } = {}): Promise<string> {
    if (stoppedByOperator()) throw new Stop('stopped: the operator pressed Stop');
    // #1199 — BEFORE THE WIRE: a line that would traverse XY below the clearance never goes out.
    const refusal = motion.check(line);
    if (refusal !== null) throw new Stop(refusal);
    const r = await deps.console.send(line, opts.timing);
    const reply = r.kind === 'sent' || r.kind === 'timeout' ? r.text : r.detail;
    const carried = r.kind === 'sent' || r.kind === 'timeout' ? (r.carried?.text ?? '') : '';
    transcript.push({ line, reply: carried ? `${reply}\n(between lines) ${carried}` : reply });
    // #1199 — the line moved the head (or may have): the guard's bookkeeping follows the reply.
    motion.commit(line, carried ? `${reply}\n${carried}` : reply);
    if (r.kind !== 'sent') throw new Stop(`${line}: ${r.kind} — ${reply}`);
    for (const text of [reply, carried]) {
      if (/\berror:/i.test(text)) throw new Stop(`${line}: the controller answered ${text.trim()}`);
      const alarm = /ALARM[^\n]*/i.exec(text)?.[0];
      if (alarm && !(opts.missOk && text === reply && /Probe fail/i.test(alarm))) throw new Stop(`${line}: ${alarm.trim()}`);
    }
    if (line === 'G91') relative = true;
    if (line === 'G90') relative = false;
    // #933 — the stop path's bookkeeping: what the probe touched, and when it was released. A MISS
    // reading (`:0`) leaves the stylus OPEN — there is nothing to back away from, so the release
    // booking is cleared on the reading, not on the line. A reply with no PRB at all does not say
    // (the controller did not answer a flag), so the booking stays: a release from an open stylus
    // is a plain `G38.5` move, never the G0 that alarms.
    const probe = /^G38\.3 ([XYZ])(-?[\d.]+) F/.exec(line);
    if (probe !== null) {
      const touched = lastPrb(reply)?.touched ?? null;
      probeDown =
        touched === false
          ? null
          : { axis: probe[1] as 'X' | 'Y' | 'Z', travelSign: Math.sign(Number(probe[2])) };
    }
    if (/^G38\.5 /.test(line)) probeDown = null;
    return reply;
  }

  /**
   * #789 — a best-effort line after the run's outcome is already decided (the supply's OFF). It
   * never throws: the outcome must not be replaced by the closing line's failure, and a dead
   * socket at that moment still leaves the machine's own switch where it was.
   */
  async function trySend(line: string): Promise<void> {
    try {
      const r = await deps.console.send(line);
      transcript.push({ line, reply: r.kind === 'sent' || r.kind === 'timeout' ? r.text : r.detail });
    } catch {
      // The outcome is already decided; a dead socket here must not replace it.
    }
  }

  /** `?` until the machine reads Idle; stop if it never does. #933 — each poll on the STATUS window. */
  async function idle(): Promise<void> {
    for (let i = 0; i < idlePolls; i++) {
      const state = controllerState(await send('?', { timing: STATUS_POLL_TIMING }));
      if (state === 'Idle') return;
    }
    throw new Stop(`the machine did not read Idle in ${idlePolls} status polls`);
  }

  /**
   * #933 — `$H`, BOUNDED. The home is the one line whose answer may outlive the console's window on
   * a cold start (auto-home), and while it runs the controller is MOVING — so a timeout must not be
   * answered with the stop path's recovery lines. Instead the status is polled (3 s window) until
   * it reads Idle (the home finished — carry on) or Alarm (homing failed — stop), at most
   * {@link HOME_POLLS} times; past that the run stops with the home named. The `$H` line itself
   * keeps the console's own window: it is the shop's `console.firstReplyMs`, which states it sits
   * above the slowest bench line ($H ~31 s, 2026-10-15).
   */
  async function home(): Promise<void> {
    const r = await deps.console.send('$H');
    const reply = r.kind === 'sent' || r.kind === 'timeout' ? r.text : r.detail;
    transcript.push({ line: '$H', reply });
    if (r.kind === 'sent') {
      for (const text of [reply, r.carried?.text ?? '']) {
        if (/\berror:/i.test(text)) throw new Stop(`$H: the controller answered ${text.trim()}`);
        const alarm = /ALARM[^\n]*/i.exec(text)?.[0];
        if (alarm) throw new Stop(`$H: ${alarm.trim()}`);
      }
      // #1199 — home puts the head at the top of its travel: the guard may now allow a traverse.
      motion.commit('$H');
      return;
    }
    if (r.kind !== 'timeout') throw new Stop(`$H: ${r.kind} — ${reply}`);
    // A timeout is not a failed home: the queue may still be running. Wait for the controller's
    // own State word rather than sending a recovery line into a moving machine.
    for (let i = 0; i < HOME_POLLS; i++) {
      const poll = await deps.console.send('?', STATUS_POLL_TIMING);
      transcript.push({ line: '?', reply: poll.kind === 'sent' ? poll.text : poll.kind });
      if (poll.kind !== 'sent') continue;
      const state = controllerState(poll.text);
      if (state === 'Idle') {
        // #1199 — the timeout was a long home, not a failed one; the head is at the top.
        motion.commit('$H');
        return;
      }
      if (state === 'Alarm') throw new Stop('$H: the machine is in alarm after homing — check the machine before anything moves');
    }
    throw new Stop(`$H did not answer and the machine did not read Idle in ${HOME_POLLS} status polls — home it by hand`);
  }

  /** Say how low the probe may be from here on (the stop message uses the latest), and narrate the step (#587). */
  function at(sentence: string): void {
    depth = sentence;
    deps.onStep?.(sentence);
  }

  /** #519 item 1 — one reading, numbered in the order the run lands them. */
  let readings = 0;
  function saw(touch: Omit<LiveTouch, 'seq'>): void {
    readings += 1;
    deps.onTouch?.({ seq: readings, ...touch });
  }

  /** The machine's own State word, read fresh from `?` — null when it does not answer one. */
  async function readState(): Promise<string | null> {
    try {
      // #933 — the status window, so a silent link costs 3 s here instead of the console's 60.
      const r = await deps.console.send('?', STATUS_POLL_TIMING);
      transcript.push({ line: '?', reply: r.kind === 'sent' ? r.text : r.kind });
      return r.kind === 'sent' ? controllerState(r.text) : null;
    } catch {
      return null;
    }
  }

  /**
   * After a stop: if the mode was left relative, put it back — `$X` FIRST, because the Z1 refuses `G90`
   * with `error:Alarm lock` while in alarm (Z1-Firmware-Dialect.md, the 2026-10-08 table) — and say
   * how low the probe may be and how to recover. Nothing else is sent.
   */
  async function stopped(reason: string): Promise<string> {
    // #588 — "in alarm" is a machine State, not a sentence. Only a controller that answers `?` with
    // `<Alarm|…>` is cleared: `$X` to an Idle machine is a no-op with no reply, so it would sit out
    // the console's whole 60 s first-reply window (the 2026-10-24 58 s park). A `?` that does not
    // answer reads null, which is never treated as an alarm.
    const inAlarm = (await readState()) === 'Alarm';
    // #933 — THE STYLUS IS RELEASED BEFORE ANYTHING ELSE. A stop can land between a triggered
    // `G38.3` and its `G38.5` — the operator's Stop is one way, a refused line is another — and the
    // epilogue's home is a rapid. The release is a probe move, so it goes out under `G91` (an
    // alarm is cleared first: the controller refuses motion while locked). When it cannot go out,
    // the sentence says the stylus may still be down rather than pretending it is open.
    let releaseNote: 'released' | 'down' | null = null;
    let alarmCleared = false;
    if (releaseProbeOnStop && probeDown !== null) {
      if (inAlarm) {
        alarmCleared = true;
        try {
          const x = await deps.console.send('$X');
          transcript.push({ line: '$X', reply: x.kind === 'sent' ? x.text : x.kind });
        } catch {
          // The release below reports the state honestly; the operator has the recovery sentence.
        }
      }
      try {
        const rel = await deps.console.send('G91');
        transcript.push({ line: 'G91', reply: rel.kind === 'sent' ? rel.text : rel.kind });
        if (rel.kind === 'sent') {
          relative = true;
          const line = probeAwayLine(probeDown.axis, probeDown.travelSign < 0 ? PROBE_AWAY_MM : -PROBE_AWAY_MM);
          const away = await deps.console.send(line);
          transcript.push({ line, reply: away.kind === 'sent' ? away.text : away.kind });
          releaseNote = away.kind === 'sent' ? 'released' : 'down';
          if (away.kind === 'sent') probeDown = null;
        } else {
          releaseNote = 'down';
        }
      } catch {
        releaseNote = 'down';
      }
    }
    if (relative) {
      // #933 — the alarm was already cleared above when the release needed it; one `$X` per stop.
      for (const line of inAlarm && !alarmCleared ? ['$X', 'G90'] : ['G90']) {
        try {
          const r = await deps.console.send(line);
          transcript.push({ line, reply: r.kind === 'sent' ? r.text : r.kind });
        } catch {
          break;
        }
      }
    }
    const probeWords =
      releaseNote === 'released'
        ? ' The stop released the stylus before stopping.'
        : releaseNote === 'down'
          ? ' The stylus may still be down — release it (G38.5) before any move.'
          : '';
    // #588 — the recovery advice is only true when the machine is actually in alarm. A G38.3 miss is
    // a READING, not an alarm (#518), so a clean stop must not tell a beginner to clear an alarm that
    // is not there; a run that reached its own home step has nothing to recover at all.
    if (homed) return `${reason}. Stopped — the probe may be ${depth}.${probeWords} Homed; nothing to recover.`;
    if (inAlarm) {
      return (
        `${reason}. Stopped — the probe may be ${depth}, and the machine may be in alarm.${probeWords} ` +
        `To recover: $X, then G90, then lift with G53 G0 Z${f(seekFromMachineZ)} before any XY move.`
      );
    }
    return `${reason}. Stopped — the probe may be ${depth}.${probeWords} The machine is Idle; nothing to recover.`;
  }

  return { send, trySend, idle, home, stopped, at, saw, markHomed: () => { homed = true; }, transcript };
}

type Session = ReturnType<typeof session>;

/**
 * The XY move to a work position. On the bracket it is sent in MACHINE coordinates from the bracket's
 * origin (#427) — `G53 G0 X Y`, observed `ok` on the bench (Z1-Firmware-Dialect.md, the B6 trace) — so the
 * touches land on the stock whatever G54 was left in force; elsewhere, plain `G0` in the work frame.
 */
function moveXY(plan: RegistrationPlan, x: number, y: number): string {
  const o = plan.mount === 'bracket' ? plan.bracketOrigin : null;
  return o ? `G53 G0 X${f(o.x + x)} Y${f(o.y + y)}` : `G0 X${f(x)} Y${f(y)}`;
}

/** #932 — the feed of a probe-away move: the bench's own 100 mm/min (10-30 survey's fix line). */
const PROBE_AWAY_FEED = 100;

/**
 * #932 — how far a probe-away move backs the stylus off, mm. The 3 mm centre-find and the rotary
 * tap already send (`CentreFindOptions.releaseMm`'s default), so the registration and the two
 * routines that had the release cannot drift apart.
 */
const PROBE_AWAY_MM = 3;

/**
 * #932 — THE PROBE-AWAY LINE, built in one place: `G38.5 <axis><signed travel> F<feed>`, sent while
 * `G91` is in force, after a TRIGGERED reading and BEFORE the first `G0`/`G53 G0`. The 3D probe's
 * stylus stays deflected where the controller stopped the move; a rapid from there alarms
 * `unexpected probe trigger` and cuts the probe's supply (10-30 survey :2033, 10-31 bore :503).
 *
 * A ZERO TRAVEL IS REFUSED BEFORE THE WIRE. The controller answers `G38.5 X0 Y F100` with
 * `error:at least one of X Y or Z must be specified, and be > or < 0` (10-31 bore :495), and the
 * contact then stays deflected for the next rapid — the exact alarm this release exists to prevent.
 */
function probeAwayLine(axis: 'X' | 'Y' | 'Z', travelMm: number, feed = PROBE_AWAY_FEED): string {
  if (!Number.isFinite(travelMm)) throw new Stop(`nothing to release: the G38.5 ${axis} travel is not a number`);
  const travel = Math.round(travelMm * 1000) / 1000;
  if (travel === 0) {
    throw new Stop(
      `nothing to release: a G38.5 ${axis} of ${f(travelMm)} mm has no travel — the controller refuses a move with nothing to move`,
    );
  }
  return `G38.5 ${axis}${travel > 0 ? f(travel) : `-${f(-travel)}`} F${f(feed)}`;
}

/**
 * #932 — whether this probe needs the release. The 3D probe's stylus stays deflected after a
 * touch; the wired V2 is a mechanical switch that returns, and has tolerated the plain retract in
 * every bench run. WP-10's rule: the wired probe gets the release too only after an air run shows
 * it is safe for it, then this gate comes out.
 */
function probeNeedsRelease(probe: ProbeSpec | null): boolean {
  return probeInstrumentOf(probe) === 'xyz';
}

/**
 * One scan touch at `at`: lift to the clearance, XY there, down to the park AT the point, Idle,
 * probe down at most to the cap, clear a miss, lift.
 *
 * #1199 — EVERY scan move traverses at the clearance. #427's `travelHigh` lifted only the FIRST
 * touch of a bracket scan (to `seek.fromMachineZ`, which the builders fill from the machine's
 * clearance); every other touch and stepover moved at whatever park height was left over — safe by
 * VALUE (the park is above the measured surface), not by construction, and the same shape as the
 * bench accident. That conditional is gone: the lift is the clearance every time, and the guard at
 * `session()` refuses any routine that moves XY from below it.
 */
async function touch(io: Session, plan: RegistrationPlan, scan: EdgeScan, at: number, parkZ: number, surfaceZ: number): Promise<ScanTouch> {
  const s = plan.settings;
  const [x, y] = scan.edge === 'left' || scan.edge === 'right' ? [at, scan.along] : [scan.along, at];
  await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
  await io.send(moveXY(plan, x, y));
  await io.send(`G53 G0 Z${f(parkZ)}`);
  await io.idle();
  io.at(`as low as ${s.capBelowSurfaceMm} mm below the surface (a scan touch)`);
  await io.send('G91');
  const reply = await io.send(`G38.3 Z-${f(s.parkAboveSurfaceMm + s.capBelowSurfaceMm)} F${f(s.touchFeed)}`, { missOk: true });
  const prb = lastPrb(reply);
  if (prb === null) throw new Stop(`the touch at ${f(x)}, ${f(y)} answered no probe reading`);
  // A miss under G38.3 is a reading, not an alarm (#518): nothing to clear. #932 — a touch that DID
  // land is released before the retract: a rapid from a deflected stylus alarms and cuts its supply.
  if (prb.touched && probeNeedsRelease(plan.probe)) await io.send(probeAwayLine('Z', PROBE_AWAY_MM));
  await io.send('G90');
  await io.send(`G53 G0 Z${f(parkZ)}`);
  io.at(`at the park height, ${s.parkAboveSurfaceMm} mm above the surface`);
  const kind = classifyTouch(prb, surfaceZ, s.surfaceBandMm);
  // #519 item 1 — the scan's reading, where it was commanded (WORK XY), as it lands.
  io.saw({ source: 'edge', label: scan.label ?? `the ${scan.edge} edge`, x, y, z: prb.z, touched: prb.touched, kind });
  return { at, prb, kind };
}

/**
 * One pass across an edge by BRACKET AND BISECTION (#594): the scan holds a point that is ON the
 * stock — the surface touch, answered a moment before at this axis's coordinate — and probes for the
 * edge between it and a point that is OFF, halving the bracket until it is the fine step. That finds
 * the edge in ~log₂ touches whatever the offset, instead of crawling 1 mm then 0.5 mm a touch at a
 * time (#593's inward search cost a touch per millimetre of offset).
 *
 * A first touch that reads ABOVE the surface is a clamp, not an invitation to search (unchanged);
 * `aboveIsEdge` (#517) still turns a high reading into the edge, and a reference scan's `label`
 * names a wall rather than a stock edge (its `oppositeAt` is absent, but the bracket uses the surface
 * point, so no field is needed).
 */
async function scanEdge(io: Session, plan: RegistrationPlan, scan: EdgeScan, parkZ: number, surfaceZ: number): Promise<ScanRecord> {
  const touches: ScanTouch[] = [];
  const probe = (p: number) => touch(io, plan, scan, p, parkZ, surfaceZ);
  // The known-on coordinate along this scan's axis: the surface touch answered there a moment ago.
  const surfaceCoord = scan.edge === 'left' || scan.edge === 'right' ? plan.surfacePoint.x : plan.surfacePoint.y;

  const start = await probe(scan.start);
  touches.push(start);
  if (start.kind === 'above' && scan.aboveIsEdge !== true) return { scan, touches };

  let on: number; // the known-on position (stock)
  let off: number; // the known-off position (past the edge)
  if (start.kind === 'stock') {
    on = scan.start;
    // The edge is outward of the start. Probe the outward limit to bracket it.
    const limit = await probe(scan.limit);
    touches.push(limit);
    if (limit.kind === 'above' && scan.aboveIsEdge !== true) return { scan, touches };
    if (limit.kind === 'stock') return { scan, touches }; // still on the stock: the edge is beyond the reach
    off = scan.limit;
  } else {
    // The start is off the stock (or the jaw past a recessed blank): the edge is inward of it.
    off = scan.start;
    on = surfaceCoord;
  }

  // Bisect to half the fine step: the edge is then known to a quarter step, which is the resolution
  // the reference scans' centre check (#429) reads the walls to.
  while (Math.abs(on - off) > scan.fineStep / 2) {
    const mid = r3((on + off) / 2);
    const t = await probe(mid);
    touches.push(t);
    if (t.kind === 'above' && scan.aboveIsEdge !== true) return { scan, touches };
    if (t.kind === 'stock') on = mid;
    else off = mid;
  }
  return { scan, touches };
}

/**
 * #525/#1133 — one SIDEWAYS edge scan: a lift (at the bracket's travel height), the move to the
 * plan's outward limit, down to the touch depth and ONE horizontal `G38.3` inward — then back up.
 * `probe3d.ts` owns the line, the depth (kept clear of the vise's ledge) and the tip/ball offset;
 * this only sends and records the reading the same way the Z touch does, so the outcome's edge, the
 * viewport's dot and the dock's row all come from one reading.
 *
 * Called for EVERY probe where `sideTouchAllowed` accepts the edge and the setup can place the
 * touch — the wired/Z-only probe included (#1133). A vise's X edges are the jaws' own faces and
 * keep the Z-only scan (`scanEdge`), because a sideways approach there would drive the ball into a
 * jaw bar — except #827's corner case, where the stock stands proud enough for its own X face to
 * be touched above the jaw; a vise with no measured jaw top keeps the Z-only scan on its free
 * edges too (the setup cannot place the ball above the ledge without it, and the plan says so).
 */
async function scanEdgeSideways(
  io: Session,
  plan: RegistrationPlan,
  scan: EdgeScan,
  surfaceZ: number,
  sentFrom: { x: number; y: number },
): Promise<ScanRecord> {
  const s = plan.settings;
  // The rim offset is the INSTRUMENT's when its tip is measured (the 3D probe's ball, the wired
  // probe's recorded 0.7 mm); a plan with no probe carries the shop's own. #1133 — the wired
  // probe seeks sideways here too, so the number must be this machine's, never a 3D-only assumption.
  const rimOffsetMm = plan.probe?.tip?.rimOffsetMm ?? s.tipRadiusMm;
  const setup = sideTouchSetup(scan, plan, s, rimOffsetMm, surfaceZ);
  if (!setup.ok) throw new Stop(setup.reason);
  const t = setup.touch;
  const what = scan.label ?? `the ${scan.edge} edge`;
  // #1199 — the sideways touch's approach traverses at the CLEARANCE whatever the mount; the
  // descent to the touch depth follows at the point. The bracket branch used to lift to
  // `seek.fromMachineZ`, which on a bracket plan is the seat's band approach (the bench's −81.25);
  // the other branches moved at whatever park the previous step left.
  await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
  await io.send(moveXY(plan, t.x, t.y));
  // #643 — THE DESCENT AT THE LIMIT IS GUARDED. The limit stands the edge band's width OUTSIDE
  // the expected edge (#1133), so a blank that sits that far toward the edge is UNDER this point:
  // an unguarded G0 down to the touch depth would drive the stylus into it. Probe down instead,
  // exactly as the Z-only scan probes at its own limit. A touch here means the blank reaches the
  // limit — the edge is beyond the band — and that case is recorded as the Z-only path records it,
  // so the outcome says the same sentence ("not found within the scan's reach") rather than a
  // false miss.
  const descendFromZ = plan.mount === 'bracket' ? plan.seek.fromMachineZ : surfaceZ + s.parkAboveSurfaceMm;
  // #643 review — the descent's START HEIGHT is stated ABSOLUTELY before the relative probe. The
  // head is wherever the previous step left it (often the travel height), not necessarily the
  // park the surface seek ended at: a relative descent from a higher Z would stop short of the
  // scan's depth, and a "miss" there would run the sideways move above the stock.
  await io.send(`G53 G0 Z${f(descendFromZ)}`);
  const descentMm = r3(descendFromZ - setup.zMachine);
  if (!(descentMm > 0)) {
    throw new Stop(`the sideways touch on ${what} has nowhere to descend: machine Z ${f(setup.zMachine)} is not below the ${f(descendFromZ)} it starts at`);
  }
  await io.idle();
  io.at(`down toward ${what}, as low as machine Z ${f(setup.zMachine)} (a guarded descent)`);
  await io.send('G91');
  const downReply = await io.send(`G38.3 Z-${f(descentMm)} F${f(s.touchFeed)}`, { missOk: true });
  const downPrb = lastPrb(downReply);
  // #932 — the guarded descent met the stock: release the stylus before the `G90` and the retract.
  if (downPrb !== null && downPrb.touched && probeNeedsRelease(plan.probe)) {
    await io.send(probeAwayLine('Z', PROBE_AWAY_MM));
  }
  await io.send('G90');
  if (downPrb === null) throw new Stop(`the sideways descent on ${what} answered no probe reading`);
  if (downPrb.touched) {
    await io.send(`G53 G0 Z${f(surfaceZ + s.parkAboveSurfaceMm)}`);
    const alongX = t.axis === 'x';
    io.saw({
      source: 'edge',
      label: what,
      x: alongX ? scan.limit : scan.along,
      y: alongX ? scan.along : scan.limit,
      z: downPrb.z,
      touched: true,
      kind: 'stock',
    });
    // A plain stock reading, NOT a side contact: `edgeFrom` then takes the branch the Z-only scan's
    // limit touch takes, and the operator reads the same sentence for the same fact.
    return { scan, touches: [{ at: scan.limit, prb: downPrb, kind: 'stock' }] };
  }
  // The descent found nothing and the machine is already at the touch depth: take the sideways move.
  await io.idle();
  io.at(`sideways toward ${what}, at machine Z ${f(setup.zMachine)}`);
  await io.send('G91');
  const reply = await io.send(t.line);
  const prb = lastPrb(reply);
  // #932 — a SIDEWAYS contact releases along the scan's axis, OPPOSITE the travel, before the
  // retract; a miss touched nothing and needs none.
  if (prb !== null && prb.touched && probeNeedsRelease(plan.probe)) {
    await io.send(probeAwayLine(t.axis === 'x' ? 'X' : 'Y', t.travelMm < 0 ? PROBE_AWAY_MM : -PROBE_AWAY_MM));
  }
  await io.send('G90');
  await io.send(`G53 G0 Z${f(surfaceZ + s.parkAboveSurfaceMm)}`);
  if (prb === null) throw new Stop(`the sideways touch on ${what} answered no probe reading`);
  const kind = prb.touched ? 'stock' : 'miss';
  const centre = sideCentreWork(prb, t.axis, sentFrom);
  const alongX = t.axis === 'x';
  io.saw({
    source: 'edge',
    label: what,
    x: alongX ? centre : scan.along,
    y: alongX ? scan.along : centre,
    z: prb.z,
    touched: prb.touched,
    kind,
  });
  return {
    scan,
    // ONE reading: the ball's centre along the axis, with the offset that turns it into the edge.
    touches: [{ at: centre, prb, kind, sideContact: true, edgeOffsetMm: setup.offsetMm }],
  };
}

/** The machine-Z band a surface reading must land in, and the two sentences that explain it. */
interface SurfaceBand {
  min: number;
  max: number;
  /** How low the probe may be from here, in the stop message's terms. */
  at: string;
  /** What the reading should have been, for a seek that finds nothing. */
  expect: string;
}

/**
 * #1166 — why an accepted miss was a miss, for the derived-top press's own record.
 */
type SurfaceMiss = { how: 'no-contact' | 'below-band'; z: number | null; which: 'fast' | 'slow' };

/**
 * A surface reading inside the band, or a stop that says where it landed.
 *
 * #585 — `missOk` turns a genuine MISS (no touch, or the controller reports `touched: false`) into
 * `null`, so the typed-seat path can offer its one guarded search lower instead of stopping cold. A
 * TOUCH outside the band is still a stop: it is information (the stock stands where the probe met
 * it), not a miss, and no deeper search can improve it.
 *
 * #1166 — `belowBandIsMiss` extends the same contract DOWN only: a reading below the band is also a
 * miss (the plan's point has been cut away by an earlier program), never a touch to keep. A reading
 * ABOVE the band stays a stop — something stands proud there and a derived top cannot explain it.
 */
function inBand(
  prb: Prb | null,
  band: SurfaceBand,
  which: string,
  maxZ: number = band.max,
  missOk = false,
  belowBandIsMiss = false,
  onMiss?: (miss: SurfaceMiss) => void,
): Prb | null {
  if (prb === null || !prb.touched) {
    if (missOk) {
      onMiss?.({ how: 'no-contact', z: null, which: which === 'slow' ? 'slow' : 'fast' });
      return null;
    }
    throw new Stop(`the ${which} surface touch found nothing down to machine Z ${band.min} — ${band.expect}`);
  }
  // #1166 — A CUT-AWAY TOP READS BELOW THE BAND. It is the press's own case, not a stock that moved:
  // the caller may derive the top, and on refusal the stop names the reading it found.
  if (prb.z < band.min && belowBandIsMiss) {
    onMiss?.({ how: 'below-band', z: prb.z, which: which === 'slow' ? 'slow' : 'fast' });
    return null;
  }
  // #619 — a reading ABOVE the band is not a miss on the datum path: a normally mounted blank may
  // stand prouder than the ledge estimate, so the upper bound is widened; only the floor still stops.
  if (prb.z < band.min || prb.z > maxZ) {
    throw new Stop(`the ${which} surface touch read machine Z ${prb.z}, outside the expected ${band.min} to ${maxZ}`);
  }
  return prb;
}

/**
 * #619/#633 — the datum path's surface ceiling: the jaw top + the stock's full thickness + tolerance.
 * A normally mounted blank may not sit on the ledge, so a reading above the plan's band can still be
 * the stock rather than a miss. Only the registration's OWN seeks use it; the re-touch keeps its
 * band (see {@link seekSurface}).
 */
function datumCeiling(plan: RegistrationPlan): number {
  return plan.mountDatum !== null && plan.stockThicknessMm !== undefined
    ? plan.mountDatum.jawTopZ + plan.stockThicknessMm + plan.settings.surfaceToleranceMm
    : plan.seek.band.max;
}

/**
 * #1166 — IS THE PLAN'S EXPECTED SURFACE THE STOCK'S TOP? True only when the plan's surface point
 * is ON the blank. Every measured-seat bracket plan is built through `planRegistration`, which
 * refuses a surface point that is not well inside the stock. The SEAT-SEEK plan — a bracket with no
 * measured seat yet — aims BESIDE the blank, on the wasteboard, and its band is the seat's, not the
 * stock's top's; it must keep today's stop (and it exists on plans written before this change, which
 * is why the geometry, not a new field, is the guard).
 */
function surfacePointOnStock(plan: RegistrationPlan): boolean {
  const p = plan.surfacePoint;
  return p.x > plan.stock.xMin && p.x < plan.stock.xMax && p.y > plan.stock.yMin && p.y < plan.stock.yMax;
}

/**
 * #1166 — the bracket's own top AS THE PLAN STATES IT: the expected surface (its measured seat +
 * the stock's thickness). The seat is the plan's own expected surface less the thickness its input
 * carried — no store is read here, and the card prints the same arithmetic.
 *
 * #1179 B4/D — A RECORDED TOP REPLACES THE ARITHMETIC. When this blank's last finished run kept
 * the top its origin was accepted at, the derived offer continues from that top; the arithmetic
 * stays in the words, as what the record is compared to.
 */
function bracketTopOf(
  plan: RegistrationPlan,
  lastRecordedTopMachineZ: number | null = null,
): {
  machineZ: number;
  seat: number | null;
  thickness: number | null;
  /** `seat + stock thickness` — the plan's own expected top, what a record replaces. */
  derivedMachineZ: number;
  /** The last accepted top for this blank, or null when there is no record. */
  recordedMachineZ: number | null;
} {
  const derivedMachineZ = r3(plan.seek.band.max - plan.settings.surfaceToleranceMm);
  const thickness = plan.stockThicknessMm ?? null;
  const recordedMachineZ =
    lastRecordedTopMachineZ !== null && Number.isFinite(lastRecordedTopMachineZ)
      ? r3(lastRecordedTopMachineZ)
      : null;
  const machineZ = recordedMachineZ ?? derivedMachineZ;
  return {
    machineZ,
    seat: thickness === null ? null : r3(machineZ - thickness),
    thickness,
    derivedMachineZ,
    recordedMachineZ,
  };
}

/** #1166 — the DERIVED surface a run continues from: no probe touched it, so `touched: false`. */
function derivedSurfacePrb(plan: RegistrationPlan, machineZ: number): Prb {
  return {
    x: r3(plan.bracketOrigin!.x + plan.surfacePoint.x),
    y: r3(plan.bracketOrigin!.y + plan.surfacePoint.y),
    z: machineZ,
    touched: false,
  };
}

/** #1166 — the one arithmetic sentence the press, the question and the record share.
 *  #1179 B4 — with a record, it names the recorded top and how far it stands from seat + stock. */
function bracketTopWords(top: {
  machineZ: number;
  seat: number | null;
  thickness: number | null;
  derivedMachineZ: number;
  recordedMachineZ: number | null;
}): string {
  if (top.recordedMachineZ !== null) {
    const diff = r3(top.recordedMachineZ - top.derivedMachineZ);
    const versus =
      diff === 0
        ? `the same as seat + stock ${f(top.derivedMachineZ)}`
        : `${f(Math.abs(diff))} mm ${diff > 0 ? 'above' : 'below'} seat + stock ${f(top.derivedMachineZ)}`;
    return `the last record for this blank: machine Z ${f(top.recordedMachineZ)} (${versus})`;
  }
  return top.seat !== null && top.thickness !== null
    ? `seat ${f(top.seat)} + stock ${f(top.thickness)} = ${f(top.machineZ)}`
    : `seat + stock thickness = ${f(top.machineZ)}`;
}

/**
 * #1179 B — THE CUT BLANK'S TOP, PROVED (the maintainer's restated rule; the analyst's amendments).
 *
 * Touch three spread points first (two if only two exist). A reading + its point's depth is the
 * IMPLIED top, and its seek's band is shifted by that depth (a floor d below the top can only be
 * found inside the shifted band). After the first three, touch on (up to five) while the highest
 * reading stands ALONE more than `cutBlankAgreeMm` above the best agreeing pair — a higher lone
 * reading may be the real top and must not be out-voted by a lower pair (today's tray: unrecorded
 * floors). At the end: the highest reading WITH a partner is the top; if it is still alone after
 * five, a lower level is accepted only when at least THREE readings agree on it (the high one is
 * then the outlier — a chip — and the note says so); otherwise stop, naming every reading.
 */
async function proveCutBlankTop(
  io: Session,
  plan: RegistrationPlan,
  s: RegistrationSettings,
): Promise<{
  prb: Prb;
  at: { x: number; y: number };
  readings: NonNullable<RunData['surfaceChecks']>;
  outlier: { machineZ: number; at: { x: number; y: number } } | null;
}> {
  type CheckReading = NonNullable<RunData['surfaceChecks']>[number];
  type Good = { reading: CheckReading; prb: Prb; implied: number };
  const checks = plan.surfaceChecks ?? [];
  // An old stored plan (approved before the key) has no agreement; the labelled fallback answers.
  const agreeMm = s.cutBlankAgreeMm ?? CUT_BLANK_AGREE_FALLBACK_MM;
  // #1179 amendment — how far above the band a reading may stand and still be a READING (chips on
  // the blank) rather than a clamp. Beyond it the seek stops, exactly as it did before.
  const aboveLimit = s.cutBlankAboveBandMm ?? CUT_BLANK_ABOVE_BAND_FALLBACK_MM;
  const first = Math.min(3, checks.length);
  const readings: CheckReading[] = [];
  const good: Good[] = [];
  const highestOf = (): Good | null =>
    good.reduce<Good | null>((best, g) => (best === null || g.implied > best.implied ? g : best), null);
  /** The HIGHEST implied level with at least two readings within the agreement. */
  const pairOf = (): { a: Good; b: Good } | null => {
    const sorted = [...good].sort((x, y) => y.implied - x.implied);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (Math.abs(sorted[i]!.implied - sorted[j]!.implied) <= agreeMm + 1e-9) return { a: sorted[i]!, b: sorted[j]! };
      }
    }
    return null;
  };
  /** The highest level at which at least THREE readings agree (the outlier case's answer). */
  const levelWithThree = (): { best: Good; group: Good[] } | null => {
    const sorted = [...good].sort((x, y) => y.implied - x.implied);
    for (const candidate of sorted) {
      const group = sorted.filter((g) => Math.abs(g.implied - candidate.implied) <= agreeMm + 1e-9);
      if (group.length >= 3) return { best: group[0]!, group };
    }
    return null;
  };
  for (let index = 0; index < checks.length && index < 5; index++) {
    if (index >= first) {
      const pair = pairOf();
      const highest = highestOf();
      // Keep touching while the highest reading stands alone above the best pair (it may find its
      // partner at its own level), or while no pair exists at all.
      if (pair !== null && highest !== null && highest.implied - pair.a.implied <= agreeMm + 1e-9) break;
    }
    const check = checks[index]!;
    // #1179 B (analyst) — THE BAND FOLLOWS THE POINT'S DEPTH: a floor d below the top is sought in
    // [min − d, max − d], so a known floor can be found at all. The lateral move stays at the
    // plan's travel height (the high approach; clamps and arms are clear there).
    const band = {
      min: r3(plan.seek.band.min - check.depthMm),
      max: r3(plan.seek.band.max - check.depthMm),
    };
    const missed: Partial<SurfaceMiss> = {};
    const prb = await seekSurface(
      io,
      plan,
      {
        ...plan.seek.band,
        ...band,
        at:
          plan.guarded === undefined
            ? `as low as machine Z ${f(band.min)} for the cut-blank check at (${f(check.x)}, ${f(check.y)})`
            : `as low as machine Z ${f(band.min)} for the top touch at (${f(check.x)}, ${f(check.y)})`,
        expect:
          plan.guarded === undefined
            ? 'no wood was found at this check point on a blank that has been cut'
            : 'nothing was found above the bed’s floor at this point',
      },
      {
        point: check,
        ceilingMm: datumCeiling(plan),
        missOk: true,
        belowBandIsMiss: true,
        // #1179 amendment — chips above the expected top are a READING, not a stop; a clamp-sized
        // obstruction (beyond the stated limit) still stops inside the seek.
        aboveBandOkMm: aboveLimit,
        onMiss: (m) => {
          missed.how = m.how;
          missed.z = m.z;
        },
      },
    );
    const aboveBandMm = prb !== null && prb.z > band.max ? r3(prb.z - band.max) : null;
    const implied = prb === null ? null : r3(prb.z + check.depthMm);
    const reading: CheckReading = {
      x: check.x,
      y: check.y,
      depthMm: check.depthMm,
      machineZ: prb === null ? null : prb.z,
      impliedMachineZ: implied,
      missed: prb === null ? (missed.how ?? 'no-contact') : null,
      ...(aboveBandMm === null ? {} : { aboveBandMm }),
    };
    readings.push(reading);
    io.saw({
      source: 'surface',
      label: `cut-blank check ${readings.length} of ${Math.min(5, checks.length)} · depth ${f(check.depthMm)} mm`,
      x: check.x,
      y: check.y,
      z: prb === null ? (missed.z ?? band.min) : prb.z,
      touched: prb !== null,
      kind: null,
    });
    // #1179 amendment — an above-band reading is never part of an agreeing pair: it is something
    // standing over the blank, not the blank's top.
    if (prb !== null && implied !== null && aboveBandMm === null) good.push({ reading, prb, implied });
  }
  const highest = highestOf();
  const pair = pairOf();
  const topHasPartner = pair !== null && highest !== null && Math.abs(pair.a.implied - highest.implied) <= 1e-9;
  let accepted: { level: number; from: Good; agreement: string; outlier: Good | null } | null = null;
  if (topHasPartner) {
    accepted = {
      level: pair.a.implied,
      from: pair.a,
      agreement: `the higher of two agreeing touches (${f(pair.b.implied)})`,
      outlier: null,
    };
  } else {
    const three = levelWithThree();
    if (three !== null) {
      accepted = {
        level: three.best.implied,
        from: three.best,
        agreement: `the level ${three.group.length} checks agree on`,
        outlier: highest !== null && highest.implied > three.best.implied + agreeMm ? highest : null,
      };
    }
  }
  if (accepted === null) {
    const words = readings
      .map((r, i) => {
        const what =
          r.missed === 'no-contact'
            ? 'found nothing'
            : r.missed === 'below-band'
              ? `read machine Z ${f(r.machineZ ?? 0)}, below the band`
              : r.aboveBandMm !== null && r.aboveBandMm !== undefined
                ? `read machine Z ${f(r.machineZ ?? 0)}, ${f(r.aboveBandMm)} mm ABOVE the expected top`
                : `read machine Z ${f(r.machineZ ?? 0)} (implied top ${f(r.impliedMachineZ ?? 0)})`;
        return `${i + 1}) ${what} at (${f(r.x)}, ${f(r.y)}) depth ${f(r.depthMm)}`;
      })
      .join('; ');
    // #1179 amendment — when nothing agreed and something stood above the band, the action is to
    // clear the top, not another run: name where it is standing, before the readings.
    const above = readings.find((r) => r.aboveBandMm !== null && r.aboveBandMm !== undefined);
    const lead =
      above === undefined
        ? ''
        : `something is lying on the blank at (${f(above.x)}, ${f(above.y)}) — clear the top and register again; `;
    throw new Stop(
      plan.guarded === undefined
        ? `the top on this cut blank could not be proved: ${lead}${words} — no two implied tops agree within ${f(agreeMm)} mm`
        : `the top on the blank could not be proved: ${lead}${words} — no two touches agree within ${f(agreeMm)} mm above the bed’s floor`,
    );
  }
  io.at(
    (plan.guarded === undefined ? 'the top is proved on a cut blank' : 'the top on the blank is proved') +
      `: implied machine Z ${f(accepted.level)} at (${f(accepted.from.reading.x)}, ${f(accepted.from.reading.y)}) — ${accepted.agreement}` +
      (accepted.outlier !== null
        ? `; the lone high reading implied ${f(accepted.outlier.implied)} at (${f(accepted.outlier.reading.x)}, ${f(accepted.outlier.reading.y)}) was not used`
        : ''),
  );
  return {
    prb: { ...accepted.from.prb, z: accepted.level },
    at: { x: accepted.from.reading.x, y: accepted.from.reading.y },
    readings,
    outlier: accepted.outlier === null ? null : { machineZ: accepted.outlier.implied, at: { x: accepted.outlier.reading.x, y: accepted.outlier.reading.y } },
  };
}

/**
 * #1166 — the stop a DECLINED derived-top press leaves: exactly the sentence the seek would have
 * stopped with had the press never been offered, so the operator's refusal changes nothing else.
 */
function surfaceMissStop(plan: RegistrationPlan, miss: Partial<SurfaceMiss>): Stop {
  const which = miss.which ?? 'fast';
  if (miss.how === 'below-band' && miss.z !== null && miss.z !== undefined) {
    return new Stop(
      `the ${which} surface touch read machine Z ${miss.z}, outside the expected ${plan.seek.band.min} to ${plan.seek.band.max}`,
    );
  }
  return new Stop(
    `the ${which} surface touch found nothing down to machine Z ${plan.seek.band.min} — the stock is not where the job expects it`,
  );
}

/**
 * The surface seek: from the plan's travel height down to the band's floor and no further — a fast
 * `G38.3`, `G0 Z1`, a slow `G38.3`, BOTH readings inside the band — then `G90` at the reading. The
 * registration and the post-facing re-touch share it, so the two seeks cannot drift apart.
 *
 * `fromMachineZ` (#590): where the seek starts. The FIRST touch of a run knows nothing and starts at
 * the plan's travel height; a later one has a reading and the band, and starts just above the band
 * (`band.max + park`), so it rapids there and probes only `2 × tolerance + park` instead of 50 mm of
 * air at the probe feed. The band's floor — the "as low as" cap — is the same either way.
 *
 * `ceilingMm` (#633) — the highest reading a touch may report, and it is REQUIRED: a caller says
 * which bound it means. The registration's own seeks pass the datum path's widened bound
 * ({@link datumCeiling}, #619: a blank mounted normally may stand prouder than the ledge estimate);
 * the post-facing re-touch passes its own band's `max`, because there the band IS the expectation
 * the skim is checked against. Before this, every caller inherited the widening — the re-touch
 * accepted an UNFACED top (0.5 mm ≥ its tolerance above where the skim should have left it) and
 * the origin was written from it.
 */
async function seekSurface(
  io: Session,
  plan: RegistrationPlan,
  band: SurfaceBand,
  opts: {
    point?: { x: number; y: number };
    fromMachineZ?: number;
    ceilingMm: number;
    /** #585 — return null on a genuine miss instead of stopping; the caller may offer a deeper search. */
    missOk?: boolean;
    /** #1166 — a reading below the band is a miss too: the top there has been cut away. */
    belowBandIsMiss?: boolean;
    /** #1166 — why a missed seek returned null, for the caller's derived-top press. */
    onMiss?: (miss: SurfaceMiss) => void;
    /**
     * #1179 amendment (2026-11-10) — a reading ABOVE the band's ceiling, up to this far above it,
     * is a READING the caller classifies (something on the blank), not a stop: the fast touch is
     * returned as-is and no slow touch is sent from a probe already resting on the obstruction.
     * Absent keeps today's hard stop above the band.
     */
    aboveBandOkMm?: number;
  },
): Promise<Prb | null> {
  const s = plan.settings;
  const point = opts.point ?? plan.surfacePoint;
  const fromMachineZ = opts.fromMachineZ ?? plan.seek.fromMachineZ;
  const travel = Math.round((fromMachineZ - band.min) * 1000) / 1000;
  // #1199 — the clearance for the traverse, the band's approach ONLY at the point. A spread's
  // extent touch used to travel at its approach height; that height is a descent, never a travel.
  await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
  await io.send('G90');
  await io.send(moveXY(plan, point.x, point.y));
  await io.send(`G53 G0 Z${f(fromMachineZ)}`);
  await io.idle();
  io.at(band.at);
  await io.send('G91');
  const aboveLimit = opts.aboveBandOkMm ?? 0;
  const fast = inBand(
    lastPrb(await io.send(`G38.3 Z-${f(travel)} F${f(s.surfaceFastFeed)}`)),
    band,
    'fast',
    Math.max(opts.ceilingMm, r3(band.max + aboveLimit)),
    opts.missOk === true,
    opts.belowBandIsMiss === true,
    opts.onMiss,
  );
  if (fast === null) {
    await io.send('G90');
    return null;
  }
  // #1179 amendment — SOMETHING IS STANDING ABOVE THE EXPECTED TOP HERE. The fast touch met it;
  // the caller records the reading as an above-band touch and moves on. A slow touch from a probe
  // already deflected on an obstruction would measure the obstruction, not the surface. The
  // stylus is released and lifted exactly as an ordinary accepted fast touch is (#932), so the
  // caller's next rapid never drags a deflected ball across what it found.
  if (opts.aboveBandOkMm !== undefined && fast.z > band.max) {
    if (probeNeedsRelease(plan.probe)) await io.send(probeAwayLine('Z', PROBE_AWAY_MM));
    await io.send(`G0 Z${f(SURFACE_LIFT_MM)}`);
    await io.send('G90');
    return fast;
  }
  // #932 — the fast touch ended on the stock: release the stylus before the relative lift.
  if (probeNeedsRelease(plan.probe)) await io.send(probeAwayLine('Z', PROBE_AWAY_MM));
  await io.send(`G0 Z${f(SURFACE_LIFT_MM)}`);
  await io.idle();
  io.at(`as low as ${f(s.surfaceSlowSeekMm - SURFACE_LIFT_MM)} mm below the fast touch's reading (the slow surface touch)`);
  const slow = inBand(
    lastPrb(await io.send(`G38.3 Z-${f(s.surfaceSlowSeekMm)} F${f(s.surfaceSlowFeed)}`)),
    band,
    'slow',
    opts.ceilingMm,
    opts.missOk === true,
    opts.belowBandIsMiss === true,
    opts.onMiss,
  );
  // #932 — the slow touch is the reading the caller keeps, and BOTH callers' next line is a rapid
  // (`runRegistration`'s park lift, `retouchSurface`'s travel-height lift): release here, once,
  // while the seek's `G91` is still in force. A miss (`missOk`) touched nothing.
  if (slow !== null && probeNeedsRelease(plan.probe)) await io.send(probeAwayLine('Z', PROBE_AWAY_MM));
  await io.send('G90');
  return slow;
}

/**
 * #585 — HOW FAR BELOW A TYPED SEAT THE ONE GUARDED SEARCH MAY GO, mm.
 *
 * The typed seat is the expert path (#598): a machine Z the operator typed, not a measured jaw top.
 * Its band is only ± `surfaceToleranceMm` around a guess, so a blank a few millimetres lower stops
 * the registration before it has touched anything. Over the stock the probe can only meet the
 * stock; this cap is the safety floor 2 mm BELOW the seat (through where the stock's body is), so a
 * stock that is really there is met long before it, and a missing stock stops the probe before the
 * bed. It is a depth, not a measurement: the measured seat the run records is `top − thickness`.
 */
export const SURFACE_RECOVERY_BELOW_SEAT_MM = 2;

/**
 * #585 — the typed-seat path's ONE guarded second search: from above the band, down to `cap`, at
 * the slow surface feed, after the operator confirms it. A touch anywhere above the cap is the
 * surface; a miss to the cap is a stop that names the cap.
 *
 * The fast pass re-crosses the band the first seek already searched (it should miss); it keeps a
 * probe mounted high from crawling the whole descent at the touch feed. The slow pass crosses from
 * the band's floor to the cap — the few millimetres where the stock can be.
 */
async function seekDeeper(
  io: Session,
  plan: RegistrationPlan,
  band: Pick<SurfaceBand, 'min' | 'max'>,
  cap: number,
): Promise<Prb> {
  const s = plan.settings;
  const from = r3(Math.max(plan.seek.band.max, band.max) + s.parkAboveSurfaceMm);
  // #1199 — the same rule: traverse at the clearance, descend to the band's approach at the point.
  await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
  await io.send('G90');
  await io.send(moveXY(plan, plan.surfacePoint.x, plan.surfacePoint.y));
  await io.send(`G53 G0 Z${f(from)}`);
  await io.idle();
  io.at(`as low as machine Z ${f(cap)} (the deeper surface search)`);
  await io.send('G91');
  const fast = lastPrb(
    await io.send(`G38.3 Z-${f(r3(from - band.min))} F${f(s.surfaceFastFeed)}`, { missOk: true }),
  );
  let prb: Prb | null = fast !== null && fast.touched ? fast : null;
  if (prb === null) {
    prb = lastPrb(
      await io.send(`G38.3 Z-${f(r3(band.min - cap))} F${f(s.surfaceSlowFeed)}`, { missOk: true }),
    );
  }
  await io.send('G90');
  if (prb === null || !prb.touched) {
    throw new Stop(
      `the deeper surface search found nothing down to machine Z ${f(cap)} (${f(SURFACE_RECOVERY_BELOW_SEAT_MM)} mm below the typed seat) — the stock is not in the vise, or the seat is further off than this search may go`,
    );
  }
  if (prb.z < cap || prb.z > band.max) {
    throw new Stop(`the deeper surface search read machine Z ${f(prb.z)}, outside ${f(cap)} to ${f(band.max)}`);
  }
  return prb;
}

/**
 * #599/#607 — how far below the stored reference a mount tap searches, and how far from it a real
 * reading may land. Two millimetres either way, the same window the vise's tap has had since #599;
 * named here because it is one rule for every mount, not a number typed twice.
 */
const MOUNT_TAP_FLOOR_MM = 2;
const MOUNT_TAP_SLACK_MM = 2;

/**
 * #599 — one guarded mount tap at the machine XY `tap`, down to the machine floor `floorZ`. One line
 * per Idle, and the G38.3 is never queued behind the rapid (that queue gave PROBE_FAIL on
 * 2026-10-23). Returns the reading — a miss is a `touched:false` reading, null is no reading — and
 * the caller checks it against the stored datum or the floor. Shared by the in-run tap and the
 * standalone {@link runMountTap}.
 *
 * #615 — with an expected Z (`expectZ`), the descent is two-stage: a fast `G38.3` seek down to
 * {@link RegistrationSettings.parkAboveSurfaceMm} above the expected Z, then the touch feed for the
 * final few millimetres down to the floor. The fast seek still probes, so a reference standing higher
 * than expected stops it (the caller's slack check flags that reading); a miss continues to the touch
 * feed. With no expected Z the whole descent stays the single touch-feed pass it has always been.
 */
async function mountTapTouch(
  io: Session,
  tap: { x: number; y: number },
  /** Where the tap's own descent starts, at the tap point: a band approach, machine Z. */
  seekFromMachineZ: number,
  /** #1199 — the machine's clearance: the ONLY height the XY move to the tap point is taken at. */
  travelZ: number,
  settings: RegistrationSettings,
  floorZ: number,
  /** #615 — the machine Z the touch expects to meet, or null to descend the full height at the touch feed. */
  expectZ: number | null,
  /**
   * #932 — the probe the run has checked out. Required (never defaulted) so a new caller cannot
   * quietly drop the release. #1070 — the release is no longer chosen by the instrument (a
   * triggered touch is released whatever the probe), but the parameter stays in the contract so
   * every caller still states which probe the tap is run with.
   */
  _probe: ProbeSpec | null,
): Promise<Prb | null> {
  await io.idle();
  // #1199 — TRAVERSE AT THE CLEARANCE, DESCEND AT THE TAP POINT. The bench's bent probe came of
  // these two lines the other way round: a seek-start height (the seat band's approach, −81.25) is
  // a DESCENT height, never a travel height.
  await io.send(`G53 G0 Z${f(travelZ)}`);
  await io.send(`G53 G0 X${f(tap.x)} Y${f(tap.y)}`);
  await io.send(`G53 G0 Z${f(seekFromMachineZ)}`);
  await io.idle();
  io.at(`as low as machine Z ${f(floorZ)} (the mount tap)`);
  await io.send('G91');
  let prb: Prb | null;
  if (expectZ === null) {
    prb = lastPrb(await io.send(`G38.3 Z-${f(seekFromMachineZ - floorZ)} F${f(settings.touchFeed)}`, { missOk: true }));
  } else {
    const approachZ = expectZ + settings.parkAboveSurfaceMm;
    const fast = lastPrb(await io.send(`G38.3 Z-${f(seekFromMachineZ - approachZ)} F${f(settings.surfaceFastFeed)}`, { missOk: true }));
    prb =
      fast !== null && fast.touched
        ? fast
        : lastPrb(await io.send(`G38.3 Z-${f(approachZ - floorZ)} F${f(settings.touchFeed)}`, { missOk: true }));
  }
  // #932/#1070 — a triggered tap is released before the relative lift. 6b's seat ruling: the
  // wired V2 gets the same G38.5 before the G0 — a triggered touch is released whatever the
  // instrument, so no lift is ever taken with the tip still on the material.
  if (prb !== null && prb.touched) await io.send(probeAwayLine('Z', PROBE_AWAY_MM));
  await io.send('G0 Z3');
  await io.send('G90');
  const after = await io.send('M119');
  if (/Probe:\s*1\b/.test(after)) {
    throw new Stop('the probe still reads touched after the mount tap — check it is seated and plugged in');
  }
  await io.send(`G53 G0 Z${f(seekFromMachineZ)}`);
  return prb;
}

export type MountTapResult =
  | { ok: true; z: number; at: { x: number; y: number }; probe: { lengthZ: number; rest: string }; transcript: Transcript[] }
  | { ok: false; reason: string; transcript: Transcript[] };

/**
 * #599 — a standalone mount tap (no surface seek): the FIRST tap on a machine with no jaw-top datum,
 * down to the machine's work-envelope Z floor rather than a stored datum. Runs home → M119 rest-check
 * → M491 → the tap → $H, transcript like a registration; the caller writes the datum and re-plans.
 */
export async function runMountTap(
  /**
   * #1199 — the tap point, and (when the caller plans one) `fromMachineZ`: the band approach the
   * tap DESCENDS to at that point. Absent, the descent starts at the clearance (the pre-#1070
   * standalone tap, whose only seek height was the clearance itself).
   */
  tap: { x: number; y: number; fromMachineZ?: number },
  /** The machine's clearance (`toolChange.clearanceZ`): the session's travel height and safe Z. */
  seekFromMachineZ: number,
  settings: RegistrationSettings,
  deps: ExecDeps,
  workEnvelopeFloorZ: number,
  /** #607 — which mount's reference this is, for the miss sentence. The vise is the default. */
  mount: 'vise' | 'bracket' | 'rotary' = 'vise',
  /**
   * #932 — the checked-out probe, when the caller has one. The standalone tap releases a triggered
   * touch for the 3D probe only (see {@link probeNeedsRelease}); its current caller carries no
   * instrument, so the default is the wired probe's behaviour — unchanged from before this.
   */
  probe: ProbeSpec | null = null,
  /**
   * #1070 — THE PLAN'S OWN BOUND, mm of travel below the seek start: the seat press plans its
   * slow seek from the band floor less the scan reach, and the tap must never search past it.
   * Absent (a pre-#1070 caller): the work-envelope floor, exactly as before.
   */
  planTravelMm: number | null = null,
): Promise<MountTapResult> {
  const io = session(deps, seekFromMachineZ, settings.idlePollLimit, probeNeedsRelease(probe));
  // The floor the tap may reach: the PLAN's bound when it states one, never the envelope's alone.
  // #1199 — the bound is stated below the tap's own APPROACH (`tap.fromMachineZ`, the band start),
  // not below the clearance: the two heights were one parameter before, and splitting them must
  // not move the floor (which it did: a clearance-based floor stopped the seat seek 1.1 mm short).
  const tapApproachZ = tap.fromMachineZ ?? seekFromMachineZ;
  const tapFloorZ =
    planTravelMm !== null && Number.isFinite(planTravelMm) && planTravelMm > 0
      ? Math.max(workEnvelopeFloorZ, tapApproachZ - planTravelMm)
      : workEnvelopeFloorZ;
  const bad = settingsProblem(settings);
  if (bad !== null) return { ok: false, reason: `nothing was sent: ${bad}`, transcript: [] };
  /** #789 — whether the probe's supply was (or may have been) switched on, for the closing M832. */
  let powered = false;
  try {
    // #933 — the opening poll is a STATUS poll: a silent link costs 3 s, not the console's 60.
    const status = await io.send('?', { timing: STATUS_POLL_TIMING });
    if (controllerState(status) !== 'Idle') throw new Stop(`the machine reads ${controllerState(status) ?? 'no state'}, not Idle`);
    await io.home();
    // #1203 — the prompt names the collet the fitted post needs (the unit's recorded shank).
    if (
      !(await deps.operator({
        kind: 'fit-probe',
        text: `Fit the wired probe in the spindle — ${probeColletWords(probe?.shankMm)} — then continue.`,
      }))
    ) {
      throw new Stop('stopped: the probe was not fitted');
    }
    // #789 — the standalone tap is a probe session too: power the connector before its first move.
    powered = true;
    await io.send(PROBE_SUPPLY_ON);
    const rest = await io.send('M119');
    if (/Probe:\s*1\b/.test(rest)) throw new Stop('the probe reads touched at rest; check it is seated and plugged in');
    const ref = lastPrb(await io.send('M491', { timing: PROBE_TIMING }));
    if (ref === null || !ref.touched) throw new Stop('M491 answered no tool-length reading');
    // #1199 — the descent starts at the tap's own planned approach (the seat's band), at the point;
    // the travel to it is at the clearance.
    const prb = await mountTapTouch(io, { x: tap.x, y: tap.y }, tap.fromMachineZ ?? seekFromMachineZ, seekFromMachineZ, settings, tapFloorZ, null, probe);
    if (prb === null || !prb.touched) {
      // The vise's sentence is the bench-tested one and stays byte for byte; the others name their
      // own reference the way the operator sees it.
      // #1070 — a BOUNDED tap on a bracket is the SEAT press: what it looks for is the wasteboard
      // beside the bracket's front arm, not the bracket's top (6b, C2 review).
      const what =
        mount === 'vise'
          ? 'jaw top'
          : mount === 'bracket'
            ? planTravelMm !== null
              ? 'seat (the wasteboard beside the bracket’s front arm)'
              : 'bracket top'
            : 'axis';
      throw new Stop(`no ${what} at (${tap.x}, ${tap.y}) down to machine Z ${f(tapFloorZ)} — is the ${mount} where the machine record says?`);
    }
    // #519 item 1 — the standalone tap's reading, as it lands.
    io.saw({ source: 'mount-tap', label: null, x: tap.x, y: tap.y, z: prb.z, touched: prb.touched, kind: null });
    await io.home();
    return { ok: true, z: prb.z, at: { x: tap.x, y: tap.y }, probe: { lengthZ: ref.z, rest }, transcript: io.transcript };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: await io.stopped(e.message), transcript: io.transcript };
    throw e;
  } finally {
    // #789 — OFF whatever happened, the same as the registration's own session.
    if (powered) await io.trySend(PROBE_SUPPLY_OFF);
  }
}

export type CentreRunResult =
  | {
      ok: true;
      /** The measured centre, MACHINE XY. */
      centreMachine: { x: number; y: number };
      /** The measured centre, WORK XY (the frame the moves were sent in). */
      centreWork: { x: number; y: number };
      /** Each axis's last pair: its span and the diameter it makes. */
      pairs: CentrePairReading[];
      /** The top the routine touched, MACHINE Z — the Z0 reference. */
      surfaceZ: number;
      /** The probe's own `M491` reading, MACHINE Z. */
      probeRefZ: number;
      /** Ready for `applyCorrection`: the origin lands on the measured centre, Z0 on the top. */
      outcome: RegistrationOutcome;
      transcript: Transcript[];
    }
  | { ok: false; reason: string; transcript: Transcript[] };

/** Where a centre find runs, in the machine's terms. */
export interface CentreFindOptions {
  plan: CentreFindPlan;
  /** The machine's travel height, MACHINE Z (the resolved `toolChange.clearanceZ`). */
  seekFromMachineZ: number;
  /**
   * The band the top may be found in, MACHINE Z — the plan's own seek band (`seek.band`). The top
   * touch descends to its floor at {@link surfaceFeed}; a touch above the floor is the reading.
   */
  bandMm: { min: number; max: number };
  /** The slow feed of the top touch, mm/min. */
  surfaceFeed: number;
  /** How far above the found top the head parks, mm. */
  parkAboveSurfaceMm: number;
  /** How far a release backs the ball away from a contact before any G0, mm (#790). */
  releaseMm?: number;
  /**
   * Where the TOP is touched, WORK XY — the Z0 reference. Defaults to the estimate (a boss's own
   * top, a round part's centre). A BORE's centre is a hole: the caller passes a point on the
   * stock's face beyond the bore's reach, or the top touch would measure the bore's floor.
   */
  topTouchAt?: { x: number; y: number };
}

const f4 = (n: number): string => String(Math.round(n * 1000) / 1000);

/**
 * #827 — FIND A FEATURE'S CENTRE WITH THE 3D PROBE, and hand back an origin ready to write.
 *
 * Studio's routine, as the 2026-10-31 bench ran it by hand: the top is touched once at the
 * estimate (Z0's reference); then −X/+X, −Y/+Y and −X/+X again, each pair recentring on its
 * midpoint so the last X pair is taken at the measured Y. A bore is touched OUTWARD from the
 * estimate and a boss INWARD from beyond its edge (`centreFind.ts` owns which); every touch that
 * triggers is released with `G38.5` PROBE-AWAY before any `G0` — a G0 retract straight after a
 * sideways contact raised `ALARM: unexpected probe trigger` on the bench (#790).
 *
 * THE PROBE'S SUPPLY is switched on before the first touch and off in a finally (#789), exactly
 * as the registration's sessions do. A guarded descent to each side touch's depth refuses a start
 * that is over material: a bore's mouth must be clear, and a boss's start must lie outside it.
 *
 * WHAT COMES BACK. The measured centre in machine and work XY, the pairs' spans and diameters
 * (bore: span + 2R; boss: span − 2R), the top touch and the probe's `M491` reading. `outcome` is
 * a RegistrationOutcome whose `correctedG54` puts the measured centre at work (0,0) and whose
 * `surfaceZ` is the top, so `applyCorrection` writes it with no other translation.
 */
export async function runCentreFind(opts: CentreFindOptions, deps: ExecDeps): Promise<CentreRunResult> {
  const plan = opts.plan;
  const release = opts.releaseMm ?? 3;
  // #933 — centre-find is the 3D probe's routine: a stop with the ball deflected releases it.
  const io = session(deps, opts.seekFromMachineZ, MAX_IDLE_POLLS, true);
  /** #789 — whether the probe's supply was (or may have been) switched on. */
  let powered = false;
  try {
    // #933 — the opening poll is a STATUS poll: a silent link costs 3 s, not the console's 60.
    const status = await io.send('?', { timing: STATUS_POLL_TIMING });
    if (controllerState(status) !== 'Idle') throw new Stop(`the machine reads ${controllerState(status) ?? 'no state'}, not Idle`);
    await io.home();
    await io.send('G54');
    await io.send('G92.1');
    if (
      !(await deps.operator({
        kind: 'fit-probe',
        text: 'Fit the 3D probe in the spindle — the ball on its cable — then continue.',
      }))
    ) {
      throw new Stop('stopped: the probe was not fitted');
    }
    powered = true;
    await io.send(PROBE_SUPPLY_ON);
    const rest = await io.send('M119');
    if (/Probe:\s*1\b/.test(rest)) throw new Stop('the probe reads touched at rest; check it is seated and plugged in');
    const refPrb = lastPrb(await io.send('M491', { timing: PROBE_TIMING }));
    if (refPrb === null || !refPrb.touched) throw new Stop('M491 answered no tool-length reading');

    // ── THE TOP TOUCH: one slow touch through the expected band. ──
    const topAt = opts.topTouchAt ?? plan.at;
    const bandTop = r3(opts.bandMm.max);
    const bandBottom = r3(opts.bandMm.min);
    const topDescentMm = r3(opts.seekFromMachineZ - bandBottom);
    if (!(topDescentMm > 0)) {
      throw new Stop(
        `the expected top's floor (machine Z ${f(bandBottom)}) is not below the travel height ${f(opts.seekFromMachineZ)} — check the stock's thickness and the mount`,
      );
    }
    await io.send(`G53 G0 Z${f(opts.seekFromMachineZ)}`);
    // The routine runs in the WORK frame (G54 is selected above); the moves are plain G0s there.
    await io.send(`G0 X${f(topAt.x)} Y${f(topAt.y)}`);
    await io.idle();
    await io.at(`down to find the top at (${f4(topAt.x)}, ${f4(topAt.y)}), from machine Z ${f(bandTop)}`);
    await io.send('G91');
    const topReply = await io.send(`G38.3 Z-${f(topDescentMm)} F${f(opts.surfaceFeed)}`, { missOk: true });
    const topPrb = lastPrb(topReply);
    if (topPrb === null || !topPrb.touched) {
      await io.send('G90');
      throw new Stop(
        `the top touch found nothing between machine Z ${f(opts.seekFromMachineZ)} and ${f(bandBottom)} at the estimate — check the stock is under the probe`,
      );
    }
    // #790 — a Z touch that ends on a surface is released before any G0. #932 — built by the one
    // probe-away builder, so a zero `releaseMm` is a stop before the wire, not a firmware error.
    await io.send(probeAwayLine('Z', release));
    await io.send('G90');
    const surfaceZ = r3(topPrb.z);
    // The work origin the moves ran in, derived exactly as the registration derives it: the touch's
    // machine XY less the work point it was sent to.
    const g54 = { x: r3(topPrb.x - topAt.x), y: r3(topPrb.y - topAt.y) };
    await io.send(`G53 G0 Z${f(opts.seekFromMachineZ)}`);

    // ── THE PAIRS: X, Y, then X again at the measured Y. ──
    const zMachine = r3(surfaceZ - plan.depthMm);
    let at = { x: plan.at.x, y: plan.at.y };
    const pairs: CentrePairReading[] = [];
    for (const axis of plan.order) {
      const balls: number[] = [];
      for (const sign of [-1, 1] as const) {
        const { from, travelMm } = centrePair(plan.kind, at, axis, sign, plan.searchMm);
        const word = axis.toUpperCase();
        const side = `${sign < 0 ? '−' : '+'}${word}`;
        await io.send(`G53 G0 Z${f(opts.seekFromMachineZ)}`);
        await io.send(`G0 X${f(from.x)} Y${f(from.y)}`);
        await io.send(`G53 G0 Z${f(r3(surfaceZ + opts.parkAboveSurfaceMm))}`);
        await io.idle();
        // A guarded descent to the touch depth: the start must be clear of material.
        await io.send('G91');
        const down = await io.send(`G38.3 Z-${f(r3(surfaceZ + opts.parkAboveSurfaceMm - zMachine))} F${f(plan.touchFeed)}`, {
          missOk: true,
        });
        const downPrb = lastPrb(down);
        if (downPrb !== null && downPrb.touched) {
          await io.send(probeAwayLine('Z', release));
          await io.send('G90');
          throw new Stop(
            plan.kind === 'bore'
              ? `the descent at the ${side} start met material — there is no open bore at (${f4(at.x)}, ${f4(at.y)}); check the centre estimate`
              : `the descent at the ${side} start met material — the part reaches past the ${f(plan.searchMm)} mm search; increase the search radius`,
          );
        }
        await io.send('G90');
        await io.idle();
        await io.at(`sideways ${plan.kind === 'bore' ? 'outward' : 'inward'} to the ${side} wall, at machine Z ${f(zMachine)}`);
        await io.send('G91');
        const reply = await io.send(`G38.3 ${word}${f4(travelMm)} F${f(plan.touchFeed)}`, { missOk: true });
        const prb = lastPrb(reply);
        await io.send('G90');
        if (prb === null || !prb.touched) {
          await io.send(`G53 G0 Z${f(opts.seekFromMachineZ)}`);
          throw new Stop(
            plan.kind === 'bore'
              ? `the ${side} touch found no wall within ${f(plan.searchMm)} mm of the estimate — the bore is larger than the search, or the centre is off`
              : `the ${side} touch found no part within ${f(plan.searchMm)} mm of the start — the part is smaller than the search, or the centre is off`,
          );
        }
        // #790 — PROBE-AWAY before any G0: the ball must release the wall first.
        await io.send('G91');
        await io.send(probeAwayLine(axis === 'x' ? 'X' : 'Y', travelMm < 0 ? release : -release));
        await io.send('G90');
        // The PRB is machine XY; the work coordinate is it less the origin the moves ran in.
        const ballWork = r3((axis === 'x' ? prb.x : prb.y) - (axis === 'x' ? g54.x : g54.y));
        balls.push(ballWork);
        io.saw({
          source: 'surface',
          label: `the ${side} wall`,
          x: axis === 'x' ? ballWork : at.x,
          y: axis === 'x' ? at.y : ballWork,
          z: prb.z,
          touched: true,
          kind: 'stock',
        });
        await io.send(`G53 G0 Z${f(opts.seekFromMachineZ)}`);
      }
      const reading = readCentrePair(plan.kind, axis, balls[0]!, balls[1]!, plan.ballRadiusMm);
      pairs.push(reading);
      at = axis === 'x' ? { x: reading.centre, y: at.y } : { ...at, y: reading.centre };
    }

    const lastX = [...pairs].reverse().find((p) => p.axis === 'x')!;
    const lastY = [...pairs].reverse().find((p) => p.axis === 'y')!;
    const centreWork = { x: lastX.centre, y: lastY.centre };
    const centreMachine = { x: r3(centreWork.x + g54.x), y: r3(centreWork.y + g54.y) };
    const notes = [
      `${plan.kind === 'bore' ? 'bore' : 'boss'} centre: ${pairs.length} wall touches around (${f4(centreWork.x)}, ${f4(centreWork.y)})`,
      ...pairs.map((p) => `the ${p.axis.toUpperCase()} span is ${f(p.spanMm)} mm between ball centres — ${f(p.diameterMm)} mm across`),
      `the top touch read machine Z ${f(surfaceZ)}; the origin is the measured centre, with Z0 from this top and the cutter's own M491`,
    ];
    const outcome: RegistrationOutcome = {
      edges: [],
      machineClearanceZ: opts.seekFromMachineZ,
      offset: { x: r3(centreWork.x - plan.at.x), y: r3(centreWork.y - plan.at.y) },
      measured: { x: true, y: true },
      centre: centreWork,
      rotationDeg: null,
      rotationShiftMm: null,
      withinMargin: true,
      margin: 0,
      surfaceZ,
      probeRefZ: r3(refPrb.z),
      seekFromMachineZ: opts.seekFromMachineZ,
      currentG54: g54,
      correctedG54: centreMachine,
      xyChecked: true,
      usable: true,
      problems: [],
      notes,
    };
    return { ok: true, centreMachine, centreWork, pairs, surfaceZ, probeRefZ: r3(refPrb.z), outcome, transcript: io.transcript };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: await io.stopped(e.message), transcript: io.transcript };
    throw e;
  } finally {
    // #789 — the supply goes OFF whatever happened.
    if (powered) await io.trySend(PROBE_SUPPLY_OFF);
  }
}

export type RotaryTapResult =
  | {
      ok: true;
      /** The fitted chuck circle: axis Z, axis Y (machine), radius. */
      circle: RotaryCircle;
      /** The check chord's residual against the fitted circle, mm. */
      residualMm: number;
      /** The one-line note when the residual is over the tolerance, else null. */
      residualLine: string | null;
      /** #1189 — the probe's M491 at this tap: the seating the axis Z was read in. */
      probeRefZ: number;
      transcript: Transcript[];
    }
  | { ok: false; reason: string; transcript: Transcript[] };

/** Where the rotary tap runs, in the machine's terms. All XY here is MACHINE coordinates. */
export interface RotaryTapOptions {
  /** The tap point on the chuck: X along the chuck, Y the axis estimate — MACHINE XY. */
  at: { x: number; y: number };
  /** The trial chord's height and the check chord's height, machine Z (`rotaryTap.planRotaryTrial`). */
  trial: { z1: number; z2: number };
  /** The crown's expected machine Z (the trial's estimate; the touch is bounded by the band below). */
  crownEstimateZ: number;
  /** The band the crown is accepted in, machine Z. */
  crownBandMm: { min: number; max: number };
  /** The probe's measured effective radius, mm. */
  probeRadiusMm: number;
  /** How far outside the chuck each side touch starts, mm — the nominal radius plus a margin. */
  searchMm: number;
  /** The machine's travel height, machine Z. */
  seekFromMachineZ: number;
  touchFeed: number;
  surfaceFeed: number;
  parkAboveSurfaceMm: number;
  /** How far a release backs the ball off before any G0, mm. */
  releaseMm?: number;
  /**
   * #1190 — the probe's `M491` reference when the stored axis Z was measured. The axis datum is a
   * RAW machine Z; the trial chord and the crown's band are placed from it BEFORE the run's M491,
   * so a probe refitted since then would place them by the seating difference. Once the M491 is
   * known the trial, the check chord and the band are shifted by `today − this`. Absent/null: a
   * legacy datum with no reference — the trial keeps its numbers (and the tap's own band says so
   * if the module is not where it expects).
   */
  probeRefZ?: number | null;
}

const f4r = (n: number): string => String(Math.round(n * 1000) / 1000);

/**
 * #607 — THE 4TH-AXIS REFERENCE TAP: the chuck body's circle in the YZ plane, with the 3D probe.
 *
 * The maintainer's geometry (#607, 2026-10-31): ONE ±Y chord pair at a trial height gives the axis
 * line's Y and the width there; the CROWN touched from above at that Y gives Ztop; the circle
 * through them solves `R = (w²/4 + d²)/(2d)` and `Zc = Ztop − R`. #626's "crown plus an unmeasured
 * radius" is answered by the chord. A SECOND chord at another height is the CHECK: its residual
 * against the fitted circle is reported, and over `ROTARY_CHORD_TOLERANCE_MM` it is said in one
 * line — the datum stays the fitted circle. Every side touch is released with G38.5 before any G0
 * (#790) and the probe's supply brackets the session (#789).
 *
 * ALL XY IS MACHINE: the tap happens beside the chuck, where the work frame means nothing yet.
 */
export async function runRotaryTap(opts: RotaryTapOptions, deps: ExecDeps): Promise<RotaryTapResult> {
  // #933 — the rotary tap is the 3D probe's routine: a stop with the ball deflected releases it.
  const io = session(deps, opts.seekFromMachineZ, MAX_IDLE_POLLS, true);
  const release = opts.releaseMm ?? 3;
  let powered = false;
  try {
    // #933 — the opening poll is a STATUS poll: a silent link costs 3 s, not the console's 60.
    const status = await io.send('?', { timing: STATUS_POLL_TIMING });
    if (controllerState(status) !== 'Idle') throw new Stop(`the machine reads ${controllerState(status) ?? 'no state'}, not Idle`);
    await io.home();
    if (
      !(await deps.operator({
        kind: 'fit-probe',
        text: 'Fit the 3D probe in the spindle — the ball on its cable — then continue.',
      }))
    ) {
      throw new Stop('stopped: the probe was not fitted');
    }
    powered = true;
    await io.send(PROBE_SUPPLY_ON);
    const rest = await io.send('M119');
    if (/Probe:\s*1\b/.test(rest)) throw new Stop('the probe reads touched at rest; check it is seated and plugged in');
    const refPrb = lastPrb(await io.send('M491', { timing: PROBE_TIMING }));
    if (refPrb === null || !refPrb.touched) throw new Stop('M491 answered no tool-length reading');
    // #1190 — THE STORED AXIS Z IS A RAW MACHINE Z, measured with the probe as it sat THAT day.
    // The trial chord, the check chord and the crown's band were placed from it before this M491;
    // a refit shifts every trigger by today's reading less the datum's own reference, so the
    // geometry is corrected once, here, and the run says so.
    let trial = opts.trial;
    let crownBandMm = opts.crownBandMm;
    const seating = probeShiftMm(refPrb.z, opts.probeRefZ ?? null);
    if (seating !== null && Math.abs(seating) >= 0.005) {
      trial = { z1: r3(opts.trial.z1 + seating), z2: r3(opts.trial.z2 + seating) };
      crownBandMm = { min: r3(opts.crownBandMm.min + seating), max: r3(opts.crownBandMm.max + seating) };
      io.at(
        `the probe sits ${f(Math.abs(seating))} mm ${seating > 0 ? 'further out' : 'further in'} than when the axis was measured ` +
          `(M491 ${f(refPrb.z)} today) — the trial chord is corrected to machine Z ${f(trial.z1)} and the crown’s band to ${f(crownBandMm.min)} to ${f(crownBandMm.max)}`,
      );
    }

    /** One ±Y chord pair at `zMachine`; returns the chord (MACHINE Y and face width). */
    const chordAt = async (zMachine: number): Promise<ChordReading> => {
      const balls: number[] = [];
      for (const sign of [-1, 1] as const) {
        const side = sign < 0 ? '−Y' : '+Y';
        const startY = r3(opts.at.y + sign * opts.searchMm);
        await io.send(`G53 G0 Z${f(opts.seekFromMachineZ)}`);
        await io.send(`G53 G0 X${f(opts.at.x)} Y${f(startY)}`);
        await io.send(`G53 G0 Z${f(r3(zMachine + opts.parkAboveSurfaceMm))}`);
        await io.idle();
        // A guarded descent: the start beside the chuck must be air above the bed.
        await io.send('G91');
        const down = await io.send(`G38.3 Z-${f(opts.parkAboveSurfaceMm)} F${f(opts.touchFeed)}`, { missOk: true });
        const downPrb = lastPrb(down);
        if (downPrb !== null && downPrb.touched) {
          await io.send(probeAwayLine('Z', release));
          await io.send('G90');
          throw new Stop(`the descent beside the chuck at Y ${f(startY)} met material — the search starts inside something; check the module's position`);
        }
        await io.send('G90');
        await io.idle();
        await io.at(`sideways toward the chuck from ${side}, at machine Z ${f(zMachine)}`);
        await io.send('G91');
        const reply = await io.send(`G38.3 Y${f4r(-sign * opts.searchMm)} F${f(opts.touchFeed)}`, { missOk: true });
        const prb = lastPrb(reply);
        await io.send('G90');
        if (prb === null || !prb.touched) {
          await io.send(`G53 G0 Z${f(opts.seekFromMachineZ)}`);
          throw new Stop(`the ${side} touch found no chuck wall within ${f(opts.searchMm)} mm of the tap point — check the tap point and the search`);
        }
        // #790 — PROBE-AWAY before any G0.
        await io.send('G91');
        await io.send(probeAwayLine('Y', sign * release));
        await io.send('G90');
        balls.push(r3(prb.y));
        io.saw({
          source: 'mount-tap',
          label: `the chuck wall ${side}`,
          x: opts.at.x,
          y: r3(prb.y),
          z: zMachine,
          touched: true,
          kind: 'stock',
        });
        await io.send(`G53 G0 Z${f(opts.seekFromMachineZ)}`);
      }
      // The app's sideways-boss convention: the ball centres stand one probe radius outside each face.
      return { y: r3((balls[0]! + balls[1]!) / 2), widthMm: r3(Math.abs(balls[1]! - balls[0]!) - 2 * opts.probeRadiusMm), zMachine };
    };

    const chord = await chordAt(trial.z1);

    // THE CROWN at the chord's own Y.
    const bandBottom = r3(crownBandMm.min);
    const descentMm = r3(opts.seekFromMachineZ - bandBottom);
    if (!(descentMm > 0)) {
      throw new Stop(`the crown's band floor (machine Z ${f(bandBottom)}) is not below the travel height ${f(opts.seekFromMachineZ)}`);
    }
    await io.send(`G53 G0 Z${f(opts.seekFromMachineZ)}`);
    await io.send(`G53 G0 X${f(opts.at.x)} Y${f(chord.y)}`);
    await io.idle();
    await io.at(`down to the chuck's crown at Y ${f(chord.y)}, from machine Z ${f(opts.seekFromMachineZ)}`);
    await io.send('G91');
    const crownReply = await io.send(`G38.3 Z-${f(descentMm)} F${f(opts.surfaceFeed)}`, { missOk: true });
    const crownPrb = lastPrb(crownReply);
    if (crownPrb === null || !crownPrb.touched) {
      await io.send('G90');
      throw new Stop(`the crown touch found nothing down to machine Z ${f(bandBottom)} above the chuck's axis — check the module's position`);
    }
    await io.send(probeAwayLine('Z', release));
    await io.send('G90');
    const crownZ = r3(crownPrb.z);
    await io.send(`G53 G0 Z${f(opts.seekFromMachineZ)}`);

    const solved = solveRotaryCircle(chord, crownZ);
    if (!solved.ok) throw new Stop(solved.reason);

    // THE CHECK chord at its own height: information, never a refusal.
    const check = await chordAt(trial.z2);
    const residualMm = chordResidualMm(check, solved.circle);
    const residualLine =
      residualMm > ROTARY_CHORD_TOLERANCE_MM
        ? `the check chord at machine Z ${f(trial.z2)} measured ${f(check.widthMm)} mm wide, ${f(residualMm)} mm off the fitted circle (tolerance ${ROTARY_CHORD_TOLERANCE_MM} mm) — the chuck may not be round, or a wall may have been touched in the wrong place`
        : null;

    return { ok: true, circle: solved.circle, residualMm, residualLine, probeRefZ: r3(refPrb.z), transcript: io.transcript };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: await io.stopped(e.message), transcript: io.transcript };
    throw e;
  } finally {
    // #789 — the supply goes OFF whatever happened.
    if (powered) await io.trySend(PROBE_SUPPLY_OFF);
  }
}

/** One touch pair of the face-angle step: the two readings and the tilt they state, degrees. */
export interface FaceAngleReading {
  /** 0 for the first pair, then one per correction. */
  pass: number;
  zPlus: number;
  zMinus: number;
  thetaDeg: number;
}

export type FaceAngleResult =
  | {
      ok: true;
      readings: FaceAngleReading[];
      /** The TOTAL signed A turn the step made, degrees (−θ of the first reading, then the rest). */
      thetaDeg: number;
      /** The last pair's |Z+ − Z−|, mm. */
      residualMm: number;
      transcript: Transcript[];
    }
  | { ok: false; reason: string; transcript: Transcript[] };

export interface FaceAngleOptions {
  /** The plan (`registration/faceAngle.ts` `planFaceAngle`) — machine coordinates throughout. */
  plan: FaceAnglePlan;
  touchFeed: number;
  /** How far the ball backs off after a triggered touch before any G0, mm. */
  releaseMm?: number;
  /** The level band on |Z+ − Z−|, mm; `FACE_ANGLE_LEVEL_BAND_MM` when absent. */
  levelBandMm?: number;
  /** The most corrections before it stops and says so; `FACE_ANGLE_MAX_CORRECTIONS` when absent. */
  maxCorrections?: number;
}

/**
 * #1059 — THE FACE-ANGLE STEP: level a square stock in the 4th axis, then make the levelled
 * position its A work zero.
 *
 * Two touches on the top face at ±d either side of the axis give `θ = atan((Z+ − Z−) / 2d)`; A
 * turns by −θ; the pair repeats until |Z+ − Z−| is inside the level band; then `G10 L20 P0 A0`
 * writes the zero. Two safety rules live HERE, in the motion:
 *
 *  1. NO A WORD FROM BELOW THE ENVELOPE CLEARANCE. The stock's corner sweeps past the face's
 *     height as it turns, so every turn is taken from `plan.turnClearanceZ` (the envelope plus the
 *     CAM's clearance), and {@link turnA} refuses — before sending anything — while the last
 *     commanded Z is below it. The lift is a `G53 G0 Z`, never the park above the face.
 *  2. A θ PAST THE SHOP'S LIMIT STOPS THE RUN. The reading is a wrong touch or a wrong mounting;
 *     turning on it would double the error, so nothing turns.
 *
 * The probe session is the axis tap's (#789 supply, #518 `G38.3` only, #790/#932 probe-away before
 * any G0, `$X` + `G90` on a stop, supply off in `finally`); a miss is a READING, not an alarm.
 * All placement is MACHINE: the step runs before the job's work offset exists.
 */
export async function runFaceAngle(opts: FaceAngleOptions, deps: ExecDeps): Promise<FaceAngleResult> {
  const { plan } = opts;
  const release = opts.releaseMm ?? 3;
  const levelBand = opts.levelBandMm ?? FACE_ANGLE_LEVEL_BAND_MM;
  const maxCorrections = opts.maxCorrections ?? FACE_ANGLE_MAX_CORRECTIONS;
  const io = session(deps, plan.seekZ, MAX_IDLE_POLLS, true);
  let powered = false;
  /** The last machine Z commanded — what the A-turn guard reads. */
  let lastZ = plan.seekZ;
  const atZ = async (z: number): Promise<void> => {
    await io.send(`G53 G0 Z${f(z)}`);
    lastZ = z;
  };
  /**
   * SAFETY RULE 1 — an A word may only be sent from at or above the turn clearance. The check runs
   * against the LAST COMMANDED Z, so a turn can never be taken with the probe still near the
   * stock, whatever the sequence that got here.
   */
  const turnA = async (deg: number): Promise<void> => {
    if (!(lastZ >= plan.turnClearanceZ - 1e-9)) {
      throw new Stop(
        `refusing to turn A from machine Z ${f(lastZ)}: the stock's corner sweeps to the ⌀${f(2 * plan.envelopeRadiusMm)} mm envelope as it turns, so the head must be at ${f(plan.turnClearanceZ)} or higher before any A word`,
      );
    }
    await io.send('G91');
    await io.send(`G0 A${f4r(deg)}`);
    await io.send('G90');
  };
  try {
    // #933 — the opening poll is a STATUS poll: a silent link costs 3 s, not the console's 60.
    const status = await io.send('?', { timing: STATUS_POLL_TIMING });
    if (controllerState(status) !== 'Idle') throw new Stop(`the machine reads ${controllerState(status) ?? 'no state'}, not Idle`);
    await io.home();
    if (
      !(await deps.operator({
        kind: 'fit-probe',
        text: 'Fit the probe in the spindle — the ball on its cable — then continue.',
      }))
    ) {
      throw new Stop('stopped: the probe was not fitted');
    }
    powered = true;
    await io.send(PROBE_SUPPLY_ON);
    const rest = await io.send('M119');
    if (/Probe:\s*1\b/.test(rest)) throw new Stop('the probe reads touched at rest; check it is seated and plugged in');
    const refPrb = lastPrb(await io.send('M491', { timing: PROBE_TIMING }));
    if (refPrb === null || !refPrb.touched) throw new Stop('M491 answered no tool-length reading');

    /** One touch on the top face at machine Y; returns the ball's machine Z at the hit. */
    const touch = async (y: number, side: string): Promise<number> => {
      await atZ(plan.seekZ);
      await io.send(`G53 G0 X${f(plan.x)} Y${f(y)}`);
      await atZ(plan.parkZ);
      await io.idle();
      const travel = r3(plan.parkZ - plan.bandFloorZ);
      if (!(travel > 0)) throw new Stop(`the touch has no travel: the park ${f(plan.parkZ)} is not above the band floor ${f(plan.bandFloorZ)}`);
      await io.at(`down to the top face ${side} of the axis, from machine Z ${f(plan.parkZ)}`);
      await io.send('G91');
      const reply = await io.send(`G38.3 Z-${f(travel)} F${f(opts.touchFeed)}`, { missOk: true });
      const prb = lastPrb(reply);
      if (prb === null || !prb.touched) {
        await io.send('G90');
        throw new Stop(
          `the touch ${side} of the axis found no face down to machine Z ${f(plan.bandFloorZ)} — check the stock is under the probe and the axis datum is right`,
        );
      }
      await io.send(probeAwayLine('Z', release));
      await io.send('G90');
      lastZ = r3(prb.z + release);
      io.saw({ source: 'mount-tap', label: `the top face ${side} of the axis`, x: plan.x, y, z: r3(prb.z), touched: true, kind: 'stock' });
      return r3(prb.z);
    };

    const readings: FaceAngleReading[] = [];
    let turned = 0;
    for (let pass = 0; ; pass++) {
      const zPlus = await touch(plan.yPlus, '+Y');
      const zMinus = await touch(plan.yMinus, '−Y');
      const theta = solveFaceAngle(zPlus, zMinus, plan.d);
      readings.push({ pass, zPlus, zMinus, thetaDeg: r3(theta) });
      // SAFETY RULE 2 — a reading this large is not a stock the step may turn.
      const limit = faceAngleLimitProblem(zPlus, zMinus, plan.d, plan.maxDeg);
      if (limit !== null) throw new Stop(limit);
      const residual = r3(Math.abs(zPlus - zMinus));
      if (residual <= levelBand) {
        // The levelled position IS the A work zero: the program's A words are then relative to
        // the stock's own face, with nothing to add at the post.
        await atZ(plan.seekZ);
        await io.send('G10 L20 P0 A0');
        return { ok: true, readings, thetaDeg: turned, residualMm: residual, transcript: io.transcript };
      }
      if (pass >= maxCorrections) {
        throw new Stop(
          `the face did not come level in ${maxCorrections} corrections — the last pair still read ${f(residual)} mm across ${f(2 * plan.d)} mm. ` +
            'Check the probe is on the stock (not a jaw or the chuck), then run the step again',
        );
      }
      // SAFETY RULE 1 — lift clear of the ENVELOPE, then turn.
      await atZ(plan.turnClearanceZ);
      await turnA(-theta);
      turned = r3(turned - theta);
    }
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: await io.stopped(e.message), transcript: io.transcript };
    throw e;
  } finally {
    // #789 — the supply goes OFF whatever happened.
    if (powered) await io.trySend(PROBE_SUPPLY_OFF);
  }
}

/**
 * #475 — how many surface touches the run may take, and where. `surfaceSpreadPlan(job)` supplies
 * the cut area's centre and extents and the depth band those regions leave; the executor measures
 * the points and assesses the readings. The caller passes it only when it wants a spread verdict.
 */
export async function runRegistration(
  plan: RegistrationPlan,
  deps: ExecDeps,
  spreadPlan?: SurfaceSpreadPlan,
): Promise<RunResult> {
  // #1199 — the clearances are proven against the LIVE machine's, never taken from the plan alone.
  const cleared = liveClearanceFor(plan, deps);
  if (cleared.problem !== null) return { ok: false, reason: `nothing was sent: ${cleared.problem}`, transcript: [] };
  const io = session(deps, cleared.clearanceZ, plan.settings.idlePollLimit, probeNeedsRelease(plan.probe));
  const s = plan.settings;
  // #449 — the settings are the location's; a set that cannot make a capped touch sends nothing at all.
  const bad = settingsProblem(s);
  if (bad !== null) return { ok: false, reason: `nothing was sent: ${bad}`, transcript: [] };
  /** #789 — whether the probe's supply was (or may have been) switched on, for the closing M832. */
  let powered = false;
  try {
    // #933 — the opening poll is a STATUS poll: a silent link costs 3 s, not the console's 60.
    const status = await io.send('?', { timing: STATUS_POLL_TIMING });
    if (controllerState(status) !== 'Idle') throw new Stop(`the machine reads ${controllerState(status) ?? 'no state'}, not Idle`);
    await io.home();
    await io.send('G54');
    await io.send('G92.1');
    // #933 — THE G54 PRE-FLIGHT, before any touch. Registration never seeds a work origin, so a
    // stale or cleared G54 puts the first touch where the stock is not — the 2026-10-21 miss, which
    // read as a planner fault. `workOffset` is `MPos − WPos`, the offset in force; it is compared
    // with the origin this bed was last registered to when the caller has one.
    if (deps.expectedG54 !== undefined && deps.expectedG54 !== null) {
      const statusText = await io.send('?', { timing: STATUS_POLL_TIMING });
      const off = workOffset(readStatusLine(statusText));
      if (off.x === null || off.y === null) {
        throw new Stop(
          'the machine’s status line did not carry both positions, so the work origin (G54) could not be checked — connect again and retry',
        );
      }
      const away = Math.hypot(off.x - deps.expectedG54.x, off.y - deps.expectedG54.y);
      if (away > G54_PREFLIGHT_MM) {
        throw new Stop(
          `the machine’s work origin (G54 X${f(off.x)} Y${f(off.y)}) is ${f(away)} mm from the one this bed was registered to ` +
            `(X${f(deps.expectedG54.x)} Y${f(deps.expectedG54.y)}) — re-establish the origin before registering, or register again to re-find it`,
        );
      }
    }
    // #1203 — the prompt names the collet the fitted post needs (the plan's recorded shank).
    if (
      !(await deps.operator({
        kind: 'fit-probe',
        text: `Fit the wired probe in the spindle — ${probeColletWords(plan.probe?.shankMm)} — then continue.`,
      }))
    ) {
      throw new Stop('stopped: the probe was not fitted');
    }
    // #789 — the probe's supply, before the first probe move and before the rest check: an
    // electronic probe reads open while it is unpowered, so the check would prove nothing.
    powered = true;
    await io.send(PROBE_SUPPLY_ON);
    // #599 — the probe must read OPEN (untouched) at rest: a touched reading before anything moves
    // means the plug is bad or wired wrong (the Carvera firmware halts PROBE_FAIL on exactly this).
    const rest = await io.send('M119');
    if (/Probe:\s*1\b/.test(rest)) {
      throw new Stop('the probe reads touched at rest; check it is seated and plugged in');
    }
    const ref = lastPrb(await io.send('M491', { timing: PROBE_TIMING }));
    if (ref === null || !ref.touched) throw new Stop('M491 answered no tool-length reading');
    // #1189 — THE PROBE'S SEATING IS NOW KNOWN. Every stored Z datum is a raw machine Z measured
    // with the probe as it sat THAT day; a refit shifts each expectation by today's M491 less the
    // datum's own reference. The correction is applied once, here, to the plan the rest of the run
    // uses — the seek band, the cut-blank check bands, the derived top, the mount tap and the jaw
    // ceiling — and it is narrated as one sentence per datum.
    const corrected = correctedPlanForProbe(plan, ref.z);
    plan = corrected.plan;
    for (const note of corrected.notes) io.at(note);
    // #1166 (c1) — THE TOP QUESTION, after the probe is fitted and referenced and BEFORE any probe
    // motion. Only under the bracket guard: a measured-seat bracket plan whose surface point is on
    // the stock, with finished programs on the machine. The operator answers with a top measured
    // before, the bracket's own top, or today's seek; a typed or derived answer moves nothing.
    const bracketTopFallback =
      // #1201 — A GUARDED TOP SEEK HAS NO EXPECTED SURFACE, so there is no derived top to offer:
      // #1166's question would offer `band.max − tolerance` (the park height), which is nonsense.
      plan.guarded === undefined &&
      plan.mount === 'bracket' &&
      plan.bracketOrigin !== null &&
      surfacePointOnStock(plan) &&
      deps.hasFinishedPrograms === true;
    // #1189 — the recorded top is a raw reading from the run that accepted it; it is shifted by
    // that run's own M491 reference, and NOT used when the record carries none.
    const bracketTop = bracketTopOf(
      plan,
      shiftedRecordedTopMachineZ(
        deps.lastRecordedTopMachineZ ?? null,
        deps.lastRecordedTopProbeRefZ ?? null,
        ref.z,
      ),
    );
    let chosenTop: { machineZ: number; source: 'bracket-top' | 'operator-entered' } | null = null;
    if (bracketTopFallback && deps.askTop !== undefined) {
      const choice = await deps.askTop({
        surfacePoint: { x: plan.surfacePoint.x, y: plan.surfacePoint.y },
        band: plan.seek.band,
        derived: bracketTop,
      });
      if (choice.kind === 'stop') throw new Stop('stopped: the top question was not answered');
      if (choice.kind === 'typed') {
        const z = r3(choice.machineZ);
        // #1166 — a typed top is accepted only INSIDE the plan's band. This is the executor's own
        // guard beside the card's sentence: an out-of-band number is never continued from.
        if (!Number.isFinite(z) || z < plan.seek.band.min || z > plan.seek.band.max) {
          throw new Stop(
            `the top entered (machine Z ${f(z)}) is outside the plan's expected ${f(plan.seek.band.min)} to ${f(plan.seek.band.max)} — nothing was moved`,
          );
        }
        chosenTop = { machineZ: z, source: 'operator-entered' };
      } else if (choice.kind === 'derived') {
        chosenTop = { machineZ: bracketTop.machineZ, source: 'bracket-top' };
      }
    }
    // A chosen top means the probe does not move to find one: the clamp confirm is the seek's (it
    // warns about the probe's path), so it is asked only when the operator chose to seek.
    if (chosenTop === null && plan.mount === 'bracket' && !(await deps.operator({ kind: 'confirm-mount', text: mountConfirmText(plan) }))) {
      throw new Stop('stopped: the clamps were not confirmed where the plan puts them');
    }

    // #599 — the mount tap: one guarded touch on the mount's reference (the fixed-jaw top) before the
    // surface seek, at the machine XY the plan carries. One line per Idle, and the G38.3 is never
    // queued behind the rapid — that exact queue gave PROBE_FAIL and MPos 0,0 on 2026-10-23.
    let mountTap: { z: number; at: { x: number; y: number } } | null = null;
    // #607 — the tap is the MOUNT's, not the vise's: which reference it touches is the plan's
    // (`PlanMountTap.reference`), and the machine Z it expects is `expectZ` — the jaw top, or the
    // bracket's top = seat + height. The fallback keeps a pre-#607 plan and the typed-seat path
    // exactly as they were: with no expected reference there is nothing to tap.
    const tapExpectZ = plan.mountTap === null ? null : (plan.mountTap.expectZ ?? plan.mountDatum?.jawTopZ ?? null);
    // #1166 (c1) — no mount tap either when the top was chosen: the question's answers move nothing.
    if (chosenTop === null && plan.mountTap !== null && tapExpectZ !== null) {
      const tap = plan.mountTap;
      const floorZ = tapExpectZ - MOUNT_TAP_FLOOR_MM;
      const prb = await mountTapTouch(io, { x: tap.x, y: tap.y }, plan.seek.fromMachineZ, plan.seek.fromMachineZ, s, floorZ, tapExpectZ, plan.probe);
      if (prb === null || !prb.touched || Math.abs(prb.z - tapExpectZ) > MOUNT_TAP_SLACK_MM) {
        const vise = tap.reference === undefined || tap.reference === 'vise-jaw-top';
        // #633 — a TOUCH outside the slack is not a miss. The fast stage meets the fixed jaw (or an
        // obstruction) above the stored reference; reporting "no jaw top … down to machine Z" sends
        // the operator looking for a surface the probe did find. Say where it touched, and how far
        // from the stored reference that is.
        if (prb !== null && prb.touched) {
          const off = r3(prb.z - tapExpectZ);
          throw new Stop(
            `a touch at machine Z ${f(prb.z)} at (${tap.x}, ${tap.y}), ${f(Math.abs(off))} mm ${off > 0 ? 'above' : 'below'} the stored ${vise ? 'jaw top' : tap.label} ${f(tapExpectZ)} — is the ${plan.mount} where the machine record says?`,
          );
        }
        throw new Stop(
          vise
            ? `no jaw top at (${tap.x}, ${tap.y}) down to machine Z ${f(floorZ)} — is the vise where the machine record says?`
            : `no touch at ${tap.label} (${tap.x}, ${tap.y}) down to machine Z ${f(floorZ)} within ${MOUNT_TAP_SLACK_MM} mm of the stored ${f(tapExpectZ)} — is the ${plan.mount} where the machine record says?`,
        );
      }
      // #519 item 1 — the tap is a reading too: the viewport marks the fixed-jaw top.
      io.saw({ source: 'mount-tap', label: tap.label, x: tap.x, y: tap.y, z: prb.z, touched: prb.touched, kind: null });
      mountTap = { z: prb.z, at: { x: tap.x, y: tap.y } };
    }

    // #449 — the slow travel is the shop's `registration.surfaceSlowSeekMm` (1.2 to 2 mm, more than the
    // lift); a plan whose settings break that never got this far (`settingsProblem`).
    // #585 — the typed-seat path (no measured jaw-top datum) may find nothing in its narrow band;
    // that is a provisional seat's expected failure, not necessarily a missing stock. The seek
    // returns a miss instead of stopping and the operator is offered ONE guarded search lower. The
    // datum path keeps its hard stop: its floor is the measured jaw top, so a miss there really is
    // "the stock is not where the machine record says".
    const typedSeat = plan.mountDatum === null && plan.mount === 'vise';
    const miss: Partial<SurfaceMiss> = {};
    let recovered: { cap: number; note: string } | null = null;
    // #1166 — the DERIVED surface this run continues from (a chosen top, or the after-miss offer):
    // no probe touched it, and the record says which kind it is.
    let derived: { machineZ: number; source: 'bracket-top' | 'operator-entered' } | null = chosenTop;
    // #1179 B — where the accepted reading was taken (a check point) and what every check read.
    let surfaceAt: { x: number; y: number } | null = null;
    let cutBlankChecks: NonNullable<RunData['surfaceChecks']> | undefined;
    let cutBlankOutlier: { machineZ: number; at: { x: number; y: number } } | null = null;
    const checks = plan.surfaceChecks ?? [];
    let slow: Prb | null;
    if (chosenTop !== null) {
      // NOTHING TOUCHED THIS. The XY is where the seek WOULD have been sent — on the bracket every
      // move is G53 from its origin, so machine XY = the origin + the plan's surface point — and the
      // Z is the top the operator chose.
      slow = derivedSurfacePrb(plan, chosenTop.machineZ);
    } else if (checks.length > 0) {
      // #1179 B — a blank that has been cut: the top is MEASURED on uncut stock and proved by two
      // agreeing touches, never taken from one reading and never asked for.
      const proved = await proveCutBlankTop(io, plan, s);
      slow = proved.prb;
      surfaceAt = proved.at;
      cutBlankChecks = proved.readings;
      cutBlankOutlier = proved.outlier;
    } else {
      slow = await seekSurface(
        io,
        plan,
        {
          ...plan.seek.band,
          at: `as low as machine Z ${plan.seek.band.min}, ${s.surfaceToleranceMm} mm below the expected surface (the surface seek)`,
          expect: 'the stock is not where the job expects it',
        },
        // #633 — the datum path's OWN widening (#619): a blank mounted normally may stand prouder
        // than the ledge estimate, and this seek is the one that accepts it.
        {
          ceilingMm: datumCeiling(plan),
          missOk: typedSeat || bracketTopFallback,
          belowBandIsMiss: bracketTopFallback,
          onMiss: (m) => {
            miss.how = m.how;
            miss.z = m.z;
          },
        },
      );
      if (slow === null && bracketTopFallback) {
        // #1166 — THE AFTER-MISS OFFER. The wording does not assert a cause it has not checked: it
        // names the arithmetic and tells the operator what a new blank means.
        const useDerived = await deps.operator({
          kind: 'derived-surface',
          // #1179 B4 — a recorded top is offered AS the record; otherwise the bracket's own top.
          text:
            `no surface where the plan expected it. If earlier programs cut this spot, ` +
            `${bracketTop.recordedMachineZ !== null ? 'use' : "use the bracket's own top:"} ${bracketTopWords(bracketTop)}. ` +
            `If this is a new blank, decline and check its thickness.`,
        });
        if (!useDerived) throw surfaceMissStop(plan, miss);
        slow = derivedSurfacePrb(plan, bracketTop.machineZ);
        derived = { machineZ: bracketTop.machineZ, source: 'bracket-top' };
      } else if (slow === null) {
        const thickness = plan.stockThicknessMm;
        if (thickness === undefined) {
          throw new Stop(
            'the surface touch found nothing in the typed seat’s band, and the plan does not carry the stock’s thickness to bound a deeper search — measure the jaw top instead of typing a seat',
          );
        }
        const expectedSurface = r3(plan.seek.band.max - s.surfaceToleranceMm);
        const seat = r3(expectedSurface - thickness);
        const cap = r3(seat - SURFACE_RECOVERY_BELOW_SEAT_MM);
        if (!(cap < plan.seek.band.min)) {
          throw new Stop(
            `the surface touch found nothing down to machine Z ${f(plan.seek.band.min)}, and the ${f(SURFACE_RECOVERY_BELOW_SEAT_MM)} mm search below the typed seat has no room below it — check the stock is in the vise`,
          );
        }
        const confirmed = await deps.operator({
          kind: 'search-lower',
          text:
            `The surface touch found nothing down to machine Z ${f(plan.seek.band.min)}. ` +
            `Search lower, to machine Z ${f(cap)}? The probe is over the stock: if the stock is there it is met before the cap, and the cap is ${f(SURFACE_RECOVERY_BELOW_SEAT_MM)} mm below the typed seat.`,
        });
        if (!confirmed) {
          throw new Stop('stopped: the surface is below the typed seat’s band, and the deeper search was not confirmed');
        }
        slow = await seekDeeper(io, plan, plan.seek.band, cap);
        recovered = {
          cap,
          note:
            `the surface was found ${f(r3(plan.seek.band.min - slow.z))} mm below the typed seat’s band — the measured top is used; ` +
            `the measured seat is machine Z ${f(r3(slow.z - thickness))} (top ${f(slow.z)} − thickness ${f(thickness)}), so the typed seat was provisional`,
        };
      }
    }
    // #585 — the extent touches search the same floor the centre was found under. After a recovery
    // that floor is the cap, not the typed seat's band: a blank found below the band is equally
    // below it at its extents, and the plan's own floor would stop every one of them.
    const seekBand = recovered === null ? plan.seek.band : { ...plan.seek.band, min: recovered.cap };
    // #519 item 1 — the surface touch, at the plan's own point. #1166 — a DERIVED top is not a
    // reading: no dot is drawn and no table row is claimed; the run narrates the derivation instead.
    if (derived !== null) {
      io.at(
        derived.source === 'operator-entered'
          ? `the top is the operator’s ENTERED value, machine Z ${f(derived.machineZ)} — nothing touched it`
          : `the surface is DERIVED: the bracket’s own top at machine Z ${f(derived.machineZ)} — nothing touched it`,
      );
    } else if (cutBlankChecks === undefined) {
      io.saw({
        source: 'surface',
        label: null,
        x: plan.surfacePoint.x,
        y: plan.surfacePoint.y,
        z: slow.z,
        touched: slow.touched,
        kind: null,
      });
    }

    // #619 — a datum-path surface ABOVE the expected band is the blank standing prouder than the
    // ledge estimate (a normally mounted blank need not sit on the ledge). The note lands on the
    // OUTCOME (the run's record), never on the plan — the plan is the approved object and is not the
    // executor's to mutate. "Expected" is the ledge proud (band max − tolerance − jawTop), not band max − jawTop.
    const proudNote =
      plan.mountDatum !== null && slow.z > plan.seek.band.max
        ? `the blank stands ${f(slow.z - plan.mountDatum.jawTopZ)} mm proud of the jaw tops — expected ${f(plan.seek.band.max - s.surfaceToleranceMm - plan.mountDatum.jawTopZ)} on the ledge; the measured top is used`
        : null;

    const parkZ = slow.z + s.parkAboveSurfaceMm;
    await io.send(`G53 G0 Z${f(parkZ)}`);
    io.at(`at the park height, ${s.parkAboveSurfaceMm} mm above the surface`);

    const scans: ScanRecord[] = [];
    // #525/#1133 — a sideways touch wherever the mount leaves the edge free: the bracket and tape
    // (all four), and a vise's free front/back edges — for EVERY probe, the wired/Z-only one
    // included. A sideways seek approaches from OUTSIDE the stock and stops at the first touch, so
    // the scan never walks inward over the stock where the bores and pockets are (the maintainer's
    // rule). A vise's X edges keep the Z-only bracket-and-bisect: its jaws stand where the ball
    // would travel — except #827's corner case below. #1133 — a vise with NO measured jaw top
    // keeps the Z-only scan on its free edges too: `sideTouchSetup` cannot place the ball above
    // the ledge without the datum, and the plan says so ("no measured jaw top for a sideways
    // touch").
    const g54 = {
      x: r3(slow.x - (surfaceAt?.x ?? plan.surfacePoint.x)),
      y: r3(slow.y - (surfaceAt?.y ?? plan.surfacePoint.y)),
    };
    for (const scan of plan.scans) {
      // #1143 — ONE RULE: `sideTouchSelected` is the dispatch, and the run plan's touch estimate
      // counts on the same predicate, so the estimate cannot drift from what the machine does.
      scans.push(
        sideTouchSelected(plan, scan.edge)
          ? await scanEdgeSideways(io, plan, scan, slow.z, g54)
          : await scanEdge(io, plan, scan, parkZ, slow.z),
      );
    }

    const data: RunData = {
      probeRefZ: ref.z,
      surface: slow,
      scans,
      ...(derived === null ? {} : { surfaceDerived: derived.source }),
      ...(surfaceAt === null ? {} : { surfaceAt }),
      ...(cutBlankChecks === undefined ? {} : { surfaceChecks: cutBlankChecks }),
    };
    // A plan that registers on earlier-setup features has its own outcome (#429); #430's is unchanged.
    const outcome = plan.references ? referenceOutcome(plan, data) : computeOutcome(plan, data);
    if (proudNote !== null) outcome.notes.push(proudNote);
    // #1189 — the seating correction is part of the record, on the card and in the run log.
    for (const note of corrected.notes) outcome.notes.push(note);
    // #585 — the typed seat's recovery is part of the record: the reading, where the probe found it,
    // and the seat that measurement implies (top − thickness). The plan itself is never mutated.
    if (recovered !== null) outcome.notes.push(recovered.note);
    // #1166 — a derived top cannot be spread-measured: the plan's points are exactly where earlier
    // programs have cut, so an extent seek would stop the run this press exists to save (or record a
    // cut face as the blank's top). The spread is skipped, and the record says so.
    if (derived !== null && spreadPlan !== undefined) {
      outcome.notes.push(
        'the surface spread was not measured this run: the top the plan expected has been cut away, and the bracket’s own top is the DERIVED surface',
      );
    }
    // #1179 B — the record states the proof: every check, its tier, and the pair the top came from.
    if (cutBlankChecks !== undefined) {
      const read = cutBlankChecks
        .map((r, i) => {
          const what =
            r.missed === 'no-contact'
              ? 'found nothing'
              : r.missed === 'below-band'
                ? `read machine Z ${f(r.machineZ ?? 0)}, below the band`
                : r.aboveBandMm !== null && r.aboveBandMm !== undefined
                  ? `read machine Z ${f(r.machineZ ?? 0)}, ${f(r.aboveBandMm)} mm above the expected top (something on the blank; not used)`
                  : `read machine Z ${f(r.machineZ ?? 0)} (implied top ${f(r.impliedMachineZ ?? 0)})`;
          return `${i + 1}) ${what} at (${f(r.x)}, ${f(r.y)}) depth ${f(r.depthMm)}`;
        })
        .join('; ');
      outcome.notes.push(
        (plan.guarded === undefined ? 'the top was measured on a cut blank' : 'the top on the blank was proved') +
          `: ${read}; the accepted implied top is machine Z ${f(slow.z)} (${cutBlankOutlier === null ? 'the higher of two agreeing touches or the level three agree on' : `three checks agree; the lone high reading implied ${f(cutBlankOutlier.machineZ)} at (${f(cutBlankOutlier.at.x)}, ${f(cutBlankOutlier.at.y)}) is a chip or an unrecorded floor and was not used`})` +
          (plan.surfaceChecksUnknown === true
            ? ' — the earlier plan’s cuts are not recorded, so the check points are outside today’s footprint and assumed uncut'
            : '') +
          (plan.surfaceChecksProbeNote === undefined ? '' : ` — ${plan.surfaceChecksProbeNote}`),
      );
      if (spreadPlan !== undefined) {
        outcome.notes.push(
          'the surface spread was not measured this run: this blank has been cut, so the top was proved by the agreeing touches on uncut stock',
        );
      }
    }

    // #475 — the cut extents, AFTER the scans (#591): the plan's touch points are where the cut's
    // extents are on the stock the job expects; the scans have just measured where the stock IS, so
    // each touch is placed by the found offset — a blank clamped 5 mm further along the jaws is
    // touched 5 mm further along, not in the air past its end (bench 2026-10-23, run 4). Each is a
    // bounded surface seek inside the SAME band the registration point was checked against (#430's
    // cap and tolerance): a reading outside it stops the run rather than quietly widening the
    // measurement. The plan's first point is the cut area's centre, normally the registration point
    // itself — that reading is reused, so the blank is not touched twice in the same spot.
    // #590 — with a reading in hand, a touch starts just above the band (`band.max + park`) and
    // probes `2 × tolerance + park`, not the whole drop from the travel height. The high approach
    // stays where the plan lists something standing above the stock (the bracket's clamps and arms).
    const spreadReadings: SurfaceReading[] = [];
    // #1166 — no extent seeks after a DERIVED top (see the note above): the points are where the
    // earlier programs cut, and a derived Z is not a spread measurement.
    if (spreadPlan !== undefined && derived === null && cutBlankChecks === undefined) {
      const lowApproach = plan.mountObstacles.length === 0;
      // #632 — the approach clears the MEASURED surface, not only the plan's high bound. A blank
      // standing prouder than the record expects (a stale `surfaceTopZ` written by a thinner blank,
      // or the ledge estimate) reads above `band.max`; approaching from `band.max + park` would
      // rapid the probe INTO the stock and drag it across the top. The slow centre reading is in
      // hand before any extent, so the approach is `max(band's high bound, that reading) + park`.
      const approachZ = Math.round((Math.max(plan.seek.band.max, slow.z) + s.parkAboveSurfaceMm) * 1000) / 1000;
      // #640 — the extent stop names the floor it really searched to and the mount it is on: the
      // vise's re-clamp advice is wrong on a bracket or tape, and on the datum path the floor is the
      // jaw top less a tolerance (#598), not "tolerance below the expected surface".
      const toleranceFloor = Math.round((plan.seek.band.max - 2 * s.surfaceToleranceMm) * 1000) / 1000;
      const floorWords =
        recovered !== null
          ? `the deeper search's cap, machine Z ${f(seekBand.min)}`
          : Math.abs(plan.seek.band.min - toleranceFloor) < 1e-6
            ? `${f(s.surfaceToleranceMm)} mm below the expected surface`
            : `the search floor above the ${plan.mount === 'vise' ? 'jaw top' : 'bracket seat'} less ${f(s.surfaceToleranceMm)} mm`;
      const reseatWords =
        plan.mount === 'vise'
          ? 'loosen the vise, press it down on that side, re-clamp'
          : plan.mount === 'bracket'
            ? 'check the stock lies flat on the bracket\'s seat — a chip under it or the arm holding one side high lifts it'
            : 'lift the stock and re-seat it flat on the tape';
      for (const touch of spreadPlan.touches) {
        const samePoint =
          Math.abs(touch.x - plan.surfacePoint.x) < 1e-6 && Math.abs(touch.y - plan.surfacePoint.y) < 1e-6;
        const prb = samePoint
          ? slow
          : await seekSurface(
              io,
              plan,
              {
                ...seekBand,
                at: `as low as machine Z ${seekBand.min} (${floorWords}) for the surface touch at ${touch.at}`,
                expect: `${touch.at} is more than ${s.surfaceToleranceMm} mm lower than the centre (${f(slow.z)}) — the blank is not sitting flat; ${reseatWords}, and run again`,
              },
              {
                point: { x: touch.x + outcome.offset.x, y: touch.y + outcome.offset.y },
                fromMachineZ: lowApproach ? approachZ : plan.seek.fromMachineZ,
                // The same top the centre seek measured, so the same datum-path ceiling.
                ceilingMm: datumCeiling(plan),
              },
            );
        // #585 — an extent seek never opts into a miss (only the typed seat's centre does), so this
        // cannot be null; a guard keeps the miss-aware signature honest without weakening the stop.
        if (prb === null) throw new Stop(`the surface touch at ${touch.at} found nothing down to machine Z ${seekBand.min}`);
        spreadReadings.push({ z: prb.z, source: 'probe' });
        // #519 item 1 — every extent reading but the reused centre: that one reading is the surface
        // touch above, and one reading must not draw two dots.
        if (!samePoint) {
          io.saw({
            source: 'spread',
            label: touch.at,
            x: touch.x + outcome.offset.x,
            y: touch.y + outcome.offset.y,
            z: prb.z,
            touched: prb.touched,
            kind: null,
          });
        }
      }
    }

    await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
    await io.home();
    io.markHomed();

    // #475/#608/#631 — the spread verdict. Z0 is the LOWEST touch (the colour line is a plane and
    // the dome is extra top material), so the outcome carries it for flat, tilt AND dome alike. A
    // tilt that fits a plane is followed by the re-posted program; a dome (residual wider than the
    // band) no longer refuses — the origin is still written and the machine levels the top itself.
    let spread: SurfaceSpreadAssessment | undefined;
    if (spreadPlan !== undefined && derived === null && cutBlankChecks === undefined) {
      spread = assessSurfaceReadings(spreadPlan, spreadReadings);
      outcome.surfaceZ = spread.z0.z;
    }
    return {
      ok: true,
      data,
      outcome,
      ...(spread === undefined ? {} : { spread }),
      mountTap,
      probe: { lengthZ: ref.z, rest },
      transcript: io.transcript,
    };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: await io.stopped(e.message), transcript: io.transcript };
    throw e;
  } finally {
    // #789 — OFF whatever happened (a miss is a reading, not a reason to leave the connector
    // powered): the supply is one switch for the whole machine, and the next thing fitted there
    // may be a cutter, not a probe.
    if (powered) await io.trySend(PROBE_SUPPLY_OFF);
  }
}

export type RetouchResult =
  | { ok: true; surface: Prb; outcome: RegistrationOutcome; transcript: Transcript[] }
  | { ok: false; reason: string; transcript: Transcript[] };

/**
 * The re-touch after a facing pass (#432 slice 4, decision 4: probe → face → re-touch → engrave).
 *
 * The facing program is posted against the PROBED top and the engraving program against the top the
 * skim leaves. That top is MEASURED, not computed: a skim never removes exactly its nominal depth
 * (spindle growth, deflection, a blank clamped a little tilted), so the first reading minus
 * `removedMm` is only the EXPECTATION the new touch is checked against — the band. The measured
 * surface is what the origin is written from.
 *
 * Runs the same surface seek as the registration, at the plan's own point, with the wired probe;
 * the XY origin is not re-derived (this measures Z alone; the first run's corrected XY is already in
 * G54). The returned outcome is the first one with `surfaceZ` replaced, ready for
 * {@link applyCorrection} with the cutter's own `M491`.
 */
export async function retouchSurface(
  plan: RegistrationPlan,
  outcome: RegistrationOutcome,
  opts: { removedMm: number; toleranceMm: number },
  deps: ExecDeps,
): Promise<RetouchResult> {
  const s = plan.settings;
  const bad = settingsProblem(s);
  if (bad !== null) return { ok: false, reason: `nothing was sent: ${bad}`, transcript: [] };
  if (!Number.isFinite(opts.removedMm) || opts.removedMm <= 0) {
    return { ok: false, reason: 'a re-touch needs the depth the facing pass removed, above 0', transcript: [] };
  }
  if (!Number.isFinite(opts.toleranceMm) || opts.toleranceMm <= 0) {
    return { ok: false, reason: 'a re-touch needs a tolerance above 0', transcript: [] };
  }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const expected = r3(outcome.surfaceZ - opts.removedMm);
  const min = r3(expected - opts.toleranceMm);
  const max = r3(expected + opts.toleranceMm);
  if (!(min < plan.seek.fromMachineZ)) {
    return {
      ok: false,
      reason:
        `the re-touch has nowhere to travel: the faced top is expected at machine Z ${expected}, at or above the ` +
        `travel height ${plan.seek.fromMachineZ}. Check the depth and that the facing pass ran`,
      transcript: [],
    };
  }
  // #1199 — the clearances are proven against the LIVE machine's, never taken from the plan alone.
  const cleared = liveClearanceFor(plan, deps);
  if (cleared.problem !== null) return { ok: false, reason: `nothing was sent: ${cleared.problem}`, transcript: [] };
  const io = session(deps, cleared.clearanceZ, plan.settings.idlePollLimit, probeNeedsRelease(plan.probe));
  /** #789 — whether the probe's supply was (or may have been) switched on, for the closing M832. */
  let powered = false;
  try {
    // #933 — the opening poll is a STATUS poll: a silent link costs 3 s, not the console's 60.
    const status = await io.send('?', { timing: STATUS_POLL_TIMING });
    if (controllerState(status) !== 'Idle') throw new Stop(`the machine reads ${controllerState(status) ?? 'no state'}, not Idle`);
    await io.home();
    await io.send('G54');
    await io.send('G92.1');
    if (
      !(await deps.operator({
        kind: 'fit-probe',
        text: `Fit the wired probe again — ${probeColletWords(plan.probe?.shankMm)}: the faced top is measured before the program file is posted from it.`,
      }))
    ) {
      throw new Stop('stopped: the probe was not fitted');
    }
    // #789 — the re-touch is a probe session of its own: power the connector before its first move.
    powered = true;
    await io.send(PROBE_SUPPLY_ON);
    const surface = await seekSurface(
      io,
      plan,
      {
        min,
        max,
        at: `as low as machine Z ${min}, ${opts.toleranceMm} mm below the faced top expected at ${expected} (the re-touch)`,
        expect: 'the faced top is not where the skim should have put it — check that the facing program ran before the re-touch',
      },
      // #633 — the re-touch band is the expectation the skim is checked against; the datum path's
      // wider ceiling does not apply here, or an unfaced top would pass and be written as Z0.
      { ceilingMm: max },
    );
    // #585 — the re-touch does not opt into a miss; the guard keeps the signature honest.
    if (surface === null) throw new Stop(`the re-touch found nothing down to machine Z ${min}`);
    // #519 item 1 — the re-touch is a reading on the faced top; mark it like the registration's own.
    io.saw({
      source: 'surface',
      label: 'the faced top (re-touch)',
      x: plan.surfacePoint.x,
      y: plan.surfacePoint.y,
      z: surface.z,
      touched: surface.touched,
      kind: null,
    });
    await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
    await io.home();
    return { ok: true, surface, outcome: { ...outcome, surfaceZ: surface.z }, transcript: io.transcript };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: await io.stopped(e.message), transcript: io.transcript };
    throw e;
  } finally {
    // #789 — the re-touch's supply goes off too, whether it measured the top or stopped trying.
    if (powered) await io.trySend(PROBE_SUPPLY_OFF);
  }
}

export type ApplyResult =
  | { ok: true; line: string; cutterRefZ: number; transcript: Transcript[] }
  | { ok: false; reason: string; transcript: Transcript[] };

/**
 * Write the corrected origin — ONLY from a usable measurement, ONLY after the operator confirmed it
 * (Q12), and in #387's order: home before the bit change, the cutter in, its `M491`, `G10 L2` with Z0
 * recomputed for it, home.
 *
 * After a facing pass this is called with the RE-TOUCH's outcome ({@link retouchSurface}), whose
 * `surfaceZ` is measured on the faced top. Nothing here subtracts a depth: Z0 is the surface the
 * outcome carries, in the cutter's frame.
 */
export async function applyCorrection(
  outcome: RegistrationOutcome,
  deps: ExecDeps,
  consent: {
    confirmed: boolean;
    /**
     * #473 — the cutter the G10 write is for, by the name the screen shows. The post-facing flow
     * passes the ENGRAVING cutter: the facing cutter is still in the spindle from the skim, and the
     * whole point of the `M491` below is to calibrate the cutter the next program runs.
     */
    cutter?: string;
    /**
     * #1123 item 31 — THE PROGRAM'S FIRST TOOL NUMBER. After the cutter's `M491` the controller
     * still holds whatever tool it last recorded (after a registration that is the probe's
     * `T8888`), so the program's first `T<n> M6` stops the job in `<Tool|>` until a hand at the
     * console. `M493.2 T<n>` records the fitted cutter's number, making that `M6` a no-op.
     * Absent: no tool line is sent (a caller that has no program, e.g. the standalone centre-find).
     */
    toolNumber?: number;
    /**
     * #1123 item 34 — the cutter fitted is the ENGRAVING one after a facing pass, so the fit
     * sentence names it as such and warns against refitting the facing cutter. Absent on an
     * ordinary registration write: the sentence names the cutter but claims no facing pass.
     */
    afterFacing?: boolean;
  },
): Promise<ApplyResult> {
  const io = session(deps, outcome.seekFromMachineZ);
  if (!outcome.usable) {
    return { ok: false, reason: `no origin is written from this measurement: ${outcome.problems.join('; ')}`, transcript: [] };
  }
  if (consent.confirmed !== true) {
    return { ok: false, reason: 'the origin is written only after the operator confirms the measured offset', transcript: [] };
  }
  try {
    await io.home();
    const fit =
      consent.cutter === undefined
        ? 'Take the probe out, fit the cutter, then continue.'
        : consent.afterFacing === true
          ? `Take the probe out, fit the ENGRAVING cutter — ${consent.cutter} — not the facing cutter, then continue.`
          : `Take the probe out, fit the cutter — ${consent.cutter} — then continue.`;
    if (!(await deps.operator({ kind: 'fit-cutter', text: fit }))) {
      throw new Stop('stopped: the cutter was not fitted');
    }
    // #1123 item 31 — RECORD THE FITTED CUTTER'S TOOL NUMBER **BEFORE** the cutter's `M491`, so
    // the M491 measures the cutter under its own number (the survey's order). The bench's side-2
    // run stopped at the program's `T1 M6` with `<Tool|>` because the controller still held the
    // probe's 8888; this line makes that tool change a no-op.
    // SOURCE: docs/bench/2026-10-30-3d-probe-survey.md:34 — Studio's own prep before its M491 is
    // `M493.2T8888` (NO space; the firmware rejects `M493.2 T1` as an unexpected line — the fake
    // machine's own dialect refuses it, and 0f's 2026-11-09 bench record shows the controller
    // holding 8888 into `T1 M6`). docs/reverse/makera-studio/03 is a one-row block table for
    // M493–M496 and does not add syntax. Order: "before" is the safe default until 0f's machine
    // test confirms whether M493.2 zeroes the TLO (the maintainer's ruling, 2026-11-09).
    if (consent.toolNumber !== undefined) await io.send(`M493.2T${consent.toolNumber}`);
    const ref = lastPrb(await io.send('M491', { timing: PROBE_TIMING }));
    if (ref === null || !ref.touched) throw new Stop('M491 answered no tool-length reading for the cutter');
    const line = correctionLine(outcome, ref.z);
    await io.send(line);
    await io.home();
    return { ok: true, line, cutterRefZ: ref.z, transcript: io.transcript };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: await io.stopped(e.message), transcript: io.transcript };
    throw e;
  }
}

export type AfterFacingResult =
  | {
      ok: true;
      /** The re-touch's measured reading on the faced top. */
      surface: Prb;
      /** The first outcome with `surfaceZ` replaced by that measurement. */
      outcome: RegistrationOutcome;
      /** The `G10 L2` line written for the engraving cutter. */
      correction: string;
      transcript: Transcript[];
    }
  | { ok: false; step: 're-touch' | 'correction'; reason: string; transcript: Transcript[] };

/**
 * #473 — the run order's middle: the face program finished, and the next program is the engraving.
 * In the one order decision 4 fixed (probe → face → re-touch → engrave):
 *
 *   1. {@link retouchSurface} MEASURES the top the facing program left. `removedMm` is `facing.depth`
 *      and is only the expectation the reading is checked against; the number the origin is written
 *      from is the measurement. The band comes from the shop's `facing.retouchToleranceMm` — never a
 *      fixed depth, never a constant.
 *   2. {@link applyCorrection} writes Z0 for the ENGRAVING cutter. The facing cutter is what ran the
 *      skim and is still in the spindle; the `M491` below has to be the cutter the next program runs,
 *      so the operator is told to fit that one and is told not to refit the facing cutter.
 *
 * Nothing is written when the re-touch's reading is outside the band: a top that is not where the
 * skim could have left it means the skim did not run or did not take what it was posted to, and the
 * caller must stop rather than engrave from a guess.
 *
 * `defaults` is the location's defaults map. It is read HERE rather than accepting a tolerance so
 * there is one reader of the key and no second statement of the seed.
 */
export async function retouchAndCorrectAfterFacing(
  plan: RegistrationPlan,
  first: RegistrationOutcome,
  opts: {
    /** The depth the facing program removed, mm (`job.facing.depth`). */
    removedMm: number;
    /** The location's defaults; the re-touch band is `facing.retouchToleranceMm`. */
    defaults: ShopDefaults | null;
    /** The engraving cutter, named in the fit step so the facing cutter is never refitted for the write. */
    engravingCutter: string;
  },
  deps: ExecDeps,
  consent: { confirmed: boolean },
): Promise<AfterFacingResult> {
  const toleranceMm = facingRetouchTolerance(opts.defaults);
  const retouch = await retouchSurface(
    plan,
    first,
    { removedMm: opts.removedMm, toleranceMm },
    deps,
  );
  if (!retouch.ok) {
    return { ok: false, step: 're-touch', reason: retouch.reason, transcript: retouch.transcript };
  }
  const applied = await applyCorrection(
    retouch.outcome,
    deps,
    { confirmed: consent.confirmed, cutter: opts.engravingCutter, afterFacing: true },
  );
  const transcript = [...retouch.transcript, ...applied.transcript];
  if (!applied.ok) return { ok: false, step: 'correction', reason: applied.reason, transcript };
  return {
    ok: true,
    surface: retouch.surface,
    outcome: retouch.outcome,
    correction: applied.line,
    transcript,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// #1088 — SIDE 2'S HOLE REGISTRATION: the executor for `planFlipRegistration` (#1073).
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** One bore's measured centre, as the flip run reads it. */
export interface FlipHoleReading {
  /** 1 or 2 — the pin the find entered, in the plan's order. */
  index: 1 | 2;
  /** The seeded centre the probe entered over (side-2 work XY). */
  seeded: { x: number; y: number };
  /** The measured centre (side-2 work XY). */
  centre: { x: number; y: number };
  /** Each axis's measured span between ball centres and the diameter it states, mm. */
  spans: { axis: 'x' | 'y'; spanMm: number; diameterMm: number }[];
}

export interface FlipRunOptions {
  /**
   * THE FRAME THE TOUCHES RUN IN: the setup's own side-2 plan data — `seek`, `mount`, `probe`,
   * `settings`, `surfacePoint`. Its `scans` are NOT run; the flip plan's steps are. (The planner
   * and the frame plan are separate on purpose: #1073 plans the steps, the setup states the frame.)
   */
  ctx: RegistrationPlan;
  /**
   * #1073 (6b's amendment A) — THE CARRIED Z0 the corner Z touches are the CHECK of, never the
   * source of (`flipChoice.flipZ0`). A reading outside its band stops the run with the number
   * before a bore is entered, so no origin can be written from a blank that is not on its seat.
   * Null/absent when the job states no carried Z0 or no tolerance — then there is no band to check.
   */
  z0?: FlipZ0 | null;
}

export type FlipRunResult =
  | {
      ok: true;
      /**
       * The run as the app's registration store and its Write press already read one: the probe's
       * `M491`, the surface touch, and the scans. `outcome` is the flip's own (the origin from the
       * bores and the front pair), so the operator's press writes it through `applyCorrection`.
       */
      data: RunData;
      outcome: RegistrationOutcome;
      mountTap: null;
      probe: { lengthZ: number; rest: string };
      /** The front pair: the edge Y it read at each touch, mm (side-2 work Y). */
      frontPair: { y: number; surfaceZ: number }[];
      /** The fence-side seed's X, mm (side-2 work X). */
      seedX: number;
      holes: FlipHoleReading[];
      /** The origin the bores and the front pair state (side-2 work XY). */
      origin: { x: number; y: number };
      /** The G54 the two bores and the front pair state — what the press writes. */
      correctedG54: { x: number; y: number };
      /** The turn the bores' line reads against the front pair's, checked by the plan's own tolerance. */
      crossCheck: { expectedAngleDeg: number; measuredAngleDeg: number; toleranceDeg: number };
      /** The surface the front pair found, machine Z. */
      surfaceZ: number;
      probeRefZ: number;
      transcript: Transcript[];
    }
  | { ok: false; reason: string; transcript: Transcript[] };

const fff = (p: { x: number; y: number }): string => `${f4(p.x)}, ${f4(p.y)}`;

/**
 * #1088 — RUN SIDE 2'S REGISTRATION. The plan's order exactly: the front pair (Y and the turn),
 * the fence-side seed (X), then each bore — an entry plunge that must find NOTHING (a trigger
 * means the bore is not where the pin seeds it), four sideways touches +X, −X, +Y, −Y from the
 * seeded pin with a `G38.5` release after every trigger, and a MISS that stops the find by name.
 * Then the bores' line is cross-checked against the front pair's within the plan's own tolerance;
 * outside it, nothing more is measured and the run stops with both angles stated.
 *
 * The origin is RETURNED, not written: the operator's press writes it (the step's route, exactly
 * as `runRegistration`'s outcome). Z0 is the front pair's lowest surface reading.
 */
export async function runFlipRegistration(
  flip: FlipRegistrationPlan,
  opts: FlipRunOptions,
  deps: ExecDeps,
): Promise<FlipRunResult> {
  let ctx = opts.ctx;
  const s = ctx.settings;
  // #1088 — THE STOP ALWAYS RELEASES THE STYLUS HERE. Side 2's bores are read with SIDEWAYS touches
  // whose G38.5 release follows the reading, so a Stop (or a refused line) between the trigger and
  // the release leaves the ball deflected whatever probe make it is; the epilogue's release is a
  // G38.5 move that is safe on a mechanical probe too, so this run never gates it on the instrument.
  const cleared = liveClearanceFor(ctx, deps);
  if (cleared.problem !== null) return { ok: false, reason: `nothing was sent: ${cleared.problem}`, transcript: [] };
  const io = session(deps, cleared.clearanceZ, s.idlePollLimit, true);
  let powered = false;
  try {
    const status = await io.send('?', { timing: STATUS_POLL_TIMING });
    if (controllerState(status) !== 'Idle') throw new Stop(`the machine reads ${controllerState(status) ?? 'no state'}, not Idle`);
    await io.home();
    await io.send('G54');
    await io.send('G92.1');
    // #1203 — the same collet, from the flip run's own frame plan.
    if (
      !(await deps.operator({
        kind: 'fit-probe',
        text: `Fit the wired probe in the spindle — ${probeColletWords(opts.ctx.probe?.shankMm)} — then continue.`,
      }))
    ) {
      throw new Stop('stopped: the probe was not fitted');
    }
    powered = true;
    await io.send(PROBE_SUPPLY_ON);
    const rest = await io.send('M119');
    if (/Probe:\s*1\b/.test(rest)) throw new Stop('the probe reads touched at rest; check it is seated and plugged in');
    const ref = lastPrb(await io.send('M491', { timing: PROBE_TIMING }));
    if (ref === null || !ref.touched) throw new Stop('M491 answered no tool-length reading');
    // #1189 — the frame plan's expectations are datum-derived raw machine Z too: correct them to
    // today's probe seating before any touch. The carried Z0 below is shifted with its own record.
    const corrected = correctedPlanForProbe(ctx, ref.z);
    ctx = corrected.plan;
    for (const note of corrected.notes) io.at(note);

    // ── THE FRONT PAIR AND THE SEED: the frame plan's own scans, in the flip plan's own steps. ──
    const pairStep = flip.steps.find((st) => st.kind === 'edge-pair');
    const seedStep = flip.steps.find((st) => st.kind === 'seed');
    if (pairStep === undefined || seedStep === undefined) throw new Stop('the flip plan has no front pair or no seed — re-plan side 2');

    // The surface the scans classify against: the frame plan's seek, from the machine's travel.
    const band = ctx.seek.band;
    const surfacePrb = await seekSurface(
      io,
      ctx,
      { min: band.min, max: band.max, at: `down to the stock's top at ${fff(ctx.surfacePoint)}`, expect: 'the stock’s top' },
      { ceilingMm: band.max },
    );
    if (surfacePrb === null || !surfacePrb.touched) {
      throw new Stop(`the surface seek found nothing at ${fff(ctx.surfacePoint)} — check the part is on the blank and the bed datum is right`);
    }
    const surfaceZ = r3(surfacePrb.z);
    // THE FRAME THE MOVES RAN IN, as every other touch routine derives it: the surface touch's
    // MACHINE XY less the work point it was sent to (centreFind.ts's rule). A `[PRB:…]` is machine
    // coordinates whatever G54 says; the bore centres are read back in this frame.
    const g54 = { x: r3(surfacePrb.x - ctx.surfacePoint.x), y: r3(surfacePrb.y - ctx.surfacePoint.y) };
    const initialPark = r3(surfaceZ + s.parkAboveSurfaceMm);
    /**
     * The edge a bisected scan leaves, from the SAME finding the side-1 outcome builds: between the
     * last touch on the stock and the first off it, moved back by the probe's effective rim offset
     * (#430 — the probe triggers with its centre past the edge). A scan that found no edge stops
     * with its own sentence rather than an assumed coordinate.
     */
    const edgeOf = (rec: ScanRecord): number => {
      const found = edgeFrom(rec, s.tipRadiusMm);
      if (found.foundAt === null) throw new Stop(found.problem ?? 'a scan of the frame found no edge');
      return found.foundAt;
    };
    const frontPair: { y: number; surfaceZ: number }[] = [];
    const frontRecs: ScanRecord[] = [];
    for (const scan of pairStep.scans) {
      const rec = await scanEdge(io, ctx, scan, initialPark, surfaceZ);
      frontRecs.push(rec);
      const first = rec.touches[0];
      frontPair.push({ y: edgeOf(rec), surfaceZ: r3(first?.prb.z ?? surfaceZ) });
    }

    // ── THE CARRIED Z0 IS CHECKED HERE, ON THE CORNER TOUCHES (#1073, 6b's amendment A). ──
    // The corner Z touches are the CHECK of the carried top, never its source: each must read the
    // carried value inside the surface tolerance. A reading outside the band stops with the numbers
    // before a bore is entered — a chip under the blank is what it finds — so no origin is written
    // from a blank that is not on its seat. Z0 is never re-derived from the rough face.
    const carried0 = opts.z0 ?? null;
    // #1189 — the carried top is a raw machine Z in the SIDE-1 seating. Its probe-independent
    // height (`topTipRefMm`) plus today's M491 gives today's expected raw reading; the band moves
    // with it. A record with no reference cannot be separated from the seating: its band is not
    // used, and the run says so.
    const z0Expected = carried0?.topTipRefMm === null || carried0?.topTipRefMm === undefined ? null : r3(carried0.topTipRefMm + ref.z);
    const z0 =
      carried0 === null || z0Expected === null
        ? null
        : {
            ...carried0,
            topMachineZ: z0Expected,
            checkBand:
              carried0.checkBand === null
                ? null
                : {
                    minMm: r3(z0Expected - (carried0.checkBand.maxMm - carried0.checkBand.minMm) / 2),
                    maxMm: r3(z0Expected + (carried0.checkBand.maxMm - carried0.checkBand.minMm) / 2),
                  },
          };
    if (carried0 !== null && z0Expected === null) {
      io.at(
        'the carried side-2 top was recorded before the probe was last fitted, so its band was not checked this run — ' +
          'the front pair still bounds the surface, and re-register side 1 to record the probe’s reference',
      );
    } else if (carried0 !== null && z0 !== null && Math.abs(z0.topMachineZ - carried0.topMachineZ) >= 0.005) {
      io.at(
        `the carried side-2 top is corrected for the probe’s seating: ${f(carried0.topMachineZ)} in side 1’s seating → ${f(z0.topMachineZ)} today (M491 ${f(ref.z)})`,
      );
    }
    const zBand = z0?.checkBand ?? null;
    if (z0 !== null && zBand !== null) {
      const outside = frontPair.filter((p) => p.surfaceZ < zBand.minMm || p.surfaceZ > zBand.maxMm);
      if (outside.length > 0) {
        const tolerance = r3((zBand.maxMm - zBand.minMm) / 2);
        throw new Stop(
          `the corner Z touches read ${frontPair.map((p) => `${f(p.surfaceZ)} mm`).join(' and ')}, and the carried Z0 says side 2's top is ${f(z0.topMachineZ)} ± ${f(tolerance)} mm ` +
            `(${f(zBand.minMm)} to ${f(zBand.maxMm)}). A reading outside that band is a chip under the blank or the wrong seat — Z0 is never re-derived from the rough face, and no origin is written from this measurement. Nothing more was measured`,
        );
      }
    }

    const seedRec = await scanEdge(io, ctx, seedStep.scan, initialPark, surfaceZ);
    const seedX = edgeOf(seedRec);

    // ── THE BORES: the entry seek, then four sideways touches each. ──
    const holes: FlipHoleReading[] = [];
    for (const step of flip.steps) {
      if (step.kind !== 'hole') continue;
      const find = step.find;
      const at = find.at;
      // The entry: from the park, down through the mouth to the touch depth — a SEEK that must
      // find nothing. A trigger means the bore is not where the pin seeds it.
      await io.send(`G53 G0 Z${f(ctx.seek.fromMachineZ)}`);
      await io.send(moveXY(ctx, at.x, at.y));
      await io.send(`G53 G0 Z${f(initialPark)}`);
      await io.idle();
      await io.send('G91');
      const entry = lastPrb(await io.send(`G38.3 Z-${f(find.plungeMm)} F${f(s.surfaceFastFeed)}`, { missOk: true }));
      if (entry !== null && entry.touched) {
        await io.send(probeAwayLine('Z', PROBE_AWAY_MM));
        await io.send('G90');
        throw new Stop(
          `the entry at the seeded centre (${fff(at)}) met material at machine Z ${f(entry.z)} — bore ${step.index} is not where the pin seeds it; check the pin and the stored centres`,
        );
      }
      await io.send('G90');
      const zMachine = r3(surfaceZ - find.entryDepthMm);
      const balls: Record<'x' | 'y', [number, number]> = { x: [0, 0], y: [0, 0] };
      for (const t of find.touches) {
        // #1199 — travel to the touch's start point at the CLEARANCE, then descend to the bore's
        // touch depth AT that point. The point is inside a mouth the entry seek has proved open;
        // the old order descended first and traversed at the depth.
        await io.send(`G53 G0 Z${f(ctx.seek.fromMachineZ)}`);
        await io.send(moveXY(ctx, t.from.x, t.from.y));
        await io.send(`G53 G0 Z${f(zMachine)}`);
        await io.idle();
        io.at(`sideways to the ${t.sign > 0 ? '+' : '−'}${t.axis.toUpperCase()} wall of bore ${step.index}, at machine Z ${f(zMachine)}`);
        await io.send('G91');
        const reply = await io.send(`G38.3 ${t.axis.toUpperCase()}${f4(t.travelMm)} F${f(s.touchFeed)}`, { missOk: true });
        const prb = lastPrb(reply);
        await io.send('G90');
        if (prb === null || !prb.touched) {
          await io.send(`G53 G0 Z${f(ctx.seek.fromMachineZ)}`);
          throw new Stop(
            `bore ${step.index} at the seeded centre (${fff(at)}) found no ${t.sign > 0 ? '+' : '−'}${t.axis.toUpperCase()} wall within ${f(find.searchMm)} mm — the pin is not where side 1 left it, or the bore is larger than the search`,
          );
        }
        await io.send('G91');
        await io.send(probeAwayLine(t.axis === 'x' ? 'X' : 'Y', t.travelMm < 0 ? find.releaseMm : -find.releaseMm));
        await io.send('G90');
        // The PRB is MACHINE XY; the work coordinate is it less the frame the moves ran in.
        const ball = r3((t.axis === 'x' ? prb.x : prb.y) - g54[t.axis]);
        io.saw({
          source: 'surface',
          label: `the ${t.sign > 0 ? '+' : '−'}${t.axis.toUpperCase()} wall of bore ${step.index}`,
          x: t.axis === 'x' ? ball : at.x,
          y: t.axis === 'x' ? at.y : ball,
          z: prb.z,
          touched: true,
          kind: 'stock',
        });
        if (t.axis === 'x') {
          if (t.sign > 0) balls.x[1] = ball;
          else balls.x[0] = ball;
        } else if (t.sign > 0) balls.y[1] = ball;
        else balls.y[0] = ball;
        await io.send(`G53 G0 Z${f(ctx.seek.fromMachineZ)}`);
      }
      const rx = readCentrePair('bore', 'x', balls.x[0], balls.x[1], find.ballRadiusMm);
      const ry = readCentrePair('bore', 'y', balls.y[0], balls.y[1], find.ballRadiusMm);
      holes.push({
        index: step.index,
        seeded: at,
        centre: { x: rx.centre, y: ry.centre },
        spans: [
          { axis: 'x', spanMm: rx.spanMm, diameterMm: rx.diameterMm },
          { axis: 'y', spanMm: ry.spanMm, diameterMm: ry.diameterMm },
        ],
      });
    }
    if (holes.length !== 2) throw new Stop('the flip plan does not state both bores — re-plan side 2');

    // ── THE TURN: the bores' line against the front pair's, inside the plan's own tolerance. ──
    const [a, b] = holes as [FlipHoleReading, FlipHoleReading];
    const measuredAngleDeg = (Math.atan2(b.centre.y - a.centre.y, b.centre.x - a.centre.x) * 180) / Math.PI;
    const cc = flip.crossCheck;
    let cross: { expectedAngleDeg: number; measuredAngleDeg: number; toleranceDeg: number };
    if (cc !== null) {
      const off = Math.abs(measuredAngleDeg - cc.expectedAngleDeg);
      const offWrap = Math.min(off, 360 - off);
      const toleranceDeg = r3(cc.angleToleranceDeg);
      cross = { expectedAngleDeg: cc.expectedAngleDeg, measuredAngleDeg: r3(measuredAngleDeg), toleranceDeg };
      if (offWrap > toleranceDeg) {
        throw new Stop(
          `the bores' line reads ${r3(measuredAngleDeg)}° against the ${cc.expectedAngleDeg}° the front pair expects — ${r3(offWrap)}° out, wider than the ${toleranceDeg}° two touch residuals allow. The part is turned; nothing more was measured`,
        );
      }
    } else {
      cross = { expectedAngleDeg: 0, measuredAngleDeg: r3(measuredAngleDeg), toleranceDeg: 0 };
    }

    // The origin: X from the bores' midpoint (the exact feature), Y from the front pair's mean —
    // both in the WORK frame the moves ran in. What the press writes is the G54 that puts those
    // measured features where the job's side-2 work frame says they are.
    const frontMeanY = r3(frontPair.reduce((sum, p) => sum + p.y, 0) / Math.max(1, frontPair.length));
    const pinMid = { x: r3((a.seeded.x + b.seeded.x) / 2), y: r3((a.seeded.y + b.seeded.y) / 2) };
    const measuredMid = { x: r3((a.centre.x + b.centre.x) / 2), y: r3((a.centre.y + b.centre.y) / 2) };
    const expectedFrontY = pairStep.scans[0]!.expectedAt;
    const origin = { x: measuredMid.x, y: frontMeanY };
    const correctedG54 = {
      x: r3(g54.x + (measuredMid.x - pinMid.x)),
      y: r3(g54.y + (frontMeanY - expectedFrontY)),
    };
    // The turn the front pair reads: its two found Ys over the line between their touches, in the
    // same convention `computeOutcome` states a side-1 stock's rotation.
    const alongPair = pairStep.scans[1]!.along - pairStep.scans[0]!.along;
    const slope = alongPair === 0 ? 0 : (frontPair[1]!.y - frontPair[0]!.y) / alongPair;
    const rotationDeg = r3((Math.atan(slope) * 180) / Math.PI);
    const rotationShiftMm = r3(Math.abs(slope) * (ctx.stock.xMax - ctx.stock.xMin));

    const diameterWord = (h: FlipHoleReading): string =>
      `bore ${h.index} reads ⌀${f(h.spans[0]!.diameterMm)} across X and ⌀${f(h.spans[1]!.diameterMm)} across Y`;
    const notes: string[] = [
      `the two bores side 1 left: ${diameterWord(a)}, ${diameterWord(b)} — both entered over their seeded centres and touched +X, −X, +Y, −Y`,
      cc === null
        ? 'the plan states no cross-check for the bores’ turn'
        : `the bores’ line reads ${r3(measuredAngleDeg)}° against the pins’ ${cc.expectedAngleDeg}° — inside the ${r3(cc.angleToleranceDeg)}° two touch residuals allow`,
      z0 === null || zBand === null
        ? 'no carried Z0 with a tolerance was stated, so the corner Z touches were not checked against one'
        : `the corner Z touches read ${frontPair.map((p) => `${f(p.surfaceZ)}`).join(' and ')} mm against the carried side-2 top ${f(z0.topMachineZ)} ± ${f(r3((zBand.maxMm - zBand.minMm) / 2))} mm — inside the band`,
      `the origin is the bores’ midpoint X and the front pair’s mean Y; the frame in force during the touches is the one this run corrects`,
    ];
    const problems: string[] = [];
    const outcome: RegistrationOutcome = {
      edges: [...frontRecs, seedRec].map((rec) => edgeFrom(rec, s.tipRadiusMm)),
      machineClearanceZ: ctx.machineClearanceZ,
      offset: { x: r3(correctedG54.x - g54.x), y: r3(correctedG54.y - g54.y) },
      measured: { x: true, y: true },
      centre: { ...origin },
      rotationDeg,
      rotationShiftMm,
      // The flip's own gates are the entry seek, the four walls, the bore's line and the carried
      // Z0 — all of them stops above. A returned outcome has therefore passed them, and the margin
      // this field names on a side-1 run (the deviation from the frame in force) is not a side-2
      // question: the frame IS what this measurement replaces.
      withinMargin: true,
      margin: s.edgeMarginMm,
      surfaceZ: r3(frontPair.reduce((sum, p) => sum + p.surfaceZ, 0) / Math.max(1, frontPair.length)),
      probeRefZ: r3(ref.z),
      seekFromMachineZ: ctx.seek.fromMachineZ,
      currentG54: g54,
      correctedG54,
      usable: problems.length === 0,
      problems,
      notes,
      xyChecked: true,
      flip: {
        holes: holes.map((h) => ({
          seeded: { ...h.seeded },
          centre: { ...h.centre },
          diameterMm: h.spans[0]!.diameterMm,
        })),
        frontPair: frontPair.map((p) => ({ ...p })),
        crossCheck: cc === null ? null : { ...cross },
        carried: z0 === null ? null : { topMachineZ: z0.topMachineZ, band: zBand === null ? null : { ...zBand } },
        rotationDeg,
        rotationShiftMm,
      },
    };
    return {
      ok: true,
      data: { probeRefZ: r3(ref.z), surface: surfacePrb, scans: [...frontRecs, seedRec] },
      outcome,
      mountTap: null,
      probe: { lengthZ: r3(ref.z), rest },
      frontPair,
      seedX,
      holes,
      origin,
      correctedG54,
      crossCheck: cross,
      surfaceZ,
      probeRefZ: r3(ref.z),
      transcript: io.transcript,
    };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: await io.stopped(e.message), transcript: io.transcript };
    throw e;
  } finally {
    if (powered) await io.trySend(PROBE_SUPPLY_OFF);
  }
}
