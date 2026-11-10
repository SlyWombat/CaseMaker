// #1164 slice (a) — THE ROTARY TIP DROP ON THE TRUE RAY GEOMETRY, judged by the penetration sweep.
//
// The defect (#1155): the planner fed the radial map to the FLAT disc drop, where a neighbour Δθ
// away is `R·Δθ` from the tool; on the machine it is `ρ·sin Δθ`, ρ its own radius. Below the
// surface the map disc is too narrow by R/ρ, so the ball gouges the wall beside a groove — and the
// stamp, copying the same metric, certified it.
//
// The acceptance (the analyst's design note): a V-groove to ρ = 8 mm on a ⌀44.5 rod, ⌀6 ball, the
// tool 10° from the groove wall. The old map-metric drop puts the ball ≥ 0.5 mm into the wall by
// the 3D sweep; the true drop ≤ 0.02 mm. The sweep is `sweepRotaryPenetration` — the helper that
// reproduces the analyst's giraffe baseline exactly (1.1162731 mm, line 8751).
import { afterEach, describe, expect, it } from 'vitest';

import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import type { EngraveTargetObject } from '@/types/engraveJob';
import type { GoalRadialField } from '@/engine/cnc/rotary/radialField';
import { radialFieldAsHeightfield, sampleGoalRadialField } from '@/engine/cnc/cam/rotaryRelief';
import { poolRadialField } from '@/engine/cnc/rotary/poolRadialField';
import { finishTipField } from '@/engine/cnc/cam/dropTip';
import { rotaryFinishTipField, type RotaryTipTool } from '@/engine/cnc/rotary/tipDrop';
import { sweepRotaryPenetration, type RotaryMove } from './helpers/rotaryPenetration';
import { stl } from './helpers/meshes';

afterEach(() => clearTargetObjectMeshCache());

type V = [number, number, number];
type Tri = [V, V, V];

const R = 44.5 / 2; // ⌀44.5 rod
const GROOVE = 8; // the groove floor radius
const BALL_R = 3;
const BALL = { radius: 0, tanHalf: null, cornerRadius: BALL_R, outerRadius: BALL_R };
const TOOL: RotaryTipTool = { cutter: BALL, ball: true, radius: BALL_R };
// The PLANNING field is coarse by design (the giraffe plans on 1 mm); a 1 mm field also keeps
// this acceptance in seconds — the tip drop's cost is cells × columns, and the naive bisection
// below is not production speed yet (a finding for the slice, not hidden here).
const PITCH = 1.0;
/** 10° in map arc at the envelope, mm — the acceptance's tool-to-wall angle. */
const TEN_DEG_MM = (10 * Math.PI * R) / 180;

/**
 * A rod with a V-groove centred on the map's φ = 0 (rows at arc 0): the radius falls at 45° from
 * the envelope to the groove floor and back over the groove's half-width. A V, not a square
 * groove — a vertical wall is uncuttable by a radiused ball, and the note's fixture is a V.
 */
function vGrooveTriangles(halfWidthMm: number): { tris: Tri[]; flat: number[] } {
  const seg = 180; // around the full circle (1 mm field: a V wall is still resolved)
  const length = 20;
  const radiusAt = (a: number): number => {
    let arc = (a * R) % (2 * Math.PI * R);
    if (arc > Math.PI * R) arc -= 2 * Math.PI * R;
    const d = Math.abs(arc);
    if (d >= halfWidthMm) return R;
    // A straight wall from the envelope at `halfWidthMm` down to the floor radius at the seam —
    // the note's V-groove to ρ = 8 mm, with the wall 10° from the tool when the ball sits at the
    // groove's bottom.
    return GROOVE + (R - GROOVE) * (d / halfWidthMm);
  };
  const at = (x: number, a: number): V => [x, radiusAt(a) * Math.sin(a), radiusAt(a) * Math.cos(a)];
  const tris: Tri[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI;
    const a1 = ((i + 1) / seg) * 2 * Math.PI;
    tris.push([at(-length / 2, a0), at(length / 2, a0), at(length / 2, a1)]);
    tris.push([at(-length / 2, a0), at(length / 2, a1), at(-length / 2, a1)]);
  }
  return { tris, flat: tris.flatMap((t) => [...t[0], ...t[1], ...t[2]]) };
}

/**
 * A rod with a SQUARE groove: the floor radius inside `halfWidthMm` of the seam, the envelope
 * outside, and a VERTICAL wall between them. This is the case the analyst's hint names — the map's
 * disc sees only the wall's top, which is beyond its reach at an interior floor cell, while the
 * ball's true lateral reach at ρ = 8 does not.
 */
function stepGrooveTriangles(halfWidthMm: number): { tris: Tri[]; flat: number[] } {
  const seg = 720;
  const length = 20;
  const radiusAt = (a: number): number => {
    let arc = (a * R) % (2 * Math.PI * R);
    if (arc > Math.PI * R) arc -= 2 * Math.PI * R;
    return Math.abs(arc) < halfWidthMm ? GROOVE : R;
  };
  const at = (x: number, a: number): V => [x, radiusAt(a) * Math.sin(a), radiusAt(a) * Math.cos(a)];
  const tris: Tri[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI;
    const a1 = ((i + 1) / seg) * 2 * Math.PI;
    tris.push([at(-length / 2, a0), at(length / 2, a0), at(length / 2, a1)]);
    tris.push([at(-length / 2, a0), at(length / 2, a1), at(-length / 2, a1)]);
  }
  return { tris, flat: tris.flatMap((t) => [...t[0], ...t[1], ...t[2]]) };
}

