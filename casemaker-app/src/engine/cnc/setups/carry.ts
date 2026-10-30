/**
 * #723 P2-2b — carrying the remaining stock between setups.
 *
 * Two programs of a multi-side job are posted in DIFFERENT work frames: each is the blank as
 * mounted for its setup (origin at the stock's front-left corner as mounted, Z0 on that setup's up
 * face, cuts negative). The exact sweeper's `priorRemoval` meshes are in the frame of the program
 * that cut them, so handing them straight to the next setup's sweep would carry the part into the
 * wrong frame. This module is the one transform between those frames, and nothing else.
 *
 * The frame chain is the setups engine's own (`orient.ts`): a job-frame point is a point on the
 * mounted stock; `toMachine` maps the stock frame to the mounted stock's work frame. A job frame is
 * that work frame with Z shifted so the mounted stock's TOP is 0, so the inverse is exact, and the
 * forward map to the next setup's job frame is the same arithmetic with its matrix.
 *
 * Read the result the way the sweeper does: the SAME solid, expressed in the frame the next
 * program cuts. A 180° turn puts the old top at the bottom — exactly what a top-Z heightfield
 * cannot show (see `targetOrientation.spec.ts`), which is why the carried stock is the solid.
 */

import { apply, machineSize, type Mat, type Vec } from './orient';
import type { Box } from './types';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';

/** A setup as the carrier needs it: its stock→machine rotation and the stock's bounds. */
export interface CarrySetup {
  rotation: Mat;
  bounds: Box;
}

function transpose(m: Mat): Mat {
  return [
    [m[0]![0]!, m[1]![0]!, m[2]![0]!],
    [m[0]![1]!, m[1]![1]!, m[2]![1]!],
    [m[0]![2]!, m[1]![2]!, m[2]![2]!],
  ];
}

/** The component-wise minimum of the stock's eight rotated corners (what `toMachine` subtracts). */
function machineMin(m: Mat, bounds: Box): Vec {
  const min: Vec = [Infinity, Infinity, Infinity];
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]])
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const q = apply(m, [x, y, z]);
        for (let i = 0; i < 3; i++) min[i] = Math.min(min[i]!, q[i]!);
      }
  return min;
}

/**
 * The map from `from`'s job frame to `to`'s job frame: un-mount the point into the stock frame,
 * then mount it the other way up. Pure and allocation-free per point once the two frames are set.
 */
export function carryPointBetweenSetups(from: CarrySetup, to: CarrySetup): (p: Vec) => Vec {
  const minFrom = machineMin(from.rotation, from.bounds);
  const minTo = machineMin(to.rotation, to.bounds);
  const zFrom = machineSize(from.rotation, from.bounds).z;
  const zTo = machineSize(to.rotation, to.bounds).z;
  const invFrom = transpose(from.rotation);
  return (p: Vec): Vec => {
    // Job frame → the stock frame: Z back onto the mounted stock (Z0 at its top), then un-rotate
    // and add back the corner the mount put at the origin.
    const rotatedFrom = [p[0] + minFrom[0], p[1] + minFrom[1], p[2] + zFrom + minFrom[2]] as Vec;
    const stock = apply(invFrom, rotatedFrom);
    // Stock frame → the next setup's job frame, the same arithmetic the other way up.
    const q = apply(to.rotation, stock);
    return [q[0] - minTo[0], q[1] - minTo[1], q[2] - minTo[2] - zTo];
  };
}

/**
 * One prior-removal mesh and the setup whose work frame it is in (1-based `setupIndex`, the
 * program's own field — the same numbering the frozen programs carry).
 */
export interface SeedMesh {
  mesh: NodeMeshOutput;
  setupIndex: number;
}

export type CarrySeedsResult =
  | { ok: true; meshes: NodeMeshOutput[] }
  | { ok: false; message: string };

/**
 * The seed a program in `targetIndex` starts from: every earlier program's remaining solid,
 * carried into the target's work frame. A mesh already in the target's frame is passed THROUGH
 * (the sweeper reads it; it does not mutate it), so a same-setup rest pass costs nothing. A
 * cross-setup carry needs both frames; a setup the planner could not orient has none, and the
 * result says so by name rather than seeding the wrong way round.
 */
