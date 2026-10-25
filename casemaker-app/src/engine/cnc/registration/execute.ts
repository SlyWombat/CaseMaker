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
 *      A scan whose FIRST touch misses the stock steps inward by the coarse step until it finds the
 *      stock (bounded by the opposite edge), then runs the outward fine pass (#593).
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
import type { ConsoleSendResult, ConsoleTiming } from '@/platform/machineConsole';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { facingRetouchTolerance } from '@/engine/cnc/stockStart';
import {
  assessSurfaceReadings,
  type SurfaceReading,
  type SurfaceSpreadAssessment,
  type SurfaceSpreadPlan,
} from '@/engine/cnc/engrave/surfaceSpread';
import { type EdgeScan, type RegistrationPlan, probeInstrumentOf } from './plan';
import { classifyTouch, lastPrb, type Prb } from './readings';
import { sideCentreWork, sideTouchAllowed, sideTouchSetup } from './probe3d';
import type { LiveTouch } from './liveTouch';
import { computeOutcome, correctionLine, type RegistrationOutcome, type RunData, type ScanRecord, type ScanTouch } from './outcome';
import { referenceOutcome } from './references';
import { settingsProblem, SURFACE_LIFT_MM, type RegistrationSettings } from './settings';

export interface RegistrationConsole {
  send(line: string, timing?: Partial<ConsoleTiming>): Promise<ConsoleSendResult>;
}

/**
 * The reply window for the `M491` two-touch macro (#563): the fast probe gap is ~13 s (108 mm at
 * F500), so the default 800 ms quiet would close the reply long before the slow `[PRB]` reading
 * lands. A longer quiet keeps the reader open across the probe moves.
 */
const PROBE_TIMING: Partial<ConsoleTiming> = { quietMs: 20_000 };

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
  /** #587 — the latest step narration, so the section shows what is running, not a blanket "Talking…". */
  onStep?: (sentence: string) => void;
  /**
   * #519 item 1 — each reading AS IT LANDS, so the viewport draws the touch and the dock lists it
   * while the run goes. Optional, and the executor never depends on a listener: a caller that omits
   * it gets exactly the behaviour it had (the readings still come back in `RunResult`).
   */
  onTouch?: (touch: LiveTouch) => void;
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

const f = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';
const r3 = (n: number) => Math.round(n * 1000) / 1000;

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
  /** How low the probe may be right now, in a sentence — set by each step that moves it down. */
  let depth = 'at a safe height';
  /** #588 — whether the run reached its own home step before it stopped. */
  let homed = false;

  async function send(line: string, opts: { missOk?: boolean; timing?: Partial<ConsoleTiming> } = {}): Promise<string> {
    const r = await deps.console.send(line, opts.timing);
    const reply = r.kind === 'sent' || r.kind === 'timeout' ? r.text : r.detail;
    const carried = r.kind === 'sent' || r.kind === 'timeout' ? (r.carried?.text ?? '') : '';
    transcript.push({ line, reply: carried ? `${reply}\n(between lines) ${carried}` : reply });
    if (r.kind !== 'sent') throw new Stop(`${line}: ${r.kind} — ${reply}`);
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
      const r = await deps.console.send('?');
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
    if (relative) {
      for (const line of inAlarm ? ['$X', 'G90'] : ['G90']) {
        try {
          const r = await deps.console.send(line);
          transcript.push({ line, reply: r.kind === 'sent' ? r.text : r.kind });
        } catch {
          break;
        }
      }
    }
    // #588 — the recovery advice is only true when the machine is actually in alarm. A G38.3 miss is
    // a READING, not an alarm (#518), so a clean stop must not tell a beginner to clear an alarm that
    // is not there; a run that reached its own home step has nothing to recover at all.
    if (homed) return `${reason}. Stopped — the probe may be ${depth}. Homed; nothing to recover.`;
    if (inAlarm) {
      return (
        `${reason}. Stopped — the probe may be ${depth}, and the machine may be in alarm. ` +
        `To recover: $X, then G90, then lift with G53 G0 Z${f(seekFromMachineZ)} before any XY move.`
      );
    }
    return `${reason}. Stopped — the probe may be ${depth}. The machine is Idle; nothing to recover.`;
  }

  return { send, idle, stopped, at, saw, markHomed: () => { homed = true; }, transcript };
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
  const probe = (p: number, travelHigh = false) => touch(io, plan, scan, p, parkZ, surfaceZ, travelHigh);
  // The known-on coordinate along this scan's axis: the surface touch answered there a moment ago.
  const surfaceCoord = scan.edge === 'left' || scan.edge === 'right' ? plan.surfacePoint.x : plan.surfacePoint.y;

  const start = await probe(scan.start, plan.mount === 'bracket');
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
 * #525 — one SIDEWAYS edge scan with the 3D probe: a lift (at the bracket's travel height), the move
 * to the plan's outward limit, down to the touch depth and ONE horizontal `G38.3` inward — then back
 * up. `probe3d.ts` owns the line, the depth (kept clear of the vise's ledge) and the ball's offset;
 * this only sends and records the reading the same way the Z touch does, so the outcome's edge, the
 * viewport's dot and the dock's row all come from one reading.
 *
 * Only called for an edge `sideTouchAllowed` accepts: a vise's X edges are the jaws' own faces and
 * keep the Z-only scan (`scanEdge`), because a sideways approach there would drive the ball into a
 * jaw bar.
 */
async function scanEdgeSideways(
  io: Session,
  plan: RegistrationPlan,
  scan: EdgeScan,
  surfaceZ: number,
  sentFrom: { x: number; y: number },
): Promise<ScanRecord> {
  const tip = plan.probe?.tip ?? null;
  // The planner refuses an unmeasured probe before any of this; a plan that reached here without one
  // has been edited, and a sideways correction cannot be guessed.
  if (tip === null) throw new Stop('the 3D probe has no measured tip — measure it (Manage › Accessories) and plan again');
  const s = plan.settings;
  const setup = sideTouchSetup(scan, plan, s, tip.rimOffsetMm, surfaceZ);
  if (!setup.ok) throw new Stop(setup.reason);
  const t = setup.touch;
  const what = scan.label ?? `the ${scan.edge} edge`;
  if (plan.mount === 'bracket') await io.send(`G53 G0 Z${f(plan.seek.fromMachineZ)}`);
  await io.send(moveXY(plan, t.x, t.y));
  await io.send(`G53 G0 Z${f(setup.zMachine)}`);
  await io.idle();
  io.at(`sideways toward ${what}, at machine Z ${f(setup.zMachine)}`);
  await io.send('G91');
  const reply = await io.send(t.line);
  const prb = lastPrb(reply);
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

/** A surface reading inside the band, or a stop that says where it landed. */
function inBand(prb: Prb | null, band: SurfaceBand, which: string, maxZ: number = band.max): Prb {
  if (prb === null || !prb.touched) {
    throw new Stop(`the ${which} surface touch found nothing down to machine Z ${band.min} — ${band.expect}`);
  }
  // #619 — a reading ABOVE the band is not a miss on the datum path: a normally mounted blank may
  // stand prouder than the ledge estimate, so the upper bound is widened; only the floor still stops.
  if (prb.z < band.min || prb.z > maxZ) {
    throw new Stop(`the ${which} surface touch read machine Z ${prb.z}, outside the expected ${band.min} to ${maxZ}`);
  }
  return prb;
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
 */
async function seekSurface(
  io: Session,
  plan: RegistrationPlan,
  band: SurfaceBand,
  point: { x: number; y: number } = plan.surfacePoint,
  fromMachineZ: number = plan.seek.fromMachineZ,
): Promise<Prb> {
  const s = plan.settings;
  // #619 — the datum path accepts a surface up to the jaw top + the stock's full thickness + tolerance:
  // a normally mounted blank may not sit on the ledge, and a higher reading is the stock, not a miss.
  const datumMax =
    plan.mountDatum !== null && plan.stockThicknessMm !== undefined
      ? plan.mountDatum.jawTopZ + plan.stockThicknessMm + s.surfaceToleranceMm
      : band.max;
  const travel = Math.round((fromMachineZ - band.min) * 1000) / 1000;
  await io.send(`G53 G0 Z${f(fromMachineZ)}`);
  await io.send('G90');
  await io.send(moveXY(plan, point.x, point.y));
  await io.idle();
  io.at(band.at);
  await io.send('G91');
  inBand(lastPrb(await io.send(`G38.3 Z-${f(travel)} F${f(s.surfaceFastFeed)}`)), band, 'fast', datumMax);
  await io.send(`G0 Z${f(SURFACE_LIFT_MM)}`);
  await io.idle();
  io.at(`as low as ${f(s.surfaceSlowSeekMm - SURFACE_LIFT_MM)} mm below the fast touch's reading (the slow surface touch)`);
  const slow = inBand(lastPrb(await io.send(`G38.3 Z-${f(s.surfaceSlowSeekMm)} F${f(s.surfaceSlowFeed)}`)), band, 'slow', datumMax);
  await io.send('G90');
  return slow;
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
  seekFromMachineZ: number,
  settings: RegistrationSettings,
  floorZ: number,
  /** #615 — the machine Z the touch expects to meet, or null to descend the full height at the touch feed. */
  expectZ: number | null = null,
): Promise<Prb | null> {
  await io.idle();
  await io.send(`G53 G0 Z${f(seekFromMachineZ)}`);
  await io.send(`G53 G0 X${f(tap.x)} Y${f(tap.y)}`);
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
  tap: { x: number; y: number },
  seekFromMachineZ: number,
  settings: RegistrationSettings,
  deps: ExecDeps,
  workEnvelopeFloorZ: number,
  /** #607 — which mount's reference this is, for the miss sentence. The vise is the default. */
  mount: 'vise' | 'bracket' = 'vise',
): Promise<MountTapResult> {
  const io = session(deps, seekFromMachineZ, settings.idlePollLimit);
  const bad = settingsProblem(settings);
  if (bad !== null) return { ok: false, reason: `nothing was sent: ${bad}`, transcript: [] };
  try {
    const status = await io.send('?');
    if (controllerState(status) !== 'Idle') throw new Stop(`the machine reads ${controllerState(status) ?? 'no state'}, not Idle`);
    await io.send('$H');
    if (!(await deps.operator({ kind: 'fit-probe', text: 'Fit the wired probe in the spindle, then continue.' }))) {
      throw new Stop('stopped: the probe was not fitted');
    }
    const rest = await io.send('M119');
    if (/Probe:\s*1\b/.test(rest)) throw new Stop('the probe reads touched at rest; check it is seated and plugged in');
    const ref = lastPrb(await io.send('M491', { timing: PROBE_TIMING }));
    if (ref === null || !ref.touched) throw new Stop('M491 answered no tool-length reading');
    const prb = await mountTapTouch(io, tap, seekFromMachineZ, settings, workEnvelopeFloorZ);
    if (prb === null || !prb.touched) {
      // The vise's sentence is the bench-tested one and stays byte for byte; the others name their
      // own reference the way the operator sees it.
      const what = mount === 'vise' ? 'jaw top' : 'bracket top';
      throw new Stop(`no ${what} at (${tap.x}, ${tap.y}) down to machine Z ${f(workEnvelopeFloorZ)} — is the ${mount} where the machine record says?`);
    }
    // #519 item 1 — the standalone tap's reading, as it lands.
    io.saw({ source: 'mount-tap', label: null, x: tap.x, y: tap.y, z: prb.z, touched: prb.touched, kind: null });
    await io.send('$H');
    return { ok: true, z: prb.z, at: { x: tap.x, y: tap.y }, probe: { lengthZ: ref.z, rest }, transcript: io.transcript };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: await io.stopped(e.message), transcript: io.transcript };
    throw e;
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
    // #599 — the probe must read OPEN (untouched) at rest: a touched reading before anything moves
    // means the plug is bad or wired wrong (the Carvera firmware halts PROBE_FAIL on exactly this).
    const rest = await io.send('M119');
    if (/Probe:\s*1\b/.test(rest)) {
      throw new Stop('the probe reads touched at rest; check it is seated and plugged in');
    }
    const ref = lastPrb(await io.send('M491', { timing: PROBE_TIMING }));
    if (ref === null || !ref.touched) throw new Stop('M491 answered no tool-length reading');
    if (plan.mount === 'bracket' && !(await deps.operator({ kind: 'confirm-mount', text: mountConfirmText(plan) }))) {
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
    if (plan.mountTap !== null && tapExpectZ !== null) {
      const tap = plan.mountTap;
      const floorZ = tapExpectZ - MOUNT_TAP_FLOOR_MM;
      const prb = await mountTapTouch(io, { x: tap.x, y: tap.y }, plan.seek.fromMachineZ, s, floorZ, tapExpectZ);
      if (prb === null || !prb.touched || Math.abs(prb.z - tapExpectZ) > MOUNT_TAP_SLACK_MM) {
        throw new Stop(
          tap.reference === undefined || tap.reference === 'vise-jaw-top'
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
    const slow = await seekSurface(io, plan, {
      ...plan.seek.band,
      at: `as low as machine Z ${plan.seek.band.min}, ${s.surfaceToleranceMm} mm below the expected surface (the surface seek)`,
      expect: 'the stock is not where the job expects it',
    });
    // #519 item 1 — the surface touch, at the plan's own point.
    io.saw({
      source: 'surface',
      label: null,
      x: plan.surfacePoint.x,
      y: plan.surfacePoint.y,
      z: slow.z,
      touched: slow.touched,
      kind: null,
    });

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
    // #525 — the 3D probe touches edges SIDEWAYS where the mount allows it (the free front/back
    // edges on a vise; every edge on the bracket/tape). The jaws block an X approach on a vise, so
    // those edges keep the Z-only bracket-and-bisect the wired probe uses — the 3D probe triggers
    // downward too, and the frame's fixed-jaw face is what the left edge confirms.
    const g54 = { x: r3(slow.x - plan.surfacePoint.x), y: r3(slow.y - plan.surfacePoint.y) };
    for (const scan of plan.scans) {
      scans.push(
        probeInstrumentOf(plan.probe) === 'xyz' && sideTouchAllowed(plan.mount, scan.edge)
          ? await scanEdgeSideways(io, plan, scan, slow.z, g54)
          : await scanEdge(io, plan, scan, parkZ, slow.z),
      );
    }

    const data: RunData = { probeRefZ: ref.z, surface: slow, scans };
    // A plan that registers on earlier-setup features has its own outcome (#429); #430's is unchanged.
    const outcome = plan.references ? referenceOutcome(plan, data) : computeOutcome(plan, data);
    if (proudNote !== null) outcome.notes.push(proudNote);

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
    if (spreadPlan !== undefined) {
      const lowApproach = plan.mountObstacles.length === 0;
      const approachZ = Math.round((plan.seek.band.max + s.parkAboveSurfaceMm) * 1000) / 1000;
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
                expect: `${touch.at} is more than ${s.surfaceToleranceMm} mm lower than the centre (${f(slow.z)}) — the blank is not sitting flat; loosen the vise, press it down on that side, re-clamp, and run again`,
              },
              { x: touch.x + outcome.offset.x, y: touch.y + outcome.offset.y },
              lowApproach ? approachZ : plan.seek.fromMachineZ,
            );
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
    await io.send('$H');
    io.markHomed();

    // #475/#608/#631 — the spread verdict. Z0 is the LOWEST touch (the colour line is a plane and
    // the dome is extra top material), so the outcome carries it for flat, tilt AND dome alike. A
    // tilt that fits a plane is followed by the re-posted program; a dome (residual wider than the
    // band) no longer refuses — the origin is still written and the machine levels the top itself.
    let spread: SurfaceSpreadAssessment | undefined;
    if (spreadPlan !== undefined) {
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
    const ref = lastPrb(await io.send('M491', { timing: PROBE_TIMING }));
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
