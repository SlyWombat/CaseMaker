/**
 * #723 R-3 — THE GOAL ON A ROD, DRAWN IN BOTH VIEWS.
 *
 * The relief's surface comes from the same radial field the CAM reads (`rotaryGoalPreview.ts`).
 * In the Map view it is laid flat in the map frame; in the Stock view the SAME buffer is wrapped
 * onto the cylinder by the preview's own `wrapMapGeometry`, so the two views are one geometry (the
 * #716 rule) and a relief that reads one way on the map reads the same way on the rod.
 *
 * The rod stays visible as the stock it is: when a relief is drawn the cylinder is GHOSTED by its
 * owner (`EngravePreview`), because the part's surface sits INSIDE the rod (r = R + z, z ≤ 0) and
 * an opaque cylinder would hide exactly the thing the picture is for.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

import type { RotaryMap } from '@/engine/cnc/rotary/wrap';
import type { EngraveJob } from '@/types/engraveJob';
import { rotaryGoalPreviewField, rotaryGoalSurfaceGeometry, rotaryGoalTarget } from './rotaryGoalPreview';
import { wrapMapGeometry } from './rotaryStockView';

/** The part's surface colour — the target object's own, so the relief reads as the part. */
const GOAL_COLOR = '#8fb4ff';

export interface RotaryGoalSurfaceProps {
  job: EngraveJob;
  rotary: RotaryMap;
  /** The radius to wrap onto in the Stock view; `null` keeps the Map view's flat frame. */
  wrapRadius: number | null;
}

export function RotaryGoalSurface({ job, rotary, wrapRadius }: RotaryGoalSurfaceProps) {
  const target = rotaryGoalTarget(job);
  const field = useMemo(
    () => (target === null ? null : rotaryGoalPreviewField(target, rotary.radius)),
    // The mesh and its placement, not the whole job: a label edit must not resample a large mesh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target?.sha256, target?.position, target?.scale, rotary.radius],
  );
  const mapGeom = useMemo(() => (field === null ? null : rotaryGoalSurfaceGeometry(field)), [field]);
  const geometry = useMemo(
    () => (mapGeom === null ? null : wrapRadius === null ? mapGeom : wrapMapGeometry(mapGeom, wrapRadius)),
    [mapGeom, wrapRadius],
  );

  // The map geometry is ours to dispose; a wrapped copy is a second buffer with its own lifetime.
  useEffect(() => () => void mapGeom?.dispose(), [mapGeom]);
  useEffect(() => {
    const wrapped = geometry !== mapGeom ? geometry : null;
    return () => void wrapped?.dispose();
  }, [geometry, mapGeom]);

  if (geometry === null) return null;
  return (
    <mesh geometry={geometry} name="engrave-rotary-goal" renderOrder={3}>
      <meshStandardMaterial
        color={GOAL_COLOR}
        emissive="#0a1a33"
        emissiveIntensity={0.35}
        metalness={0.1}
        roughness={0.65}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
