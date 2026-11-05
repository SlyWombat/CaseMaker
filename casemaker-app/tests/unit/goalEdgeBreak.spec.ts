// #955/V2-2 — THE EDGE-BREAK ALLOWANCE in the app's goal check.
//
// E's `goal_check.py` rule, ported: a cell cut into by a V bit WITHIN THE BIT'S REACH of a design
// edge, and NO DEEPER than the bit's leg, is edge break — not cut-into. Wall cells are reported as
// an unadjudicable share beside the verdict; since v5 (#970) the wall shadow joins them only on
// the rule's proof — the V cut within its leg, or the deepest cutter's CL stated at least the
// shadow radius from the wall. With no `edgeBreak` option the check is the pre-V2-2 reading
// exactly.
import { describe, expect, it } from 'vitest';

import { checkGoalCutInto, type GoalCutIntoOptions } from '@/engine/cnc/engrave/designCheck';
import { goalEdgeBreakOptions, vToolAllowance } from '@/engine/cnc/engrave/edgeBreak';
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { flatEndMill } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';

const PITCH = 0.25;
const N = 40; // 10 mm square

function goal(zAt: (x: number, y: number) => number): GoalHeightfield {
  const z = new Float32Array(N * N);
  const covered = new Uint8Array(N * N);
  let minZ = Infinity;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const v = zAt(i * PITCH, j * PITCH);
      z[k] = v;
      covered[k] = 1;
      minZ = Math.min(minZ, v);
    }
  }
  return {
    nx: N,
    ny: N,
    x0: 0,
    y0: 0,
    pitch: PITCH,
    topZ: 0,
    minZ,
    z,
    covered,
    coveredCount: N * N,
    resolutionNote: 'test',
  };
}

/** The swept top: the goal, except where `cut` says how deep the cutter went. */
function swept(goalField: GoalHeightfield, cut: (x: number, y: number) => number | null) {
  return (x: number, y: number): number | null => {
    const i = Math.round((x - goalField.x0) / goalField.pitch);
    const j = Math.round((y - goalField.y0) / goalField.pitch);
    if (i < 0 || j < 0 || i >= goalField.nx || j >= goalField.ny) return null;
    const k = j * goalField.nx + i;
    if (goalField.covered[k] !== 1) return null;
    const depth = cut(x, y);
    return (goalField.z[k] as number) - (depth ?? 0);
  };
}

// A 2 mm step at x = 5: a design edge (E's wall), with the floor on both sides.
const STEP = goal((x) => (x < 5 ? -1 : -3));

const EDGE: GoalCutIntoOptions = { edgeBreak: { reachMm: 1.5, legMm: 1.5 } };