function goal(tris: Tri[]): EngraveTargetObject {
  return {
    id: 'v-groove',
    name: 'v-groove.stl',
    format: 'stl',
    sha256: 'b'.repeat(64),
    data: stl(tris),
    size: { x: 20, y: 2 * R, z: 2 * R },
    position: { x: 50, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

/** The field cell nearest (x, arc). */
function cellAt(field: GoalRadialField, x: number, arc: number): number {
  const i = Math.round((x - field.x0) / field.pitch);
  const j = ((Math.round((arc - field.y0) / field.pitch) % field.ny) + field.ny) % field.ny;
  return j * field.nx + i;
}

/** One finishing pose: the ball's tip at `tipZ` (relative to the envelope) on the ray at `arc`. */
function poseMove(x: number, tipZ: number, arc: number): RotaryMove {
  const aDeg = (arc / R) * (180 / Math.PI);
  return { startX: x, startZ: R, startA: aDeg, x, z: R + tipZ, aDeg, line: 1, operation: 'finish' };
}

describe('#1164 the rotary tip drop on the true ray geometry', () => {
  // The wall 10° from the seam: the ball at the groove's bottom is the acceptance's "tool 10°
  // from the groove wall", and the floor is ρ = 8 mm (14.25 mm below the envelope).
  const halfWidth = TEN_DEG_MM;

  function setup(): { field: GoalRadialField; flat: number[]; k: number; x: number; arc: number } {
    const { tris, flat } = vGrooveTriangles(halfWidth);
    const field = sampleGoalRadialField(goal(tris), R, { pitchMm: PITCH });
    // The ball sits at the groove's BOTTOM: its walls are halfWidth (= 10°) away, the acceptance's
    // pose, and the map's own disc (7.7° at the envelope) does not reach them while the true
    // distance at ρ = 8 does.
    const arc = 0;
    // The FIELD is in the target's world frame (position.x = 50); the mesh the sweep uses is in the
    // rod's own frame. Take the field's mid-x cell, then pose the sweep at that x TER the goal's
    // position — the field's x0 alone is 30 mm away from where the mesh lives.
    const xWorld = field.x0 + Math.floor(field.nx / 2) * field.pitch;
    const k = cellAt(field, xWorld, arc);
    const x = xWorld - 50;
    return { field, flat, k, x, arc };
  }

  function sweepAt(flat: number[], x: number, arc: number, tipZ: number): number {
    return (
      sweepRotaryPenetration({
        triangles: flat,
        R,
        moves: [poseMove(x, tipZ, arc)],
        cutter: { radius: BALL_R, shape: 'ball' },
      }).worst?.penMm ?? 0
    );
  }

  it("the old map-metric drop gouges the STEP wall; the true drop does not (the analyst's acceptance)", () => {
    const { tris, flat } = stepGrooveTriangles(4);
    // THE PRODUCTION PATH: the field is sampled FINE and the PLANNING field is the pooled one
    // (rule 5). A cell that contains the wall then carries the wall's radius, so the plan stands
    // off it; planning on the unpooled 1 mm samples leaves the wall's face unresolved between
    // cells and the ball shaves it (0.36 mm, measured).
    const fine = sampleGoalRadialField(goal(tris), R, { pitchMm: 0.1 });
    const field = poolRadialField(fine, PITCH);
    const xWorld = field.x0 + Math.floor(field.nx / 2) * field.pitch;
    const arc = 0;
    const k = cellAt(field, xWorld, arc);
    const x = xWorld - 50;
    const hf = radialFieldAsHeightfield(field);
    const oldTips = finishTipField(hf, { radius: BALL_R, ball: true }, Number.MAX_SAFE_INTEGER, { wrapRows: true });
    const newTips = rotaryFinishTipField(field, TOOL, { maxOps: Number.MAX_SAFE_INTEGER });
    const oldPen = sweepAt(flat, x, arc, oldTips[k]!);
    const newPen = sweepAt(flat, x, arc, newTips[k]!);
    expect(oldPen, `the old drop must gouge the wall (${oldPen.toFixed(3)} mm)`).toBeGreaterThanOrEqual(0.5);
    expect(newPen, `the true drop must leave the wall (${newPen.toFixed(3)} mm)`).toBeLessThanOrEqual(0.02);
  }, 600_000);

  it('the new tip is the smallest that clears the wall — 0.1 mm lower and the sweep gouges', () => {
    const { field, flat, k, x, arc } = setup();
    const newTips = rotaryFinishTipField(field, TOOL, { maxOps: Number.MAX_SAFE_INTEGER });
    expect(sweepAt(flat, x, arc, newTips[k]! - 0.1)).toBeGreaterThan(0.02);
  }, 600_000);

  it('a plain rod with no groove asks for no lift', () => {
    const { tris } = vGrooveTriangles(0);
    const field = sampleGoalRadialField(goal(tris), R, { pitchMm: PITCH });
    const tips = rotaryFinishTipField(field, TOOL, { maxOps: Number.MAX_SAFE_INTEGER });
    // The sampled rod is a 180-gon: its chords sag below the envelope by ~0.0017 mm, and the tip
    // follows the sampled surface, not the ideal circle.
    for (let k = 0; k < tips.length; k += 101) expect(Math.abs(tips[k]!)).toBeLessThanOrEqual(0.01);
  }, 600_000);
});
