/**
 * #957 — THE CL SURFACE, RED-FIRST AGAINST F'S PARITY FIXTURES.
 *
 * `dropCutterHeight` (`cam/model/dropcutter.ts`) against the three analytic meshes (plane, ramp,
 * step) and the four cutters (flat, ball, bull, v90), compared with both reference columns
 * (OpenCamLib, and PyCAM for flat/ball/bull) via F's own comparator (`tests/tools/clParity.ts`).
 * Numbers-only references: no OpenCamLib or PyCAM source is read or linked, here or anywhere else.
 */

import { describe, expect, it } from 'vitest';

import { compareClSurface, loadClFixtures, type ClCutterFixture, type ClFixture } from '../tools/clParity';
import { dropCutterHeight, profileOf, type DropCutterMesh } from '../../src/engine/cnc/cam/model/dropcutter';
import { clSurface, reach } from '../../src/engine/cnc/cam/model/clsurface';
import type { FeatureSource, RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill, type Tool, type ToolShape } from '../../src/engine/cnc/tool';

const fixtures = loadClFixtures();

function toolFromFixtureCutter(c: ClCutterFixture): Tool {
  const isV = c.shape === 'v90';
  const shape: ToolShape = isV ? 'chamfer' : (c.shape as ToolShape);
  return {
    number: 1,
    id: c.shape,
    name: c.shape,
    typeText: c.shape,
    shape,
    handleDiameter: null,
    tipDiameter: isV ? 0 : null,
    diameter: c.diameterMm,
    cornerRadius: c.cornerRadiusMm ?? null,
    angle: c.angleDeg ?? null,
    halfAngle: null,
    fluteLength: c.lengthMm ?? null,
    shoulderLength: null,
    stickout: null,
    centreCutting: null,
  };
}

function meshFromFixture(f: ClFixture): DropCutterMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [a, b, c] of f.mesh.triangles) {
    const base = positions.length / 3;
    for (const i of [a, b, c]) {
      const v = f.mesh.vertices[i]!;
      positions.push(v[0], v[1], v[2]);
    }
    indices.push(base, base + 1, base + 2);
  }
  return { positions, indices, triangleCount: f.mesh.triangles.length };
}

describe('#957 dropCutterHeight against the parity fixtures', () => {
  for (const fixture of fixtures) {
    const mesh = meshFromFixture(fixture);
    for (const cutter of fixture.cutters) {
      const tool = toolFromFixtureCutter(cutter);
      const profile = profileOf(tool);

      it(`${fixture.id} ${cutter.shape}: profileOf() reads the fixture's cutter`, () => {
        expect(profile).not.toBeNull();
      });

      if (profile === null) continue;
      const candidate = (x: number, y: number): number | null => dropCutterHeight(profile, mesh, x, y);

      it(`${fixture.id} ${cutter.shape}: agrees with OpenCamLib within one grid cell`, () => {
        const result = compareClSurface(fixture, cutter.shape, candidate);
        if (!result.ok) {
          const worst = result.mismatches[0];
          throw new Error(
            `${result.mismatches.length} mismatches, max delta ${result.maxDeltaMm.toFixed(4)} mm ` +
              `(e.g. at (${worst?.x}, ${worst?.y}): reference ${worst?.referenceZ}, candidate ${worst?.candidateZ})`,
          );
        }
        expect(result.ok).toBe(true);
      });

      if (cutter.pycamSamples != null) {
        it(`${fixture.id} ${cutter.shape}: agrees with PyCAM within one grid cell`, () => {
          const result = compareClSurface(fixture, cutter.shape, candidate, undefined, 'pycam');
          expect(result.ok).toBe(true);
        });
      }
    }
  }
});

function region(slopeDeg: [number, number]): RemainderRegion {
  return {
    id: 'r1',
    footprint: [],
    area: 0,
    zTop: 0,
    zBottom: -1,
    triangles: new Uint32Array(),
    slopeDeg,
    slopeMedianDeg: (slopeDeg[0] + slopeDeg[1]) / 2,
    in: 'top',
  };
}

