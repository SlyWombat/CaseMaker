/**
 * #965 — `cam/model/setups.ts`: the reach-aware top+bottom decision (`buildSetupSpecs`, built on
 * the now-reach-aware `goalFlipPlan` ported from `held/914-flip-plan` onto this branch's own
 * pre-#914 `goalFlipPlan.ts`/`goalFlipSetups.ts`), and the setup→document frame map
 * (`documentXY`/`mapIRToDocument`/`rotatedGeometryFor`).
 *
 * The shapes are plain, hand-built meshes (the SAME `box`/`sphere` construction
 * `goalFlipPlan.spec.ts` uses) so this spec does not need the Manifold runtime for most of it.
 */
import { describe, expect, it } from 'vitest';

import { buildSetupSpecs, documentXY, mapIRToDocument, rotatedGeometryFor } from '@/engine/cnc/cam/model/setups';
import type { FeatureSource } from '@/engine/cnc/cam/model/features';
import type { ParsedMesh } from '@/engine/import/stlParser';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import type { MountSpec } from '@/engine/cnc/setups/types';

function quad(out: number[], a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]): void {
  out.push(...a, ...b, ...c, ...a, ...c, ...d);
}

function meshOf(p: number[]): ParsedMesh {
  const positions = new Float32Array(p);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!); maxX = Math.max(maxX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!);
    minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!);
  }
  return { positions, indices, triangleCount: indices.length / 3, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
}

