/**
 * #1003 — THE STOCK BOTTOM IS THE FLOOR. A goal taller than its blank must not free through the
 * vise: the freeing contour is cut off at the stock bottom and the clipped millimetres are stated.
 * The verifier's `cut-too-deep` stays the hard gate; this pins the PLAN honouring it.
 *
 * RED FIRST: at the parent the contour runs to the part's own bottom (10 mm on an 8 mm stock), so
 * the deepest feed reads −10 — deeper than the stock — and no note exists.
 */

import { describe, expect, it } from 'vitest';

import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

const flat6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });

/** An axis-aligned box, top at z = 0, `size` mm on each axis (so its bottom is −size). */
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

function input(stockThickness: number, breakthroughMm?: number): ModelPlanInput {
  return {
    geometry: cube(10),
    ...(breakthroughMm === undefined ? {} : { sacrificialBreakthroughMm: breakthroughMm }),
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -stockThickness }, underside: 'flatOnStockBottom' }],
    stock: { length: 20, width: 20, thickness: stockThickness, material: 'hardwood' },
    fixture: { mount: 'vise', envelope: null },
    cutters: { house: [flat6], catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
  };
}

/** The deepest Z any posted move reaches, across the setup's programs. */
function deepestZ(output: Awaited<ReturnType<typeof planModelCam>>): number {
  let deepest = 0;
  for (const setup of output.perSetup) {
    for (const ir of setup.programs) for (const op of ir.operations) for (const move of op.moves) deepest = Math.min(deepest, move.z);
  }
  return deepest;
}

describe('#1003 the stock bottom is the floor', () => {
  it('a 10 mm cube on an 8 mm stock frees at −8, and the plan states the 2 mm it cut off', async () => {
    const output = await planModelCam(input(8));
    expect(deepestZ(output)).toBeGreaterThanOrEqual(-8 - 1e-6);
    const notes = output.perSetup.flatMap((s) => s.notes).join('\n');
    expect(notes).toContain('2.000 mm below the stock; the freeing contour is cut off at the stock bottom');
  }, 240_000);

  it('the same cube on a 12 mm stock is unchanged — no clamp, no note', async () => {
    const output = await planModelCam(input(12));
    expect(deepestZ(output)).toBeLessThanOrEqual(-10 + 1e-6);
    expect(deepestZ(output)).toBeGreaterThanOrEqual(-10 - 1e-6);
    const notes = output.perSetup.flatMap((s) => s.notes).join('\n');
    expect(notes).not.toContain('cut off at the stock bottom');
  }, 240_000);

  it('with a board under the blank, the contour may cut through into it — no clip, no note', async () => {
    // #1003 (the manager's narrowing): the breakthrough exists so the FREEING CONTOUR cuts through
    // the blank into the board. An 8 mm stock with a 5 mm breakthrough allows the contour to reach
    // the part's own bottom; the pockets and the surfaces still stop at the stock bottom.
    const output = await planModelCam(input(8, 5));
    expect(deepestZ(output)).toBeLessThanOrEqual(-10 + 1e-6);
    const notes = output.perSetup.flatMap((s) => s.notes).join('\n');
    expect(notes).not.toContain('cut off at the stock bottom');
  }, 240_000);

  it('a part whose bottom is the stock bottom takes the board breakthrough — no skin under it', async () => {
    // #943 (10): the M1 tray's freeing contour stopped at −25.000 on a 25 mm blank over a board,
    // leaving the part held by a skin. A contour that reaches the stock bottom IS a through cut:
    // it goes `thickness + breakthrough`, the same rule every through cut follows.
    const output = await planModelCam(input(10, 0.3));
    expect(deepestZ(output)).toBeGreaterThanOrEqual(-10.3 - 1e-6);
    expect(deepestZ(output)).toBeLessThanOrEqual(-10.3 + 1e-6);
    const notes = output.perSetup.flatMap((s) => s.notes).join('\n');
    expect(notes).not.toContain('cut off at the stock bottom');
  }, 240_000);

  it('a job that states NO freeing tabs cuts the contour to its floor everywhere', async () => {
    // #943 (10), the vendor tray's own side 1: `supportTabs = 0`. The job states it through
    // `ModelPlanInput.freeingTabs` (from `goal.underside`); the default job keeps its 4 tabs, so
    // the tab-top level (−(thickness − height) = −9.3 at height 0.7) only exists with the tabs.
    const contourZ = (out: Awaited<ReturnType<typeof planModelCam>>): number[] =>
      out.perSetup
        .flatMap((s) => s.ops)
        .filter((op) => op.kind === 'contour')
        .flatMap((op) => op.outcome.ir.operations)
        .flatMap((op) => op.moves)
        .filter((m) => m.kind === 'feed')
        .map((m) => Math.round(m.z * 1000) / 1000);
    const withTabs = contourZ(await planModelCam({ ...input(10, 0.3), freeingTabs: { count: 4, widthMm: 6, heightMm: 0.7 } }));
    expect(withTabs).toContain(-9.3);
    const without = contourZ(await planModelCam({ ...input(10, 0.3), freeingTabs: { count: 0, widthMm: 6, heightMm: 0.7 } }));
    expect(without).not.toContain(-9.3);
    expect(Math.min(...without)).toBeCloseTo(-10.3, 3);
  }, 240_000);
});
