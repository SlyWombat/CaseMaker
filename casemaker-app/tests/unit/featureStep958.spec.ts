/**
 * #958 — the STEP path: B-rep faces through occt-import-js `brep_faces` as a per-triangle faceId,
 * read at the recognition tessellation (absolute 0.01 mm chord, §2), into the feature tree.
 *
 * The part is `tests/fixtures/goals/step-accuracy.step`, documented in
 * `scripts/gen-step-fixture.mts`: a 60 × 40 × 10 plate, its (60, 40) corner rounded R 2, a ⌀3
 * through hole at (20, 20), and a spherical cap (sphere R 20 centred (45, 20, −8)) rising 2 mm
 * above the top, rim radius √76. The expected numbers below are those dimensions.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { stepToMesh } from '@/engine/import/stepMesh';
import { recogniseFeatures, type PocketNode } from '@/engine/cnc/cam/model/features';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'goals', 'step-accuracy.step');
const all = (nodes: PocketNode[]): PocketNode[] => nodes.flatMap((n) => [n, ...all(n.children)]);
const close = (a: number, b: number, eps: number): void => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(eps);

async function read(tessellation: 'display' | 'recognition') {
  const bytes = fs.readFileSync(FIXTURE);
  return stepToMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, tessellation);
}

describe('#958 the STEP path', () => {
  it('the import carries one face id per triangle, and the recognition read is finer', async () => {
    const display = await read('display');
    const fine = await read('recognition');
    expect(fine.faceId).toBeDefined();
    expect(fine.faceId!.length).toBe(fine.mesh.triangleCount);
    // The B-rep: top, bottom, four sides (one split by the fillet into two planes + the fillet),
    // the hole's wall, the cap. At least 8 faces; every id used.
    const ids = new Set(fine.faceId);
    expect(ids.size).toBeGreaterThanOrEqual(8);
    expect(fine.mesh.triangleCount).toBeGreaterThan(display.mesh.triangleCount);
  });

  it('the tree: a shoulder at z 10 round the cap, the cap as remainder, the hole through', async () => {
    const step = await read('recognition');
    const tree = recogniseFeatures({ triangles: step.mesh, faceId: step.faceId }, { up: [0, 0, 1], stockTop: 12, stockBottom: 0 }, tl);
    expect(tree.report.source).toBe('step');
    close(tree.frame.partTop, 12, 0.01);
    close(tree.frame.partBottom, 0, 1e-6);
    // The only floor level is the plate's top at 10 (the cap's top is curved, not a floor).
    expect(tree.levels.map((z) => Number(z.toFixed(4)))).toEqual([10]);
    expect(tree.top.area).toBe(0);

    const capArea = Math.PI * 76;
    const holeArea = Math.PI * 1.5 * 1.5;
    const filletLoss = 4 - Math.PI;
    const nodes = all(tree.pockets);
    const shoulder = nodes.filter((n) => !n.through);
    expect(shoulder).toHaveLength(1);
    expect(shoulder[0]!.open).toBe(true);
    close(shoulder[0]!.floorZ, 10, 1e-4);
    close(shoulder[0]!.floors[0]!.area, 2400 - filletLoss - holeArea - capArea, 1);
    expect(shoulder[0]!.islands).toHaveLength(1);
    close(shoulder[0]!.islands[0]!.topZ, 12, 0.01);

    const through = nodes.filter((n) => n.through);
    expect(through).toHaveLength(1);

    expect(tree.remainder).toHaveLength(1);
    close(tree.remainder[0]!.area, capArea, 1);
    close(tree.remainder[0]!.zBottom, 10, 0.01);
    close(tree.contour.area, 2400 - filletLoss, 0.1);
  });

  it('the mesh path reads the same part to the same tree', async () => {
    const step = await read('recognition');
    const viaStep = recogniseFeatures({ triangles: step.mesh, faceId: step.faceId }, { up: [0, 0, 1], stockTop: 12 }, tl);
    const viaMesh = recogniseFeatures({ triangles: step.mesh }, { up: [0, 0, 1], stockTop: 12 }, tl);
    expect(viaMesh.report.source).toBe('mesh');
    expect(viaMesh.levels.length).toBe(viaStep.levels.length);
    viaMesh.levels.forEach((z, i) => close(z, viaStep.levels[i]!, 0.005));
    const a = all(viaStep.pockets);
    const b = all(viaMesh.pockets);
    expect(b.length).toBe(a.length);
    expect(viaMesh.remainder.length).toBe(viaStep.remainder.length);
    close(viaMesh.remainder[0]!.area, viaStep.remainder[0]!.area, 0.5);
  });
});
