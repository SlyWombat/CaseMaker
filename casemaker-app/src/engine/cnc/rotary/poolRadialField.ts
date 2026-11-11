/**
 * engine/cnc/rotary/poolRadialField.ts — A PLANNING FIELD THAT CAN ONLY STAND OFF (#1164 slice a,
 * the analyst's rule 5 in the Manager's ruling).
 *
 * The planner may plan on a coarser map than the check judges on. A coarse cell sampled at its
 * CENTRE can sit on the pocket side of a step and lose the step entirely (#1155's 1 mm cell beside
 * a 0.1 mm-judged shelf was the measured case). The conservative rule: a planning cell carries the
 * HIGHEST goal radius over a block of fine cells CENTRED on the cell's own coordinate — `max(z)`
 * — so material anywhere under the cell keeps the cutter away, and a coarse plan can only
 * over-lift. The block's half-extent travels WITH the field (`footprintHalfMm`): a cell's single
 * maximum stands for material up to that far either side of its coordinate, and the tip drop
 * judges it at the block's nearest point to the cutter (#1164 a's 0.4077 mm, the giraffe).
 *
 * The fine field is sampled ONCE at the judged pitch (`sampleGoalRadialField`, the same cached
 * sampler the check reads) and this pooling is the only bridge to the planning pitch. Corner
 * sub-sampling inside the sampler was refused by the analyst: five rays are a sample, not a bound.
 *
 * A footprint that includes an UNCOVERED fine cell reads at least the envelope (z = 0): the stock's
 * surface stands there, exactly as the fields already treat an uncovered cell. A coarse cell is
 * covered when ANY fine cell under it is. `minRadius` is the smallest radius the pooled cells
 * present — never smaller than the fine field's, and it is what the tip drop's reach
 * `asin(min(1, r/ρ_min))` must read.
 */

import type { GoalRadialField } from './radialField';

/**
 * The field a pooled plan is made from: a cell's value is the highest goal radius over a block
 * of fine cells CENTRED on the cell's own coordinate, and `footprintHalfMm` is the greatest
 * distance (map millimetres, X and arc alike) any sample of that block can sit from it. The tip
 * drop needs the number: a cell's value must be judged at the block's nearest point to the cutter,
 * never only at the cell's coordinate (see `tipDrop.ts`).
 */
export interface PooledRadialField extends GoalRadialField {
  readonly footprintHalfMm: number;
}

/**
 * Pool `fine` down to `planningPitch` (mm, both axes), keeping each coarse cell's highest goal
 * radius. `planningPitch` must be a whole number of fine cells on each axis; anything else would
 * need resampling the mesh, which this function refuses rather than guessing.
 *
 * EACH FINE SAMPLE IS OWNED BY ITS NEAREST PLANNING CELL (ties round up), so a coarse cell's
 * coordinate is the CENTRE of what it carries, not its leading edge. The first and last blocks are
 * clamped to the sampled X range — no fine sample is dropped at an edge and none is counted twice
 * (the row axis wraps: the circumference is a circle).
 */
export function poolRadialField(fine: GoalRadialField, planningPitch: number): PooledRadialField {
  const factor = Math.round(planningPitch / fine.pitch);
  if (!(factor >= 1) || Math.abs(factor * fine.pitch - planningPitch) > 1e-9) {
    throw new Error(
      `the planning pitch ${planningPitch} mm is not a whole number of the judged ${fine.pitch} mm cells`,
    );
  }
  // No pooling: the planning cells ARE the fine samples, each a point of the surface.
  if (factor === 1) return { ...fine, footprintHalfMm: 0 };
  // A sampled map's row count is ceil(2πR/pitch), so blocks almost never divide exactly. The
  // EDGE blocks carry whatever remains (clamped in X, wrapped in the row axis — the circumference
  // is a circle): still the highest radius over the block, never a dropped cell.
  const nx = Math.ceil(fine.nx / factor);
  const ny = Math.ceil(fine.ny / factor);
  if (nx < 1 || ny < 1) {
    throw new Error(`a ${planningPitch} mm planning pitch leaves no cell in this ${fine.nx}×${fine.ny} map`);
  }
  const z = new Float32Array(nx * ny).fill(-Infinity);
  const covered = new Uint8Array(nx * ny);
  for (let k = 0; k < fine.ny; k++) {
    // The nearest planning row (ties round up); the row axis wraps, so the cell count is the
    // block count — no fine row is left unowned.
    const j = ((Math.round(k / factor) % ny) + ny) % ny;
    for (let c = 0; c < fine.nx; c++) {
      // The nearest planning column; the last cell absorbs the remainder at the X edge.
      const i = Math.min(nx - 1, Math.round(c / factor));
      const at = j * nx + i;
      const fineAt = k * fine.nx + c;
      if (fine.covered[fineAt] === 0) {
        // The stock's surface stands under any uncovered fine cell: at least the envelope.
        if (z[at]! < 0) z[at] = 0;
        continue;
      }
      covered[at] = 1;
      const value = fine.z[fineAt]!;
      if (value > z[at]!) z[at] = value;
    }
  }
  // Every block owns at least one fine sample (the assignment covers the whole fine grid), so
  // this is a guard, not a rule: a value the loop never wrote is the envelope, never -Infinity.
  for (let at = 0; at < z.length; at++) if (!(z[at]! > -Infinity)) z[at] = 0;
  let coveredCount = 0;
  let minRadius = Infinity;
  let maxRadius = -Infinity;
  for (let at = 0; at < z.length; at++) {
    if (covered[at] !== 1) continue;
    coveredCount++;
    const radius = fine.radius + z[at]!;
    if (radius < minRadius) minRadius = radius;
    if (radius > maxRadius) maxRadius = radius;
  }
  return {
    nx,
    ny,
    x0: fine.x0,
    y0: fine.y0,
    pitch: planningPitch,
    radius: fine.radius,
    minRadius: coveredCount === 0 ? fine.radius : minRadius,
    maxRadius: coveredCount === 0 ? fine.radius : maxRadius,
    z,
    covered,
    coveredCount,
    // The farthest a sample owned by a cell can sit from the cell's coordinate: `footprintHalfMm`
    // either side (rounding up, so the tip drop's near-edge shift always covers the block).
    footprintHalfMm: Math.ceil((factor - 1) / 2) * fine.pitch,
    resolutionNote: `${fine.resolutionNote} · planned at ${planningPitch} mm (highest radius over each cell)`,
  };
}
