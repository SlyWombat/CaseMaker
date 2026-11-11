// #1199 — THE SAFE-Z INVARIANT, one guard every probing session shares.
//
// The bench's 2026-11-10 seat press (build c8fa03a6) sent, at home, `G53 G0 Z-81.25` and then a
// 177 mm `G53 G0 X-175 Y-35`: the traverse ran 7 mm above the board, below the blank's top and the
// clamp, and bent fx-probe-1's shaft. The height was right for the DESCENT — the band's approach —
// but a traverse must never be taken there.
//
// THE RULE IS STRUCTURAL AND DENY-BY-DEFAULT, so a future routine cannot skip it. Every line is
// classified by its WORDS, not by a G-prefix shape:
//
//   - a line carrying X, Y or A (with or without Z) is a TRAVERSE: it may go out only from the
//     machine's clearance (proven, see below) or above;
//   - a line carrying X/Y/A AND Z together must ALSO keep its own Z at or above the clearance —
//     a diagonal into a low Z is the same crash split differently, so it is refused and the caller
//     must split it into a traverse and a descent;
//   - modal continuations (no G word: `X10 Y10` after a G0), `G00`/`G01` spellings, `G1`/`G0`
//     and `G53 G0` are all handled — nothing is allowed because it failed to match a shape;
//   - a motion-bearing line of any other recognised-or-not G code is REFUSED (arcs included);
//   - `G10` offset writes and `G92`/`G92.1` set NO machine position and are exempt;
//   - `G38.3` X/Y is a lateral PROBE (not a traverse): it may be refused separately when the unit
//     allows top touches only (#1200), and it never changes Z;
//   - `G38.3 Z` carries its trigger height from the reply, so the next XY move must lift first;
//   - `G38.5` (probe away) is not parsed: it keeps the conservative state it was sent in, which is
//     safe — a release never moves the head closer to the work than the probe left it.
//
// ONLY `G53` STATES A MACHINE Z. A work-coordinate `G0 Z…` says nothing about the machine (the work
// zero may sit tens of millimetres down), so it makes the Z UNKNOWN — conservative on purpose.
//
// THE CLEARANCE IS THE MACHINE'S, NEVER THE PLAN'S. `session()` passes `toolChange.clearanceZ` (the
// resolved machine), not a plan's travel height: a plan that states a band approach as its travel
// height would otherwise hand the guard a floor of −81.25 and wave the accident through.

import { lastPrb } from './readings';
import { topTouchEdgeMarginsMm } from './cutBlank';
import type { EdgeScan, RegistrationPlan } from './plan';

export interface MotionOrderGuardOptions {
  /**
   * #1200 — whether this session's probe may touch SIDEWAYS. Defaults to true; a unit whose socket
   * is only trusted straight down (the repaired probe, 2026-11-10) sets false, and every lateral
   * `G38.3 X/Y` is refused before the wire.
   */
  lateralProbes?: boolean;
  /**
   * #1199 field 7 — where a DESCENT below the clearance may happen, in the frame the line speaks:
   * `machine` true for a G53 line, false for a work-coordinate one. Absent: no footprint check (the
   * clearance/order rules still hold). The stock's space belongs to the job; the space around it
   * belongs to the hold (clamps, arms, jaws), so nothing may descend there.
   */
  descentAllowed?: (machine: boolean, x: number, y: number) => boolean;
}

export interface MotionOrderGuard {
  /**
   * Feed one line, in the order the session sends it, with the controller's reply when there is
   * one. Returns null for a line that may go out, or the refusal sentence for a line the invariant
   * forbids. The caller must not send the refused line.
   */
  observe(line: string, reply?: string): string | null;
  /** The check ALONE, before the line is sent: what {@link observe} refuses, with no state change. */
  check(line: string): string | null;
  /** The state change alone, after the line went out and its reply is known. */
  commit(line: string, reply?: string): void;
  /** The last commanded machine Z (Infinity after a home), or null when unknown. */
  lastMachineZ(): number | null;
}