describe('#957 reach()', () => {
  const v90 = toolFromFixtureCutter({ shape: 'v90', diameterMm: 6, angleDeg: 90, samples: [] });
  const flat = toolFromFixtureCutter({ shape: 'flat', diameterMm: 6, samples: [] });

  it('a 90° V reaches a 30° slope (its flank is 45° from horizontal)', () => {
    expect(reach(v90, region([0, 30])).reachable).toBe(true);
  });

  it('a 90° V refuses a 70° slope, and names why', () => {
    const r = reach(v90, region([0, 70]));
    expect(r.reachable).toBe(false);
    expect(r.note).toContain('45.0°');
    expect(r.note).toContain('70.0°');
  });

  it('a flat cutter is always reachable by this check', () => {
    expect(reach(flat, region([0, 89])).reachable).toBe(true);
  });
});

/** A flat plane at `z`, `half`×`half` wide and centred on the origin — two triangles. */
function flatPlaneMesh(z: number, half: number): FeatureSource {
  return {
    triangles: {
      positions: Float32Array.from([-half, -half, z, half, -half, z, half, half, z, -half, half, z]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      triangleCount: 2,
      bbox: { min: [-half, -half, z], max: [half, half, z] },
    },
  };
}

function regionWithFootprint(half: number, slopeDeg: [number, number] = [0, 0]): RemainderRegion {
  return { ...region(slopeDeg), footprint: [[[-half, -half], [half, -half], [half, half], [-half, half]]] };
}

// The manager's ruling on B's clSurface question (6621141190): `clSurface(geometry, region,
// cutter, …)` — a lazy point query against the WHOLE geometry (never just `region.triangles`),
// never a pre-built adaptive grid (that is the finish/rough row-dropper's own job, #960).
describe('#959 clSurface()', () => {
  it('drops a flat cutter onto a flat plane exactly at the plane\'s own Z — the TIP height, not the ball centre', () => {
    const geometry = flatPlaneMesh(-3, 50);
    const flat = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
    const surface = clSurface(geometry, regionWithFootprint(50), flat, 3);
    expect(surface.dropCutter(0, 0)).toBeCloseTo(-3, 9);
  });

  it('a ball dropped on the same flat plane also posts exactly the plane\'s own Z, never the ball centre (which would be r above it)', () => {
    const geometry = flatPlaneMesh(-3, 50);
    const ball: Tool = { ...flatEndMill(6, { number: 1, id: 'ball-6', name: 'ball-6' }), shape: 'ball' };
    const surface = clSurface(geometry, regionWithFootprint(50), ball, 3);
    expect(surface.dropCutter(0, 0)).toBeCloseTo(-3, 9);
  });

  it('returns null outside the region\'s own footprint, even where the mesh itself still has material', () => {
    const geometry = flatPlaneMesh(-3, 50);
    const flat = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
    // The region's own footprint is narrower (±10) than the mesh (±50): a query past ±10 must
    // read null, not the plane's real height, however far the mesh itself still extends.
    const surface = clSurface(geometry, regionWithFootprint(10), flat, 3);
    expect(surface.dropCutter(0, 0)).toBeCloseTo(-3, 9);
    expect(surface.dropCutter(20, 0)).toBeNull();
  });

  it('counts a sample only for a query the drop-cutter actually evaluated, not an out-of-footprint miss', () => {
    const geometry = flatPlaneMesh(-3, 50);
    const flat = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
    const surface = clSurface(geometry, regionWithFootprint(10), flat, 3);
    expect(surface.sampleCount).toBe(0);
    surface.dropCutter(20, 0); // outside the footprint — no real evaluation
    expect(surface.sampleCount).toBe(0);
    surface.dropCutter(0, 0);
    surface.dropCutter(1, 1);
    expect(surface.sampleCount).toBe(2);
  });

  it('refuses a cutter with no drop-cutter profile (a drill has no stated diameter here)', () => {
    const geometry = flatPlaneMesh(-3, 50);
    const drill: Tool = { ...flatEndMill(6, { number: 1, id: 'drill', name: 'drill' }), shape: 'drill', diameter: null, tipDiameter: null };
    expect(() => clSurface(geometry, regionWithFootprint(10), drill, 3)).toThrow(/no drop-cutter profile/);
  });
});

// Advisor's review: the dense barycentric grid (48 divisions) `dropCutterHeight` used to fall
// back on reads LOW on any facet larger than the grid's own spacing, for EVERY shape, not just
// ball/flat — a5cc4597's own "36 cases within one grid cell" claim is withdrawn; that comparator
// was +-1 mm, which hid exactly this. A single LARGE (300x300 mm) sloped triangle — far bigger
// than the parity fixtures' own meshes — stresses that gap directly, checked against the unified
// closed-form oracle (this file's own header: `z = plane(axis) + rho0*g + r*(L-1)` for flat/ball/
// bull, `plane(axis) + max(r0*g, R*g - (R-r0)/tanPhi)` for cone/V) at points well inside the
// facet (so the FACET-INTERIOR contact governs, not an edge or a vertex).
describe('#960 the unified facet contact, all four shapes, on one large sloped triangle', () => {
  const SIZE = 300;
  const A = 0.3;
  const B = 0.2;
  function slopedMesh(): DropCutterMesh {
    const z = (px: number, py: number): number => A * px + B * py;
    return {
      positions: [0, 0, z(0, 0), SIZE, 0, z(SIZE, 0), SIZE, SIZE, z(SIZE, SIZE), 0, 0, z(0, 0), SIZE, SIZE, z(SIZE, SIZE), 0, SIZE, z(0, SIZE)],
      indices: [0, 1, 2, 3, 4, 5],
      triangleCount: 2,
    };
  }
  const mesh = slopedMesh();
  const g = Math.hypot(A, B);
  const L = Math.sqrt(1 + A * A + B * B);
  const plane = (x: number, y: number): number => A * x + B * y;

  function oracle(profile: ReturnType<typeof profileOf>, x: number, y: number): number {
    const p = profile!;
    if (p.kind === 'cone') {
      const tanPhi = p.tanHalfAngle ?? 1;
      return plane(x, y) + Math.max(p.flatRadiusMm * g, p.radiusMm * g - (p.radiusMm - p.flatRadiusMm) / tanPhi);
    }
    const r = p.curveRadiusMm ?? 0;
    return plane(x, y) + p.flatRadiusMm * g + r * (L - 1);
  }

  const points: [number, number][] = [[100, 100], [150, 120], [80, 200]];

  it('flat (R=6)', () => {
    const profile = profileOf(flatEndMill(12, { number: 1, id: 'flat', name: 'flat' }));
    for (const [x, y] of points) expect(dropCutterHeight(profile!, mesh, x, y)).toBeCloseTo(oracle(profile, x, y), 6);
  });

  it('ball (R=6)', () => {
    const ball: Tool = { ...flatEndMill(12, { number: 1, id: 'ball', name: 'ball' }), shape: 'ball' };
    const profile = profileOf(ball);
    for (const [x, y] of points) expect(dropCutterHeight(profile!, mesh, x, y)).toBeCloseTo(oracle(profile, x, y), 6);
  });

  it('bull (R=6, corner 2)', () => {
    const bull: Tool = { ...flatEndMill(12, { number: 1, id: 'bull', name: 'bull' }), shape: 'bull', cornerRadius: 2 };
    const profile = profileOf(bull);
    for (const [x, y] of points) expect(dropCutterHeight(profile!, mesh, x, y)).toBeCloseTo(oracle(profile, x, y), 6);
  });

  it('cone (90° V, sharp tip) — the shallow branch, apex binds (g*tanPhi < 1)', () => {
    const v90: Tool = {
      ...flatEndMill(12, { number: 1, id: 'v90', name: 'v90' }),
      typeText: 'V-Bit', shape: 'chamfer', tipDiameter: 0, angle: 90, halfAngle: 45,
    };
    const profile = profileOf(v90);
    expect((profile!.tanHalfAngle ?? 1) * g).toBeLessThan(1); // confirms this is the apex branch
    for (const [x, y] of points) expect(dropCutterHeight(profile!, mesh, x, y)).toBeCloseTo(oracle(profile, x, y), 6);
  });

  it('cone (80° half-angle, sharp tip — a WIDE, shallow-flanked cone) — the steep branch, the rim binds (g*tanPhi >= 1)', () => {
    // A narrow V (small half-angle) is the OTHER (apex-binds) branch above — this needs a cone
    // whose own flank is SHALLOWER than the plane's slope, which is a WIDE half-angle, not a
    // narrow one (a flat disc, half-angle 90 deg, is this same branch's own limit).
    const vWide: Tool = {
      ...flatEndMill(12, { number: 1, id: 'v-wide', name: 'v-wide' }),
      typeText: 'V-Bit', shape: 'chamfer', tipDiameter: 0, angle: 160, halfAngle: 80,
    };
    const profile = profileOf(vWide);
    expect((profile!.tanHalfAngle ?? 1) * g).toBeGreaterThanOrEqual(1); // confirms the rim branch
    for (const [x, y] of points) expect(dropCutterHeight(profile!, mesh, x, y)).toBeCloseTo(oracle(profile, x, y), 6);
  });
});

// #970 — A DEGENERATE (VERTICAL) FACET'S OWN EDGES ARE STILL REAL GEOMETRY. A triangle standing
// on edge (every vertex at the same y) has no facet-interior contact — `triangleBins.ts`'s own
// `planeA` is `NaN` for it, no `a*x+b*y+c` states its height anywhere — but its three EDGES are
// ordinary 3D line segments with real XY extent, exactly as exact as any other triangle's. A
// query placed where every VERTEX is out of the cutter's own reach, with one edge's own interior
// (not an endpoint) the nearest real geometry, proves the edges are the only path to an answer at
// all here: skipping them whenever the facet is degenerate (the bug this pins) does not just
// under-report the height, it reports the surface UNREACHABLE at a point that plainly is not.
describe('#970 a degenerate (vertical) facet still carries its own edges', () => {
  // A=(0,0,0) B=(16,0,0) C=(8,0,6): a triangle standing in the XZ plane (y=0 throughout), apex
  // offset from the query so no vertex is in reach. A second, far-off flat triangle (E,F,G) only
  // gives the mesh a nonzero Y extent overall — `triangleBins` refuses a mesh with none — and
  // sits nowhere near any query this case makes.
  const mesh: DropCutterMesh = {
    positions: Float32Array.from([0, 0, 0, 16, 0, 0, 8, 0, 6, 1000, 1000, 0, 1001, 1000, 0, 1000, 1001, 0]),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
    triangleCount: 2,
  };
  const ball2: Tool = { ...flatEndMill(4, { number: 1, id: 'ball-2', name: 'ball-2' }), shape: 'ball' };
  const profile = profileOf(ball2)!;
  const QX = 5;

  it('every vertex of the triangle is out of reach (R = 2 mm)', () => {
    expect(Math.hypot(QX - 0, 0)).toBeGreaterThan(profile.radiusMm); // A, 5 mm away
    expect(Math.hypot(QX - 16, 0)).toBeGreaterThan(profile.radiusMm); // B, 11 mm away
    expect(Math.hypot(QX - 8, 0)).toBeGreaterThan(profile.radiusMm); // C, 3 mm away
  });

  it("edge C-A is the surface here — closed form w = 6/5 (f = 17/4 exactly)", () => {
    // f(s) = z(s) - heightAt(ball, rho(s)) on edge C-A's own reach interval, substituting
    // w = 3 - 8s (so rho = |w|, z = 3.75 + 0.75w): the one interior maximum (this file's own
    // header: concave along any edge) is at d/dw[0.75w + sqrt(4-w^2)] = 0, i.e. w = 6/5.
    const w = 6 / 5;
    const r = profile.curveRadiusMm!;
    const expected = 3.75 + 0.75 * w - (r - Math.sqrt(r * r - w * w));
    expect(expected).toBeCloseTo(4.25, 9); // 17/4 exactly, by hand above
    const z = dropCutterHeight(profile, mesh, QX, 0);
    expect(z).not.toBeNull();
    expect(z!).toBeCloseTo(expected, 6);
  });
});
