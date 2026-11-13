/**
 * #948 — THE PAGE'S OWN SWEPT-TOP READ, stamped onto the goal grid.
 *
 * The demo page's verdict is computed by `tools/goal_check.py`, which does NOT read a simulation
 * grid: it parses the posted program, walks every cutting move at 0.05 mm, and stamps the cut
 * shape onto each goal cell's own centre. A cell's swept top is the lowest value any passing
 * cutter leaves there — `z(sample) + profile(distance)`, with the profile the cutter's own
 * (flat: 0; ball: `R − √(R² − d²)`; cone: `(d − tip)/tan(halfAngle)`; drill: `d/tan(59°)`).
 *
 * The column grid's top answers a different question — a 0.1 mm piecewise-constant surface read
 * conservatively — which is right for cut-into (never claim a cell was gouged on the strength of
 * a neighbour) and wrong for leftover (the highest touching column reads the surface up to half a
 * cell high, and the coverage percentage moves with it). So the goal check carries TWO reads:
 * the session's conservative `sweptTop` for cut-into, and this one — the page's own stamp — for
 * the leftover bands and the pass line.
 *
 * It is computed as a FIELD on the goal grid, not per point: one Float32Array the size of the
 * goal (a few hundred KB on the biggest job), every move sampled on the page's own grid
 * (`k = ⌈(length + |Δz|)/0.05⌉` equal steps, samples below 0.05 mm only) and each sample's disc
 * stamped cell by cell. No move index, no retained geometry — the cost is the stamping loop and
 * the memory is the goal grid's own.
 *
 * #964 — the footprint's edge is STRICT (`distance < radius − 1e-6`): a cell centred exactly on
 * the disc's edge is not charged. See {@link EDGE_EPS_MM}.
 */

import type { Timeline, ToolState } from '@/engine/cnc/emulator/timeline';
import type { CutMove } from '@/workers/geometry/columnEngine';
import type { Tool } from '@/engine/cnc/tool';

/** The page's move sampling, mm: one sample every 0.05 mm of XY travel plus |Δz|. */
const SAMPLE_MM = 0.05;
/** Samples above this Z are not stamped (the page's `q[:,2] < 0.05`). */
const STAMP_Z = 0.05;
/**
 * #964 — THE FOOTPRINT'S EDGE. A cell is cut only where its centre lies STRICTLY inside the
 * cutter's disc: `distance < radius − this`. Counting `distance <= radius` charged the cells whose
 * centres sat exactly on the disc edge — and the part's contour is posted with the tool centre
 * offset by the radius, so its disc edge is tangent to the outline and every goal cell centred on
 * the outline read the full cutting depth (E's 134 phantom cells on #959; the Makera tray card
 * shows the same class). Zero-measure contact is not a cut. `goal_check.py` applies this same
 * rule, so the page and the app keep agreeing cell for cell.
 */
const EDGE_EPS_MM = 1e-6;

/**
 * #1251 — FLOAT SLACK when comparing the cut with the goal: an edge cell is not lowered when the
 * cut there would stand below the goal by more than this.
 */
const GOAL_AGREE_EPS_MM = 1e-6;

/**
 * The goal grid a stamp is measured on, plus #1251's optional edge rule: the goal's own height at
 * each cell (`z`, same indexing) and the band — one posted step — either side of the cutter's
 * edge. Both absent → the strict #964 edge, exactly as before.
 */
export interface StampGoal {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  pitch: number;
  /** The goal's height at each cell, same indexing as the field. */
  z?: Float32Array;
  /** The edge band, mm (one posted step): a cell within it either side of the cutter's edge is an edge cell. */
  edgeBandMm?: number;
}

interface StampProfile {
  /** The cutting radius the disc stamps at, mm. */
  radius: number;
  /** The rise from the tip at a distance `r` from the move's own point, mm. */
  profile(r: number): number;
}

/**
 * The cutter's stamp, exactly as `goal_check.py`'s `cutter()` reads it. A shape the page does not
 * model is a flat disc at the stated cutting diameter.
 */
