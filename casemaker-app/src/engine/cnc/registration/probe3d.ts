/**
 * #525 — the Makera 3D probe's SIDEWAYS edge touch: where it starts, where it travels, and what the
 * reading means. The executor sends the line this module plans and records the reading it derives;
 * every number and correction lives HERE, so the bench corrects one place.
 *
 * HOW IT DIFFERS FROM THE WIRED PROBE. The wired probe is Z-only: an edge is found by stepping
 * outward and descending at each point until a touch misses the stock (`execute.ts`'s bracket-and-
 * bisect). The 3D probe triggers on a SIDEWAYS move, so an edge is ONE horizontal `G38.3` toward it:
 * no step size, no bisection, and the correction is the stylus ball's geometry alone.
 *
 * WHICH EDGES CAN BE TOUCHED SIDEWAYS (#525, the maintainer's condition). A VISE's jaws stand exactly
 * where an X-direction approach would travel — the fixed-jaw edge IS the frame's own face and the
 * moving-jaw side is blocked the same way — so on a vise only the FREE front/back edges take a side
 * touch; left/right keep the Z-only bracket-and-bisect (the 3D probe triggers downward too). The
 * bracket and the tape expose all four edges.
 *
 * THE DEPTH RULE (vise). The ball's centre runs below the measured top by one radius (the equator
 * meets the wall) — but never so low that the ball's BOTTOM reaches the vise's ledge step, and never
 * so low that it leaves the stock's thickness. `zMachine = max(top − R, jawTop − ledgeStep + R +
 * PARK_CLEARANCE)`, with the stock's own half-thickness cap from the generic rule. A stock thin enough
 * on the ledge that no depth is left refuses the plan with a sentence instead of touching at a
 * guessed height.
 *
 * THE CORRECTION IS NOT ALWAYS THE RADIUS. When the centre is at least one radius below the top, the
 * equator meets the wall and the contact is one radius out. When the stock is thinner than two radii
 * (or the ledge rule lifts the centre), the ball meets the top EDGE — a corner — and the horizontal
 * offset is `sqrt(R² − depth²)`, smaller than R. Both are computed here; the outcome's edge is
 * `centre − outward × offset`, exactly.
 *
 * FRAME. The start is WORK XY (the executor's `moveXY` puts the bracket's start in machine XY, as
 * every other move there is). The PRB reports MACHINE coordinates, so the ball's centre in work XY is
 * `prb − sentFrom`, the same subtraction `computeOutcome` makes for every touch.
 *
 * THE BENCH OWNS (issue #525): the effective stylus radius (recorded on the accessory, refused when
 * absent), what the firmware answers to a sideways `G38.3` here, and whether a touch at these depths
 * repeats on a real blank. The depth rule is the safe geometric choice, not a measurement.
 */

import type { Edge, EdgeScan, Mount, RegistrationPlan } from './plan';
import type { Prb } from './readings';
import { Z1_VISE } from '@/engine/cnc/fixture';
import { PARK_CLEARANCE_MM } from '@/platform/defaultsClient';

/** One sideways touch, as the executor will run it. */
export interface SideTouchPlan {
  /** The commanded start, WORK XY — outside the stock on the scan's axis. */
  x: number;
  y: number;
  /** The scan's axis: which coordinate the probe travels along. */
  axis: 'x' | 'y';
  /** The signed travel, mm (a relative move; the executor has `G91` in force for the touch). */
  travelMm: number;
  /** The console line, ready to send while `G91` is in force. */
  line: string;
}

/** The whole sideways plan for one scan: where it runs and how the reading becomes an edge. */
export interface SideTouchSetup {
  ok: true;
  touch: SideTouchPlan;
  /** MACHINE Z the horizontal move runs at. */
  zMachine: number;
  /** Below-top depth the ball's centre runs at. */
  depthMm: number;
  /** The centre-to-edge horizontal offset at that depth, mm. */
  offsetMm: number;
}

/** Why a side touch cannot be taken here, in a sentence the operator can act on. */
export interface SideTouchRefusal {
  ok: false;
  reason: string;
}

/** Below this the ball cannot meet the stock's side at all: refuse rather than guess a height. */
export const MIN_SIDE_DEPTH_MM = 0.3;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Whether a sideways touch can reach this edge on this mount. A VISE's jaws stand where an X-direction
 * approach would travel (the fixed-jaw edge is the frame's face, the moving-jaw side is blocked the
 * same way), so only the free front/back edges are side-probeable there. Bracket and tape: all four.
 */
export function sideTouchAllowed(mount: Mount, edge: Edge): boolean {
  return mount === 'vise' ? edge === 'front' || edge === 'back' : true;
}

/**
 * How far below the measured top the ball's CENTRE travels, mm: one radius (the equator on the
 * wall) for stock thicker than two radii, half the thickness for thinner stock (the ball then meets
 * the top corner, and `ballOffsetMm` accounts for it). The centre never leaves the stock's thickness.
 */
export function sideTouchDepthMm(ballRadiusMm: number, stockThicknessMm: number): number {
  const half = stockThicknessMm > 0 ? stockThicknessMm / 2 : ballRadiusMm;
  return r3(Math.max(MIN_SIDE_DEPTH_MM, Math.min(ballRadiusMm, half)));
}

/**
 * The horizontal distance from the ball's centre to the stock's edge at the trigger, mm — one radius
 * at or below the equator's depth, `sqrt(R² − depth²)` when the ball meets the top corner instead.
 */
