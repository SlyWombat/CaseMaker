/**
 * Pure helpers that turn the simulation session's plain data into what the viewport draws
 * (#197). No React, no stores: everything here is testable in Node (`simGeometry.spec.ts`).
 */

import * as THREE from 'three';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { CheckpointInfo, SimPath } from '@/workers/sim/session';
import type { Tool } from '@/engine/cnc/tool';
import { isVShape, vCone } from '@/engine/cnc/vProfile';

/**
 * The sacrificial material's colour (#213 §4) — the board under the part and the strips beside it.
 * A PALER neighbour of the fixture grey (`SimMeshes`' `FIXTURE_COLOR` / `EngravePreview`'s
 * `JAW_COLOR`, both `#4b5563`), so a strip clamped between the jaws reads as the material the
 * cutter is allowed to reach, not as a third jaw. ONE constant, shared by the simulation
 * (`SimMeshes`) and the panel preview (`EngravePreview`), so the two CNC views cannot drift apart.
 * PROVISIONAL (#213): still the first place it is named; fold into a shared palette when one exists.
 */
export const SACRIFICIAL_COLOR = '#9ca3af';

/**
 * The simulation layer colours (#197), the ONE source for both the viewport meshes (`SimMeshes`)
 * and the layer-toggle swatches (#553): the toggles ARE the legend, so the swatch and the drawn
 * line must be the same hex, and a single constant is what stops them drifting apart.
 */
export const PATH_COLOR = '#00e0ff'; // cuts (kind 1/2), the blue path
export const RAPID_COLOR = '#ffd400'; // rapids (kind 0), drawn dashed
export const REMOVED_COLOR = '#ff5a36'; // the removed volume ghost
export const TOOL_COLOR = '#d0d4dc'; // the cutting head / tool body
export const FIXTURE_COLOR = '#4b5563'; // the vise jaws

/** The flute length the tool head falls back to when the tool states none (#197). */
export const TOOL_FLUTE_LENGTH_MM = 12;

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
 * The sacrificial body to draw for the current view (#213 §4): the material as cut so far, or null
 * when the job has none. Prefers the frame delivered for the current checkpoint (the body as cut
 * up to `k`) and falls back to the load's uncut body (`meshes.sacrificial`) before the first frame
 * lands — the same warm-up fallback `SimMeshes` uses for the stock. Both sources are null exactly
 * when the job has no sacrificial material, so the layer is present iff the material is.
 */
export function sacrificialMesh(
  frame: { sacrificial: NodeMeshOutput | null } | null,
  meshes: { sacrificial: NodeMeshOutput | null } | null,
): NodeMeshOutput | null {
  return frame?.sacrificial ?? meshes?.sacrificial ?? null;
}

/**
 * Whether the sacrificial body is drawn (#213 §4): its OWN layer, independent of the workholding
 * (`fixture`) layer. The `layers` type deliberately omits `fixture`, so this cannot read it — the
 * two toggles are independent by construction, and turning the fixture off never hides the
 * material. Nothing is drawn when the job has none (`meshPresent` false), whatever the layer says.
 */
export function drawsSacrificial(layers: { sacrificial: boolean }, meshPresent: boolean): boolean {
  return layers.sacrificial && meshPresent;
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

/**
 * The stock dexel/heightfield mesh with its per-column SIDE SKIRTS rebuilt as one flat wall per
 * side (#552). The engine meshes the four outer skirts column-by-column (a quad between every two
 * display columns), so even an uncut blank's walls read as dense vertical seams. The top heightfield
 * (where the pocket is) and the underside (whose kerfs stay open on a through cut) are kept exactly
 * as the engine made them; only the skirts are replaced, so the untouched perimeter is a clean flat
 * face while the cut detail stays. The caller owns the returned geometry and must `dispose()` it.
 */
export function cleanStockGeometry(mesh: NodeMeshOutput): THREE.BufferGeometry {
  const positions = mesh.positions;
  const src = mesh.indices;
  const kept: number[] = [];
  for (let i = 0; i < src.length; i += 3) {
    const ia = src[i]! * 3;
    const ib = src[i + 1]! * 3;
    const ic = src[i + 2]! * 3;
    const ax = positions[ia]!, ay = positions[ia + 1]!;
    const bx = positions[ib]!, by = positions[ib + 1]!;
    const cx = positions[ic]!, cy = positions[ic + 1]!;
    // The z of (b−a)×(c−a): positive for the top heightfield, negative for the underside, and
    // exactly 0 for the vertical skirts — which is what this drops.
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(nz) > 1e-9) kept.push(src[i]!, src[i + 1]!, src[i + 2]!);
  }
  // Rebuild the four skirts as one quad each, reusing `meshFlat`'s own vertex order so the walls
  // keep the engine's outward winding.
  const { min, max } = mesh.bbox;
  const zT = max[2]!;
  const zB = min[2]!;
  const x0 = min[0]!, x1 = max[0]!, y0 = min[1]!, y1 = max[1]!;
  const wallVerts: number[] = [];
  const wallIdx: number[] = [];
  const side = (t0: [number, number, number], t1: [number, number, number], b0: [number, number, number], b1: [number, number, number]): void => {
    const n = positions.length / 3 + wallVerts.length / 3;
    wallVerts.push(t0[0], t0[1], t0[2], t1[0], t1[1], t1[2], b0[0], b0[1], b0[2], b1[0], b1[1], b1[2]);
    wallIdx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  };
  side([x0, y0, zT], [x0, y1, zT], [x0, y0, zB], [x0, y1, zB]); // −X
  side([x1, y1, zT], [x1, y0, zT], [x1, y1, zB], [x1, y0, zB]); // +X
  side([x1, y0, zT], [x0, y0, zT], [x1, y0, zB], [x0, y0, zB]); // −Y
  side([x0, y1, zT], [x1, y1, zT], [x0, y1, zB], [x1, y1, zB]); // +Y

  const positionsOut = new Float32Array(positions.length + wallVerts.length);
  positionsOut.set(positions, 0);
  positionsOut.set(wallVerts, positions.length);
  const indicesOut = new Uint32Array(kept.length + wallIdx.length);
  indicesOut.set(kept, 0);
  indicesOut.set(wallIdx, kept.length);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positionsOut, 3));
  geom.setIndex(new THREE.BufferAttribute(indicesOut, 1));
  geom.computeVertexNormals();
  return geom;
}