export function stampProfile(tool: Tool): StampProfile {
  const shape = tool.shape;
  if (shape === 'engraving' || shape === 'chamfer') {
    const diameter = tool.diameter ?? 3.175;
    const ang = tool.halfAngle !== null && tool.halfAngle !== undefined ? 2 * tool.halfAngle : (tool.angle ?? 30);
    const tan = Math.tan((Math.PI * Math.abs(ang)) / 360);
    // #964 — THE STATED TIP IS THE TIP, for a chamfer as much as an engraver. Forcing 0 here made
    // the V stamp a sharp cone: at r < tipRadius ours read lower than the real 0.1 mm flat by up
    // to the tip radius, which flipped the per-cell `who` at ~10 000 cells in the tray's rim band
    // and under-counted the edge break (2.91 % against the page's 3.66 %).
    const tipR = (tool.tipDiameter ?? 0) / 2;
    return {
      radius: diameter / 2,
      profile: (r) => (r <= tipR ? 0 : (r - tipR) / tan),
    };
  }
  const diameter = tool.tipDiameter ?? tool.diameter ?? 1;
  const radius = diameter / 2;
  if (shape === 'ball') {
    return { radius, profile: (r) => radius - Math.sqrt(Math.max(radius * radius - r * r, 0)) };
  }
  if (shape === 'drill') {
    const tan = Math.tan((59 * Math.PI) / 180);
    return { radius, profile: (r) => r / tan };
  }
  return { radius, profile: () => 0 };
}

/** The stamp's result: the field, who left each cell's lowest reach (#964), and where. */
export interface StampedTop {
  /** `z[j*nx+i]`, the goal's own cell centres; unstamped cells read 0 (the stock's top). */
  field: Float32Array;
  /** Per cell, the tool NUMBER of the stamp that left the lowest reach — 0 when no cut. */
  who: Uint8Array;
  /**
   * #970/v5 — the CUTTER-LOCATION point (the tool's centre, XY) of the stamp that left the
   * cell's lowest reach, 0/0 when no cut. `checkGoalCutInto`'s v5 wall-shadow rule reads it:
   * a wall-shadow cell is excused only when the deepest cutter's CL stays at least the shadow
   * radius from the wall there (a stamp/disc artefact), or the V cut it within its leg.
   */
  clX: Float32Array;
  clY: Float32Array;
}

/** The cutter active for a checkpoint, or null when there is none to stamp with. */
export type StampToolAt = (tool: ToolState) => Tool | null;

