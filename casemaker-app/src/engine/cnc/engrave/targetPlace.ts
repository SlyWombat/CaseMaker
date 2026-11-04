/**
 * WHERE A TARGET MESH SITS IN THE WORK FRAME (#722, #723 part 2) — one definition, shared by the
 * goal sampler (`engrave/goalHeightfield.ts`) and the rim extractor (#829, `engrave/targetRim.ts`).
 *
 * The mesh's LOCAL points are scaled about its bbox centre (X/Y) and its top (Z), turned about
 * that same centre by the object's three Euler turns (Z first, then Y, then X — `rotationMatrix`'s
 * matrix, the one the viewport's Euler prop applies), and placed with the TURNED box's centre in
 * X/Y at `position` and its top at `position.z`. For a Z-only or unturned object this is exactly
 * the original contract.
 */

import type { EngraveTargetObject } from '@/types/engraveJob';
import type { ParsedMesh } from '@/engine/import/stlParser';
import { applyMat, rotatedExtents, rotationMatrix, targetScale, targetTurns } from './targetScale';

/** The fields of a target object that decide where its mesh sits. */
export type PlacementTarget = Pick<
  EngraveTargetObject,
  'format' | 'position' | 'rotation' | 'rotationX' | 'rotationY' | 'scale'
>;

export interface PlacedTarget {
  /** A mesh-local point → the work frame, mm; the turned box's top is at `position.z`. */
  place: (px: number, py: number, pz: number) => [number, number, number];
  /** The placed mesh's extents, mm (scaled, before the turn). */
  size: { x: number; y: number; z: number };
  /** The turned box's Z extent: the placed bottom is `position.z − extentsZ`. */
  extentsZ: number;
}

export function placeTarget(target: PlacementTarget, mesh: Pick<ParsedMesh, 'bbox'>): PlacedTarget {
  const cx = (mesh.bbox.min[0] + mesh.bbox.max[0]) / 2;
  const cy = (mesh.bbox.min[1] + mesh.bbox.max[1]) / 2;
  const cz = (mesh.bbox.min[2] + mesh.bbox.max[2]) / 2;
  // #722 — the scale applies about the same anchor as the placement (bbox centre in X/Y, the top
  // in Z), BEFORE the turn, so a scaled object stays centred on `position` with its top there.
  const scale = targetScale(target);
  const turns = targetTurns(target);
  const m = rotationMatrix(turns);
  const size = {
    x: (mesh.bbox.max[0] - mesh.bbox.min[0]) * scale.x,
    y: (mesh.bbox.max[1] - mesh.bbox.min[1]) * scale.y,
    z: (mesh.bbox.max[2] - mesh.bbox.min[2]) * scale.z,
  };
  const extentsZ = rotatedExtents(size, turns).z;
  const place = (px: number, py: number, pz: number): [number, number, number] => {
    // Scaled about the bbox centre, then turned, then placed with the turned bbox's centre in X/Y
    // at `position` and its top at `position.z`.
    const q = applyMat(m, {
      x: (px - cx) * scale.x,
      y: (py - cy) * scale.y,
      z: (pz - cz) * scale.z,
    });
    return [target.position.x + q.x, target.position.y + q.y, target.position.z - extentsZ / 2 + q.z];
  };
  return { place, size, extentsZ };
}
