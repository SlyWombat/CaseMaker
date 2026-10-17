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
 *   4. The surface at the plan's clean point, from the plan's seek height (`seek.fromMachineZ`): a fast `G38.2` that travels only to the
 *      expected surface − tolerance, `G0 Z1`, a slow `G38.2`. BOTH readings must land inside the
 *      expected surface ± tolerance, or the run stops. The probe then PARKS at surface + park.
 *   5. Each edge scan, touch by touch, every XY move AT THE PARK HEIGHT: `G0 X Y`, `?` until Idle,
 *      `G91`, `G38.2 Z-(park + cap)` — so a touch can never go below the surface − cap — `$X` after a
 *      miss, `G90`, the lift to park. Coarse, then fine; the scan stops at the first touch off the
 *      stock, then takes ONE touch midway back toward the stock to halve the last step (never further
 *      out than the miss).
 *   6. Lift to the plan's seek height (`G53 G0 Z` — the resolved machine's `toolChange.clearanceZ`) and
 *      `$H`.
 *
 * `?` IS POLLED UNTIL IDLE BEFORE EVERY `G38.2`, as the bench did: a probe sent while a move is still
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
 */

import { controllerState } from '@/platform/machineUpload';
import type { ConsoleSendResult } from '@/platform/machineConsole';
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
  | { ok: true; data: RunData; outcome: RegistrationOutcome; transcript: Transcript[] }
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
  const reply = await io.send(`G38.2 Z-${f(s.parkAboveSurfaceMm + s.capBelowSurfaceMm)} F${f(s.touchFeed)}`, { missOk: true });
  const prb = lastPrb(reply);
  if (prb === null) throw new Stop(`the touch at ${f(x)}, ${f(y)} answered no probe reading`);
  if (!prb.touched) await io.send('$X');
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
      // Something above the surface (a clamp): stop the scan here and say so (outcome.ts).
      if (t.kind !== 'above' && lastOn !== null) {
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
 * `G38.2`, `G0 Z1`, a slow `G38.2`, BOTH readings inside the band — then `G90` at the reading. The
 * registration and the post-facing re-touch share it, so the two seeks cannot drift apart.
 */
async function seekSurface(io: Session, plan: RegistrationPlan, band: SurfaceBand): Promise<Prb> {
  const s = plan.settings;
  const travel = Math.round((plan.seek.fromMachineZ - band.min) * 1000) / 1000;
  await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
  await io.send('G90');
  await io.send(moveXY(plan, plan.surfacePoint.x, plan.surfacePoint.y));
  await io.idle();
  io.at(band.at);
  await io.send('G91');
  inBand(lastPrb(await io.send(`G38.2 Z-${f(travel)} F${f(s.surfaceFastFeed)}`)), band, 'fast');
  await io.send(`G0 Z${f(SURFACE_LIFT_MM)}`);
  await io.idle();
  io.at(`as low as ${f(s.surfaceSlowSeekMm - SURFACE_LIFT_MM)} mm below the fast touch's reading (the slow surface touch)`);
  const slow = inBand(lastPrb(await io.send(`G38.2 Z-${f(s.surfaceSlowSeekMm)} F${f(s.surfaceSlowFeed)}`)), band, 'slow');
  await io.send('G90');
  return slow;
}

export async function runRegistration(plan: RegistrationPlan, deps: ExecDeps): Promise<RunResult> {
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
    const parkZ = slow.z + s.parkAboveSurfaceMm;
    await io.send(`G53 G0 Z${f(parkZ)}`);
    io.at(`at the park height, ${s.parkAboveSurfaceMm} mm above the surface`);

    const scans: ScanRecord[] = [];
    for (const scan of plan.scans) scans.push(await scanEdge(io, plan, scan, parkZ, slow.z));

    await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
    await io.send('$H');
    const data: RunData = { probeRefZ: ref.z, surface: slow, scans };
    // A plan that registers on earlier-setup features has its own outcome (#429); #430's is unchanged.
    return { ok: true, data, outcome: plan.references ? referenceOutcome(plan, data) : computeOutcome(plan, data), transcript: io.transcript };
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
  consent: { confirmed: boolean },
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
    if (!(await deps.operator({ kind: 'fit-cutter', text: 'Take the probe out, fit the cutter, then continue.' }))) {
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