function stampField(
  goal: StampGoal,
  timeline: Timeline,
  toolAt: StampToolAt,
): StampedTop | null {
  const { nx, ny, x0, y0, pitch } = goal;
  // #1251 — THE EDGE BAND: a cell within one posted step of the cutter's edge is an edge cell and
  // is judged by the goal; absent either member the stamp keeps #964's strict edge.
  const band = goal.z !== undefined && goal.edgeBandMm !== undefined ? goal.edgeBandMm : 0;
  const goalZ = band > 0 ? goal.z! : undefined;
  const field = new Float32Array(nx * ny);
  const who = new Uint8Array(nx * ny);
  const clX = new Float32Array(nx * ny);
  const clY = new Float32Array(nx * ny);
  const profiles = new Map<Tool, { stamp: StampProfile; number: number }>();
  const profileOf = (tool: Tool): { stamp: StampProfile; number: number } => {
    let p = profiles.get(tool);
    if (p === undefined) {
      p = { stamp: stampProfile(tool), number: Math.max(0, Math.min(255, tool.number ?? 0)) };
      profiles.set(tool, p);
    }
    return p;
  };
  let stamped = 0;
  for (const cp of timeline.checkpoints) {
    const tool = toolAt(cp.tool);
    if (tool === null) continue;
    const { stamp, number } = profileOf(tool);
    const R = stamp.radius;
    // #964 — a cell is cut only while its centre is STRICTLY inside the footprint.
    const Rin = Math.max(R - EDGE_EPS_MM, 0);
    const Rin2 = Rin * Rin;
    // #1251 — with a band the disc reaches one posted step past its edge, and the cells within
    // one posted step of the edge (either side) are edge cells.
    const reach = R + band;
    const Rout2 = reach * reach;
    const Rband2 = Math.max(R - band, 0) ** 2;
    for (let m = 0; m < cp.steps.length; m++) {
      const ax = cp.xy[m * 4] as number;
      const ay = cp.xy[m * 4 + 1] as number;
      const az = cp.zs[m * 2] as number;
      const bx = cp.xy[m * 4 + 2] as number;
      const by = cp.xy[m * 4 + 3] as number;
      const bz = cp.zs[m * 2 + 1] as number;
      if (Math.min(az, bz) >= STAMP_Z) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      const steps = Math.max(1, Math.ceil((Math.hypot(dx, dy) + Math.abs(dz)) / SAMPLE_MM));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const z = az + dz * t;
        if (z >= STAMP_Z) continue;
        const qx = ax + dx * t;
        const qy = ay + dy * t;
        const iLo = Math.max(0, Math.round((qx - reach - x0) / pitch));
        const iHi = Math.min(nx - 1, Math.round((qx + reach - x0) / pitch));
        const jLo = Math.max(0, Math.round((qy - reach - y0) / pitch));
        const jHi = Math.min(ny - 1, Math.round((qy + reach - y0) / pitch));
        if (iLo > iHi || jLo > jHi) continue;
        for (let j = jLo; j <= jHi; j++) {
          const ddy = y0 + j * pitch - qy;
          const rowBase = j * nx;
          for (let i2 = iLo; i2 <= iHi; i2++) {
            const ddx = x0 + i2 * pitch - qx;
            const d2 = ddx * ddx + ddy * ddy;
            if (band > 0) {
              if (d2 >= Rout2) continue; // beyond the edge band: never
            } else if (d2 >= Rin2) continue; // no band given: today's strict edge
            // #1251 — AT OR BEYOND THE EDGE THE PROFILE IS THE EDGE'S OWN HEIGHT (a point just
            // outside the disc is given the edge's height, a ball's R).
            const v = z + stamp.profile(Math.min(Math.sqrt(d2), R));
            const k = rowBase + i2;
            // #1251 — AN EDGE CELL IS NOT TAKEN BELOW THE GOAL: a floor cell at the edge counts as
            // reached, a wall cell at the edge is not gouged. Further inside the band always cuts.
            if (band > 0 && d2 >= Rband2 && v < goalZ![k]! - GOAL_AGREE_EPS_MM) continue;
            // #964 — TIES GO TO THE LATER STAMP, as `goal_check.py`'s `put` does (`Wf[z <= Hf] =
            // tn` AFTER `minimum.at`): a cell where the V and a flat cut to the same depth is the
            // V's, which is what makes the `who`-gated edge-break share match the page's.
            if (v <= field[k]!) {
              field[k] = v;
              who[k] = number;
              clX[k] = qx;
              clY[k] = qy;
            }
            stamped++;
          }
        }
      }
    }
  }
  return stamped === 0 ? null : { field, who, clX, clY };
}

/**
 * `goal_check.py`'s stamp as a field over the goal grid (`z[j*nx+i]`, the goal's own cell
 * centres). Unstamped cells read 0 — the stock's top, exactly as the page's `H = zeros` starts.
 * Null when the tool is unknown or no move cuts.
 */
export function exactSweptField(
  goal: StampGoal,
  timeline: Timeline,
  tool: Tool | null,
): Float32Array | null {
  if (tool === null) return null;
  return stampField(goal, timeline, () => tool)?.field ?? null;
}

/**
 * #964 — THE SAME STAMP WITH PER-CHECKPOINT CUTTERS, and the per-cell identity of the lowest
 * reach: `who[k]` is the tool NUMBER of whichever cutter's stamp took that cell deepest. A
 * multi-tool program (Makera's own tray NC runs four) stamps each checkpoint with the tool it
 * actually ran, exactly as `goal_check.py` does, so the edge-break allowance can gate on the
 * deepest cutter being the V bit. Null when nothing was stamped.
 */
export function exactSweptFieldTooled(
  goal: StampGoal,
  timeline: Timeline,
  toolAt: StampToolAt,
): StampedTop | null {
  return stampField(goal, timeline, toolAt);
}

