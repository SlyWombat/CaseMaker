/**
 * #964 — THE PLAN'S WALL-TIME BUDGET (#965 performance guard).
 *
 * A tray-sized synthetic part (110 × 140 × 27.2, six pockets at different depths, a through
 * hole) planned through `planModelCam` must finish inside a stated wall time on this machine, so
 * a performance regression is red. The pin is 2× the measured time of the first accepted run:
 *
 *   PLAN_BUDGET_MS is PROVISIONAL until the entry lands — `planModelCam` is the #956 stub today,
 *   so the spec fails on that named error before it can time anything. The first green run on
 *   dave-1 records its wall time in the note on #964 and replaces this constant with 2× it (the
 *   same rule as the seven-line fixtures: measured, not guessed).
 *
 * The part is built with the production Manifold kernel; nothing else in the spec is a stub.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ParsedMesh } from '@/engine/import/stlParser';

/** PROVISIONAL — replace with 2× the measured first accepted run (see this file's header). */
const PLAN_BUDGET_MS = 120_000;

const HOUSE: Tool[] = [
  flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' }),
  flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' }),
  flatEndMill(2, { number: 3, id: 'flat-2', name: 'flat-2' }),
  { ...flatEndMill(2, { number: 4, id: 'ball-2', name: 'ball-2' }), typeText: 'Ball Nose', shape: 'ball' },
];

function trayMesh(): ParsedMesh {
  const L = 110;
  const W = 140;
  const T = 27.2;
  let solid = tl.Manifold.cube([L, W, T], true).translate([0, 0, -T / 2]);
  const pockets: [number, number, number, number, number][] = [
    [-35, -45, 26, 30, 6],
    [-35, 0, 26, 30, 9],
    [-35, 45, 26, 30, 12],
    [25, -45, 30, 30, 4],
    [25, 0, 30, 30, 15],
    [25, 45, 30, 30, 7],
  ];
  for (const [x, y, w, d, depth] of pockets) {
    solid = solid.subtract(tl.Manifold.cube([w, d, depth + 2], true).translate([x, y, -depth / 2]));
  }
  solid = solid.subtract(tl.Manifold.cylinder(T + 2, 4, 4, 32, true).translate([0, 70, 0]));
  const m = solid.getMesh();
  const positions = new Float32Array(m.vertProperties);
  const indices = new Uint32Array(m.triVerts);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!); maxX = Math.max(maxX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!);
    minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!);
  }
  return {
    positions,
    indices,
    triangleCount: indices.length / 3,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}

describe('#964 the rebuilt plan meets its wall-time budget (#965)', () => {
  it('plans the tray-sized part within the stated wall time', async () => {
    const mesh = trayMesh();
    const input: ModelPlanInput = {
      geometry: { triangles: mesh },
      setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -27.2 }, underside: 'flatOnStockBottom' }],
      stock: { length: 110, width: 140, thickness: 27.2, material: 'hardwood' },
      fixture: { mount: 'tape', envelope: null },
      cutters: { house: HOUSE, catalogue: [] },
      tolerances: { finishMm: 0.01 },
      edgeBreak: { legMm: 0 },
    };
    const t0 = performance.now();
    const output = await planModelCam(input);
    const elapsed = performance.now() - t0;
    // eslint-disable-next-line no-console -- the measured wall time is the pin's evidence
    console.log(`#965: planModelCam took ${elapsed.toFixed(0)} ms (budget ${PLAN_BUDGET_MS} ms)`);
    expect(output.perSetup.length).toBeGreaterThan(0);
    expect(elapsed, `planModelCam took ${elapsed.toFixed(0)} ms, budget ${PLAN_BUDGET_MS} ms`).toBeLessThanOrEqual(PLAN_BUDGET_MS);
  }, 600_000);
});
