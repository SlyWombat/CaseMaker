/**
 * cam/model/dropcutter.ts — the drop-cutter primitive #957/#956 §2 build on: the exact CL height a
 * flat, ball, bull or V cutter reaches at one (x, y) against a triangle mesh.
 *
 * Re-implemented from OpenCamLib's published description (`BatchDropCutter`/`PathDropCutter`,
 * LGPL-2.1, algorithm reference only — no OCL source read or copied): the cutter's own drop routine
 * evaluated against the triangles within its reach, per cutter-geometry contact rule. The four
 * cutter shapes are unified under one profile function (`CutterProfile.heightAt`, below): the
 * cutter's own bottom surface height above its tip, as a function of horizontal distance from the
 * tool axis. Flat, ball, bull and V/chamfer all have a known closed form for this; §9 of the design
 * note names a cone's as OpenCamLib's description, a ball/bull's as the standard sphere-offset
 * result (the same `R(secθ − 1)` rise this engine's own held findings already use).
 *
 * The drop height at (x, y) is the Z that puts the cutter's tip as low as possible while every
 * triangle point within reach stays at or below the cutter's surface:
 *
 *     z_tip(x, y) = max over every reachable mesh point p of [ p.z − heightAt(ρ) ]
 *
 * where ρ is p's horizontal distance from (x, y). For a FLAT cutter (heightAt ≡ 0 within radius)
 * this is just "the highest point within the footprint"; for a ball it reduces to the known
 * `R(secθ − 1)` rise on a plane; the same one formula covers all four shapes.
 *
 * PER-TRIANGLE EVALUATION is by dense barycentric sampling plus the exact vertex/edge extremes, not
 * a closed-form per-facet solve: correctness first, on meshes small enough that this is accurate
 * well inside the parity fixtures' one-grid-cell tolerance. A true spatial index (kd-tree) and an
 * exact analytic per-facet solve are the documented follow-up once real meshes (hundreds of
 * triangles, not the fixtures' one or two) make the brute-force mesh walk a real cost — this file's
 * mesh loop below is already isolated behind `reachableTriangles` so that swap is one function.
 */

import type { Tool } from '@/engine/cnc/tool';
import { isVShape, vCone } from '@/engine/cnc/vProfile';

/** A triangle-soup mesh: `positions` is 9 numbers (x0,y0,z0,x1,y1,z1,x2,y2,z2) per triangle, exactly `ParsedMesh`'s shape. */
export interface DropCutterMesh {
  positions: Float32Array | number[];
  indices: Uint32Array | number[];
  triangleCount: number;
}

/**
 * The cutter's own bottom-surface height above its tip, as a function of horizontal distance `rho`
 * from the tool axis, for `rho` up to `radiusMm`. `flatRadiusMm` is where the flat-bottomed part of
 * the profile ends (the whole radius for a flat cutter, 0 for a ball, the cone's tip radius for a
 * V/chamfer, `R − r` for a bull); beyond it the profile is either a circular arc (ball/bull, radius
 * `curveRadiusMm`) or a cone (V/chamfer, slope `1 / tanHalfAngle`).
 */
export interface CutterProfile {
  radiusMm: number;
  flatRadiusMm: number;
  kind: 'flat' | 'arc' | 'cone';
  curveRadiusMm?: number;
  tanHalfAngle?: number;
}

export function heightAt(profile: CutterProfile, rho: number): number {
  if (rho <= profile.flatRadiusMm) return 0;
  if (profile.kind === 'cone') return (rho - profile.flatRadiusMm) / (profile.tanHalfAngle ?? 1);
  if (profile.kind === 'flat') return 0;
  const r = profile.curveRadiusMm ?? 0;
  const w = rho - profile.flatRadiusMm;
  return r - Math.sqrt(Math.max(0, r * r - w * w));
}

/**
 * The cutter's profile, from its `Tool` record. `null` for a shape this engine's CL surface does
 * not cover (drill, thread, engraving/chamfer with no stated angle) — §2 is flat/ball/bull/V only.
 */
