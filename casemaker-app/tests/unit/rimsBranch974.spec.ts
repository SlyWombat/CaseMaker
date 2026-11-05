/**
 * #974 — THE ORGANIZER'S POCKET RIMS CLOSE ON THEIR OWN VERTICES.
 *
 * `features/rims.ts`'s old chainer left a complex pocket's rim open where two floors' rims touch
 * at a branch point: rim-5 (pocket-16) ended 77.2 mm from its start at #962's base (E/B), and
 * the #962 guard now refuses such a rim instead of bridging it. The fix chains each pocket's rim
 * on its own floor patch, so every pocket rim closes exactly on its own mesh vertices; this spec
 * reads the real organization STEP and states it.
 */
import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { stepToMesh } from '@/engine/import/stepMesh';
import { recogniseFeatures, type FeatureTree } from '@/engine/cnc/cam/model/features';

/** The organizer STEP, when the licensed local tree is present (the same env the acceptance uses). */
const ORGANIZER = process.env.CM_959_ORGANIZER_STEP;

/** The organizer placed as the acceptance places it: 170 × 170 stock, model top 0.8 mm below. */
async function placedTree(file: string, stock: [number, number], modelTop: number): Promise<FeatureTree> {
  const bytes = fs.readFileSync(file);
  const read = await stepToMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'recognition');
  const { min, max } = read.mesh.bbox;
  const dx = stock[0] / 2 - (min[0] + max[0]) / 2;
  const dy = stock[1] / 2 - (min[1] + max[1]) / 2;
  const dz = modelTop - max[2];
  const positions = Float32Array.from(read.mesh.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! + dx;
    positions[i + 1] = positions[i + 1]! + dy;
    positions[i + 2] = positions[i + 2]! + dz;
  }
  return recogniseFeatures({ triangles: { ...read.mesh, positions }, faceId: read.faceId }, { up: [0, 0, 1], stockTop: 0 }, tl);
}

const gapMm = (polyline: readonly [number, number][]): number => {
  const a = polyline[0]!;
  const b = polyline[polyline.length - 1]!;
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
};

describe.skipIf(ORGANIZER === undefined)('#974 — the organizer’s pocket rims close on their own vertices', () => {
  it('every pocket rim closes, and rim-5 (open 77.2 mm at #962’s base) closes on its real edges', async () => {
    const tree = await placedTree(ORGANIZER!, [170, 170], -0.8);
    const pockets = tree.rims.filter((rim) => rim.of !== 'contour');
    expect(pockets.length, 'the organizer has pocket rims').toBeGreaterThan(0);
    const open = pockets
      .map((rim) => ({ id: rim.id, of: rim.of, gap: gapMm(rim.polyline) }))
      .filter((rim) => rim.gap > 0.01);
    expect(open, 'pocket rims that still do not close (first and last vertex 0.01 mm apart)').toEqual([]);
    // The rim that was open by 77.2 mm at #962's base: pocket-16's mouth (identified by the rim's
    // own pocket, not its index — the loop decomposition renumbers the rims).
    const openBefore = tree.rims.find((rim) => rim.of === 'pocket-16');
    expect(openBefore, 'pocket-16 has a rim').toBeDefined();
    expect(gapMm(openBefore!.polyline), 'pocket-16’s rim closes').toBeLessThanOrEqual(0.01);
    expect(openBefore!.polyline.length, 'the mouth region’s own outline, not a 7-point strand').toBeGreaterThan(7);
  }, 900_000);
});
