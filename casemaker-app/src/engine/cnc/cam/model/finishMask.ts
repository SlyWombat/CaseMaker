/**
 * #970 — THE FINISH MASK'S RULE: a point is planted when the exact per-point leftover rule says so
 * at the point itself or at any ball-footprint ring point. The leftover test is the caller's
 * (the plan's exact CL queries; `planCurvedForTree` builds it); this module owns only the
 * footprint shape, so the rule is testable without a plan.
 *
 * `cd5ec056` replaced the exact test with a leftover grid read by `Math.round` of the point's
 * coordinate — a per-point read that drops the leftover between its samples (the panther's 74–89°
 * flanks: coverage 73.17 → 49.09 %, #965's bisect). The ruling on #970: correct cuts come before
 * speed, and the grid cannot be conservative enough at its pitch (MASK-EQUIV: 9,483 of 23,058
 * points dropped at 0.5 mm, 0 over-included; 0.1 mm still 2.5 points short) — so the mask's rule
 * is the exact per-point test again, and a grid is not kept as a second mechanism.
 */

/** TRUE when the point or any footprint-ring point is leftover by the caller's EXACT rule. */
export function maskCellsExact(
  leftoverAt: (x: number, y: number) => boolean,
  ring: readonly [number, number][],
  x: number,
  y: number,
): boolean {
  if (leftoverAt(x, y)) return true;
  for (const [ox, oy] of ring) if (leftoverAt(x + ox, y + oy)) return true;
  return false;
}
