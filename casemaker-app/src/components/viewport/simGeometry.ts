/**
 * Pure helpers that turn the simulation session's plain data into what the viewport draws
 * (#197). No React, no stores: everything here is testable in Node (`simGeometry.spec.ts`).
 */

import * as THREE from 'three';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { CheckpointInfo, SimPath } from '@/workers/sim/session';

/**
 * A mesh as the worker returns it → a three `BufferGeometry`, the same way `bufferToGeometry`
 * builds the case's meshes (`SceneMeshes.tsx`): a position attribute, an index, and vertex
 * normals. The caller owns the returned geometry and must `dispose()` it.
 */
export function geometryFromMesh(m: NodeMeshOutput): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  geom.setIndex(new THREE.BufferAttribute(m.indices, 1));
  geom.computeVertexNormals();
  return geom;
}

/**
 * A `LineSegments` geometry over a shared position buffer (#197 §4). When `dashed`, the
 * `lineDistance` attribute `LineDashedMaterial` needs is computed HERE, at build time.
 *
 * It cannot wait for an effect keyed on the layer's ref: a layer whose `drawRange` is empty
 * renders nothing, so the ref is null, and a later step (a scrub back) would mount the line
 * with no distances and draw the to-come rapids SOLID. A fresh load sits at the last step, so
 * the to-come layer is exactly that case. Distances are per-geometry and per-step, so building
 * them once here is correct and cheap. The caller owns the geometry and must `dispose()` it.
 */
export function segmentGeometry(data: Float32Array, dashed: boolean): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(data, 3));
  if (dashed) new THREE.LineSegments(geom).computeLineDistances();
  return geom;
}

/** The path split into `LineSegments` vertex buffers, one per drawn kind. */
export interface SplitPath {
  /** Cut segments (kind 1 and 2): two vertices per segment, previous → this. */
  cuts: Float32Array;
  /** Rapid segments (kind 0): two vertices per segment. */
  rapids: Float32Array;
  /** The program step each cut SEGMENT belongs to (the ending vertex's step). */
  cutStep: Uint32Array;
  /** The program step each rapid segment belongs to. */
  rapidStep: Uint32Array;
}

/**
 * Split the path into cut and rapid `LineSegments` buffers (#197). Each drawn segment is
 * `(previous vertex → this vertex)`, and its kind is the kind of the vertex it ENDS at.
 * Kind 2 (a feed with the spindle off) goes in the CUTS buffer, where a caller that tracks it
 * can colour it as an error; `simPath` keeps the kinds, and `SimMeshes` draws it with the cuts.
 */
export function splitPath(path: SimPath): SplitPath {
  const n = path.kind.length;
  const cuts: number[] = [];
  const rapids: number[] = [];
  const cutStep: number[] = [];
  const rapidStep: number[] = [];
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * 3;
    const b = i * 3;
    const rapid = path.kind[i] === 0;
    const dst = rapid ? rapids : cuts;
    const dstStep = rapid ? rapidStep : cutStep;
    dst.push(
      path.xyz[a] as number, path.xyz[a + 1] as number, path.xyz[a + 2] as number,
      path.xyz[b] as number, path.xyz[b + 1] as number, path.xyz[b + 2] as number,
    );
    dstStep.push(path.step[i] as number);
  }
  return {
    cuts: Float32Array.from(cuts),
    rapids: Float32Array.from(rapids),
    cutStep: Uint32Array.from(cutStep),
    rapidStep: Uint32Array.from(rapidStep),
  };
}

/**
 * How many entries of `stepArray` are at or before `step` (upper bound). For `path.step` this is
 * a count of vertices; for a split buffer's step array it is a count of SEGMENTS, which is what a
 * `LineSegments` `drawRange` needs once doubled. A step with no vertex (an unknown position) is
 * simply passed over: the count is of the entries that exist.
 */
export function vertexIndexAtStep(stepArray: Uint32Array, step: number): number {
  let lo = 0;
  let hi = stepArray.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((stepArray[mid] as number) <= step) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The tool-tip position at the last vertex whose step is ≤ `step`, or null before the first. */
export function toolPositionAt(path: SimPath, step: number): [number, number, number] | null {
  const i = vertexIndexAtStep(path.step, step) - 1;
  if (i < 0) return null;
  return [path.xyz[i * 3] as number, path.xyz[i * 3 + 1] as number, path.xyz[i * 3 + 2] as number];
}

/**
 * The extent of a path's known vertices, or null when it has none. Used to frame a PATH-ONLY
 * session (#194), which has no stock mesh at all — the camera still has to centre on the one
 * thing that IS drawn.
 */
export function pathBounds(path: SimPath): { min: [number, number, number]; max: [number, number, number] } | null {
  const n = path.xyz.length / 3;
  if (n === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = path.xyz[i * 3 + a] as number;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}

/**
 * The index of the last checkpoint whose `firstStep` is ≤ `step`, or -1 before the first cut.
 * Checkpoints are causal and ordered, so their `firstStep`s strictly increase and a binary
 * search is exact. `step` at or past the last checkpoint returns `count - 1`.
 */
export function checkpointAtStep(checkpoints: CheckpointInfo[], step: number): number {
  let lo = 0;
  let hi = checkpoints.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((checkpoints[mid] as CheckpointInfo).firstStep <= step) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
