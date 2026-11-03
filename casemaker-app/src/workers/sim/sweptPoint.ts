/**
 * #948 — THE PAGE'S OWN SWEPT-TOP READ, point for point.
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
 * the session's conservative `sweptTop` for cut-into, and this one — the page's own rule — for
 * the leftover bands and the pass line.
 *
 * The points are the same points the page evaluates: each move is sampled on the page's own grid
 * (`k = ⌈(length + |Δz|)/0.05⌉` equal steps, samples below 0.05 mm only), and a sample stamps the
 * disc of radius R with its profile. A move is indexed into every 1 mm cell its disc-swept
 * footprint touches, so a query looks at the moves near its own cell only.
 */

import type { Timeline } from '@/engine/cnc/emulator/timeline';
import type { Tool } from '@/engine/cnc/tool';
import type { ResultTop } from '@/engine/cnc/engrave/goalCoverage';

/** The page's move sampling, mm: one sample every 0.05 mm of XY travel plus |Δz|. */
const SAMPLE_MM = 0.05;
/** Samples above this Z are not stamped (the page's `q[:,2] < 0.05`). */
const STAMP_Z = 0.05;
/** The spatial index's cell, mm — at least the largest cutter radius, so a query's own cell holds
 * every move whose disc can reach it. */
const CELL_MM = 1;

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

interface Move {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

/**
 * The page's swept top as a work-frame sampler, built from the timeline the session already holds:
 * every cutting move, index by 1 mm cell. Null when the program has no cutting move at all, and
 * when the tool is unknown (the page names the cutter from the file's own tool comment; a session
 * with no tool cannot).
 */
export function exactSweptTop(timeline: Timeline, tool: Tool | null): ResultTop | null {
  if (tool === null) return null;
  const stamp = stampProfile(tool);
  const moves: Move[] = [];
  for (const cp of timeline.checkpoints) {
    for (let m = 0; m < cp.steps.length; m++) {
      const move: Move = {
        x0: cp.xy[m * 4] as number,
        y0: cp.xy[m * 4 + 1] as number,
        z0: cp.zs[m * 2] as number,
        x1: cp.xy[m * 4 + 2] as number,
        y1: cp.xy[m * 4 + 3] as number,
        z1: cp.zs[m * 2 + 1] as number,
      };
      // The page's own gate: a move whose lowest end is at or above the stamp plane never cuts.
      if (Math.min(move.z0, move.z1) >= STAMP_Z) continue;
      moves.push(move);
    }
  }
  if (moves.length === 0) return null;

  // Index every move into the cells its disc-swept bounds touch, so a query only looks at its own.
  const index = new Map<string, Move[]>();
  const key = (ix: number, iy: number): string => `${ix},${iy}`;
  const pad = stamp.radius + STAMP_Z * 0 + SAMPLE_MM;
  for (const m of moves) {
    const xLo = Math.floor((Math.min(m.x0, m.x1) - pad) / CELL_MM);
    const xHi = Math.floor((Math.max(m.x0, m.x1) + pad) / CELL_MM);
    const yLo = Math.floor((Math.min(m.y0, m.y1) - pad) / CELL_MM);
    const yHi = Math.floor((Math.max(m.y0, m.y1) + pad) / CELL_MM);
    for (let ix = xLo; ix <= xHi; ix++) {
      for (let iy = yLo; iy <= yHi; iy++) {
        const k = key(ix, iy);
        const list = index.get(k);
        if (list === undefined) index.set(k, [m]);
        else list.push(m);
      }
    }
  }

  return (x, y) => {
    const near = index.get(key(Math.floor(x / CELL_MM), Math.floor(y / CELL_MM)));
    // No move's disc reaches this point: the stock's own top stands.
    if (near === undefined) return 0;
    let top = 0;
    for (const m of near) {
      const dx = m.x1 - m.x0;
      const dy = m.y1 - m.y0;
      const dz = m.z1 - m.z0;
      const len2 = dx * dx + dy * dy;
      // The page's sample grid along the move: k equal steps over the whole move.
      const steps = Math.max(1, Math.ceil((Math.hypot(dx, dy) + Math.abs(dz)) / SAMPLE_MM));
      // The sample indices whose point can lie within the cutter's radius of the query.
      let iLo: number;
      let iHi: number;
      if (len2 < 1e-12) {
        const d0 = Math.hypot(x - m.x0, y - m.y0);
        if (d0 > stamp.radius) continue;
        iLo = 0;
        iHi = 0;
      } else {
        const c = (m.x0 - x) * (m.x0 - x) + (m.y0 - y) * (m.y0 - y) - stamp.radius * stamp.radius;
        const b = 2 * ((m.x0 - x) * dx + (m.y0 - y) * dy);
        const a = len2;
        const disc = b * b - 4 * a * c;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc);
        const tLo = Math.max(0, (-b - sq) / (2 * a));
        const tHi = Math.min(1, (-b + sq) / (2 * a));
        if (tLo > tHi) continue;
        iLo = Math.max(0, Math.ceil(tLo * steps - 1e-9));
        iHi = Math.min(steps, Math.floor(tHi * steps + 1e-9));
      }
      for (let i = iLo; i <= iHi; i++) {
        const t = i / steps;
        const z = m.z0 + dz * t;
        if (z >= STAMP_Z) continue;
        const qx = m.x0 + dx * t;
        const qy = m.y0 + dy * t;
        const d = Math.hypot(x - qx, y - qy);
        if (d > stamp.radius) continue;
        const v = z + stamp.profile(d);
        if (v < top) top = v;
      }
    }
    return top;
  };
}
