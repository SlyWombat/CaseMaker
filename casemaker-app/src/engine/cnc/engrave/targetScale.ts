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

/** The size the object occupies on the blank, mm: the parsed bbox times the scale. */
export function placedSize(
  target: Pick<EngraveTargetObject, 'format' | 'scale' | 'size'>,
): { x: number; y: number; z: number } {
  const s = targetScale(target);
  return { x: target.size.x * s.x, y: target.size.y * s.y, z: target.size.z * s.z };
}

/**
 * The work-frame footprint of a box `w × h` turned `rotationDeg` about its centre, mm: the
 * axis-aligned extents the heightfield grid and the stock actually see.
 */
export function turnedFootprint(w: number, h: number, rotationDeg: number): { x: number; y: number } {
  const t = (rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  return { x: w * c + h * s, y: w * s + h * c };
}

/**
 * The largest UNIFORM scale that fits the stock (#722 "Fit to the stock"): the TURNED footprint
 * inside the stock less the edge margin on every side, and the height no more than the stock's
 * thickness. Null when the stock leaves no room (margins eat the blank).
 */
export function fitToStockScale(
  size: { x: number; y: number; z: number },
  stock: { length: number; width: number; thickness: number },
  edgeMarginMm: number,
  rotationDeg = 0,
): number | null {
  const room = {
    x: stock.length - 2 * edgeMarginMm,
    y: stock.width - 2 * edgeMarginMm,
    z: stock.thickness,
  };
  if (!(room.x > 0 && room.y > 0 && room.z > 0)) return null;
  if (!(size.x > 0 && size.y > 0 && size.z > 0)) return null;
  // The footprint scales linearly with a uniform scale, so the 1× turned extents set the limit.
  const turned = turnedFootprint(size.x, size.y, rotationDeg);
  return Math.min(room.x / turned.x, room.y / turned.y, room.z / size.z);
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
