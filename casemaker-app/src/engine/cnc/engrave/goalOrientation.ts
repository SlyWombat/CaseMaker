import type { EngraveTargetObject } from '@/types/engraveJob';
import {
  rotatedExtents,
  rotationMatrix,
  targetScale,
  targetTurns,
  type Mat3,
  type TargetTurns,
} from '@/engine/cnc/engrave/targetScale';

/**
 * #831 — TURNING A GOAL TO FIT THE STOCK.
 *
 * The model is the one #723 part 2 already stores: three Euler angles in degrees, order "XYZ"
 * (`rotationX`, `rotationY`, `rotation` = Z), the order three.js draws with, so the sampler, the
 * preview worker and the viewport read one matrix (`rotationMatrix`). Euler degrees rather than a
 * quaternion because they are what the operator types and what the document has always held; a
 * turn about a WORLD axis (the +90° buttons, the on-canvas rings) is composed as a matrix here and
 * written back as the three angles, so the stored form never changes.
 */

const EPS = 1e-6;
type Axis = 'x' | 'y' | 'z';

function mul(a: Mat3, b: Mat3): Mat3 {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
    }
  }
  return r as unknown as Mat3;
}

/** A clean angle: rounded to a millionth of a degree, in (−180, 180], never −0. */
function cleanDeg(rad: number): number {
  let d = Math.round(((rad * 180) / Math.PI) * 1e6) / 1e6;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d === 0 ? 0 : d;
}

/** The "XYZ" Euler angles of a rotation matrix (three.js's `Euler.setFromRotationMatrix`), degrees. */
export function turnsFromMatrix(m: Mat3): TargetTurns {
  const m13 = Math.max(-1, Math.min(1, m[2]));
  const y = Math.asin(m13);
  if (Math.abs(m13) < 0.9999999) {
    return { x: cleanDeg(Math.atan2(-m[5], m[8])), y: cleanDeg(y), z: cleanDeg(Math.atan2(-m[1], m[0])) };
  }
  return { x: cleanDeg(Math.atan2(m[7], m[4])), y: cleanDeg(y), z: 0 };
}

/** `turns` followed by a further turn of `deg` about the WORLD (stock) axis `axis`. */
export function turnAboutAxis(turns: TargetTurns, axis: Axis, deg: number): TargetTurns {
  const r = rotationMatrix({ x: axis === 'x' ? deg : 0, y: axis === 'y' ? deg : 0, z: axis === 'z' ? deg : 0 });
  return turnsFromMatrix(mul(r, rotationMatrix(turns)));
}

/** The patch that stores `turns` the way the row always has: 0 about X or Y is an absent key. */
export function turnsPatch(turns: TargetTurns): {
  rotation: number;
  rotationX: number | undefined;
  rotationY: number | undefined;
} {
  return {
    rotation: turns.z,
    rotationX: turns.x === 0 ? undefined : turns.x,
    rotationY: turns.y === 0 ? undefined : turns.y,
  };
}