const f = (n: number): string => (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';

interface Words {
  /** The G word's number as written (`G0`, `G00`, `G53`), or null for a modal line. */
  g: number | null;
  gRaw: string | null;
  /** A G53 token appeared anywhere on the line: its Z word is machine-coordinate and absolute. */
  machine: boolean;
  x: number | null;
  y: number | null;
  z: number | null;
  a: number | null;
  /** `L2`/`L20` present — the offset-write form of G10. */
  l: number | null;
}

/** Split a line into its words. A token that is not a letter+number is ignored (none are sent). */
function wordsOf(line: string): Words {
  const w: Words = { g: null, gRaw: null, machine: false, x: null, y: null, z: null, a: null, l: null };
  for (const token of line.trim().split(/\s+/)) {
    const m = /^([A-Za-z])(-?\d+(?:\.\d+)?)$/.exec(token);
    if (m === null) continue;
    const letter = m[1]!.toUpperCase();
    const value = Number(m[2]);
    if (letter === 'G') {
      w.g = value;
      w.gRaw = token.toUpperCase();
      if (value === 53) w.machine = true;
    } else if (letter === 'X') w.x = value;
    else if (letter === 'Y') w.y = value;
    else if (letter === 'Z') w.z = value;
    else if (letter === 'A') w.a = value;
    else if (letter === 'L') w.l = value;
  }
  return w;
}

/** A line with X, Y or A: a traverse (a G38.3 X/Y lateral probe is separated before this). */
function isTraverse(w: Words): boolean {
  return w.x !== null || w.y !== null || w.a !== null;
}

/** A Z probe's trigger Z (`[PRB:x,y,z:1]`), or null when the reply carries none. */
function triggerZOf(reply: string | undefined): number | null {
  return reply ? (lastPrb(reply)?.z ?? null) : null;
}

/**
 * #1199 field 7 (analyst 2026-11-11) — WHERE A JOB-TIME DESCENT MAY HAPPEN, per plan:
 *  - the BLANK's outline as the hold places it, SHRUNK by the probe's top-touch margins
 *    (`topTouchEdgeMarginsMm`: tip + unit lateral uncertainty + hold placement, registry floor);
 *  - each declared edge-find window (a scan's start..limit along its edge, ± `edgeBandMm`), minus
 *    any stretch a top clamp's box covers — never on a clamped stretch;
 *  - the plan's own mount-tap target (a datum measurement the planner places and checks).
 * Machine-frame lines are converted with the bracket origin; a machine line on a plan with no
 * origin is refused. A plan with no hold figure or floor shrinks to NOTHING: every descent is
 * refused rather than guessed.
 */
export function jobDescentRegion(
  plan: RegistrationPlan,
  extraScans: readonly EdgeScan[] = [],
): (machine: boolean, x: number, y: number) => boolean {
  const eps = 1e-6;
  const origin = plan.mount === 'bracket' ? plan.bracketOrigin : null;
  const toWork = (machine: boolean, x: number, y: number): { x: number; y: number } | null => {
    if (!machine) return { x, y };
    if (plan.mount !== 'bracket') return null;
    return origin === null ? null : { x: x - origin.x, y: y - origin.y };
  };
  const hold = plan.holdUncertainty;
  const floor = plan.settings.probeFootprintShrinkMm;
  const margins =
    hold === undefined || floor === undefined
      ? null
      : topTouchEdgeMarginsMm(
          { tipRadiusMm: plan.settings.tipRadiusMm, tipLateralUncertaintyMm: plan.probe?.tipLateralUncertaintyMm ?? 0 },
          { floorMm: floor, hold },
        );
  const stock = plan.stock;
  const inBlank = (x: number, y: number): boolean => {
    if (margins === null) return false;
    return (
      x >= stock.xMin + margins.xMm - eps &&
      x <= stock.xMax - margins.xMm + eps &&
      y >= stock.yMin + margins.yMm - eps &&
      y <= stock.yMax - margins.yMm + eps
    );
  };
  const band = plan.settings.edgeBandMm;
  /**
   * The #1133 declared edge-find window: a COLLAR of `edgeBandMm` around the blank's outline —
   * "edge ± band" (analyst 2026-11-11). Only where the plan actually runs edge finds (a bracket
   * plan runs none, so its collar is empty), and never over a TOP CLAMP's box.
   */
  const inEdgeWindow = (x: number, y: number): boolean => {
    const allScans = [...plan.scans, ...extraScans];
    if (allScans.length === 0) return false;
    // (1) THE PLAN'S OWN DECLARED WINDOW: each scan's start..limit, at its own line along the
    // edge (either axis orientation), ± one band for the probe's rim.
    for (const sc of allScans) {
      // An X-axis edge varies in X: `at` is the coordinate along start..limit, `along` is fixed.
      const xEdge = sc.edge === 'left' || sc.edge === 'right';
      const at = xEdge ? x : y;
      const along = xEdge ? y : x;
      const lo = Math.min(sc.start, sc.limit);
      const hi = Math.max(sc.start, sc.limit);
      if (Math.abs(along - sc.along) <= band + eps && at >= lo - band - eps && at <= hi + band + eps) {
        // A clamp's box is WORK XY. `at`/`along` are the scan's own axis pair, so put the point
        // back in (x, y) before the box test — a right/left edge's `along` is Y, not X.
        const px = xEdge ? at : along;
        const py = xEdge ? along : at;
        const clamped = plan.mountObstacles.some(
          (o) =>
            o.kind === 'clamp' &&
            px >= o.min[0] - eps && px <= o.max[0] + eps &&
            py >= o.min[1] - eps && py <= o.max[1] + eps,
        );
        if (!clamped) return true;
      }
    }
    // (2) …and the COLLAR of one band around the blank's outline (the analyst's edge ± band).
    const inCollar =
      x >= stock.xMin - band - eps &&
      x <= stock.xMax + band + eps &&
      y >= stock.yMin - band - eps &&
      y <= stock.yMax + band + eps;
    if (!inCollar) return false;
    return !plan.mountObstacles.some(
      (o) =>
        o.kind === 'clamp' &&
        x >= o.min[0] - eps &&
        x <= o.max[0] + eps &&
        y >= o.min[1] - eps &&
        y <= o.max[1] + eps,
    );
  };
  const tap = plan.mountTap;
  return (machine, x, y) => {
    // TODO(#1199 analyst): the VISE's jaw tap sits outside the blank by design — kept as a
    // declared target until the analyst rules how a job-time jaw datum fits field 7. The tap's
    // own coordinates are MACHINE XY (`PlanMountTap`), so they are compared in that frame.
    if (tap !== null && machine && Math.abs(x - tap.x) <= 1e-3 && Math.abs(y - tap.y) <= 1e-3) return true;
    const p = toWork(machine, x, y);
    if (p === null) return false;
    if (inBlank(p.x, p.y)) return true;
    return inEdgeWindow(p.x, p.y);
  };
}

/** The refusal for a plan whose travel height sits below the machine's clearance. */
export function planTravelProblem(travelZ: number, clearanceZ: number, what: string): string | null {
  if (!Number.isFinite(clearanceZ)) return 'the machine’s clearance is not known — nothing was sent';
  if (!Number.isFinite(travelZ)) return `the ${what} has no travel height — nothing was sent`;
  if (travelZ < clearanceZ - 1e-9) {
    return (
      `the ${what} travels at machine Z ${f(travelZ)}, below the machine's clearance ${f(clearanceZ)} — ` +
      'nothing was sent: a plan (or a caller) may not hand a probing run a traverse height the machine does not call clear'
    );
  }
  return null;
}

/**
 * @param clearanceZ the MACHINE's own travel height, MACHINE Z (`toolChange.clearanceZ`): the
 *                   lowest Z at which any traverse or turn may be taken. Never a plan's value.
 */
export function motionOrderGuard(clearanceZ: number, opts: MotionOrderGuardOptions = {}): MotionOrderGuard {
  const lateralProbes = opts.lateralProbes !== false;
  let lastZ: number | null = null;
  /**
   * #1199 field 7 — the last commanded XY, in the frame its line spoke (machine for G53). A descent
   * below the clearance is allowed only here, inside the stock's footprint.
   */
  let lastXY: { machine: boolean; x: number; y: number } | null = null;

  const check = (line: string): string | null => {
    const l = line.trim();
    if (l === '$H') return null;
    const w = wordsOf(l);
    // G10 (offset write) and G92/G92.1 (offset set) move nothing.
    if (w.g === 10 || w.g === 92) return null;
    // Probes: lateral X/Y (#1200 gate) is a probe, not a traverse; Z sets the trigger height.
    if (w.g === 38.3 || w.g === 38.5) {
      if (w.g === 38.3 && (w.x !== null || w.y !== null)) {
        if (!lateralProbes) {
          return (
            'refusing a sideways probe (G38.3 X/Y): this unit is checked for top touches only — ' +
            'a lateral touch is not trusted with the probe in this spindle'
          );
        }
        return null;
      }
      return null;
    }
    // Any other motion-bearing line must be a rapid we can classify. Deny the rest.
    const motionBearing = isTraverse(w) || w.z !== null;
    if (!motionBearing) return null;
    // A line with no G word is a MODAL continuation of the last G0/G1/G53: still a move, still
    // checked. Anything else carrying axes is not a shape this session sends.
    const rapid = w.g === null || w.g === 0 || w.g === 1 || w.g === 53;
    if (!rapid) {
      return (
        `refusing an unrecognised motion line (${l}): a probing session sends only G0/G1/G53 moves, ` +
        'G38.3/G38.5 probes and G10/G92 offsets — split it or lift it to the clearance explicitly'
      );
    }
    // A pure Z move is a DESCENT. #1199 field 7 — below the clearance it may happen only over the
    // stock (or a declared edge-find window); the space around the blank belongs to the hold.
    if (!isTraverse(w)) {
      if (opts.descentAllowed !== undefined && w.z !== null && w.z < clearanceZ - 1e-9) {
        if (lastXY === null) {
          return (
            `refusing to descend to machine Z ${f(w.z)}: the head's XY is not known — a depth below the ` +
            `clearance ${f(clearanceZ)} is only entered over the stock's footprint`
          );
        }
        if (!opts.descentAllowed(lastXY.machine, lastXY.x, lastXY.y)) {
          return (
            `refusing to descend to machine Z ${f(w.z)} at ${lastXY.machine ? 'machine' : 'work'} X ${f(lastXY.x)}, ` +
            `Y ${f(lastXY.y)}: that point is outside the stock's footprint — during a job nothing descends beside the blank`
          );
        }
      }
      return null;
    }
    if (lastZ === null) {
      return (
        'refusing to move X/Y/A: the head is at an unknown Z — lift to the machine\'s clearance ' +
        `${f(clearanceZ)} with G53 G0 Z, then traverse, and descend only at the point to be probed`
      );
    }
    if (!(lastZ >= clearanceZ - 1e-9)) {
      return (
        `refusing to move X/Y/A from machine Z ${f(lastZ)}: a traverse on a probing run is taken at the machine's ` +
        `clearance ${f(clearanceZ)} or higher — lift first, then move, and descend only at the point to be probed`
      );
    }
    if (w.z !== null && !(w.z >= clearanceZ - 1e-9)) {
      return (
        `refusing a combined XY/A and Z move into machine Z ${f(w.z)}: the clearance is ${f(clearanceZ)} — ` +
        'split it into a traverse at the clearance and a descent at the point to be probed'
      );
    }
    return null;
  };

  const commit = (line: string, reply?: string): void => {
    const l = line.trim();
    if (l === '$H') {
      // Homing puts the head at the top of its travel; whatever came before is history.
      lastZ = Number.POSITIVE_INFINITY;
      return;
    }
    if (l === 'G91' || l === 'G90') return; // modality alone moves nothing
    const w = wordsOf(l);
    if (w.g === 10 || w.g === 92) return; // offsets move nothing
    if (w.g === 38.3) {
      if (w.z !== null) lastZ = triggerZOf(reply);
      return; // X/Y and G38.5 leave Z where it is
    }
    if (w.g === 38.5) return;
    // A G53 line is machine-coordinate and absolute whatever the mode; anything else with a Z is a
    // work/relative move and hides the machine Z.
    if (w.z !== null) {
      lastZ = w.machine ? w.z : null;
    }
    if (isTraverse(w) && w.x !== null && w.y !== null) {
      lastXY = { machine: w.machine, x: w.x, y: w.y };
    } else if (isTraverse(w)) {
      // A one-axis traverse (an edge scan line, an A turn): keep the frame, update the axis known.
      if (w.a !== null) return;
      if (lastXY !== null && lastXY.machine === w.machine) {
        lastXY = { machine: w.machine, x: w.x ?? lastXY.x, y: w.y ?? lastXY.y };
      } else if (w.x !== null && w.y !== null) {
        lastXY = { machine: w.machine, x: w.x, y: w.y };
      } else {
        lastXY = null; // one axis from an unknown point: the position is no longer known
      }
    }
  };

  return {
    lastMachineZ: () => lastZ,
    check,
    commit,
    observe(line: string, reply?: string): string | null {
      const problem = check(line);
      if (problem !== null) return problem;
      commit(line, reply);
      return null;
    },
  };
}
