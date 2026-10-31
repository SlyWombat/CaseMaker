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

/**
 * #241 slice 3 — the turning group's rotation at `step`, radians: the A in force there (the last
 * vertex at or before the step), or 0 for a flat program, before the first A word, and in Unroll
 * (the map is already the opened surface; turning it would carry it out of its frame).
 *
 * An INDEXED job (R-4) holds one A per face, so while a face is played or scrubbed the stock sits
 * at that face's A and the face being cut is the one on top, as on the machine. Crossing an index
 * turn changes only this angle: the step, the clock and the checkpoint stay what the user chose.
 * The sign is the column engine's (`closestAngularOffset` / `rotaryMovesOf`, columnEngine.ts): +A
 * about +X brings the column at θ = A to the top.
 */
export function simTurningRadians(path: SimPath | null, step: number, mapView: boolean): number {
  if (path === null || mapView) return 0;
  const a = angleAtStep(path, step);
  return a === null ? 0 : turningRadians(a);
}

/**
 * #241 slice 3 — an INDEXED job's path carried into the STOCK frame, vertex by vertex, so it turns
 * with the material it cut.
 *
 * The path's vertices are tool tips in the WORK frame; the exact sweeper's material (stock, removal
 * ghost, gouges) is in the STOCK frame, each run's removal turned by `R_x(−a)` (`intoStockFrame`,
 * sweep.ts). The same turn is applied here per vertex, at that vertex's own A, so the group's
 * `R_x(+A(step))` puts the face being cut back exactly under the cutter, and every earlier face's
 * passes lie on that face. This is the column engine's sign (`closestAngularOffset` /
 * `rotaryMovesOf`, columnEngine.ts: a column at θ is under the tool when A = θ, `φ = θ − A`),
 * right-handed about +X: `y' = y·cos a + z·sin a`, `z' = −y·sin a + z·cos a`.
 *
 * A vertex with no A (NaN, before the first A word) is left where it is. A path with no `a` array
 * is returned as-is. A WRAPPED job does not come here: its drawing is unchanged by #241.
 */
export function stockFramePath(path: SimPath): SimPath {
  const a = path.a;
  if (a === undefined) return path;
  const xyz = new Float32Array(path.xyz);
  for (let i = 0; i < a.length; i++) {
    const deg = a[i] as number;
    if (Number.isNaN(deg) || deg === 0) continue;
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const y = xyz[i * 3 + 1] as number;
    const z = xyz[i * 3 + 2] as number;
    xyz[i * 3 + 1] = y * c + z * s;
    xyz[i * 3 + 2] = -y * s + z * c;
  }
  return { ...path, xyz };
}

/**
 * #241 slice 3 — the path the viewport DRAWS: an indexed job's in the stock frame
 * ({@link stockFramePath}), every other job's (flat, wrapped, or any job in Unroll) untouched — the
 * same object, so a wrapped or flat scene is exactly what it was.
 */
export function drawnSimPath(
  path: SimPath | null,
  rotaryClass: 'none' | 'indexed' | 'wrapped' | undefined,
  mapView: boolean,
): SimPath | null {
  return path !== null && rotaryClass === 'indexed' && !mapView ? stockFramePath(path) : path;
}