/** The 24 axis-aligned orientations of a box, as "XYZ" Euler turns, in a fixed order. */
export const AXIS_ALIGNED_TURNS: readonly TargetTurns[] = (() => {
  const out: TargetTurns[] = [];
  const seen = new Set<string>();
  const q = [0, 90, 180, -90];
  for (const x of q) {
    for (const y of q) {
      for (const z of q) {
        const m = rotationMatrix({ x, y, z });
        const key = m.map((v) => Math.round(v)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(turnsFromMatrix(m));
      }
    }
  }
  return out;
})();

/** The angle of the one turn that carries orientation `a` to `b`, degrees (0–180). */
function angleBetween(a: TargetTurns, b: TargetTurns): number {
  const ma = rotationMatrix(a);
  const mb = rotationMatrix(b);
  // trace(Mb · Maᵀ) = Σ mb[i][j]·ma[i][j]
  let tr = 0;
  for (let i = 0; i < 9; i++) tr += mb[i]! * ma[i]!;
  return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
}

export interface LayFlatChoice {
  /** The chosen orientation. */
  turns: TargetTurns;
  /** The placed height in that orientation at the current scale, mm. */
  depthMm: number;
  /** The placed height as it stands now, mm. */
  currentDepthMm: number;
  /** True when the choice is a different orientation from the current one. */
  changes: boolean;
}

/**
 * "LAY IT FLAT": among the 24 axis-aligned orientations, the one with the least height over the
 * stock. Ties (the same face down, turned about Z or flipped) go to the one whose footprint fits
 * the blank's room best (the largest uniform scale that fits X and Y), then to the one nearest the
 * current orientation, so a part already lying flat is left alone.
 */
export function chooseLayFlat(
  target: Pick<EngraveTargetObject, 'format' | 'scale' | 'size' | 'rotation' | 'rotationX' | 'rotationY'>,
  room?: { x: number; y: number } | null,
): LayFlatChoice {
  const s = targetScale(target);
  const size = { x: target.size.x * s.x, y: target.size.y * s.y, z: target.size.z * s.z };
  const current = targetTurns(target);
  const currentDepthMm = rotatedExtents(size, current).z;
  let best: { turns: TargetTurns; depth: number; fit: number; angle: number } | null = null;
  for (const turns of AXIS_ALIGNED_TURNS) {
    const e = rotatedExtents(size, turns);
    const fit = room && room.x > 0 && room.y > 0 ? Math.min(room.x / e.x, room.y / e.y) : 0;
    const angle = angleBetween(current, turns);
    const cand = { turns, depth: e.z, fit, angle };
    if (best === null) {
      best = cand;
      continue;
    }
    const tol = EPS * Math.max(1, best.depth);
    if (cand.depth < best.depth - tol) best = cand;
    else if (Math.abs(cand.depth - best.depth) <= tol) {
      if (cand.fit > best.fit * (1 + EPS)) best = cand;
      else if (Math.abs(cand.fit - best.fit) <= best.fit * EPS && cand.angle < best.angle - EPS) best = cand;
    }
  }
  const chosen = best!;
  // Lying flat already (the current orientation is as shallow): keep it exactly as it is.
  if (currentDepthMm <= chosen.depth + EPS * Math.max(1, chosen.depth)) {
    return { turns: current, depthMm: currentDepthMm, currentDepthMm, changes: false };
  }
  return { turns: chosen.turns, depthMm: chosen.depth, currentDepthMm, changes: angleBetween(current, chosen.turns) > EPS };
}

/** The suggestion threshold: the goal stands this many times deeper than it could lie. */
export const LAY_FLAT_SUGGEST_RATIO = 1.5;

/**
 * The words for the turn from `from` to `to`: "Turned 90° about X" when it is one turn about one
 * stock axis, otherwise the angles it now has.
 */
export function describeTurn(from: TargetTurns, to: TargetTurns): string {
  const AXES = ['x', 'y', 'z'] as const;
  const DEGS = [90, -90, 180];
  for (const axis of AXES) {
    for (const deg of DEGS) {
      if (angleBetween(turnAboutAxis(from, axis, deg), to) < 1e-4) {
        return `Turned ${deg}° about ${axis.toUpperCase()}`;
      }
    }
  }
  // Two quarter (or half) turns about two different stock axes, in the order they are made.
  for (const a1 of AXES) {
    for (const d1 of DEGS) {
      const mid = turnAboutAxis(from, a1, d1);
      for (const a2 of AXES) {
        if (a2 === a1) continue;
        for (const d2 of DEGS) {
          if (angleBetween(turnAboutAxis(mid, a2, d2), to) < 1e-4) {
            return `Turned ${d1}° about ${a1.toUpperCase()}, then ${d2}° about ${a2.toUpperCase()}`;
          }
        }
      }
    }
  }
  return `Turned to ${fmtDeg(to.x)}° about X, ${fmtDeg(to.y)}° about Y and ${fmtDeg(to.z)}° about Z`;
}

const fmtDeg = (n: number): string => `${Number(n.toFixed(2))}`;

/** Snap an angle to `step` degrees (no snap when step is 0). */
export function snapDeg(deg: number, step: number): number {
  return step > 0 ? Math.round(deg / step) * step : deg;
}
