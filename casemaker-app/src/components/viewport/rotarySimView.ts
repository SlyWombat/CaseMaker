/**
 * #716 slice 2 — THE ROTARY SIMULATION'S WORDS (design `rotary-flow.md` §3.9, R-UI-8).
 *
 * A rotary program's scrubber reads its A position as the angle WITHIN the turn plus the number of
 * turns (`A 154.5° · 3 turns`), never the unwound total alone (R9): the machine's own A is a degree
 * count that a multi-turn pass pushes past 360, and "1 234.5°" tells an operator nothing about
 * where on the stock the cut is. Z is a radius on a rotary job, so it reads "above the axis".
 *
 * The values come from the path's own `a` array (session `simPath`), read at the same vertex the
 * tool tip is read from — the two can never point at different steps.
 */
import type { SimPath } from '@/workers/sim/session';
import { vertexIndexAtStep } from './simGeometry';

// #769 — the A's words moved to `rotaryWords.ts` so the status strip can print them without
// pulling this module's path reading (and the simulation's geometry) in; re-exported here so the
// simulation's callers keep one import.
export { aboveAxisWords, rotaryAngleWords } from './rotaryWords';

/** The A axis at the last vertex whose step is ≤ `step`, degrees; null when absent or unknown. */
export function angleAtStep(path: SimPath, step: number): number | null {
  if (path.a === undefined) return null;
  const i = vertexIndexAtStep(path.step, step) - 1;
  if (i < 0) return null;
  const a = path.a[i];
  return a === undefined || Number.isNaN(a) ? null : a;
}

/**
 * The STOCK group's rotation about X for machine angle A, radians.
 *
 * The column engine's own convention is the authority: a column at stock angle θ (measured from
 * +Z toward +Y) is under the tool when A = θ (`closestAngularOffset` returns θ − A). A rotation
 * about +X by α sends θ to θ − α, so the group turns by **+A** and the stock point being cut at
 * this step sits at the top, under the cutter. A flat program (no A) turns by 0.
 */
export function turningRadians(unwoundDegrees: number): number {
  return (unwoundDegrees * Math.PI) / 180;
}
