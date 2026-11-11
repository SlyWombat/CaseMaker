/**
 * #943 (10) — THE PART'S OUTLINE IS THE STOCK'S: no freeing contour.
 *
 * Side 2 of the M1 tray is the freed part as its own stock (Makera's Bottom project states it
 * that way: stock 106 × 136 × 26, no contour, only the recess). `planPocketsForTree` demands a
 * freeing contour only when the goal's outline lies inside the stock footprint by more than the
 * fit tolerance on some side; when the outline IS the stock's, the plan cuts no contour and says
 * so rather than leaving the operator to notice a missing program.
 *
 * RED FIRST: at the parent the footprint option does not exist, so the same part always gets a
 * contour — the no-contour expectation and the sentence both fail.
 */

import { describe, expect, it } from 'vitest';

import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

const flat6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });

/** An axis-aligned box sitting in the stock's own front-left corner, `size` mm on each axis. */
function cube(size: number): ModelPlanInput['geometry'] {
  const s = size;
  const v: [number, number, number][] = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, -s], [s, 0, -s], [s, s, -s], [0, s, -s],
  ];
  const faces: [number, number, number][] = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  const positions: number[] = [];
  for (const f of faces) for (const idx of f) positions.push(...v[idx]!);
  const arr = Float32Array.from(positions);
  return {
    triangles: {
      positions: arr,
      indices: Uint32Array.from({ length: arr.length / 3 }, (_, i) => i),
      triangleCount: faces.length,
      bbox: { min: [0, 0, -s], max: [s, s, 0] },
    },
  };
}

function input(length: number, width: number): ModelPlanInput {
  return {
    geometry: cube(10),
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -10 }, underside: 'flatOnStockBottom' }],
    stock: { length, width, thickness: 10, material: 'hardwood' },
    fixture: { mount: 'vise', envelope: null },
    cutters: { house: [flat6], catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
  };
}

describe('#943 (10) the outline is the stock', () => {
  it('a goal whose outline is the stock cuts no freeing contour, and says so', async () => {
    const out = await planModelCam(input(10, 10));
    const ops = out.perSetup.flatMap((s) => s.ops);
    expect(ops.some((op) => op.kind === 'contour')).toBe(false);
    const notes = out.perSetup.flatMap((s) => s.notes).join('\n');
    expect(notes).toContain("the part's outline is the stock's — no freeing contour");
  }, 240_000);

  it('with stock around the outline the contour is demanded as before', async () => {
    const out = await planModelCam(input(20, 20));
    const ops = out.perSetup.flatMap((s) => s.ops);
    expect(ops.some((op) => op.kind === 'contour')).toBe(true);
    const notes = out.perSetup.flatMap((s) => s.notes).join('\n');
    expect(notes).not.toContain("the part's outline is the stock's");
  }, 240_000);
});
