/**
 * #965 — A MESH COMPONENT IS NOT ONE ORIENTATION. The panther's curved surface arrives from a
 * triangle mesh as ONE edge-connected component (119,262 triangles, nz ∈ [−1, +1]) because a
 * closed sculpture's connected curved surface spans both its up-facing top and its down-facing
 * underside. `classifyPatches`' `anyDown` rule then marked the WHOLE component `undercut` — one
 * down-facing facet demoted 73 % of the mesh, no `RemainderRegion` projected over it, and the
 * finish never ran there. This spec pins the mesh-path rule: a watertight component that is
 * up-facing except for down-facing facets must yield remainder SURFACES over its up-facing part,
 * with every down-facing facet still excluded.
 *
 * The fixtures are spheres turned off the axes (an axis-aligned sphere's facets split into planar
 * clusters and its curved pool into latitude rings; turned, every facet lands in the curved pool
 * and the whole surface is one edge-connected component, as on the real meshes).
 *
 * Red at ea8f8510 (the turned sphere reads `undercut` whole, no remainder region over its top);
 * green once the mesh path classifies per triangle. The STEP B-rep path (one face = one surface)
 * keeps the patch-level rule and is covered by the tray/organizer bit-identical rows elsewhere.
 */
import { describe, expect, it } from 'vitest';

import { tl as toplevel, type ManifoldInstance } from './helpers/manifoldExec';
import { DEFAULT_FEATURE_TOLERANCES as TOL, patchesFromMesh, type FrameMesh } from '@/engine/cnc/cam/model/features/patches';
import { recogniseFeatures, type FeatureTree } from '@/engine/cnc/cam/model/features';
import type { ParsedMesh } from '@/engine/import/stlParser';

/** A Manifold solid's mesh, in the recognition's own frame type. */
function meshOf(build: (tl: typeof toplevel) => ManifoldInstance): FrameMesh {
  const solid = build(toplevel);
  const m = solid.getMesh();
  const positions = new Float64Array((m.vertProperties.length / m.numProp) * 3);
  for (let v = 0; v < positions.length / 3; v++) {
    positions[3 * v] = m.vertProperties[v * m.numProp]!;
    positions[3 * v + 1] = m.vertProperties[v * m.numProp + 1]!;
    positions[3 * v + 2] = m.vertProperties[v * m.numProp + 2]!;
  }
  solid.delete();
  return { positions, indices: Uint32Array.from(m.triVerts) };
}

const CAP_AREA = Math.PI * 20 * 20;

/** A closed sphere turned off the axes: ONE curved component, up-facing over its top half and
 * down-facing under its bottom half — the panther's mixed component in miniature, watertight and
 * consistently wound. */
const mixedSphere = (): FrameMesh =>
  meshOf((tl) => tl.Manifold.sphere(20, 128).rotate([13, 7, 3]).translate([20, 20, 10]));

/** The control: the same turned sphere's part above z 10 (a flat face closes it) — a single
 * curved component that is up-facing throughout, which the tip already reads as remainder. */
const upCap = (): FrameMesh =>
  meshOf((tl) =>
    tl.Manifold.sphere(20, 128).rotate([13, 7, 3]).translate([20, 20, 10]).intersect(tl.Manifold.cube([60, 60, 60]).translate([-10, -10, 10])),
  );

function treeOf(mesh: FrameMesh): FeatureTree {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i]!, y = mesh.positions[i + 1]!, z = mesh.positions[i + 2]!;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const triangles: ParsedMesh = {
    positions: Float32Array.from(mesh.positions),
    indices: mesh.indices,
    triangleCount: mesh.indices.length / 3,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
  return recogniseFeatures({ triangles }, { up: [0, 0, 1], stockTop: 0 }, toplevel);
}

/** The triangle's own unit z normal, from its winding. */
function triangleNz(mesh: FrameMesh, t: number): number {
  const { positions: p, indices: idx } = mesh;
  const a = idx[3 * t]! * 3, b = idx[3 * t + 1]! * 3, c = idx[3 * t + 2]! * 3;
  const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
  const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return nz / (Math.hypot(nx, ny, nz) || 1);
}

describe('#965 a mesh component mixing up- and down-facing facets', () => {
  it('RED-FIRST: a watertight component up-facing over its top yields remainder regions there', () => {
    const mesh = mixedSphere();
    // The fixture is what it says: one UNCLASSIFIED curved component, up-facing above and
    // down-facing below.
    const raw = patchesFromMesh(mesh, TOL).filter((p) => !p.planar);
    expect(raw.length, 'the turned sphere is one curved component').toBe(1);
    const zs = raw[0]!.triangles.map((t) => triangleNz(mesh, t));
    expect(Math.max(...zs)).toBeGreaterThan(0.9);
    expect(Math.min(...zs)).toBeLessThan(-0.9);

    const tree = treeOf(mesh);
    const largest = Math.max(0, ...tree.remainder.map((r) => r.area));
    expect(
      largest,
      `no remainder region covers the sphere's up-facing top — regions: ${tree.remainder.length}`,
    ).toBeGreaterThan(0.9 * CAP_AREA);
  });

  it('the up-facing control is remainder ground at the tip and after the fix', () => {
    const tree = treeOf(upCap());
    expect(Math.max(0, ...tree.remainder.map((r) => r.area))).toBeGreaterThan(0.5 * CAP_AREA);
  });

  it('every down-facing facet stays excluded from the remainder regions (a true undercut)', () => {
    const mesh = mixedSphere();
    const tree = treeOf(mesh);
    const sinTol = Math.sin(TOL.angleDeg * (Math.PI / 180));
    const admittedDown = tree.remainder.some((region) =>
      Array.from(region.triangles).some((t) => triangleNz(mesh, t) < -sinTol),
    );
    expect(admittedDown, 'a down-facing triangle was admitted into a remainder region').toBe(false);
  });
});
