/**
 * engine/cnc/rotary/tipDrop.ts — THE ROTARY FINISHING TIP FIELD ON THE TRUE RAY GEOMETRY (#1164
 * slice a).
 *
 * THE DEFECT THIS REPLACES. The rotary relief fed the radial map to the FLAT disc drop
 * (`finishTipField` with `wrapRows`), where a neighbour `dj` rows away is `dj·pitch` from the tool
 * — an arc at the envelope. On the machine that neighbour is at `ρ·sin Δθ` from the tool axis, ρ
 * its OWN goal radius. Below the surface (ρ < R) the map disc is too narrow by R/ρ, so a ball walked
 * along a groove gouges the wall beside it, and the verdict stamp — which copied the same metric —
 * certified the planner's assumption instead of testing it (#1155).
 *
 * THE RULE (the analyst's design note, field 1). The tip at a covered cell is the SMALLEST absolute
 * tip radius `zt` such that every column the cutter can reach has
 * `cutterFloorOnColumn(cutter, zt, φ, dx)` null, or at least that column's goal radius. The floor
 * function is #763's — the same one the column sweep and the verdict read (`columnRay.ts`) — so the
 * planner, the sweep and the stamp cannot disagree about where the cutter's body is. `zt` is an
 * absolute radius from the rod's axis; the returned field is Z RELATIVE to the envelope (0 at the
 * stock's surface, negative into the stock), exactly like `finishTipField`'s, so the consumers
 * (`aSweepRoughing`, `finishingMoves`) take it unchanged.
 *
 * ANGLE AND REACH are the true ones: `φ = dj·pitch / R` (the map's own row convention), and the
 * columns considered are those the cutter can reach at the smallest goal radius in the field,
 * `asin(min(1, r/ρ_min))` — not the flat field's `r/R` (field 2). A column is "reached" when the
 * floor function returns a value at all; raising the tip eventually lifts the cutter off it.
 *
 * The minimal tip per column is found by BISECTION on the shared floor function, for every cutter
 * shape — one derivation, no closed form to drift (the note permits the ball's closed form only
 * with a pin against this function; bisection IS that function, so the pin is unnecessary). The
 * budget unit states the column evaluations, not the iterations; the iteration constant is below.
 */

import { cutterFloorOnColumn, type ColumnCutter } from './columnRay';
import type { GoalRadialField } from './radialField';

/** Bisection steps per column: 28 halvings of the envelope is 1e-4 mm on a 22 mm rod. */
const TIP_BISECTION_STEPS = 28;

/** The cutter the rotary drop plans for. `radius` is its cutting radius (the caller's tool), the
 *  `cutter` its #763 body — a ball is `{ radius: 0, cornerRadius: R, outerRadius: R }`. */
export interface RotaryTipTool {
  cutter: ColumnCutter;
  ball: boolean;
  radius: number;
}

/**
 * The field's own work in its unit: CELLS × COLUMNS IN THE TRUE REACH, so the plan's budget
 * statement and the loop cannot disagree. The iteration constant above is folded in — the unit is
 * calibrated to wall-clock like the flat's — and every column evaluation costs the same.
 */
export function rotaryTipFieldOpsFor(field: GoalRadialField, tool: RotaryTipTool): number {
  const reachAngle = Math.asin(Math.min(1, tool.radius / Math.max(field.minRadius, 1e-6)));
  const rows = Math.ceil((reachAngle * field.radius) / field.pitch) + 1;
  const cols = Math.ceil(tool.radius / field.pitch) + 1;
  const columns = (2 * rows + 1) * (2 * cols + 1);
  return field.coveredCount * columns * TIP_BISECTION_STEPS;
}

/**
 * THE BALL'S CLOSED FORM (the analyst's note, field 1), pinned to the shared floor function by a
 * spec: the tip radius `zt` that leaves the column `(φ, dx)` at or above `rho` is
 * `zt + r ≥ max over u ≤ ρ of [u·cos φ + √(r² − dx² − u²·sin² φ)]`. The maximum is NOT always at
 * u = ρ: the derivative vanishes at `u* = cos φ·√(r² − dx²)/sin φ`, and a step wall is exactly the
 * case where u* binds. Returns null when the ball cannot reach the column at all (dx > r), where no
 * lift is needed.
 */
export function ballTipRequirement(rho: number, phi: number, dx: number, r: number): number | null {
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const under = r * r - dx * dx;
  if (!(under > 0)) return null; // the ball never reaches this column
  const root = Math.sqrt(under);
  // The bracket peaks at the TANGENT point u* = √(r² − dx²)·cos φ / sin φ, where it is
  // √(r² − dx²)/sin φ. If u* lies inside the goal's solid (ρ ≥ u*), that is the requirement;
  // otherwise the column's own surface point ρ is the binding one. (The analyst's derivation,
  // #1164 comment; at exactly the tangent tip the floor function returns the graze point — zero
  // depth — so the pin raises the tip by 1e-6 and lowers it by 1e-3.)
  if (s === 0) return rho + root - r;
  const uStar = (root * c) / Math.abs(s);
  if (uStar > 0 && rho >= uStar) return root / Math.abs(s) - r;
  return rho * c + Math.sqrt(Math.max(0, under - rho * rho * s * s)) - r;
}

