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
 *   4. The surface at the plan's clean point, from the plan's seek height (`seek.fromMachineZ`): a fast `G38.3` that travels only to the
 *      expected surface − tolerance, `G0 Z1`, a slow `G38.3`. BOTH readings must land inside the
 *      expected surface ± tolerance, or the run stops. The probe then PARKS at surface + park.
 *   5. Each edge scan, touch by touch, every XY move AT THE PARK HEIGHT: `G0 X Y`, `?` until Idle,
 *      `G91`, `G38.3 Z-(park + cap)` — so a touch can never go below the surface − cap — `G90`, the
 *      lift to park. Coarse, then fine; the scan stops at the first touch off the stock, then takes
 *      ONE touch midway back toward the stock to halve the last step (never further out than the miss).
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
 * THE CUT-EXTENT SPREAD (#475) is an optional half of {@link runRegistration}: after the
 * registration point, the same `seekSurface` measures the plan's cut-extent touch points, the
 * readings are assessed against the depth band (`assessSurfaceReadings`), Z0 becomes the LOWEST
 * touch, and a spread wider than the band makes the outcome unusable with the `blank-bowed`
 * refusal. The touches stay inside the registration's own validated seek band, so the #430 cap and
 * tolerance hold unchanged.
 */

import { controllerState } from '@/platform/machineUpload';
import type { ConsoleSendResult } from '@/platform/machineConsole';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { facingRetouchTolerance } from '@/engine/cnc/stockStart';
import {
  assessSurfaceReadings,
  type SurfaceReading,
  type SurfaceSpreadAssessment,
  type SurfaceSpreadPlan,
} from '@/engine/cnc/engrave/surfaceSpread';
import { scanPositions, type EdgeScan, type RegistrationPlan } from './plan';
import { classifyTouch, lastPrb, type Prb } from './readings';
import { computeOutcome, correctionLine, type RegistrationOutcome, type RunData, type ScanRecord, type ScanTouch } from './outcome';
import { referenceOutcome } from './references';
import { settingsProblem, SURFACE_LIFT_MM } from './settings';

export interface RegistrationConsole {
  send(line: string): Promise<ConsoleSendResult>;
}

export type OperatorStep = { kind: 'fit-probe' | 'fit-cutter' | 'confirm-mount'; text: string };

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
      transcript: Transcript[];
    }
  | { ok: false; reason: string; transcript: Transcript[] };

/**
 * How many `?` polls to wait for Idle before a probe — each is a round trip of about a second. The
 * labelled NO-SERVICE FALLBACK only: the run uses the plan's `registration.idlePollLimit` (#449).
 */
export const MAX_IDLE_POLLS = 30;

const f = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';

class Stop extends Error {}

/**
 * One machine conversation, stopping at the first answer it did not expect. `seekFromMachineZ` is
 * REQUIRED: it is the height the recovery sentence tells the operator to lift to (the resolved
 * machine's `toolChange.clearanceZ`), and a forgotten argument must be a typecheck error, never a
 * silent −3 that could send the head somewhere the machine does not call clear.
 */