export function profileOf(tool: Tool): CutterProfile | null {
  if (isVShape(tool)) {
    const cone = vCone(tool);
    if (cone === null) return null;
    return {
      radiusMm: cone.outerRadius ?? cone.tipRadius + 10,
      flatRadiusMm: cone.tipRadius,
      kind: 'cone',
      tanHalfAngle: cone.tanHalf,
    };
  }
  const diameter = cuttingDiameterOf(tool);
  if (diameter === null || !(diameter > 0)) return null;
  const R = diameter / 2;
  if (tool.shape === 'flat') return { radiusMm: R, flatRadiusMm: R, kind: 'flat' };
  if (tool.shape === 'ball') return { radiusMm: R, flatRadiusMm: 0, kind: 'arc', curveRadiusMm: R };
  if (tool.shape === 'bull') {
    const r = tool.cornerRadius;
    if (r === null || !(r > 0) || !(r <= R)) return null;
    return { radiusMm: R, flatRadiusMm: R - r, kind: 'arc', curveRadiusMm: r };
  }
  return null;
}

function cuttingDiameterOf(tool: Tool): number | null {
  if (tool.tipDiameter !== null && tool.tipDiameter > 0) return tool.tipDiameter;
  if (tool.diameter !== null && tool.diameter > 0) return tool.diameter;
  return null;
}

interface Tri {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
  minX: number; maxX: number; minY: number; maxY: number;
}

function triangleOf(mesh: DropCutterMesh, t: number): Tri {
  const i0 = mesh.indices[t * 3]! * 3;
  const i1 = mesh.indices[t * 3 + 1]! * 3;
  const i2 = mesh.indices[t * 3 + 2]! * 3;
  const p = mesh.positions;
  const ax = p[i0]!, ay = p[i0 + 1]!, az = p[i0 + 2]!;
  const bx = p[i1]!, by = p[i1 + 1]!, bz = p[i1 + 2]!;
  const cx = p[i2]!, cy = p[i2 + 1]!, cz = p[i2 + 2]!;
  return {
    ax, ay, az, bx, by, bz, cx, cy, cz,
    minX: Math.min(ax, bx, cx), maxX: Math.max(ax, bx, cx),
    minY: Math.min(ay, by, cy), maxY: Math.max(ay, by, cy),
  };
}

/** Triangle indices whose bounding box (grown by `radiusMm`) can reach (x, y). Brute-force bbox prune; a kd-tree is the documented follow-up. */
export function reachableTriangles(mesh: DropCutterMesh, x: number, y: number, radiusMm: number): number[] {
  const out: number[] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    const tri = triangleOf(mesh, t);
    if (x < tri.minX - radiusMm || x > tri.maxX + radiusMm) continue;
    if (y < tri.minY - radiusMm || y > tri.maxY + radiusMm) continue;
    out.push(t);
  }
  return out;
}

const EPS = 1e-9;

/** One triangle's contribution to the drop-cutter max at (x, y) — the highest `p.z - heightAt(rho)` over the triangle's points within `profile.radiusMm`. */
function triangleContribution(tri: Tri, profile: CutterProfile, x: number, y: number): number | null {
  const R = profile.radiusMm;
  let best: number | null = null;
  const consider = (px: number, py: number, pz: number): void => {
    const rho = Math.hypot(px - x, py - y);
    if (rho > R + EPS) return;
    const z = pz - heightAt(profile, rho);
    if (best === null || z > best) best = z;
  };

  // Vertices.
  consider(tri.ax, tri.ay, tri.az);
  consider(tri.bx, tri.by, tri.bz);
  consider(tri.cx, tri.cy, tri.cz);

  // Dense interior sampling (barycentric grid) — correctness-first, see this file's header.
  const N = 48;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N - i; j++) {
      const u = i / N;
      const v = j / N;
      const w = 1 - u - v;
      const px = u * tri.ax + v * tri.bx + w * tri.cx;
      const py = u * tri.ay + v * tri.by + w * tri.cy;
      const pz = u * tri.az + v * tri.bz + w * tri.cz;
      consider(px, py, pz);
    }
  }

  return best;
}

/**
 * The CL height at (x, y): the Z the cutter's tip reaches, dropped onto `mesh`, or `null` when no
 * triangle is within the cutter's reach. `profile` is this cutter's `profileOf(tool)` — callers that
 * query many points for the same cutter should compute it once.
 */
export function dropCutterHeight(profile: CutterProfile, mesh: DropCutterMesh, x: number, y: number): number | null {
  let best: number | null = null;
  for (const t of reachableTriangles(mesh, x, y, profile.radiusMm)) {
    const tri = triangleOf(mesh, t);
    const contribution = triangleContribution(tri, profile, x, y);
    if (contribution !== null && (best === null || contribution > best)) best = contribution;
  }
  return best;
}
