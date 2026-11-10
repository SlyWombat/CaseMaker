// #1164 slice (a) — THE ROTARY TIP DROP ON THE TRUE RAY GEOMETRY.
//
// The defect: the planner fed the radial field to the FLAT disc drop, where a neighbour Δθ away is
// `R·Δθ` from the tool. On the machine it is `ρ·sin Δθ`, ρ its own radius, so below the surface the
// stencil was too narrow by R/ρ and the ball gouged the wall beside a groove. The new drop asks
// `cutterFloorOnColumn` (#763) — the same function the column sweep uses — for every column the
// cutter can reach, and takes the smallest tip that leaves every column at or above its own goal
// radius.
//
// Red-first: this spec is written against `rotaryFinishTipField`, which does not exist at the
// parent. The acceptance fixture is the analyst's: a V-groove to ρ = 8 mm on a ⌀44.5 rod with a
// ⌀6 ball; here the heightfield is built analytically (the groove rows at ρ = 8, the rest at the
// envelope) so the geometry, not a mesh importer, is what is measured.
import { describe, expect, it } from 'vitest';

import type { GoalRadialField } from '@/engine/cnc/rotary/radialField';
import { cutterFloorOnColumn, type ColumnCutter } from '@/engine/cnc/rotary/columnRay';
import { radialFieldAsHeightfield } from '@/engine/cnc/cam/rotaryRelief';
import { finishTipField } from '@/engine/cnc/cam/dropTip';
import { rotaryFinishTipField, type RotaryTipTool } from '@/engine/cnc/rotary/tipDrop';

const ENVELOPE = 44.5 / 2; // ⌀44.5 rod
const PITCH = 0.2;
const BALL_R = 3; // ⌀6 ball
const BALL: ColumnCutter = { radius: 0, tanHalf: null, cornerRadius: BALL_R, outerRadius: BALL_R };
const TOOL: RotaryTipTool = { cutter: BALL, ball: true, radius: BALL_R };

/** A rod with a V-groove down to `grooveRadius` over `grooveRows` rows centred on the seam. */
function grooveField(grooveRadius: number, grooveRows: number): GoalRadialField {
  const nx = 8;
  const ny = 80; // ~7.2 mm of arc at the envelope at 0.2 mm
  const z = new Float32Array(nx * ny);
  const covered = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const inGroove = Math.abs(j - ny / 2) <= grooveRows / 2;
    for (let i = 0; i < nx; i++) {
      z[j * nx + i] = inGroove ? grooveRadius - ENVELOPE : 0;
      covered[j * nx + i] = 1;
    }
  }
  return {
    nx,
    ny,
    x0: 0,
    y0: 0,
    pitch: PITCH,
    radius: ENVELOPE,
    minRadius: grooveRadius,
    maxRadius: ENVELOPE,
    z,
    covered,
    coveredCount: nx * ny,
    resolutionNote: 'test',
  };
}

/** The floor the cutter leaves on the column `phi` away and `dx` along, at a tip Z (relative). */
function floorAt(tipZ: number, phi: number, dx: number): number | null {
  return cutterFloorOnColumn(BALL, ENVELOPE + tipZ, phi, dx);
}

/** The worst (smallest) clearance the tip leaves: floor − goal radius over the reached columns. */
/** The tool sits at cell (i, j) at ITS OWN tip; every column it can reach is measured against
 *  that column's goal radius. A negative value is material cut away below the surface. */
function worstClearance(field: GoalRadialField, tips: Float32Array, i: number, j: number): number {
  let worst = Infinity;
  const { nx, ny, pitch, radius, z, covered } = field;
  const span = Math.ceil((2 * BALL_R) / pitch) + 2;
  const centreTip = tips[j * nx + i]!;
  for (let dj = -span; dj <= span; dj++) {
    for (let di = -span; di <= span; di++) {
      const ii = i + di;
      const jj = ((j + dj) % ny + ny) % ny;
      if (ii < 0 || ii >= nx) continue;
      const rho = covered[jj * nx + ii] === 1 ? radius + z[jj * nx + ii]! : radius;
      const phi = (dj * pitch) / radius;
      const floor = floorAt(centreTip, phi, di * pitch);
      if (floor === null) continue;
      worst = Math.min(worst, floor - rho);
    }
  }
  return worst;
}

describe('#1164 the rotary tip drop on the true ray geometry', () => {
  it('the old map-metric drop gouges the V-groove wall; the true drop does not', () => {
    const field = grooveField(8, 40);
    const hf = radialFieldAsHeightfield(field);
    const oldTips = finishTipField(hf, { radius: BALL_R, ball: true }, Number.MAX_SAFE_INTEGER, { wrapRows: true });
    const newTips = rotaryFinishTipField(field, TOOL, { maxOps: Number.MAX_SAFE_INTEGER });

    // A cell on the groove floor next to its wall: the wall stands 14.25 mm above the floor.
    const j = Math.round(field.ny / 2);
    const i = Math.round(field.nx / 2);
    const wallClearanceOld = worstClearance(field, oldTips, i, j);
    const wallClearanceNew = worstClearance(field, newTips, i, j);
    expect(wallClearanceOld, `the old drop must gouge this wall (clearance ${wallClearanceOld.toFixed(3)} mm)`).toBeLessThan(-0.5);
    expect(wallClearanceNew, `the true drop must leave the wall (clearance ${wallClearanceNew.toFixed(3)} mm)`).toBeGreaterThanOrEqual(-0.02);
  });

  it('every reached column is at or above its own goal radius on the new tip, across the whole field', () => {
    const field = grooveField(8, 40);
    const tips = rotaryFinishTipField(field, TOOL, { maxOps: Number.MAX_SAFE_INTEGER });
    let worst = Infinity;
    for (let j = 0; j < field.ny; j += 7) {
      for (let i = 0; i < field.nx; i += 3) {
        worst = Math.min(worst, worstClearance(field, tips, i, j));
      }
    }
    expect(worst).toBeGreaterThanOrEqual(-0.02);
  });

  it('the tip is the SMALLEST one that clears the wall — a higher tip is not the answer', () => {
    const field = grooveField(8, 40);
    const tips = rotaryFinishTipField(field, TOOL, { maxOps: Number.MAX_SAFE_INTEGER });
    const j = Math.round(field.ny / 2);
    const i = Math.round(field.nx / 2);
    // Lower the tip by 0.1 mm: some reached column must now be cut into. That is what makes the
    // field a plan and not a safe over-lift.
    const lowered = Float32Array.from(tips);
    lowered[j * field.nx + i] = tips[j * field.nx + i]! - 0.1;
    expect(worstClearance(field, lowered, i, j)).toBeLessThan(-0.02);
  });

  it('a flat rod with no groove stays at the envelope (nothing to cut, no lift)', () => {
    const field = grooveField(ENVELOPE, 0);
    const tips = rotaryFinishTipField(field, TOOL, { maxOps: Number.MAX_SAFE_INTEGER });
    for (let k = 0; k < tips.length; k += 97) expect(tips[k]).toBeCloseTo(0, 6);
  });
});
