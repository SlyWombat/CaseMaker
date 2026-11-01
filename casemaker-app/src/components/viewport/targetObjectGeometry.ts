/**
 * #876 — THE TARGET MESH'S GEOMETRY, built the way the viewport draws it.
 *
 * Extracted from `TargetObjectMesh` when the place-on-face picker needed the same geometry: the
 * engine's parse (`targetObjectMesh`) is already cached by SHA-256, so a second component pays only
 * for its own BufferGeometry. Local origin is the bbox centre in X/Y and its TOP in Z, so the
 * row's placement is the mesh's position with no second offset anywhere.
 */
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

import { targetObjectMesh } from '@/engine/import/targetObject';
import type { EngraveTargetObject } from '@/types/engraveJob';

export function useTargetGeometry(
  target: Pick<EngraveTargetObject, 'sha256' | 'format' | 'data'>,
): THREE.BufferGeometry | null {
  const { sha256, format, data } = target;
  const geom = useMemo(() => {
    try {
      const parsed = targetObjectMesh({ sha256, format, data });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(parsed.positions, 3));
      g.setIndex(new THREE.BufferAttribute(parsed.indices, 1));
      g.computeVertexNormals();
      const cx = (parsed.bbox.min[0] + parsed.bbox.max[0]) / 2;
      const cy = (parsed.bbox.min[1] + parsed.bbox.max[1]) / 2;
      g.translate(-cx, -cy, -parsed.bbox.max[2]);
      return g;
    } catch {
      // A malformed embedded document draws nothing rather than taking the viewport down.
      return null;
    }
  }, [sha256, format, data]);
  useEffect(() => () => geom?.dispose(), [geom]);
  return geom;
}
