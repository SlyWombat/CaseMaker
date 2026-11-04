/**
 * #876 — PLACE ON FACE: the goal mesh's near-flat regions, under the pointer.
 *
 * Armed from the goal row's "Face down" / "Face up first" press. While armed, an invisible
 * pick mesh (the same geometry and placement the target is drawn with) follows the pointer:
 * the largest near-flat regions ({@link goalFaceRegions}, ranked by area, the top
 * {@link TOP_REGIONS}) highlight, and a click turns the chosen face's normal to −Z (down, the
 * part's bottom) or +Z (up, the face machined first) through `turnsFacing`, remembering the
 * placement for Undo. A click on a region below the top N still places — its region's mean
 * normal is the point fallback, so a mesh with no large flats is still usable.
 *
 * A press that turned into an orbit (the pointer moved more than {@link PRESS_SLOP_PX}) places
 * nothing: turning the view must not turn the part.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';

import { useEngraveJobStore } from '@/store/engraveJobStore';
import { rememberGoalPlacement } from '@/store/goalTransformUndo';
import { useViewportStore } from '@/store/viewportStore';
import { isMold } from '@/engine/cnc/engrave/goalHeightfield';
import { turnsFacing, turnsPatch, type FaceDirection } from '@/engine/cnc/engrave/goalOrientation';
import { targetPlacement, targetScale, targetTurns } from '@/engine/cnc/engrave/targetScale';
import type { EngraveTargetObject } from '@/types/engraveJob';
import { goalFaceRegions, TOP_REGIONS, type GoalFaceMap } from './goalFacePick';
import { useTargetGeometry } from './targetObjectGeometry';

const HIGHLIGHT = '#ffd267';
/** A pointer that moved more than this between press and release orbited the view, not a pick. */
export const PRESS_SLOP_PX = 6;

/** The highlight geometry for one region: its triangles as a plain (non-indexed) position list. */
function regionGeometry(geom: THREE.BufferGeometry, map: GoalFaceMap, region: number): THREE.BufferGeometry {
  const pos = geom.getAttribute('position');
  const index = geom.getIndex();
  const out = new Float32Array(map.regions[region]!.triangles.length * 9);
  let o = 0;
  for (const t of map.regions[region]!.triangles) {
    for (let k = 0; k < 3; k++) {
      const v = index === null ? t * 3 + k : index.getX(t * 3 + k);
      out[o++] = pos.getX(v);
      out[o++] = pos.getY(v);
      out[o++] = pos.getZ(v);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  return g;
}

export function GoalFacePicker({ target, direction }: { target: EngraveTargetObject; direction: FaceDirection }) {
  const geom = useTargetGeometry(target);
  const updateTargetObject = useEngraveJobStore((s) => s.updateTargetObject);
  const disarmPlaceFace = useViewportStore((s) => s.disarmPlaceFace);
  const map = useMemo(() => {
    if (geom === null) return null;
    const pos = geom.getAttribute('position');
    const index = geom.getIndex();
    return goalFaceRegions(
      pos.array as Float32Array,
      index === null ? null : (index.array as Uint32Array),
    );
  }, [geom]);
  const [hover, setHover] = useState<number | null>(null);
  const highlight = useMemo(
    () => (geom === null || map === null || hover === null ? null : regionGeometry(geom, map, hover)),
    [geom, map, hover],
  );
  useEffect(() => () => highlight?.dispose(), [highlight]);
  const press = useRef<{ x: number; y: number } | null>(null);

  if (geom === null || map === null) return null;
  const mold = isMold(target) && (target.role ?? 'reference') === 'goal';
  const placement = targetPlacement(target, mold ? 'mold' : 'item');
  const top = new Set(map.ranked.slice(0, TOP_REGIONS));
  const regionAt = (faceIndex: number | null | undefined): number | null => {
    if (faceIndex === undefined || faceIndex === null) return null;
    const r = map.regionOf[faceIndex] ?? -1;
    return r >= 0 ? r : null;
  };

  const over = (e: ThreeEvent<PointerEvent>): void => {
    e.stopPropagation();
    const r = regionAt(e.faceIndex);
    // Only the largest regions are offered; a smaller facet stays unlit but is still clickable
    // (the fallback below), so the highlight never promises a pick the click would refuse.
    setHover(r !== null && top.has(r) ? r : null);
  };

  const place = (r: number): void => {
    const turns = turnsFacing(targetTurns(target), map.regions[r]!.normal, targetScale(target), direction);
    rememberGoalPlacement(target);
    updateTargetObject(turnsPatch(turns));
    disarmPlaceFace();
  };

  const down = (e: ThreeEvent<PointerEvent>): void => {
    e.stopPropagation();
    press.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
  };
  const up = (e: ThreeEvent<PointerEvent>): void => {
    e.stopPropagation();
    const start = press.current;
    press.current = null;
    if (start === null) return;
    if (Math.hypot(e.nativeEvent.clientX - start.x, e.nativeEvent.clientY - start.y) > PRESS_SLOP_PX) return;
    const r = regionAt(e.faceIndex);
    if (r !== null) place(r);
  };

  return (
    <group position={[placement.at.x, placement.at.y, placement.at.z]}>
      <group
        rotation={[placement.turns.x * (Math.PI / 180), placement.turns.y * (Math.PI / 180), placement.turns.z * (Math.PI / 180)]}
        scale={[placement.scale.x, placement.scale.y, placement.scale.z]}
      >
        <mesh
          geometry={geom}
          name="engrave-goal-face-pick"
          onPointerMove={over}
          onPointerLeave={() => setHover(null)}
          onPointerDown={down}
          onPointerUp={up}
        >
          {/* Invisible to the eye, still raycastable: opacity 0 does not hide an object from the
              pointer, while `visible={false}` would. */}
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
        {highlight !== null && (
          <mesh geometry={highlight} name="engrave-goal-face-highlight">
            <meshBasicMaterial
              color={HIGHLIGHT}
              transparent
              opacity={0.55}
              depthWrite={false}
              side={THREE.DoubleSide}
              polygonOffset
              polygonOffsetFactor={-2}
              polygonOffsetUnits={-2}
            />
          </mesh>
        )}
      </group>
    </group>
  );
}
