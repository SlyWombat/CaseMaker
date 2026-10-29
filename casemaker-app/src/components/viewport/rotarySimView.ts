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

/** The A axis at the last vertex whose step is ≤ `step`, degrees; null when absent or unknown. */
export function angleAtStep(path: SimPath, step: number): number | null {
  if (path.a === undefined) return null;
  const i = vertexIndexAtStep(path.step, step) - 1;
  if (i < 0) return null;
  const a = path.a[i];
  return a === undefined || Number.isNaN(a) ? null : a;
}

/** `154.5` — one decimal at most, the units rule the rest of the map's numbers follow. */
function degrees(n: number): string {
  return Number(n.toFixed(1)).toString();
}

/**
 * `A 154.5° · 3 turns` — the unwound A reduced to (turns, angle within the turn). The angle is in
 * [0, 360); a negative unwound A keeps its sign on the turn count, so `A = turns·360 + within`
 * always holds and the pair is never a rounded lie.
 *
 * #716 review — round FIRST, then carry: 359.96° is one decimal from a whole turn, and printing
 * "A 360° · 0 turns" would name an angle outside the turn it claims. It becomes `A 0° · 1 turn`;
 * symmetrically -0.04° becomes `A 0° · 0 turns` rather than `A 360° · −1 turns`.
 */
export function rotaryAngleWords(unwoundDegrees: number): string {
  let turns = Math.floor(unwoundDegrees / 360);
  let within = Number((unwoundDegrees - turns * 360).toFixed(1));
  if (within >= 360) {
    within = 0;
    turns += 1;
  }
  return `A ${degrees(within)}° · ${turns} ${Math.abs(turns) === 1 ? 'turn' : 'turns'}`;
}

/** `above the axis 9.5 mm` — Z on a rotary job is the radius from the axis, not the blank's face. */
export function aboveAxisWords(z: number): string {
  return `above the axis ${degrees(z)} mm`;
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