export function ballOffsetMm(depthBelowTopMm: number, ballRadiusMm: number): number {
  if (depthBelowTopMm >= ballRadiusMm) return r3(ballRadiusMm);
  const sq = ballRadiusMm * ballRadiusMm - depthBelowTopMm * depthBelowTopMm;
  return r3(Math.sqrt(Math.max(0, sq)));
}

/**
 * The sideways touch for one edge scan: start at the plan's own outward limit (where the Z-only scan
 * would have parked), travel the plan's full span inward at the touch feed. The ball contacts the
 * stock — wall or top corner — wherever the edge really is inside that span.
 */
export function sideTouchFor(scan: EdgeScan, touchFeed: number): SideTouchPlan {
  const travel = Math.abs(scan.limit - scan.start);
  // Travel is INWARD: opposite the outward direction (a left edge's outward is −X, so it travels +X).
  const travelMm = r3(-scan.outward * travel);
  const alongX = scan.edge === 'left' || scan.edge === 'right';
  const axis = alongX ? 'x' : 'y';
  const startAt = scan.limit;
  const x = alongX ? startAt : scan.along;
  const y = alongX ? scan.along : startAt;
  const word = travelMm < 0 ? `-${Math.abs(travelMm)}` : String(travelMm);
  return {
    x: r3(x),
    y: r3(y),
    axis,
    travelMm,
    line: `G38.3 ${axis.toUpperCase()}${word} F${touchFeed}`,
  };
}

/**
 * The ball's CENTRE along the scan's axis, in WORK coordinates, from the machine PRB and the frame
 * the moves were sent in (`sentFrom`: the G54 in force, or the bracket's origin).
 */
export function sideCentreWork(prb: Prb, axis: 'x' | 'y', sentFrom: { x: number; y: number }): number {
  return r3((axis === 'x' ? prb.x : prb.y) - (axis === 'x' ? sentFrom.x : sentFrom.y));
}

/** The machine-Z the sideways move runs at: the measured surface less the touch depth. */
export function sideTouchMachineZ(surfaceMachineZ: number, depthBelowTopMm: number): number {
  return r3(surfaceMachineZ - depthBelowTopMm);
}

/**
 * The whole sideways plan for a registration plan and scan, or the sentence that refuses it:
 *  - a VISE's X edges cannot be reached sideways (the jaws) — only front/back;
 *  - a vise touch needs the MEASURED jaw top to place the ball above the ledge;
 *  - the ball's bottom must stay `PARK_CLEARANCE_MM` above the ledge (`jawTop − Z1_VISE.ledgeStep`),
 *    which on a thin stock sitting low in the jaws can leave no depth at all.
 */
export function sideTouchSetup(
  scan: EdgeScan,
  plan: Pick<RegistrationPlan, 'mount' | 'mountDatum' | 'stockThicknessMm'>,
  settings: { touchFeed: number },
  ballRadiusMm: number,
  surfaceMachineZ: number,
): SideTouchSetup | SideTouchRefusal {
  // #525 — the jaws stand where an X-direction approach travels: the fixed-jaw edge is the frame's
  // own face and the moving-jaw side is blocked the same way.
  if (!sideTouchAllowed(plan.mount, scan.edge)) {
    return {
      ok: false,
      reason:
        `a sideways touch cannot reach the ${scan.edge} edge on a vise: the jaws stand where the ball would travel. ` +
        `The fixed-jaw face is the frame's own datum; use the wired probe for this edge, or mount on the bracket`,
    };
  }

  if (plan.mount === 'vise' && plan.mountDatum === null) {
    return {
      ok: false,
      reason:
        'a sideways touch on the vise needs the measured jaw top (to keep the ball above the ledge): tap the fixed jaw first, then plan again',
    };
  }

  // The generic depth first: one radius below the top on thick stock, half the thickness on thin.
  const thickness = plan.stockThicknessMm ?? ballRadiusMm * 2;
  const depthMm = sideTouchDepthMm(ballRadiusMm, thickness);
  let zMachine = sideTouchMachineZ(surfaceMachineZ, depthMm);

  if (plan.mount === 'vise' && plan.mountDatum !== null) {
    // The ball's bottom must stay clear of the ledge step the stock may sit on. The step's floor is
    // `jawTop − ledgeStep` (the Z1 vise's own calipered constants); the centre must therefore be at
    // least `R + clearance` above it, which can be HIGHER than one radius below the top.
    const ledge = plan.mountDatum.jawTopZ - Z1_VISE.ledgeStep;
    const aboveLedge = r3(ledge + PARK_CLEARANCE_MM + ballRadiusMm);
    zMachine = Math.max(zMachine, aboveLedge);
  }

  const actualDepth = r3(surfaceMachineZ - zMachine);
  if (actualDepth < MIN_SIDE_DEPTH_MM) {
    return {
      ok: false,
      reason:
        `no sideways touch is possible: the stock sits too low in the jaws. Holding the ball above the vise's ledge leaves ` +
        `${actualDepth} mm below the measured top (under ${MIN_SIDE_DEPTH_MM} mm) — raise the stock, or register with the wired probe`,
    };
  }

  return {
    ok: true,
    touch: sideTouchFor(scan, settings.touchFeed),
    zMachine,
    depthMm: actualDepth,
    offsetMm: ballOffsetMm(actualDepth, ballRadiusMm),
  };
}