/** A closed box `w × d × h`, min corner at the origin — a flat underside, no flip worth a setup. */
function box(w: number, d: number, h: number): ParsedMesh {
  const p: number[] = [];
  const [x0, x1, y0, y1, z0, z1] = [0, w, 0, d, 0, h];
  quad(p, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad(p, [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
  quad(p, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad(p, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
  quad(p, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
  quad(p, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  return meshOf(p);
}

/** A UV sphere, radius r, bottom at z 0 — no flat back, so the flip is what finishes it. */
function sphere(r: number, rings = 24, segs = 48): ParsedMesh {
  const p: number[] = [];
  const at = (i: number, j: number): [number, number, number] => {
    const phi = (i / rings) * Math.PI;
    const theta = (j / segs) * 2 * Math.PI;
    return [r + r * Math.sin(phi) * Math.cos(theta), r + r * Math.sin(phi) * Math.sin(theta), r - r * Math.cos(phi)];
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      p.push(...a, ...c, ...b, ...a, ...d, ...c);
    }
  }
  return meshOf(p);
}

const VISE: MountSpec = { kind: 'vise', viseOpeningMm: 120 };

describe('#965 buildSetupSpecs', () => {
  it("a box's own underside is a flat face — one setup, top only (no flip is worth it)", () => {
    const geometry: FeatureSource = { triangles: box(40, 30, 10) };
    const { setups, plan } = buildSetupSpecs({ geometry, underside: 'flippedTabs', mount: VISE, stockSize: { x: 40, y: 30, z: 10 } });
    expect(setups).toHaveLength(1);
    expect(setups[0]!.frame.up).toEqual([0, 0, 1]);
    expect(setups[0]!.underside).toBe('flippedTabs');
    expect(plan.stopped).toBe('only-flat-faces-remain');
  });

  it('a sphere needs the flip to finish it — two setups, top then bottom, #914s band-floor trigger', () => {
    const r = 15;
    const geometry: FeatureSource = { triangles: sphere(r) };
    const { setups, plan } = buildSetupSpecs({
      geometry,
      underside: 'flippedTabs',
      mount: VISE,
      stockSize: { x: 2 * r, y: 2 * r, z: 2 * r },
    });
    expect(setups).toHaveLength(2);
    expect(plan.sides.map((s) => s.faceUp)).toEqual(['top', 'bottom']);

    expect(setups[0]!.frame).toEqual({ up: [0, 0, 1], stockTop: 0, stockBottom: -2 * r });
    // frameForFace's own formula: stockTop_new = thicknessMm - stockTopZ, stockBottom_new = -stockTopZ
    // (stockTopZ is 0 here, so stockBottom_new is -0 — numerically 0, just not `Object.is`-equal to it).
    expect(setups[1]!.frame.up).toEqual([0, 0, -1]);
    expect(setups[1]!.frame.stockTop).toBe(2 * r);
    expect(setups[1]!.frame.stockBottom).toBe(-0);
    expect(setups[1]!.underside).toBe('flippedTabs');
  });

  it("#898's stockBottomExclusion, ported: flatOnStockBottom never offers the flip, even when a sphere's own coverage would want it", () => {
    const r = 15;
    const geometry: FeatureSource = { triangles: sphere(r) };
    const { setups, plan } = buildSetupSpecs({
      geometry,
      underside: 'flatOnStockBottom',
      mount: VISE,
      stockSize: { x: 2 * r, y: 2 * r, z: 2 * r },
    });
    expect(setups).toHaveLength(1);
    expect(setups[0]!.frame.up).toEqual([0, 0, 1]);
    expect(plan.dropped.some((d) => d.faceUp === 'bottom')).toBe(true);
  });
});

describe('#965 documentXY / mapIRToDocument', () => {
  it('up = [0, 0, 1] is the identity document map', () => {
    expect(documentXY({ up: [0, 0, 1], stockTop: 0 }, 3, -4)).toEqual([3, -4]);
  });

  it('up = [0, 0, -1] mirrors Y (the half turn about X `toSetupFrame`/vise `orient` both use)', () => {
    expect(documentXY({ up: [0, 0, -1], stockTop: 0 }, 3, -4)).toEqual([3, 4]);
  });

  it('refuses a frame outside the stated top/bottom scope', () => {
    expect(() => documentXY({ up: [1, 0, 0], stockTop: 0 }, 0, 0)).toThrow(/#965 stated scope/);
  });

  function ir(moves: { x: number; y: number; z: number }[]): ToolpathIR {
    return {
      frame: 'flat',
      tool: { shape: 'flat', id: 't', name: 't', number: 1 } as ToolpathIR['tool'],
      toolNumber: 1,
      spindleRpm: 10000,
      air: true,
      safeZ: 5,
      hopZ: 1,
      operations: [
        {
          number: 1,
          name: 'op',
          labelId: 'l',
          depth: 1,
          estimatedSeconds: 1,
          moves: moves.map((m) => ({ kind: 'feed' as const, x: m.x, y: m.y, z: m.z, f: 100 })),
        },
      ],
    };
  }

  it('mapIRToDocument is the identity for the top setup', () => {
    const top = ir([{ x: 1, y: 2, z: -1 }]);
    const mapped = mapIRToDocument(top, { up: [0, 0, 1], stockTop: 0 });
    expect(mapped).toBe(top);
  });

  it('mapIRToDocument mirrors Y for a flipped setup, leaving Z (a machine height) untouched', () => {
    const bottom = ir([{ x: 1, y: 2, z: -3 }]);
    const mapped = mapIRToDocument(bottom, { up: [0, 0, -1], stockTop: 0 });
    expect(mapped.operations[0]!.moves[0]).toEqual({ kind: 'feed', x: 1, y: -2, z: -3, f: 100 });
  });
});

describe('#965 rotatedGeometryFor', () => {
  it('is the identity for the top setup', () => {
    const geometry: FeatureSource = { triangles: box(10, 10, 10) };
    expect(rotatedGeometryFor(geometry, { up: [0, 0, 1], stockTop: 10 })).toBe(geometry);
  });

  it("rotates the mesh for a flipped setup — the SAME half turn `recogniseFeatures` applies to build that setup's own tree", () => {
    const geometry: FeatureSource = { triangles: box(10, 20, 4) };
    const rotated = rotatedGeometryFor(geometry, { up: [0, 0, -1], stockTop: 0 });
    expect(rotated.triangles.triangleCount).toBe(geometry.triangles.triangleCount);
    // x unchanged, y and z negate (the half turn about X).
    for (let i = 0; i < 9; i += 3) {
      expect(rotated.triangles.positions[i]).toBeCloseTo(geometry.triangles.positions[i]!, 5);
      expect(rotated.triangles.positions[i + 1]).toBeCloseTo(-geometry.triangles.positions[i + 1]!, 5);
      expect(rotated.triangles.positions[i + 2]).toBeCloseTo(-geometry.triangles.positions[i + 2]!, 5);
    }
  });
});
