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

/** #876 — which way a placed face ends up: down = the part's bottom, up = the face machined first. */
export type FaceDirection = 'down' | 'up';

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A rotation of `rad` about the unit `axis`, row-major (Rodrigues). */
function axisAngleMatrix(axis: Vec3, rad: number): Mat3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const t = 1 - c;
  const { x, y, z } = axis;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

function unit(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  return len > 1e-12 ? { x: v.x / len, y: v.y / len, z: v.z / len } : { x: 0, y: 0, z: 1 };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Rotate vector `v` by the row-major matrix `m`. */
function applyMatrix(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0]! * v.x + m[1]! * v.y + m[2]! * v.z,
    y: m[3]! * v.x + m[4]! * v.y + m[5]! * v.z,
    z: m[6]! * v.x + m[7]! * v.y + m[8]! * v.z,
  };
}

/**
 * #876 — THE TURNS THAT PUT A CHOSEN FACE ON ±Z. `localNormal` is the face's normal in the mesh's
 * own frame (as the face picker measured it) and `scale` the target's per-axis scale: a
 * non-uniform scale turns a normal by the INVERSE TRANSPOSE, not by R alone, so the placed normal
 * is `R · S⁻¹ · n`. The delta is the smallest world-axis rotation carrying that placed normal to
 * the chosen target — `down` puts the face at −Z (the part's bottom), `up` at +Z (the face
 * machined first) — composed exactly as `turnAboutAxis` composes, so the stored form never
 * changes and a face already facing the target leaves the turns untouched.
 */
export function turnsFacing(turns: TargetTurns, localNormal: Vec3, scale: Vec3, direction: FaceDirection): TargetTurns {
  const inv = (s: number): number => (Math.abs(s) > 1e-9 ? 1 / s : 1);
  const n = unit({ x: localNormal.x * inv(scale.x), y: localNormal.y * inv(scale.y), z: localNormal.z * inv(scale.z) });
  const w = unit(applyMatrix(rotationMatrix(turns), n));
  const target: Vec3 = direction === 'up' ? { x: 0, y: 0, z: 1 } : { x: 0, y: 0, z: -1 };
  const cos = Math.max(-1, Math.min(1, w.x * target.x + w.y * target.y + w.z * target.z));
  if (cos >= 1 - 1e-12) return { ...turns };
  let axis: Vec3;
  let angle: number;
  if (cos <= -1 + 1e-12) {
    // Exactly opposed: a half turn about any axis perpendicular to `w`. Pick a stable one, and
    // choose it BEFORE normalising — the cross with +Z is zero when w is itself ±Z.
    let perp = cross(w, { x: 0, y: 0, z: 1 });
    if (Math.hypot(perp.x, perp.y, perp.z) < 1e-6) perp = cross(w, { x: 1, y: 0, z: 0 });
    axis = unit(perp);
    angle = Math.PI;
  } else {
    axis = unit(cross(w, target));
    angle = Math.acos(cos);
  }
  return turnsFromMatrix(mul(axisAngleMatrix(axis, angle), rotationMatrix(turns)));
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
