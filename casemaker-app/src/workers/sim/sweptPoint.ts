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
  goal: { nx: number; ny: number; x0: number; y0: number; pitch: number },
  timeline: Timeline,
  toolAt: StampToolAt,
): StampedTop | null {
  const { nx, ny, x0, y0, pitch } = goal;
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
        const iLo = Math.max(0, Math.round((qx - R - x0) / pitch));
        const iHi = Math.min(nx - 1, Math.round((qx + R - x0) / pitch));
        const jLo = Math.max(0, Math.round((qy - R - y0) / pitch));
        const jHi = Math.min(ny - 1, Math.round((qy + R - y0) / pitch));
        if (iLo > iHi || jLo > jHi) continue;
        for (let j = jLo; j <= jHi; j++) {
          const ddy = y0 + j * pitch - qy;
          const rowBase = j * nx;
          for (let i2 = iLo; i2 <= iHi; i2++) {
            const ddx = x0 + i2 * pitch - qx;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 >= Rin2) continue;
            const v = z + stamp.profile(Math.sqrt(d2));
            const k = rowBase + i2;
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
  goal: { nx: number; ny: number; x0: number; y0: number; pitch: number },
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
  goal: { nx: number; ny: number; x0: number; y0: number; pitch: number },
  timeline: Timeline,
  toolAt: StampToolAt,
): StampedTop | null {
  return stampField(goal, timeline, toolAt);
}