describe('#955/V2-2 the goal check edge-break allowance', () => {
  it('a V cut within reach and leg of an edge is edge break, not cut-into', () => {
    // A 0.5 mm gouge in a 1 mm band around the step: within the 1.5 mm reach, shallower than 1.5.
    const top = swept(STEP, (x) => (Math.abs(x - 5) <= 1 ? 0.5 : null));
    const r = checkGoalCutInto(STEP, top, EDGE);
    expect(r.cutIntoFraction).toBeGreaterThan(0); // the raw figure still says it was cut
    expect(r.edgeBreakFraction).toBeGreaterThan(0);
    expect(r.adjudicatedFraction).toBe(0);
    // #964 — the raw maximum is stated raw; the adjudicated maximum is the judged one.
    expect(r.maxCutIntoMm).toBeCloseTo(0.5, 6);
    expect(r.adjudicatedMaxMm).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.sentence).toContain('edge break');
  });

  it('a V gouge away from every edge stays cut-into', () => {
    // A flat 10 mm plate: the only edge is the silhouette, 5 mm from the centre gouge.
    const flat = goal(() => -1);
    const top = swept(flat, (x, y) => (Math.hypot(x - 5, y - 5) <= 0.5 ? 0.5 : null));
    const r = checkGoalCutInto(flat, top, EDGE);
    expect(r.edgeBreakFraction).toBe(0);
    expect(r.adjudicatedFraction).toBeGreaterThan(0);
    expect(r.maxCutIntoMm).toBeCloseTo(0.5, 6);
  });

  it('a cut deeper than the bit’s leg at an edge is not excused', () => {
    // The gouge sits on the wall row and is 2 mm deep — deeper than the 1.5 mm leg.
    const top = swept(STEP, (x) => (Math.abs(x - 5) <= 0.25 ? 2 : null));
    const r = checkGoalCutInto(STEP, top, EDGE);
    expect(r.edgeBreakFraction).toBe(0);
    expect(r.wallNotScoredFraction).toBeGreaterThan(0);
    // The non-wall cells of the band are judged, not excused: the deep cut still counts.
    expect(r.adjudicatedFraction).toBeGreaterThan(0);
    expect(r.maxCutIntoMm).toBeCloseTo(2, 6);
  });

  it('#964 — the who rule: only a cell the V bit cut deepest is edge break', () => {
    const top = swept(STEP, (x) => (Math.abs(x - 5) <= 1 ? 0.5 : null));
    const V: GoalCutIntoOptions = { edgeBreak: { reachMm: 1.5, legMm: 1.5, toolNumber: 7 } };
    // The stamp says the V bit is the deepest cutter everywhere: the shallow band is excused.
    const vCell = checkGoalCutInto(STEP, top, { ...V, whoAt: () => 7 });
    expect(vCell.edgeBreakFraction).toBeGreaterThan(0);
    expect(vCell.adjudicatedFraction).toBe(0);
    expect(vCell.ok).toBe(true);
    // A flat cut that cell deepest (who = 2): it is judged, not excused.
    const flatCell = checkGoalCutInto(STEP, top, { ...V, whoAt: () => 2 });
    expect(flatCell.edgeBreakFraction).toBe(0);
    expect(flatCell.adjudicatedFraction).toBeGreaterThan(0);
    expect(flatCell.ok).toBe(false);
    // No identity at all is the conservative side: not excused.
    const unknown = checkGoalCutInto(STEP, top, V);
    expect(unknown.edgeBreakFraction).toBe(0);
  });

  it('v5 — a shadow cut with no stated CL is adjudicated; the stamp-artefact CL excuses it', () => {
    // Just past the reach: outside the 1.5 mm edge reach, inside a 2 mm shadow. The cut is kept
    // INSIDE the grid (y 2..8): since the manager's #959 sanction the part's silhouette is a
    // design edge, and this fixture's y-edges are border cells — a cut touching them is edge
    // break by rule, which is a different question from the one this case asks.
    const top = swept(STEP, (x, y) => (Math.abs(x - 3) <= 0.125 && y > 2 && y < 8 ? 0.5 : null));
    // v4 excused these cells unconditionally; v5 states no CL, so they are judged — E's 3.49 mm
    // tray gouge was hidden by exactly this blanket class.
    const bare = checkGoalCutInto(STEP, top, { ...EDGE, wallShadowRadiusMm: 2 });
    expect(bare.edgeBreakFraction).toBe(0);
    expect(bare.shadowNotScoredFraction).toBe(0);
    expect(bare.adjudicatedFraction).toBeGreaterThan(0);
    expect(bare.ok).toBe(false);
    // The deepest cutter's CL stated at x = 0, ~5 mm clear of the wall: the disc's rim covered the
    // cells, not a wall drive — excused as unadjudicable, the class v4 assumed everywhere.
    const far = checkGoalCutInto(STEP, top, { ...EDGE, wallShadowRadiusMm: 2, clAt: () => ({ x: 0, y: 5 }) });
    expect(far.shadowNotScoredFraction).toBeGreaterThan(0);
    expect(far.adjudicatedFraction).toBe(0);
  });

  it('with no edgeBreak option the wall cells are still excluded — the gate’s rule, not an allowance', () => {
    // #964 — the edge-break ALLOWANCE is what a job opts into; wall cells (and the wall shadow,
    // when a radius is given) are unadjudicable in every goal job. The gouge spans the wall row
    // and its neighbours: the wall cells are excluded, the rest still judged.
    const top = swept(STEP, (x) => (Math.abs(x - 5) <= 1 ? 0.5 : null));
    const r = checkGoalCutInto(STEP, top);
    expect(r.edgeBreakFraction).toBe(0);
    expect(r.wallNotScoredFraction).toBeGreaterThan(0);
    expect(r.shadowNotScoredFraction).toBe(0); // no shadow radius given
    expect(r.adjudicatedFraction).toBeGreaterThan(0);
    expect(r.adjudicatedFraction).toBeLessThan(r.cutIntoFraction);
    expect(r.maxCutIntoMm).toBeCloseTo(0.5, 6); // raw
    expect(r.adjudicatedMaxMm).toBeCloseTo(0.5, 6); // non-wall gouge cells remain
    expect(r.ok).toBe(false);
  });
});