function session(deps: ExecDeps, seekFromMachineZ: number, idlePollLimit: number = MAX_IDLE_POLLS) {
  // A bounded wait whatever the location says: a whole number of polls, at least one (#449).
  const idlePolls = Number.isInteger(idlePollLimit) && idlePollLimit >= 1 ? idlePollLimit : MAX_IDLE_POLLS;
  const transcript: Transcript[] = [];
  let relative = false;
  /** Whether the last answer left the machine in alarm (a miss before its `$X`, or any alarm). */
  let alarmed = false;
  /** How low the probe may be right now, in a sentence — set by each step that moves it down. */
  let depth = 'at a safe height';

  async function send(line: string, opts: { missOk?: boolean } = {}): Promise<string> {
    const r = await deps.console.send(line);
    const reply = r.kind === 'sent' || r.kind === 'timeout' ? r.text : r.detail;
    const carried = r.kind === 'sent' || r.kind === 'timeout' ? (r.carried?.text ?? '') : '';
    transcript.push({ line, reply: carried ? `${reply}\n(between lines) ${carried}` : reply });
    if (r.kind !== 'sent') throw new Stop(`${line}: ${r.kind} — ${reply}`);
    if (/ALARM/i.test(reply) || /ALARM/i.test(carried)) alarmed = true;
    if (line === '$X') alarmed = false;
    for (const text of [reply, carried]) {
      if (/\berror:/i.test(text)) throw new Stop(`${line}: the controller answered ${text.trim()}`);
      const alarm = /ALARM[^\n]*/i.exec(text)?.[0];
      if (alarm && !(opts.missOk && text === reply && /Probe fail/i.test(alarm))) throw new Stop(`${line}: ${alarm.trim()}`);
    }
    if (line === 'G91') relative = true;
    if (line === 'G90') relative = false;
    return reply;
  }

  /** `?` until the machine reads Idle; stop if it never does. */
  async function idle(): Promise<void> {
    for (let i = 0; i < idlePolls; i++) {
      const state = controllerState(await send('?'));
      if (state === 'Idle') return;
    }
    throw new Stop(`the machine did not read Idle in ${idlePolls} status polls`);
  }

  /** Say how low the probe may be from here on (the stop message uses the latest). */
  function at(sentence: string): void {
    depth = sentence;
  }

  /**
   * After a stop: if the mode was left relative, put it back — `$X` FIRST, because the Z1 refuses `G90`
   * with `error:Alarm lock` while in alarm (Z1-Firmware-Dialect.md, the 2026-10-08 table) — and say
   * how low the probe may be and how to recover. Nothing else is sent.
   */
  async function stopped(reason: string): Promise<string> {
    if (relative) {
      for (const line of alarmed || /ALARM|timeout/i.test(reason) ? ['$X', 'G90'] : ['G90']) {
        try {
          const r = await deps.console.send(line);
          transcript.push({ line, reply: r.kind === 'sent' ? r.text : r.kind });
        } catch {
          break;
        }
      }
    }
    return (
      `${reason}. Stopped — the probe may be ${depth}, and the machine may be in alarm. ` +
      `To recover: $X, then G90, then lift with G53 G0 Z${f(seekFromMachineZ)} before any XY move.`
    );
  }

  return { send, idle, stopped, at, transcript };
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

/**
 * One scan touch at `at`: XY at the park height, Idle, probe down at most to the cap, clear a miss, lift.
 * `travelHigh` (#427): the move that STARTS a scan on the bracket goes at the seek height (the plan's
 * `seek.fromMachineZ`) and only then down to the park — the clamps and the bracket's arms stand above the
 * stock, higher than the park, and the move between two scan lines (or from the surface point) is not
 * checked against them.
 * The touches ALONG a scan line stay at the park: the line itself is kept clear of the clamps.
 */
async function touch(io: Session, plan: RegistrationPlan, scan: EdgeScan, at: number, parkZ: number, surfaceZ: number, travelHigh = false): Promise<ScanTouch> {
  const s = plan.settings;
  const [x, y] = scan.edge === 'left' || scan.edge === 'right' ? [at, scan.along] : [scan.along, at];
  if (travelHigh) await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
  await io.send(moveXY(plan, x, y));
  if (travelHigh) await io.send(`G53 G0 Z${f(parkZ)}`);
  await io.idle();
  io.at(`as low as ${s.capBelowSurfaceMm} mm below the surface (a scan touch)`);
  await io.send('G91');
  const reply = await io.send(`G38.3 Z-${f(s.parkAboveSurfaceMm + s.capBelowSurfaceMm)} F${f(s.touchFeed)}`, { missOk: true });
  const prb = lastPrb(reply);
  if (prb === null) throw new Stop(`the touch at ${f(x)}, ${f(y)} answered no probe reading`);
  // A miss under G38.3 is a reading, not an alarm (#518): nothing to clear.
  await io.send('G90');
  await io.send(`G53 G0 Z${f(parkZ)}`);
  io.at(`at the park height, ${s.parkAboveSurfaceMm} mm above the surface`);
  return { at, prb, kind: classifyTouch(prb, surfaceZ, s.surfaceBandMm) };
}

/** One pass outward; it STOPS at the first touch off the stock, then halves the last step inward. */
async function scanEdge(io: Session, plan: RegistrationPlan, scan: EdgeScan, parkZ: number, surfaceZ: number): Promise<ScanRecord> {
  const touches: ScanTouch[] = [];
  let lastOn: number | null = null;
  for (const p of scanPositions(scan)) {
    const t = await touch(io, plan, scan, p, parkZ, surfaceZ, plan.mount === 'bracket' && touches.length === 0);
    touches.push(t);
    if (t.kind !== 'stock') {
      // Something above the surface (a clamp): stop the scan here and say so (outcome.ts) — unless the
      // plan says a high reading on this scan is the jaw past a recessed stock (#517), the edge itself.
      if ((t.kind !== 'above' || scan.aboveIsEdge === true) && lastOn !== null) {
        const mid = Math.round(((lastOn + p) / 2) * 1000) / 1000;
        touches.push(await touch(io, plan, scan, mid, parkZ, surfaceZ));
      }
      break;
    }
    lastOn = p;
  }
  return { scan, touches };
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

/** A surface reading inside the band, or a stop that says where it landed. */
function inBand(prb: Prb | null, band: SurfaceBand, which: string): Prb {
  if (prb === null || !prb.touched) {
    throw new Stop(`the ${which} surface touch found nothing down to machine Z ${band.min} — ${band.expect}`);
  }
  if (prb.z < band.min || prb.z > band.max) {
    throw new Stop(`the ${which} surface touch read machine Z ${prb.z}, outside the expected ${band.min} to ${band.max}`);
  }
  return prb;
}

/**
 * The surface seek: from the plan's travel height down to the band's floor and no further — a fast
 * `G38.3`, `G0 Z1`, a slow `G38.3`, BOTH readings inside the band — then `G90` at the reading. The
 * registration and the post-facing re-touch share it, so the two seeks cannot drift apart.
 */
async function seekSurface(
  io: Session,
  plan: RegistrationPlan,
  band: SurfaceBand,
  point: { x: number; y: number } = plan.surfacePoint,
): Promise<Prb> {
  const s = plan.settings;
  const travel = Math.round((plan.seek.fromMachineZ - band.min) * 1000) / 1000;
  await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
  await io.send('G90');
  await io.send(moveXY(plan, point.x, point.y));
  await io.idle();
  io.at(band.at);
  await io.send('G91');
  inBand(lastPrb(await io.send(`G38.3 Z-${f(travel)} F${f(s.surfaceFastFeed)}`)), band, 'fast');
  await io.send(`G0 Z${f(SURFACE_LIFT_MM)}`);
  await io.idle();
  io.at(`as low as ${f(s.surfaceSlowSeekMm - SURFACE_LIFT_MM)} mm below the fast touch's reading (the slow surface touch)`);
  const slow = inBand(lastPrb(await io.send(`G38.3 Z-${f(s.surfaceSlowSeekMm)} F${f(s.surfaceSlowFeed)}`)), band, 'slow');
  await io.send('G90');
  return slow;
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
  const io = session(deps, plan.seek.fromMachineZ, plan.settings.idlePollLimit);
  const s = plan.settings;
  // #449 — the settings are the location's; a set that cannot make a capped touch sends nothing at all.
  const bad = settingsProblem(s);
  if (bad !== null) return { ok: false, reason: `nothing was sent: ${bad}`, transcript: [] };
  try {
    const status = await io.send('?');
    if (controllerState(status) !== 'Idle') throw new Stop(`the machine reads ${controllerState(status) ?? 'no state'}, not Idle`);
    await io.send('$H');
    await io.send('G54');
    await io.send('G92.1');
    if (!(await deps.operator({ kind: 'fit-probe', text: 'Fit the wired probe in the spindle, then continue.' }))) {
      throw new Stop('stopped: the probe was not fitted');
    }
    const ref = lastPrb(await io.send('M491'));
    if (ref === null || !ref.touched) throw new Stop('M491 answered no tool-length reading');
    if (plan.mount === 'bracket' && !(await deps.operator({ kind: 'confirm-mount', text: mountConfirmText(plan) }))) {
      throw new Stop('stopped: the clamps were not confirmed where the plan puts them');
    }

    // #449 — the slow travel is the shop's `registration.surfaceSlowSeekMm` (1.2 to 2 mm, more than the
    // lift); a plan whose settings break that never got this far (`settingsProblem`).
    const slow = await seekSurface(io, plan, {
      ...plan.seek.band,
      at: `as low as machine Z ${plan.seek.band.min}, ${s.surfaceToleranceMm} mm below the expected surface (the surface seek)`,
      expect: 'the stock is not where the job expects it',
    });

    // #475 — the cut extents. Each planned touch is a full, bounded surface seek at its own XY,
    // inside the SAME band the registration point was checked against (#430's cap and tolerance):
    // a reading outside it stops the run rather than quietly widening the measurement. The plan's
    // first point is the cut area's centre, which is normally the registration point itself — that
    // reading is reused, so the blank is not touched twice in the same spot.
    const spreadReadings: SurfaceReading[] = [];
    if (spreadPlan !== undefined) {
      for (const touch of spreadPlan.touches) {
        const samePoint =
          Math.abs(touch.x - plan.surfacePoint.x) < 1e-6 && Math.abs(touch.y - plan.surfacePoint.y) < 1e-6;
        const prb = samePoint
          ? slow
          : await seekSurface(
              io,
              plan,
              {
                ...plan.seek.band,
                at: `as low as machine Z ${plan.seek.band.min}, ${s.surfaceToleranceMm} mm below the expected surface (the surface touch at ${touch.at})`,
                expect: 'the stock is not where the job expects it',
              },
              { x: touch.x, y: touch.y },
            );
        spreadReadings.push({ z: prb.z, source: 'probe' });
      }
    }

    const parkZ = slow.z + s.parkAboveSurfaceMm;
    await io.send(`G53 G0 Z${f(parkZ)}`);
    io.at(`at the park height, ${s.parkAboveSurfaceMm} mm above the surface`);

    const scans: ScanRecord[] = [];
    for (const scan of plan.scans) scans.push(await scanEdge(io, plan, scan, parkZ, slow.z));

    await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
    await io.send('$H');
    const data: RunData = { probeRefZ: ref.z, surface: slow, scans };
    // A plan that registers on earlier-setup features has its own outcome (#429); #430's is unchanged.
    const outcome = plan.references ? referenceOutcome(plan, data) : computeOutcome(plan, data);

    // #475 — the spread verdict. Z0 is the LOWEST touch (the colour line is a plane and the dome is
    // extra top material), so the outcome carries it even when the blank is refused; a refusal also
    // makes the measurement unusable, which stops `applyCorrection` writing an origin from it.
    let spread: SurfaceSpreadAssessment | undefined;
    if (spreadPlan !== undefined) {
      spread = assessSurfaceReadings(spreadPlan, spreadReadings);
      outcome.surfaceZ = spread.z0.z;
      if (!spread.ok && spread.refusal !== null) {
        outcome.usable = false;
        outcome.problems.push(spread.refusal.message);
      }
    }
    return {
      ok: true,
      data,
      outcome,
      ...(spread === undefined ? {} : { spread }),
      transcript: io.transcript,
    };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: await io.stopped(e.message), transcript: io.transcript };
    throw e;
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
  const io = session(deps, plan.seek.fromMachineZ, plan.settings.idlePollLimit);
  try {
    const status = await io.send('?');
    if (controllerState(status) !== 'Idle') throw new Stop(`the machine reads ${controllerState(status) ?? 'no state'}, not Idle`);
    await io.send('$H');
    await io.send('G54');
    await io.send('G92.1');
    if (
      !(await deps.operator({
        kind: 'fit-probe',
        text: 'Fit the wired probe again: the faced top is measured before the engraving file is posted from it.',
      }))
    ) {
      throw new Stop('stopped: the probe was not fitted');
    }
    const surface = await seekSurface(io, plan, {
      min,
      max,
      at: `as low as machine Z ${min}, ${opts.toleranceMm} mm below the faced top expected at ${expected} (the re-touch)`,
      expect: 'the faced top is not where the skim should have put it — check that the facing program ran before the re-touch',
    });
    await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
    await io.send('$H');
    return { ok: true, surface, outcome: { ...outcome, surfaceZ: surface.z }, transcript: io.transcript };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: await io.stopped(e.message), transcript: io.transcript };
    throw e;
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
     * whole point of the `M491` below is to calibrate the cutter the next program runs. Omitted on
     * the registration path, whose sentence stays the generic one.
     */
    cutter?: string;
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
    await io.send('$H');
    const fit =
      consent.cutter === undefined
        ? 'Take the probe out, fit the cutter, then continue.'
        : `Take the probe out, fit the ENGRAVING cutter — ${consent.cutter} — not the facing cutter, then continue.`;
    if (!(await deps.operator({ kind: 'fit-cutter', text: fit }))) {
      throw new Stop('stopped: the cutter was not fitted');
    }
    const ref = lastPrb(await io.send('M491'));
    if (ref === null || !ref.touched) throw new Stop('M491 answered no tool-length reading for the cutter');
    const line = correctionLine(outcome, ref.z);
    await io.send(line);
    await io.send('$H');
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
    { confirmed: consent.confirmed, cutter: opts.engravingCutter },
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
