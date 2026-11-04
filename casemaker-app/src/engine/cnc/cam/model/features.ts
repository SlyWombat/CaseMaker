/**
 * cam/model/features.ts — planar-face/patch recognition (#958, A), feature recognition §1 of
 * `docs/design/cam-model-engine.md`.
 *
 * Shapes are A's own #958 comment (2026-11-03) §4, adopted as-is, plus `Rim.id` from A's N1
 * amendment. This file does not implement A's method (patches → levels → sections → booleans) —
 * `recogniseFeatures` is a stub for the skeleton; A's slice fills it in.
 */

import type { ParsedMesh } from '@/engine/import/stlParser';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { RegionRef } from './plan';

export interface FeatureSource {
  triangles: ParsedMesh;
  /** Per-triangle B-rep face id — STEP only. `faceId[i]` is the face triangle `i` came from. */
  faceId?: Uint32Array;
}

export interface SetupFrame {
  up: [number, number, number];
  stockTop: number;
}

/**
 * Patch/plane/mesh tolerances A's method reads (her §3: `tolPlane = 0.005 mm`, `tolAngle = 0.5°`
 * triangle-cluster growth, the STEP mesh read's `linearDeflection`). NEW — A's comment names these as
 * numbers in prose, not as a shape; this interface is this note's placeholder for them, A's to adjust.
 */
export interface FeatureTolerances {
  planarityMm: number;
  clusterAngleDeg: number;
  deflectionMm: number;
}

export interface PocketNode {
  id: string;
  floorZ: number;
  mouthZ: number;
  open: boolean;
  /** Cleared area at `floorZ`, islands as holes. May extend below `floorZ` where remainder continues (A's N2) — the pocket op must not assume the whole region is floor. */
  region: Polygons;
  islands: { outline: Polygons; topZ: number }[];
  children: PocketNode[];
  /** `RemainderRegion.id`s that continue below this node, per A's N2. */
  remainder: string[];
  /** Narrowest width, so the cutter-sequence cost model (#961) can pick the largest flat that fits. */
  narrowest: number;
  /**
   * True for a pocket component at the model's bottom inside the silhouette (A's #958 D2, interface
   * delta on comment 6620460283, e.g. the organizer's eleven through-holes at −22.80): the contour
   * op frees it, not the pocket op's own floor pass.
   */
  through: boolean;
}

export interface RemainderRegion {
  id: string;
  footprint: Polygons;
  zTop: number;
  zBottom: number;
  triangles: Uint32Array;
  slopeDeg: [number, number];
  in: string | 'top';
}

export interface Rim {
  /** A's N1 amendment — `PlannedOp.region` (a `RegionRef`) needs an id to point at. */
  id: string;
  polyline: [number, number][];
  z: number;
  of: string | 'contour';
  kind: 'sharp' | 'modelledChamfer';
  legs?: [number, number];
}

export interface FeatureTree {
  frame: SetupFrame & { partTop: number; partBottom: number };
  /** Floor Z levels, descending. */
  levels: number[];
  contour: { outline: Polygons; zTo: number; frees: boolean; shoulders: string[] };
  pockets: PocketNode[];
  rims: Rim[];
  remainder: RemainderRegion[];
  unreachable: { footprint: Polygons; zRange: [number, number]; reason: 'undercut' }[];
  report: {
    source: 'step' | 'mesh';
    patches: number;
    planarArea: number;
    remainderArea: number;
    tolerances: FeatureTolerances;
    notes: string[];
    /**
     * A's #958 D2 (comment 6620460283): a would-be floor patch whose largest inscribed circle is
     * under 0.25 mm diameter is listed here, never silently dropped — its area joins the
     * neighbouring region instead of becoming its own `PocketNode`.
     */
    slivers: { z: number; area: number; centroid: [number, number]; bbox: { min: [number, number]; max: [number, number] } }[];
  };
}

/**
 * Patches → levels → sections → booleans (A's #958 method). Stub for the skeleton — #958 fills
 * this in; every slice downstream of it can compile and be exercised against a hand-built
 * `FeatureTree` fixture until then.
 */
export function recogniseFeatures(_src: FeatureSource, _frame: SetupFrame, _tol?: Partial<FeatureTolerances>): FeatureTree {
  throw new Error('cam/model/features: recogniseFeatures() not implemented (#958)');
}

/**
 * `RegionRef`s derived from a `FeatureTree` — A's N1: so #961/#962 read bounds/`topZ`/`bottomZ` from
 * the tree instead of re-deriving them. `obstacles` and `regionClearanceZ` are filled in by
 * `plan.ts` from the resolved fixture envelope (§3.0's `ModelPlanInput.fixture`), not by this
 * function, which has no fixture data.
 */
export function regionRefs(_tree: FeatureTree): Omit<RegionRef, 'obstacles' | 'regionClearanceZ'>[] {
  throw new Error('cam/model/features: regionRefs() not implemented (#958)');
}