/**
 * The smallest tip (absolute radius) that leaves the column at `(φ, dx)` at or above its goal
 * radius `rho`. Bisection on `cutterFloorOnColumn`: the floor rises monotonically with the tip, and
 * at the envelope it clears every column (the cutter floats on the surface).
 */
export function columnTipRequirement(
  cutter: ColumnCutter,
  rho: number,
  phi: number,
  dx: number,
  envelope: number,
): number {
  // The ball's closed form (the analyst's two-case derivation, pinned to the floor function by
  // the spec with the tangency handled): the tangent point u* binds inside the goal's solid, else
  // the column's own ρ does. Cheap, and still ONE derivation — the pin IS `cutterFloorOnColumn`.
  if (cutter.cornerRadius !== undefined && cutter.radius === 0 && cutter.tanHalf === null) {
    const closed = ballTipRequirement(rho, phi, dx, cutter.cornerRadius);
    return closed === null ? 0 : Math.min(envelope, Math.max(0, closed));
  }
  // A tip EXACTLY on the axis makes every ray start on the cutter's own tip point, where
  // `cutterFloorOnColumn` reports u = 0 as "not reached" — a degenerate contact, not a miss. The
  // predicate is evaluated a hair above the axis so "no floor" really means the body is elsewhere,
  // and the search then sits on the true, monotone boundary.
  const EPS = 1e-6;
  const clears = (zt: number): boolean => {
    const floor = cutterFloorOnColumn(cutter, zt, phi, dx);
    return floor === null || floor >= rho - 1e-9;
  };
  if (clears(EPS)) return 0;
  let lo = EPS;
  let hi = envelope;
  for (let k = 0; k < TIP_BISECTION_STEPS; k++) {
    const mid = (lo + hi) / 2;
    if (clears(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The rotary finishing tip field: the tip Z (relative to the envelope) per map cell.
 *
 * An UNCOVERED neighbour is the stock's surface at the envelope — the same claim the flat field
 * makes with `topZ` — so a disc that reaches an uncovered cell rides on the rod. Uncovered CELLS
 * themselves stay at 0 (nothing is planned there), exactly as `finishTipField` leaves them at
 * `topZ`.
 */
export function rotaryFinishTipField(
  field: GoalRadialField,
  tool: RotaryTipTool,
  opts: { maxOps?: number } = {},
): Float32Array {
  const { nx, ny, pitch, radius, z, covered } = field;
  const ops = rotaryTipFieldOpsFor(field, tool);
  if (opts.maxOps !== undefined && ops > opts.maxOps) {
    throw new Error(
      `The rotary finish's drop-tip field would need ${ops} column evaluations ` +
        `(${field.coveredCount} covered cells × ${Math.round(ops / Math.max(1, field.coveredCount * TIP_BISECTION_STEPS))} ` +
        `columns in the ball's true reach for a ${(tool.radius * 2).toFixed(2)} mm cutter at a ` +
        `${pitch.toFixed(4)} mm map), over the ${opts.maxOps} budget. Coarsen the map, shorten the ` +
        `relief, or use a smaller cutter so the finish fits the budget.`,
    );
  }
  // The reach, in rows: asin(min(1, r/ρ_min)) of arc at the envelope. ρ_min is the smallest goal
  // radius anywhere in the field — the worst case a column band can present.
  const rhoMin = Math.max(field.minRadius, 1e-6);
  const reachAngle = Math.asin(Math.min(1, tool.radius / rhoMin));
  const rows = Math.ceil((reachAngle * radius) / pitch) + 1;
  const cols = Math.ceil(tool.radius / pitch) + 1;
  const tips = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const at = j * nx + i;
      if (covered[at] === 0) continue;
      let tipAbs = 0;
      for (let dj = -rows; dj <= rows; dj++) {
        const jj = ((j + dj) % ny + ny) % ny;
        const phi = (dj * pitch) / radius;
        for (let di = -cols; di <= cols; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= nx) continue; // beyond the sampled X the stock continues: no column
          const nAt = jj * nx + ii;
          const rho = covered[nAt] === 1 ? radius + z[nAt]! : radius;
          if (rho > radius) continue; // past the envelope there is nothing to cut
          const required = columnTipRequirement(tool.cutter, rho, phi, di * pitch, radius);
          if (required > tipAbs) tipAbs = required;
        }
      }
      tips[at] = tipAbs - radius;
    }
  }
  return tips;
}
