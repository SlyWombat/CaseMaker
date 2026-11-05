/**
 * #960 — the ball finish never posts below its own exact drop-cutter CL, on the REAL organizer.
 *
 * E's #959 sweep found the organizer's ⌀6 ball program posting Z under `dropCutterHeight` at its
 * own XY on a ~45° ramp (worst −0.115 mm at a posted point, −0.136 mm on a chord), where five
 * synthetic reproductions came back clean. So this spec is gated on the vendor STEP (licensed —
 * never copied into the repo):
 *
 *   CM_959_ORGANIZER_STEP=…/makera-tool-organizer/<organizer>.step npx vitest run tests/unit/finishClOrganizer960.spec.ts
 *
 * The part is placed exactly as `opsAcceptance959.spec.ts` places it (centred on 170×170 stock,
 * top at −0.8, stock top Z 0 — the posted program's own frame) and planned through `planModelCam`.
 * Every FEED of every ball op (finish and pencil) is checked against the exact CL of the same ball
 * on the same mesh: each end point, and points along the chord between consecutive points.
 */

import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { stepToMesh } from '@/engine/import/stepMesh';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { planModelCam, type ModelPlanInput } from '@/engine/cnc/cam/model/plan';
import { dropCutterHeight, profileOf, type DropCutterMesh } from '@/engine/cnc/cam/model/dropcutter';

const ORGANIZER = process.env.CM_959_ORGANIZER_STEP;
const TOL_MM = 0.005;

const FLAT6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 32 });
const FLAT3175 = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 25 });
const BALL6: Tool = { ...flatEndMill(6, { number: 3, id: 'ball-6', name: 'ball-6', fluteLength: 32 }), typeText: 'Ball Nose', shape: 'ball' };
const CHAMFER3175: Tool = {
  ...flatEndMill(3.175, { number: 4, id: 'chamfer-90', name: '3.175mm*90º Chamfer' }),
  typeText: 'V-Bit',
  shape: 'chamfer',
  tipDiameter: 0.1,
  diameter: 3.175,
  cornerRadius: 0,
  angle: 90,
  halfAngle: 45,
};

describe.skipIf(ORGANIZER === undefined)('#960 — the organizer ball program stays on or above its exact CL', () => {
  it('no posted point and no chord of a ball op dips below dropCutterHeight − 0.005 mm', async () => {
    const bytes = fs.readFileSync(ORGANIZER!);
    const read = await stepToMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'recognition');
    const { min, max } = read.mesh.bbox;
    const dx = 85 - (min[0] + max[0]) / 2;
    const dy = 85 - (min[1] + max[1]) / 2;
    const dz = -0.8 - max[2];
    const positions = Float32Array.from(read.mesh.positions);
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = positions[i]! + dx;
      positions[i + 1] = positions[i + 1]! + dy;
      positions[i + 2] = positions[i + 2]! + dz;
    }
    const lo: [number, number, number] = [Infinity, Infinity, Infinity];
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c]!, positions[i + c]!);
        hi[c] = Math.max(hi[c]!, positions[i + c]!);
      }
    }
    const triangles = { positions, indices: read.mesh.indices, triangleCount: read.mesh.indices.length / 3, bbox: { min: lo, max: hi } };
    const input: ModelPlanInput = {
      geometry: { triangles, ...(read.faceId === undefined ? {} : { faceId: read.faceId }) },
      setups: [{ frame: { up: [0, 0, 1], stockTop: 0 }, underside: 'flatOnStockBottom' }],
      stock: { length: 170, width: 170, thickness: -lo[2], material: 'hardwood' },
      fixture: { mount: 'tape', envelope: null },
      cutters: { house: [FLAT6, FLAT3175, BALL6, CHAMFER3175], catalogue: [] },
      tolerances: { finishMm: 0.01 },
      edgeBreak: { legMm: 0.5 },
    };
    const setup = (await planModelCam(input)).perSetup[0]!;
    const ballOps = setup.ops.filter((op) => op.outcome.ir.tool.shape === 'ball');
    expect(ballOps.some((op) => op.kind === 'finish'), 'the ball finish never ran on the organizer').toBe(true);

    // The exact CL on a SEPARATE mesh object (its own triangle bins), in the same frame (stock top 0).
    const exactMesh: DropCutterMesh = { positions, indices: read.mesh.indices, triangleCount: triangles.triangleCount };
    const profile = profileOf(BALL6)!;
    type Gap = { op: string; kind: 'point' | 'chord'; x: number; y: number; z: number; cl: number; gap: number };
    const gaps: Gap[] = [];
    let checked = 0;
    const check = (op: string, kind: Gap['kind'], x: number, y: number, z: number): void => {
      const cl = dropCutterHeight(profile, exactMesh, x, y);
      if (cl === null) return;
      checked++;
      if (z < cl - TOL_MM) gaps.push({ op, kind, x, y, z, cl, gap: z - cl });
    };
    for (const op of ballOps) {
      const label = `${op.kind} ${op.region.id}`;
      for (const operation of op.outcome.ir.operations) {
        let at: [number, number, number] | null = null;
        for (const m of operation.moves) {
          if (!('x' in m) || m.x === undefined || m.y === undefined || m.z === undefined) { at = null; continue; }
          if (m.kind === 'feed') {
            check(label, 'point', m.x, m.y, m.z);
            if (at !== null) {
              for (const t of [0.25, 0.5, 0.75]) {
                check(label, 'chord', at[0] + (m.x - at[0]) * t, at[1] + (m.y - at[1]) * t, at[2] + (m.z - at[2]) * t);
              }
            }
          }
          at = [m.x, m.y, m.z];
        }
      }
    }
    gaps.sort((a, b) => a.gap - b.gap);
    const worst = gaps.slice(0, 12).map((g) => `${g.op} ${g.kind} (${g.x.toFixed(3)}, ${g.y.toFixed(3)}) z ${g.z.toFixed(4)} cl ${g.cl.toFixed(4)} gap ${g.gap.toFixed(4)}`);
    console.log(`#960 organizer: ${checked} checks over ${ballOps.length} ball op(s); ${gaps.length} below CL − ${TOL_MM}; worst:\n  ${worst.join('\n  ')}`);
    expect(checked).toBeGreaterThan(1000);
    expect(gaps.length, `worst:\n${worst.join('\n')}`).toBe(0);
  }, 1_800_000);
});
