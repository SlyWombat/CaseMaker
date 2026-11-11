/**
 * #988 — THE SETUP'S DEPTH BAND, on `planModelCam` directly (the issue's red-first fixture): a
 * 30 mm-deep pocket in a 40 mm blank with a 12 mm flute. With `setups[0].bandMm = 11` the pocket
 * is planned to −11 and the 19 mm left is named; without the band the sequencer's own refusal
 * stands (today's behaviour, RED at the parent for the banded half).
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ParsedMesh } from '@/engine/import/stlParser';

const FLAT: Tool = flatEndMill(3.175, { number: 1, id: 'flat-3.175-12', name: 'flat-3.175 (12 mm flute)', fluteLength: 12 });
const BALL: Tool = { ...flatEndMill(3, { number: 2, id: 'ball-3', name: 'ball-3 (12 mm flute)', fluteLength: 12 }), shape: 'ball', typeText: 'Ball Nose' };

const STOCK = { length: 30, width: 30, thickness: 40 };
const POCKET_FLOOR = -30;

function meshOf(solid: ReturnType<typeof tl.Manifold.cube>): ParsedMesh {
  const m = solid.getMesh();
  const positions = new Float32Array(m.vertProperties);
  const indices = new Uint32Array(m.triVerts);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!); maxX = Math.max(maxX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!);
    minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!);
  }
  return { positions, indices, triangleCount: indices.length / 3, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
}

/** A 30 × 30 × 40 block, top at Z 0, with a 10 × 10 pocket 30 mm deep. */
function part(): ParsedMesh {
  const block = tl.Manifold.cube([30, 30, 40], true).translate([0, 0, -20]);
  // The pocket void: 10 × 10, floor −30, its top 0.5 mm above the stock so the boolean is clean.
  const pocket = tl.Manifold.cube([10, 10, 31], true).translate([0, 0, POCKET_FLOOR + 15.5]);
  return meshOf(block.subtract(pocket));
}

function input(bandMm: number | undefined): ModelPlanInput {
  return {
    geometry: { triangles: part() },
    setups: [
      {
        frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -STOCK.thickness },
        underside: 'flatOnStockBottom',
        ...(bandMm === undefined ? {} : { bandMm }),
      },
    ],
    stock: { ...STOCK, material: 'hardwood' },
    fixture: { mount: 'tape', envelope: null },
    cutters: { house: [FLAT, BALL], catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
  };
}

describe('#988 — the setup depth band on planModelCam', () => {
  it('a 30 mm pocket with bandMm 11 is cut to −11 and the 19 mm left is named', async () => {
    const out = await planModelCam(input(11));
    const programs = out.perSetup.flatMap((s) => s.programs);
    const notes = out.perSetup.flatMap((s) => s.notes).join('\n');
    expect(programs.length, `no program was planned — ${notes}; unreachable: ${out.perSetup.flatMap((s) => s.unreachable).join('; ')}`).toBeGreaterThan(0);
    const zs = programs.flatMap((p) => p.operations.flatMap((o) => o.moves.map((m) => m.z)));
    expect(Math.min(...zs), `notes: ${notes}`).toBeGreaterThanOrEqual(-11.001);
    // The band is the floor: the deepest cut reaches it, it does not stop above it.
    expect(Math.min(...zs)).toBeLessThanOrEqual(-10.5);
    expect(notes).toContain('cut to −11 of −30');
    expect(notes).toContain('19 mm is left');
    expect(notes).toContain("Cut only the stock's top 11 mm");
    // Nothing reaches the pocket's stated floor.
    expect(Math.min(...zs)).toBeGreaterThan(POCKET_FLOOR + 1e-6);
  }, 120_000);

  it('without the band the 12 mm flute cannot reach the pocket — the sequencer refuses, unchanged', async () => {
    // #1195 — the refusal is NAMED now: no owned cutter with a stated flute reaches the profile.
    await expect(planModelCam(input(undefined))).rejects.toThrow(/nothing can free this part: none of your cutters has a stated flute/);
  }, 120_000);
});
