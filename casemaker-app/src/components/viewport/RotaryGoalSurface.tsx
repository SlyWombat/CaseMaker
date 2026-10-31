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

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import type { RotaryMap } from '@/engine/cnc/rotary/wrap';
import type { EngraveJob } from '@/types/engraveJob';
import { rotaryGoalPreviewField, rotaryGoalSurfaceGeometry, rotaryGoalTarget } from './rotaryGoalPreview';
import { wrapMapGeometry } from './rotaryStockView';

export interface RotaryGoalSurfaceProps {
  job: EngraveJob;
  rotary: RotaryMap;
  /** The radius to wrap onto in the Stock view; `null` keeps the Map view's flat frame. */
  wrapRadius: number | null;
}

export function RotaryGoalSurface({ job, rotary, wrapRadius }: RotaryGoalSurfaceProps) {
  const target = rotaryGoalTarget(job);
  // #808 — THE BYTES ARRIVE AFTER THE HASH. `rotaryGoalTarget` is null while `target.data` is
  // undefined (#720 keeps the bytes in a blob store and re-attaches them asynchronously), and its
  // deps below are the hash, the placement and the radius — none of which changes when the bytes
  // arrive. Without this flag the memo kept its cached null and the goal never drew on the map:
  // the #723 R-4 e2e's 1-in-3 flat sheet (the target was loaded and the preview `ready`; the
  // surface had simply never been sampled).
  const hasTarget = target !== null;
  const field = useMemo(
    () => (target === null ? null : rotaryGoalPreviewField(target, rotary.radius)),
    // The mesh and its placement, not the whole job: a label edit must not resample a large mesh.
    // `hasTarget` is the bytes' arrival, which the other keys cannot see (#808).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasTarget, target?.sha256, target?.position, target?.scale, rotary.radius],
  );
  const mapGeom = useMemo(() => (field === null ? null : rotaryGoalSurfaceGeometry(field)), [field]);
  const geometry = useMemo(
    () => (mapGeom === null ? null : wrapRadius === null ? mapGeom : wrapMapGeometry(mapGeom, wrapRadius)),
    [mapGeom, wrapRadius],
  );

  // #808 — DISPOSE REPLACED BUFFERS, NEVER THE LIVE ONE IN A CLEANUP. React StrictMode runs a
  // mount's cleanup immediately after its setup, so disposing from an effect keyed to the live
  // geometry deleted the buffer the mesh was still drawing with: the relief vanished from the map
  // and the parts of the picture were gone until something re-rendered the tree (switching
  // Stock | Map brought it back). Each buffer is freed when a NEW one replaces it; the last one is
  // released with the canvas context, which lives as long as the app does.
  const previousMap = useRef<THREE.BufferGeometry | null>(null);
  useEffect(() => {
    const previous = previousMap.current;
    previousMap.current = mapGeom;
    if (previous !== null && previous !== mapGeom) previous.dispose();
  }, [mapGeom]);
  const previousGeometry = useRef<THREE.BufferGeometry | null>(null);
  useEffect(() => {
    const previous = previousGeometry.current;
    previousGeometry.current = geometry;
    if (previous !== null && previous !== mapGeom && previous !== geometry) previous.dispose();
  }, [geometry, mapGeom]);

  if (geometry === null) return null;
  return (
    <mesh geometry={geometry} name="engrave-rotary-goal" renderOrder={3} dispose={null}>
      {/* #723 R-4 review — the vertex colours carry the depth (crest pale, trough deep blue); the
          white base leaves them unmultiplied, and a little lift keeps the troughs legible under
          the stock's shadow. */}
      <meshStandardMaterial
        vertexColors
        color="#ffffff"
        emissive="#0a1a33"
        emissiveIntensity={0.35}
        metalness={0.1}
        roughness={0.65}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
