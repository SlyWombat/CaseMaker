/**
 * #1029 — A NON-FINITE VERTEX IS REFUSED BY NAME, AT THE DOOR AND AT THE BOOLEANS.
 *
 * A binary STL carries raw float32 bits, so a NaN or ±Infinity vertex parses without complaint;
 * the object then reaches the kernel through `CrossSection.ofPolygons` / `new Manifold(mesh)`,
 * where the glue answers with either an unusable thrown number or — on the x86 patched build — a
 * trap that kills the worker's whole instance. Neither refusal names the file or the region.
 *
 * RED at `be931c159`: the door reads the bytes with no complaint, and the wrappers hand the bad
 * point straight to the wasm.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { readTargetObjectFile, targetObjectMesh } from '@/engine/import/targetObject';
import { importStlFile } from '@/engine/import/assetImporter';
import { mergeGerberShapes, type GerberShape } from '@/engine/import/gerber';
import { mesh } from '@/engine/compiler/buildPlan';
import { executeOpSync } from '@/workers/geometry/evaluateOp';
import type { Polygons } from '@/engine/cnc/cam/pocket';

type Tri = [[number, number, number], [number, number, number], [number, number, number]];

function binaryStl(tris: Tri[]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12; // normal left 0
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2; // attribute byte count
  }
  return buf;
}

/** Two triangles with volume in all three axes — a readable target object when finite. */
const GOOD: Tri[] = [
  [[0, 0, 0], [10, 0, 0], [0, 10, 5]],
  [[0, 0, 0], [0, 10, 5], [0, 0, 5]],
];

describe('#1029 — the mesh door names a non-finite file', () => {
  it('one NaN and one Infinity vertex: refused with the code, the count and the first triangle', async () => {
    const bad: Tri[] = [GOOD[0]!, [[NaN, 0, 0], [10, 0, 0], [0, Infinity, 5]]];
    const result = await readTargetObjectFile(new File([binaryStl(bad)], 'bad.stl'), 'goal-bad.stl');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('goal-mesh-non-finite');
    expect(result.error).toContain('2 of 6 vertices');
    expect(result.error).toContain('first at triangle 1');
  });

  it('a stored goal parsed by the plan path is refused the same way — before any Manifold sees it', () => {
    const bad: Tri[] = [GOOD[0]!, [[NaN, 0, 0], [10, 0, 0], [0, Infinity, 5]]];
    const data = Buffer.from(new Uint8Array(binaryStl(bad))).toString('base64');
    expect(() => targetObjectMesh({ sha256: 'non-finite-1029', format: 'stl', data })).toThrow(/goal-mesh-non-finite/);
  });

  it('the same triangles with finite numbers still read', async () => {
    const result = await readTargetObjectFile(new File([binaryStl(GOOD)], 'good.stl'), 'goal-good.stl');
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
  });
});

describe('#1029 — a non-finite operand throws a named error, never a trap', () => {
  const SQUARE: Polygons = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
  const CELL: Polygons = [[[5, 5], [15, 5], [15, 15], [5, 15]]];

  it('subtract, union and offset each refuse the operand by operation and position', () => {
    const infinityRing: Polygons = [[[Infinity, 0], [10, 0], [10, 10], [0, 10]]];
    const nanRing: Polygons = [[[0, 0], [NaN, 0], [10, 10], [0, 10]]];
    const subtract = makeClipperSubtract(tl);
    expect(() => subtract(SQUARE, infinityRing)).toThrow('cam: non-finite coordinate in subtract at ring 0 point 0');
    expect(() => subtract(nanRing, SQUARE)).toThrow('cam: non-finite coordinate in subtract at ring 0 point 1');
    expect(() => makeClipperUnion(tl)(infinityRing, SQUARE)).toThrow('cam: non-finite coordinate in union');
    expect(() => makeClipperOffset(tl)(infinityRing, 1)).toThrow('cam: non-finite coordinate in offset');
  });

  it('the instance is still alive after the refusals — a valid boolean follows', () => {
    const subtract = makeClipperSubtract(tl);
    expect(() => subtract(SQUARE, [[[Infinity, 0], [10, 0], [10, 10], [0, 10]]])).toThrow(/non-finite/);
    const out = subtract(SQUARE, CELL);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('#1029 — user files on the asset and Gerber paths are refused by name too', () => {
  const bad: Tri[] = [GOOD[0]!, [[NaN, 0, 0], [10, 0, 0], [0, Infinity, 5]]];

  it('an external asset STL with a NaN vertex is refused at import', async () => {
    await expect(importStlFile(new File([binaryStl(bad)], 'asset.stl'))).rejects.toThrow(/goal-mesh-non-finite/);
  });

  it('the same mesh as a union asset fails its build op by name, and the instance lives', () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, NaN, 10, 5]);
    const indices = new Uint32Array([0, 1, 2]);
    expect(() => executeOpSync(tl, mesh(positions, indices))).toThrow(
      'cam: non-finite coordinate in a mesh build op at vertex 2',
    );
    // The instance is alive afterwards — a valid solid still builds.
    const cube = executeOpSync(tl, { kind: 'cube', size: [2, 2, 2] });
    expect(cube.numTri()).toBeGreaterThan(0);
    cube.delete();
  });

  it('a Gerber shape with a NaN contour point is refused by name', () => {
    const shape: GerberShape = {
      polarity: 'dark',
      contours: [[[0, 0], [10, 0], [NaN, 10], [0, 10]]],
      fillRule: 'NonZero',
      line: 7,
    };
    expect(() => mergeGerberShapes(tl, [shape])).toThrow('cam: non-finite coordinate in a Gerber shape at ring 0 point 2');
  });
});
