/**
 * engine/cnc/rotary/poolRadialField.ts — A PLANNING FIELD THAT CAN ONLY STAND OFF (#1164 slice a,
 * the analyst's rule 5 in the Manager's ruling).
 *
 * The planner may plan on a coarser map than the check judges on. A coarse cell sampled at its
 * CENTRE can sit on the pocket side of a step and lose the step entirely (#1155's 1 mm cell beside
 * a 0.1 mm-judged shelf was the measured case). The conservative rule: a planning cell carries the
 * HIGHEST goal radius over its own footprint of fine cells — `max(radius + z)`, i.e. `max z` — so
 * material anywhere under the cell keeps the cutter away, and a coarse plan can only over-lift.
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
 * Pool `fine` down to `planningPitch` (mm, both axes), keeping each coarse cell's highest goal
 * radius. `planningPitch` must be a whole number of fine cells on each axis, and the fine grid's
 * row count must divide into the coarse one; anything else would need resampling the mesh, which
 * this function refuses rather than guessing.
 */
export function poolRadialField(fine: GoalRadialField, planningPitch: number): GoalRadialField {
  const factor = Math.round(planningPitch / fine.pitch);
  if (!(factor >= 1) || Math.abs(factor * fine.pitch - planningPitch) > 1e-9) {
    throw new Error(
      `the planning pitch ${planningPitch} mm is not a whole number of the judged ${fine.pitch} mm cells`,
    );
  }
  if (factor === 1) return fine;
  const nx = Math.floor(fine.nx / factor);
  const ny = Math.floor(fine.ny / factor);
  if (nx < 1 || ny < 1) {
    throw new Error(`a ${planningPitch} mm planning pitch leaves no cell in this ${fine.nx}×${fine.ny} map`);
  }
  if (nx * factor !== fine.nx || ny * factor !== fine.ny) {
    throw new Error(
      `the fine map ${fine.nx}×${fine.ny} does not divide into ${factor}-cell planning blocks`,
    );
  }
  const z = new Float32Array(nx * ny);
  const covered = new Uint8Array(nx * ny);
  let coveredCount = 0;
  let minRadius = Infinity;
  let maxRadius = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let best = -Infinity;
      let anyCovered = 0;
      for (let dj = 0; dj < factor; dj++) {
        for (let di = 0; di < factor; di++) {
          const at = (j * factor + dj) * fine.nx + (i * factor + di);
          if (fine.covered[at] === 0) {
            // The stock's surface stands under any uncovered fine cell: at least the envelope.
            if (best < 0) best = 0;
            continue;
          }
          anyCovered = 1;
          const value = fine.z[at]!;
          if (value > best) best = value;
        }
      }
      const at = j * nx + i;
      z[at] = best === -Infinity ? 0 : best;
      covered[at] = anyCovered;
      if (anyCovered === 1) {
        coveredCount++;
        const radius = fine.radius + z[at]!;
        if (radius < minRadius) minRadius = radius;
        if (radius > maxRadius) maxRadius = radius;
      }
    }
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
    resolutionNote: `${fine.resolutionNote} · planned at ${planningPitch} mm (highest radius over each cell)`,
  };
}