describe('#955/V2-2 the gate parameters come from the job, not the CAM', () => {
  const chamfer = flatEndMill(3.175, {
    name: '90° chamfer',
    shape: 'chamfer',
    typeText: 'Chamfer',
    angle: 90,
    halfAngle: 45,
    tipDiameter: 0.1,
    diameter: 3.175,
  });
  const ball = flatEndMill(6, { shape: 'ball', typeText: 'Ball End', tipDiameter: 6 });

  function job(edgeBreak?: { widthMm: number; toolKey?: string }): EngraveJob {
    return {
      targetObject: {
        role: 'goal',
        enabled: true,
        ...(edgeBreak === undefined ? {} : { edgeBreak }),
      },
      labels: [],
      shapes: [],
      cutouts: [],
      chamfers: [],
      combined: [],
      traces: [],
      vectors: [],
      keepOuts: [],
      drills: [],
      threads: [],
      primitives: [],
    } as unknown as EngraveJob;
  }

  it('a V tool’s reach and leg are its cone’s outer radius and cone height', () => {
    expect(vToolAllowance(chamfer)).toEqual({ reachMm: 1.5875, legMm: 1.5375 });
    expect(vToolAllowance(ball)).toBeNull();
  });

  it('no stated edge break → no allowance (the existing pins keep their reading)', () => {
    const opts = goalEdgeBreakOptions(job(), () => null, ['c90']);
    expect(opts.edgeBreak).toBeUndefined();
  });

  it('the stated edge break resolves its pinned V bit and the run’s widest tool for the shadow', () => {
    const toolFor = (key: string) => (key === 'c90' ? chamfer : key === 'ball' ? ball : null);
    const opts = goalEdgeBreakOptions(job({ widthMm: 1, toolKey: 'c90' }), toolFor, ['c90', 'ball']);
    // #964 — the V's own tool number rides with the allowance (the `who` rule).
    expect(opts.edgeBreak).toEqual({ reachMm: 1.5875, legMm: 1.5375, toolNumber: chamfer.number });
    expect(opts.wallShadowRadiusMm).toBe(3); // the ball, not the 1.5875 chamfer
  });

  it('with no pinned key the widest usable V in the run is the bit', () => {
    const wide = flatEndMill(6, { shape: 'chamfer', typeText: 'Chamfer', angle: 90, halfAngle: 45, tipDiameter: 0.1, diameter: 6 });
    const toolFor = (key: string) => (key === 'c90' ? chamfer : key === 'wide' ? wide : null);
    const opts = goalEdgeBreakOptions(job({ widthMm: 1 }), toolFor, ['c90', 'wide']);
    expect(opts.edgeBreak?.reachMm).toBe(3);
    expect(opts.edgeBreak?.legMm).toBeCloseTo((3 - 0.05) / 1, 9);
  });
});
