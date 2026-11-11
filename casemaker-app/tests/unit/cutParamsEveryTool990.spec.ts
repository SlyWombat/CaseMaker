/**
 * #990 — THE ISSUE'S DIRECT RED-FIRST PIN: a PLA job whose house holds a ⌀6 and a smaller flat, the
 * pocket too narrow for the ⌀6, where the smaller rest must post ITS OWN step-down, not the
 * primary's. The issue's §6 wording ("⌀6 + ⌀2 … 2.7 vs 0.3") does not match the compiled table:
 * PLA's rows are ⌀0.8–1.6 → 0.3 mm and ⌀1.6–3.2 → 0.5 mm, and the ⌀6 has no row of its own (it
 * takes the 3.2 mm row as a stated proxy, 0.5). So the pin uses the pair that genuinely differs —
 * the ⌀6 at its proxy 0.5 against the ⌀1.5 at its own 0.3 — which is the same mechanism the
 * acceptance names, on numbers that exist. (The ledger's other two sites — the curved rough and
 * the skin — are pinned by goalRoughSplit869's SMALL case; this is the pocket-chain site.)
 *
 * RED at `bb75df77` (the rest posts the primary's 0.5), green on the #990 branch (its own 0.3).
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ParsedMesh } from '@/engine/import/stlParser';

const FLAT6 = flatEndMill(6, { number: 1, id: 'flat-6-990', name: 'flat-6' });
const FLAT15 = flatEndMill(1.5, { number: 2, id: 'flat-1.5-990', name: 'flat-1.5' });

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

/** A 20 × 20 × 10 block (top at Z 0) with a 4 × 10 pocket 5 mm deep — too narrow for the ⌀6. */
function part(): ParsedMesh {
  const block = tl.Manifold.cube([20, 20, 10], true).translate([0, 0, -5]);
  const pocket = tl.Manifold.cube([4, 10, 6], true).translate([0, 0, -2]); // spans z −5 … +1
  return meshOf(block.subtract(pocket));
}

const INPUT: ModelPlanInput = {
  geometry: { triangles: part() },
  setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -10 }, underside: 'flatOnStockBottom' }],
  stock: { length: 20, width: 20, thickness: 10, material: 'pla' },
  fixture: { mount: 'tape', envelope: null },
  cutters: { house: [FLAT6, FLAT15], catalogue: [] },
  tolerances: { finishMm: 0.01 },
  edgeBreak: { legMm: 0 },
};

describe('#990 the smaller rest plans at its own PLA step-down', () => {
  it('the ⌀6 primary posts its 0.5 proxy and the ⌀1.5 rest posts its own 0.3, never the primary’s row', async () => {
    const out = await planModelCam(INPUT);
    const programs = out.perSetup[0]!.programs;
    expect(programs.length, 'no program was planned').toBeGreaterThan(0);
    const stepsOf = (id: string): number[] =>
      programs
        .filter((p) => p.tool.id === id)
        .flatMap((p) => p.operations.map((op) => op.passStepMm ?? Number.NaN))
        .filter((v) => Number.isFinite(v));
    const six = stepsOf('flat-6-990');
    const two = stepsOf('flat-1.5-990');
    expect(six, 'the ⌀6 planned nothing to measure').not.toEqual([]);
    expect(two, 'the ⌀2 rest was not planned — the narrow pocket needs it').not.toEqual([]);
    // PLA's compiled rows: ⌀1.6–3.2 → 0.5 mm (the ⌀6 answers through the 3.2 mm proxy, 0.5);
    // ⌀0.8–1.6 → 0.3 mm (the ⌀1.5). Each cutter's passes take its own number.
    expect(new Set(six), 'the ⌀6’s proxy row').toEqual(new Set([0.5]));
    expect(new Set(two), 'the ⌀1.5 must post its own 0.3, not the primary’s 0.5').toEqual(new Set([0.3]));
    // #1186 rule 4 RE-PIN — the borrow is STATED ONCE for every borrowed bit, naming the bits, the
    // row it borrows and what it costs (the #1114 shape was one line per cutter; three identical
    // warnings was the bench's complaint). The behaviour this test is about — each cutter's OWN
    // PLA step-down, never the primary's — is asserted above and unchanged.
    const notes = out.perSetup.flatMap((s2) => s2.notes).join('\n');
    expect(notes).toContain('no feed of its own for pla');
    expect(notes).toContain("row's slower feed and step-down");
    expect((notes.match(/no feed of (its|their) own for/g) ?? []).length, 'the borrow is stated once').toBe(1);
  }, 120_000);
});
