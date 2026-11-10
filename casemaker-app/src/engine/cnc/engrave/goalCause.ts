/**
 * #1165 — THE GOAL VERDICT'S CAUSE CLASS (#1157's ruling, issue comment 6767626064).
 *
 * The verdict stays ONE line against the whole goal (no coverage exception, no
 * `SIMULATOR_VERSION` change). What it gains is WHY it missed, from numbers the plan already has:
 *
 *  - `setup-infeasible` — the share of the goal this staging can address is itself under the pass
 *    line; no plan of this staging can pass (heart-gear-a cut as a one-setup relief: 46 %).
 *  - `shop-infeasible` — addressable, but a refused region's floor sits beyond the longest usable
 *    reach the set's cutters have (the four floors at 23.9–34.7 mm against a 22 mm usable ball).
 *  - `plan-shortfall` — addressable and reachable, and still not cut. The only engine defect.
 *
 * The addressable share rides beside the class as a DIAGNOSTIC — "5.66 % of the goal; 12.3 % of
 * what this setup can address" — never as the judged number. A PASS, or a check that never ran,
 * carries no class at all: the receipt then has no key, so Set B's passing packages stay
 * byte-identical.
 *
 * The facts are read from what the run already wrote, never re-measured: the goal-unreached
 * finding's own top-setup share, and the plan's `goal-finish-unreachable` statements (each carries
 * the refused floor and the finisher's usable length as numbers, beside their sentence).
 */

import type { PlanStatement } from '@/engine/cnc/cam/model/types';
import type { GoalCutIntoReport } from './designCheck';
import type { JobFinding } from './jobSetup';

export type GoalCauseClass = 'setup-infeasible' | 'shop-infeasible' | 'plan-shortfall';

/** The class, with the addressable share it was judged against (null when the plan did not state one). */
export interface GoalCause {
  causeClass: GoalCauseClass;
  addressableFraction: number | null;
}

/** The staging facts the class is read from — each null when the plan did not state it. */
export interface GoalCauseFacts {
  /** The share of the goal this staging's own top setup can address, 0–1. */
  addressableFraction: number | null;
  /** The deepest refused region's floor below the stock top, mm. */
  deepestUnreachableFloorMm: number | null;
  /** The longest usable cutter reach among the finishers that ran, mm. */
  longestUsableMm: number | null;
}

/**
 * The verdict's cause, or null when there is nothing to explain: the check did not run, it passed,
 * or it has no leftover number to judge. The line is the coverage line (`1 − leftoverFractions[0]`
 * against `passCoverage`) — exactly the one the Cut card and the harness read.
 */
export function goalCauseOf(
  report: Pick<GoalCutIntoReport, 'ran' | 'leftoverFractions' | 'passCoverage'>,
  facts: GoalCauseFacts,
): GoalCause | null {
  if (!report.ran) return null;
  const leftover = report.leftoverFractions[0];
  if (leftover === undefined) return null;
  if (1 - leftover + 1e-9 >= report.passCoverage) return null;
  const addressable = facts.addressableFraction;
  // NO PLAN OF THIS STAGING COULD PASS: the setup itself cannot address enough of the goal.
  if (addressable !== null && addressable + 1e-9 < report.passCoverage) {
    return { causeClass: 'setup-infeasible', addressableFraction: addressable };
  }
  // ADDRESSABLE BUT BEYOND THE SET'S REACH: a refused region stands deeper than the longest usable
  // cutter can go, so no cutter the shop has would finish it from here.
  if (
    facts.deepestUnreachableFloorMm !== null &&
    facts.longestUsableMm !== null &&
    facts.deepestUnreachableFloorMm - facts.longestUsableMm > 1e-6
  ) {
    return { causeClass: 'shop-infeasible', addressableFraction: addressable };
  }
  return { causeClass: 'plan-shortfall', addressableFraction: addressable };
}

/**
 * The staging facts, harvested from the run's own findings and plan statements. The top-setup share
 * rides the `goal-unreached` finding (`goalTopFraction`); each refused finish carries its floor and
 * the finisher's usable length (`floorMm`, `usableMm`). Nothing is re-measured here.
 */
export function goalCauseFacts(
  findings: readonly JobFinding[],
  statements: readonly PlanStatement[],
): GoalCauseFacts {
  let addressableFraction: number | null = null;
  for (const finding of findings) {
    if (finding.code === 'goal-unreached' && finding.goalTopFraction !== undefined) {
      addressableFraction = finding.goalTopFraction;
      break;
    }
  }
  let deepestUnreachableFloorMm: number | null = null;
  let longestUsableMm: number | null = null;
  for (const statement of statements) {
    if (statement.severity === 'sheet' || statement.code !== 'goal-finish-unreachable') continue;
    if (statement.floorMm !== undefined && (deepestUnreachableFloorMm === null || statement.floorMm > deepestUnreachableFloorMm)) {
      deepestUnreachableFloorMm = statement.floorMm;
    }
    if (statement.usableMm !== undefined && (longestUsableMm === null || statement.usableMm > longestUsableMm)) {
      longestUsableMm = statement.usableMm;
    }
  }
  return { addressableFraction, deepestUnreachableFloorMm, longestUsableMm };
}