/**
 * #1086 — THE PAGE'S STAMP IN THE ROTARY MAP FRAME. The goal is a radial field (X, arc → radius);
 * a cutting move's disc is stamped at each covered map cell as `tip + profile(h)`, with `h` the
 * distance from the move's point IN THE MAP PLANE — the X offset and the arc offset at the
 * design radius, exactly as the CAM's own tip field measures it (the relief is planned on the
 * unwrapped map, so this is the surface the program's gouge-safety was proven on). A cell takes
 * the LOWEST radius any passing sample leaves; a cell no sample reaches keeps the stock's own
 * radius at that row (`initial`). The page's per-move sampling (0.05 mm), the strict footprint
 * edge and the axis clamp are the flat stamp's own rules.
 */
export function stampRotarySweptField(
  goal: { nx: number; ny: number; x0: number; y0: number; pitch: number; radius: number },
  initial: (j: number) => number,
  moves: Iterable<CutMove>,
  profile: StampProfile,
): Float32Array | null {
  return stampRotarySweptFieldDetail(goal, initial, moves, profile)?.field ?? null;
}

/**
 * #1086 — THE ROTARY STAMP WITH ITS CUTTER LOCATION, the map frame's twin of {@link StampedTop}.
 * `clX` is the sample's map X, `clY` its map arc (mm at the design radius): the point at which the
 * cutter's tip stood when it left that cell's lowest remaining radius. The goal check's wall-shadow
 * rule reads it exactly as the flat check reads its own CL (v5, #970).
 */
export interface RotaryStampedTop {
  field: Float32Array;
  clX: Float32Array;
  clY: Float32Array;
}

export function stampRotarySweptFieldDetail(
  goal: { nx: number; ny: number; x0: number; y0: number; pitch: number; radius: number },
  initial: (j: number) => number,
  moves: Iterable<CutMove>,
  profile: StampProfile,
): RotaryStampedTop | null {
  const { nx, ny, x0, y0, pitch, radius } = goal;
  const field = new Float32Array(nx * ny);
  const clX = new Float32Array(nx * ny);
  const clY = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) field.fill(initial(j), j * nx, (j + 1) * nx);
  const reach = profile.radius;
  const Rin = Math.max(reach - EDGE_EPS_MM, 0);
  const Rin2 = Rin * Rin;
  let stamped = 0;
  for (const m of moves) {
    const za0 = m.z0 ?? m.z;
    const za1 = m.z1 ?? m.z;
    // A tip at or above the envelope removes nothing (no cell's radius can exceed it).
    if (Math.min(za0, za1) >= radius) continue;
    const dx = m.u1 - m.u0;
    // The map's y is arc at the design radius; the move's A is degrees about the axis.
    const dArcMove = (((m.v1 - m.v0) * Math.PI) / 180) * radius;
    const steps = Math.max(1, Math.ceil((Math.hypot(dx, dArcMove) + Math.abs(za1 - za0)) / SAMPLE_MM));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const z = za0 + (za1 - za0) * t;
      if (z >= radius) continue;
      const zs = Math.max(0, z); // the axis clamp: a dip below the axis cuts to the axis
      const qx = m.u0 + dx * t;
      const qArc = ((m.v0 + (m.v1 - m.v0) * t) * Math.PI * radius) / 180;
      const iLo = Math.max(0, Math.ceil((qx - reach - x0) / pitch));
      const iHi = Math.min(nx - 1, Math.floor((qx + reach - x0) / pitch));
      if (iLo > iHi) continue;
      const rows = Math.min(ny, Math.ceil(reach / pitch));
      const jC = Math.round((qArc - y0) / pitch);
      for (let dj = -rows; dj <= rows; dj++) {
        const j = (((jC + dj) % ny) + ny) % ny;
        const dArc = y0 + (jC + dj) * pitch - qArc;
        const arc2 = dArc * dArc;
        if (arc2 >= Rin2) continue;
        const rowBase = j * nx;
        for (let ii = iLo; ii <= iHi; ii++) {
          const ddx = x0 + ii * pitch - qx;
          const d2 = ddx * ddx + arc2;
          if (d2 >= Rin2) continue;
          const v = zs + profile.profile(Math.sqrt(d2));
          const k = rowBase + ii;
          if (v < field[k]!) {
            field[k] = v;
            clX[k] = qx;
            clY[k] = qArc;
          }
          stamped++;
        }
      }
    }
  }
  return stamped === 0 ? null : { field, clX, clY };
}