export function carrySeedsForSetup(
  seeds: readonly SeedMesh[],
  targetIndex: number,
  frames: readonly (CarrySetup | null)[],
): CarrySeedsResult {
  const meshes: NodeMeshOutput[] = [];
  for (const seed of seeds) {
    if (seed.setupIndex === targetIndex) {
      meshes.push(seed.mesh);
      continue;
    }
    const from = frames[seed.setupIndex - 1] ?? null;
    const to = frames[targetIndex - 1] ?? null;
    if (from === null || to === null) {
      const missing = from === null ? seed.setupIndex : targetIndex;
      return {
        ok: false,
        message: `setup ${missing} has no work-frame rotation (its stock face cannot be mounted), so the remaining stock cannot be carried into setup ${targetIndex}`,
      };
    }
    meshes.push(carryRemovalBetweenSetups(seed.mesh, from, to));
  }
  return { ok: true, meshes };
}

/**
 * The affine maps a carried FIELD needs, from `from`'s work frame to `to`'s:
 *   source (x₁, y₁) = (map[0]·x + map[1]·y + map[2],  map[3]·x + map[4]·y + map[5])
 *   target floor Z  = z[0]·(source top) + z[1]
 * where (x, y) is a TARGET work point. Derived from the same point map the mesh carry uses, so a
 * mesh and a field can never disagree about the frames.
 *
 * REFUSED when the XY map depends on the height — a stock turned to a SIDE (90°), whose columns
 * in the target are not a re-indexing of the source's. That class is the stated limitation; a
 * map that is only right at one height would carry the stock wrongly and silently.
 */
export interface CarriedMaps {
  map: [number, number, number, number, number, number];
  z: [number, number];
}

export type CarriedMapsResult = { ok: true; maps: CarriedMaps } | { ok: false; message: string };

export function carriedMaps(from: CarrySetup, to: CarrySetup): CarriedMapsResult {
  const point = carryPointBetweenSetups(from, to);
  const sourceToTarget = (x: number, y: number, z: number): Vec => point([x, y, z]);
  const p00 = sourceToTarget(0, 0, 0);
  const p10 = sourceToTarget(1, 0, 0);
  const p01 = sourceToTarget(0, 1, 0);
  const p00z = sourceToTarget(0, 0, 1);
  if (Math.abs(p00z[0] - p00[0]) > 1e-9 || Math.abs(p00z[1] - p00[1]) > 1e-9) {
    return {
      ok: false,
      message:
        'this side is simulated from the stock as mounted; the material the earlier sides removed is not carried into a side setup, so its walls are not checked against them',
    };
  }
  // source → target XY: target = A·source + c.
  const a = p10[0] - p00[0];
  const b = p01[0] - p00[0];
  const c0 = p00[0];
  const d = p10[1] - p00[1];
  const e = p01[1] - p00[1];
  const f0 = p00[1];
  const det = a * e - b * d;
  if (!(Math.abs(det) > 1e-12)) {
    return { ok: false, message: 'the two setups’ frames are not related by a turn this field can invert' };
  }
  // The field samples TARGET → SOURCE, so the inverse of the map above.
  const ia = e / det;
  const ib = -b / det;
  const id = -d / det;
  const ie = a / det;
  const map: [number, number, number, number, number, number] = [
    ia,
    ib,
    -(ia * c0 + ib * f0),
    id,
    ie,
    -(id * c0 + ie * f0),
  ];
  // target Z is affine in the source Z: probe two heights.
  const g = p00z[2] - p00[2];
  return { ok: true, maps: { map, z: [g, p00[2]] } };
}

/**
 * The same solid, in `to`'s job frame. Positions are transformed, the triangulation is untouched,
 * and the bbox is recomputed. A same-setup carry is still a fresh mesh (the caller may hand it to
 * another worker), so no caller can mutate the seed it passed in.
 */
export function carryRemovalBetweenSetups(
  mesh: NodeMeshOutput,
  from: CarrySetup,
  to: CarrySetup,
): NodeMeshOutput {
  const map = carryPointBetweenSetups(from, to);
  const positions = new Float32Array(mesh.positions.length);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < mesh.positions.length; v += 3) {
    const q = map([mesh.positions[v]!, mesh.positions[v + 1]!, mesh.positions[v + 2]!]);
    positions[v] = q[0];
    positions[v + 1] = q[1];
    positions[v + 2] = q[2];
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, q[i]!);
      max[i] = Math.max(max[i]!, q[i]!);
    }
  }
  return {
    positions,
    indices: new Uint32Array(mesh.indices),
    triangleCount: mesh.triangleCount,
    vertexCount: mesh.vertexCount,
    bbox: { min, max },
    componentCount: mesh.componentCount,
  };
}