/**
 * The cutting-head assembly for the sim's tool layer (#554): the true bit profile (cone for a
 * V/engraving/chamfer bit, a flat body, a hemispherical end for a ball), the shank above the
 * flutes, and a collet/holder stub — instead of `info.radius`, which is a lossy stand-in. Built in
 * the tool's own frame: the TIP sits at the origin and the head rises along +Z, so the caller just
 * positions the group at the tip. The caller owns the group and must dispose every mesh it holds.
 */
export function toolHeadGroup(tool: Tool | null): THREE.Group | null {
  if (!tool) return null;
  const tipR = Math.max(0.05, (tool.tipDiameter ?? tool.diameter ?? 1) / 2);
  const cutR = Math.max(tipR, (tool.diameter ?? tool.handleDiameter ?? tipR * 2) / 2);
  // The 1/8" shank is the catalogue default, so a missing handle reads as the common case.
  const shankR = Math.max(cutR, (tool.handleDiameter ?? 3.175) / 2);
  const fluteLen = tool.fluteLength ?? TOOL_FLUTE_LENGTH_MM;
  const stickout = tool.stickout ?? Math.max(fluteLen + 6, 20);
  const holderR = Math.max(shankR + 0.75, 4);
  const holderLen = 6;

  const material = new THREE.MeshStandardMaterial({ color: TOOL_COLOR, transparent: true, opacity: 0.9, metalness: 0.3, roughness: 0.4 });
  const group = new THREE.Group();
  // A body of revolution: a cylinder/cone of `height` spanning z ∈ [z, z+height], `rTop` at the
  // top end and `rBottom` at the tip end (CylinderGeometry's axis is +Y; rotate it up to +Z).
  const addBody = (rTop: number, rBottom: number, height: number, z: number): void => {
    if (height <= 0) return;
    const g = new THREE.CylinderGeometry(rTop, rBottom, height, 20);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, z + height / 2);
    group.add(new THREE.Mesh(g, material));
  };

  // Where the cutting head ends — the shank and collet sit above it.
  let headTop = fluteLen;

  if (tool.shape === 'ball') {
    // A ball nose: a hemisphere whose dome is the tip (below the origin), then the body cylinder.
    const cap = new THREE.SphereGeometry(cutR, 20, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    cap.rotateX(Math.PI / 2); // lower hemisphere's dome -> −Z
    cap.translate(0, 0, cutR); // dome (the tip) at z=0, equator at z=cutR
    group.add(new THREE.Mesh(cap, material));
    addBody(cutR, cutR, fluteLen, cutR);
    headTop = cutR + fluteLen;
  } else if (tool.shape === 'drill') {
    // A drill: a conical point at the tip, then the body cylinder above it.
    const pointH = Math.min(fluteLen, tipR * 3);
    const point = new THREE.ConeGeometry(tipR, pointH, 20);
    point.rotateX(-Math.PI / 2); // apex -> −Z (the tip)
    point.translate(0, 0, pointH / 2); // apex at z=0
    group.add(new THREE.Mesh(point, material));
    addBody(tipR, tipR, fluteLen, pointH);
    headTop = pointH + fluteLen;
  } else {
    // A V/engraving/chamfer cone widens from the tip to the shank over the flute; everything else
    // (flat, bull, thread, tapered-ball, unknown) is a plain cutting body.
    const cone = vCone(tool);
    const topR = cone ? Math.min(shankR, cone.tipRadius + fluteLen * cone.tanHalf) : cutR;
    addBody(topR, isVShape(tool) ? cone?.tipRadius ?? tipR : cutR, fluteLen, 0);
  }

  const shankLen = Math.max(0, stickout - headTop);
  addBody(shankR, shankR, shankLen, headTop);
  addBody(holderR, holderR, holderLen, headTop + shankLen);
  return group;
}

/** Dispose every geometry and material a `toolHeadGroup` built (#554). */
export function disposeToolHeadGroup(group: THREE.Group | null): void {
  if (!group) return;
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      const m = obj.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
    }
  });
}
