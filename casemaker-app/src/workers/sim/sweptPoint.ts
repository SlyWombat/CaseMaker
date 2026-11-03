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
 */

import type { Timeline } from '@/engine/cnc/emulator/timeline';
import type { Tool } from '@/engine/cnc/tool';

/** The page's move sampling, mm: one sample every 0.05 mm of XY travel plus |Δz|. */
const SAMPLE_MM = 0.05;
/** Samples above this Z are not stamped (the page's `q[:,2] < 0.05`). */
const STAMP_Z = 0.05;

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
    const tipR = shape === 'chamfer' ? 0 : (tool.tipDiameter ?? 0) / 2;
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
  const stamp = stampProfile(tool);
  const { nx, ny, x0, y0, pitch } = goal;
  const field = new Float32Array(nx * ny);
  const R = stamp.radius;
  const R2 = R * R;
  let stamped = 0;
  for (const cp of timeline.checkpoints) {
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
            if (d2 > R2) continue;
            const v = z + stamp.profile(Math.sqrt(d2));
            const k = rowBase + i2;
            if (v < field[k]!) field[k] = v;
            stamped++;
          }
        }
      }
    }
  }
  return stamped === 0 ? null : field;
}
