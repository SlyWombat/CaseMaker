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
import { reach } from '../../src/engine/cnc/cam/model/clsurface';
import type { RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import type { Tool, ToolShape } from '../../src/engine/cnc/tool';

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
    zTop: 0,
    zBottom: -1,
    triangles: new Uint32Array(),
    slopeDeg,
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
