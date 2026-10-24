/**
 * #604 — the found position's scene transform: translate by the registration's offset, rotate by
 * its rotation. Pure so the viewport component and its spec share one arithmetic.
 */

export interface FoundPosition {
  offset: { x: number; y: number };
  rotationDeg: number | null;
}

export function foundTransform(found: FoundPosition | null): {
  position: [number, number, number];
  rotation: [number, number, number];
} {
  if (found === null) return { position: [0, 0, 0], rotation: [0, 0, 0] };
  return {
    position: [found.offset.x, found.offset.y, 0],
    rotation: [0, 0, found.rotationDeg === null ? 0 : found.rotationDeg * (Math.PI / 180)],
  };
}
