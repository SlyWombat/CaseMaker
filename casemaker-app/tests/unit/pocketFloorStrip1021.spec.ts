/**
 * #1021 — A POCKET FLOOR STRIP NARROWER THAN THE PRIMARY FLAT'S RING, RED-FIRST.
 *
 * The geometry is the issue's own, scaled to the Manager's numbers: an 84 × 60 mm pocket floored
 * at −6, two 30 × 20 mm ISLANDS standing in it, a 3.3 mm gap between them and 10 mm of open floor
 * all round. Islands are what makes the strip exist at all: `recogniseFeatures`' pocket region is
 * the cleared cross-section at the floor, so a DEPRESSION leaves the region solid and its strip is
 * within a flat-radius of open floor; a standing island removes the area from the region, and the
 * strip between two long islands is a channel whose middle is 10 mm from the open floor at its
 * ends — further than the ⌀6 flat's radius, so no ring ever enters it.
 *
 * RED FIRST: with the #1021 builder removed, the strip has no owner — nothing in the plan states
 * it and no pass cuts it. GREEN: the plan states it through the EXISTING `goal-region-uncut`
 * warning with the node id and its area, because with {⌀6 flat, ⌀6 ball} nothing owned fits a
 * 3.3 mm strip (a round cutter cannot reach a floor narrower than its own diameter), and it plans
 * no air motion over it.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const BALL6: Tool = { ...flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose' };

const L = 130;
const W = 110;
const T = 12;
const FLOOR = -6;
/** Pocket, then the two islands and the gap between them — the Manager's own numbers. */
const POCKET = { x0: 23, x1: 107, y0: 25, y1: 85 };
const ISLAND_W = 30;
const GAP = 3.3;
const ISLAND_Y = { y0: 45, y1: 65 };
const ISLAND_A_X = { x0: 33, x1: 63 };
const ISLAND_B_X = { x0: 63 + GAP, x1: 63 + GAP + ISLAND_W };

function fixture(): { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } {
  const M = tl.Manifold;
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
    M.cube([x1 - x0, y1 - y0, z1 - z0], true).translate([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]);
  let solid = box(0, L, 0, W, -T, 0);
  // The pocket void with the two islands standing in it: the void is the pocket less the islands,
  // so the islands are part of the part.
  let pocketVoid = box(POCKET.x0, POCKET.x1, POCKET.y0, POCKET.y1, FLOOR, 0);
  pocketVoid = pocketVoid.subtract(box(ISLAND_A_X.x0, ISLAND_A_X.x1, ISLAND_Y.y0, ISLAND_Y.y1, FLOOR, 0));
  pocketVoid = pocketVoid.subtract(box(ISLAND_B_X.x0, ISLAND_B_X.x1, ISLAND_Y.y0, ISLAND_Y.y1, FLOOR, 0));
  solid = solid.subtract(pocketVoid);
  const mesh = solid.getMesh();
  const numProp = mesh.numProp;
  const numVert = mesh.vertProperties.length / numProp;
  const positions = new Float32Array(numVert * 3);
  for (let i = 0; i < numVert; i++) {
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = mesh.vertProperties[i * numProp + k]!;
  }
  const indices = new Uint32Array(mesh.triVerts);
  solid.delete();
  return { positions, indices, triangleCount: indices.length / 3, bbox: { min: [0, 0, -T], max: [L, W, 0] } };
}

describe('#1021 — the strip between two islands, nothing owned fits it', () => {
  it('states the strip as standing, with its node and area, and plans no air over it', async () => {
    const input: ModelPlanInput = {
      geometry: { triangles: fixture() },
      setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -T }, underside: 'flatOnStockBottom' }],
      stock: { length: L, width: W, thickness: T, material: 'hardwood' },
      fixture: { mount: 'tape', envelope: null },
      cutters: { house: [FLAT6, BALL6], catalogue: [] },
      tolerances: {},
      edgeBreak: { legMm: 0 },
    };
    const output = await planModelCam(input);
    const statements = output.perSetup.flatMap((s) => s.statements);
    const notes = output.perSetup.flatMap((s) => s.notes).join('\n');

    const strip = statements.find((s) => s.code === 'goal-region-uncut' && s.text.includes('floor strip'));
    expect(strip, `no floor-strip statement; statements: ${statements.map((s) => `${s.code}: ${s.text}`).join(' | ')}\nnotes:\n${notes}`).toBeDefined();
    expect(strip!.severity).toBe('warning');
    expect(strip!.count).toBe(1);
    // The strip is the 3.3 × 20 mm channel between the islands, less the two ends the flat's disc
    // can reach from the open floor (3 mm each) — tens of mm², never the whole pocket.
    expect(strip!.text).toMatch(/pocket-\d+:/);
    // No "finished by the ball" claim, and no floor-strip pass planned: nothing owned fits it.
    expect(statements.some((s) => s.code === 'goal-pocket-floor-rest')).toBe(false);
    expect(output.perSetup.flatMap((s) => s.ops).filter((op) => op.region.id.endsWith(':floor-strip')).length).toBe(0);

    // The strip still stands — that is the honest state this issue reports.
    const stripArea = Number(/pocket-\d+: ([\d.]+) mm²/.exec(strip!.text)?.[1] ?? '0');
    console.log(`strip area ${stripArea} mm²`);
    expect(stripArea).toBeGreaterThan(5);
    expect(stripArea).toBeLessThan(80);
  }, 240_000);
});
