import type { EngraveTargetObject } from '@/types/engraveJob';

/**
 * #722 — a mesh target's SCALE, the one transform every reader applies.
 *
 * `size` stays the PARSED bounding box (what the file says); `scale` multiplies it per axis about
 * the placement anchor (the bbox centre in X/Y, the TOP in Z), so the heightfield, the viewport
 * and the job's size checks all read the same placed size. A PNG relief has no scale: its `size`
 * IS its placed size (#672), so `targetScale` is 1 for it whatever the document holds.
 */
export interface TargetScale {
  x: number;
  y: number;
  z: number;
}

const UNIT: TargetScale = { x: 1, y: 1, z: 1 };

/** The per-axis factor a reader applies; absent (or a picture) is 1 on every axis. */
export function targetScale(target: Pick<EngraveTargetObject, 'format' | 'scale'>): TargetScale {
  if (target.format === 'png' || target.scale === undefined) return UNIT;
  return target.scale;
}

/** #723 part 2 — the mesh's three turns, in degrees, about its bbox centre (absent = 0). */
export interface TargetTurns {
  x: number;
  y: number;
  z: number;
}

export function targetTurns(
  target: Pick<EngraveTargetObject, 'rotation' | 'rotationX' | 'rotationY'>,
): TargetTurns {
  return { x: target.rotationX ?? 0, y: target.rotationY ?? 0, z: target.rotation };
}

/** A 3×3 rotation, row-major. */
export type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

const DEG = Math.PI / 180;

/**
 * The matrix for the three turns, `Rx(x)·Ry(y)·Rz(z)`: Z is applied to the point first, then Y,
 * then X. This is exactly three.js's Euler order `"XYZ"` (`Matrix4.makeRotationFromEuler`), which
 * is the viewport's default `rotation` prop order, so the drawn mesh and the sampled heightfield
 * read the same turn (pinned against three's own matrix in the unit tests).
 */
export function rotationMatrix(turns: TargetTurns): Mat3 {
  const rx = turns.x * DEG;
  const ry = turns.y * DEG;
  const rz = turns.z * DEG;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  return [
    cy * cz, -cy * sz, sy,
    sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy,
    -cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy,
  ];
}

export function applyMat(m: Mat3, v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

/** The axis-aligned extents of a box `size` turned by `turns` about its centre, mm. */
export function rotatedExtents(
  size: { x: number; y: number; z: number },
  turns: TargetTurns,
): { x: number; y: number; z: number } {
  const m = rotationMatrix(turns);
  return {
    x: Math.abs(m[0]) * size.x + Math.abs(m[1]) * size.y + Math.abs(m[2]) * size.z,
    y: Math.abs(m[3]) * size.x + Math.abs(m[4]) * size.y + Math.abs(m[5]) * size.z,
    z: Math.abs(m[6]) * size.x + Math.abs(m[7]) * size.y + Math.abs(m[8]) * size.z,
  };
}

/**
 * The size the object occupies on the blank, mm: the parsed bbox times the scale, TURNED — the
 * axis-aligned extents the placed object actually covers (#723 part 2). For a Z-only or unturned
 * object this is `size × scale` exactly as before.
 */
export function placedSize(
  target: Pick<
    EngraveTargetObject,
    'format' | 'scale' | 'size' | 'rotation' | 'rotationX' | 'rotationY'
  >,
): { x: number; y: number; z: number } {
  const s = targetScale(target);
  return rotatedExtents(
    { x: target.size.x * s.x, y: target.size.y * s.y, z: target.size.z * s.z },
    targetTurns(target),
  );
}

/**
 * The work-frame footprint of a box `w × h` turned `rotationDeg` about its centre, mm: the
 * axis-aligned extents the heightfield grid and the stock actually see. Kept for callers that
 * speak only the Z turn; `rotatedExtents` is the general form.
 */
export function turnedFootprint(w: number, h: number, rotationDeg: number): { x: number; y: number } {
  const e = rotatedExtents({ x: w, y: h, z: 1 }, { x: 0, y: 0, z: rotationDeg });
  return { x: e.x, y: e.y };
}

/**
 * The largest UNIFORM scale that fits the stock (#722 "Fit to the stock"): the TURNED extents
 * inside the stock less the edge margin on every side, and the height no more than the stock's
 * thickness. Null when the stock leaves no room (margins eat the blank). `turns` accepts the Z
 * degrees alone (the pre-#723 callers) or all three turns.
 */
export function fitToStockScale(
  size: { x: number; y: number; z: number },
  stock: { length: number; width: number; thickness: number },
  edgeMarginMm: number,
  turns: number | TargetTurns = 0,
): number | null {
  const room = {
    x: stock.length - 2 * edgeMarginMm,
    y: stock.width - 2 * edgeMarginMm,
    z: stock.thickness,
  };
  if (!(room.x > 0 && room.y > 0 && room.z > 0)) return null;
  if (!(size.x > 0 && size.y > 0 && size.z > 0)) return null;
  // The extents scale linearly with a uniform scale, so the 1× turned extents set the limit.
  const turned = rotatedExtents(size, typeof turns === 'number' ? { x: 0, y: 0, z: turns } : turns);
  return Math.min(room.x / turned.x, room.y / turned.y, room.z / turned.z);
}

/**
 * The scale that makes one axis's placed size `targetMm`. Locked: every axis takes the same
 * factor (the aspect is kept). Unlocked: only that axis changes, so the object stretches.
 */
export function scaleForAxisSize(
  current: TargetScale,
  size: { x: number; y: number; z: number },
  axis: 'x' | 'y' | 'z',
  targetMm: number,
  locked: boolean,
): TargetScale | null {
  if (!(targetMm > 0) || !(size[axis] > 0)) return null;
  const factor = targetMm / size[axis];
  if (locked) return { x: factor, y: factor, z: factor };
  return { ...current, [axis]: factor };
}

/** True when every axis carries the same factor, the state the row shows as aspect-locked. */
export function isUniform(scale: TargetScale): boolean {
  return Math.abs(scale.x - scale.y) < 1e-9 && Math.abs(scale.x - scale.z) < 1e-9;
}
