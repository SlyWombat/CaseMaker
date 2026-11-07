/** #1028 k3 timing probe (temporary): the ladder on the plate, tray and organizer. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { stepToMesh } from '@/engine/import/stepMesh';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import { planModelCam } from '@/engine/cnc/cam/model/plan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { buildModelPlanInputForGoal } from '@/workers/sim/engraveGenerate';

const FLAT6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 32 });
const FLAT3175 = flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 25 });
const BALL6: Tool = { ...flatEndMill(6, { number: 3, id: 'ball-6', name: 'ball-6', fluteLength: 32 }), typeText: 'Ball Nose', shape: 'ball' };
const VENDOR_SET = [FLAT6, FLAT3175, BALL6];

type P = [number, number, number];
type Tri2 = [[number, number], [number, number], [number, number]];

function stlBase64(tris: readonly (readonly [P, P, P])[]): string {
  const bytes = new Uint8Array(84 + tris.length * 50);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const [a, b, c] of tris) {
    for (let k = 0; k < 3; k++) dv.setFloat32(off + k * 4, 0, true);
    off += 12;
    for (const q of [a, b, c]) {
      dv.setFloat32(off, q[0], true);
      dv.setFloat32(off + 4, q[1], true);
      dv.setFloat32(off + 8, q[2], true);
      off += 12;
    }
    dv.setUint16(off, 0, true);
    off += 2;
  }
  return Buffer.from(bytes).toString('base64');
}

/** The #1023 plate: 20 × 10 × 5 with a 6 mm-wide V notch, wound consistently. */
function notchedPlate(): string {
  const A: [number, number] = [0, 0];
  const B: [number, number] = [20, 0];
  const C: [number, number] = [20, 5];
  const D: [number, number] = [13, 5];
  const E: [number, number] = [10, 0.5];
  const F: [number, number] = [7, 5];
  const G: [number, number] = [0, 5];
  const section = [A, B, C, D, E, F, G];
  const depth = 10;
  const capTris: Tri2[] = [[C, D, E], [B, C, E], [A, B, E], [G, A, E], [E, F, G]];
  const cap = (y: number): readonly (readonly [P, P, P])[] =>
    capTris.map(([a, b, c]) => (y === 0
      ? [[a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]]]
      : [[a[0], y, a[1]], [c[0], y, c[1]], [b[0], y, b[1]]])) as readonly (readonly [P, P, P])[];
  const sideTris: (readonly [P, P, P])[] = [];
  for (let i = 0; i < section.length; i++) {
    const a = section[i]!;
    const b = section[(i + 1) % section.length]!;
    const a0: P = [a[0], 0, a[1]];
    const b0: P = [b[0], 0, b[1]];
    const a1: P = [a[0], depth, a[1]];
    const b1: P = [b[0], depth, b[1]];
    sideTris.push([a0, a1, b1], [a0, b1, b0]);
  }
  return stlBase64([...cap(0), ...cap(depth), ...sideTris]);
}

async function plateRun(): Promise<void> {
  const base = defaultEngraveJob();
  const target = {
    id: 'goal-1023', name: 'notched plate', role: 'goal', enabled: true, format: 'stl',
    sha256: 'q'.repeat(64), data: notchedPlate(),
    position: { x: 30, y: 20, z: 0 }, rotation: 0,
    size: { x: 20, y: 10, z: 5 }, surface: { gridPitchMm: 0.5 },
  } as EngraveTargetObject;
  const job: EngraveJob = {
    ...base, labels: [], shapes: [], targetObject: target, toolKey: '', tool: BALL6,
    stock: { ...base.stock, length: 60, width: 40, thickness: 12, material: 'pla' },
  };
  const feeds = [{ material: 'pla' as const, minDiameter: 0.4, maxDiameter: 8, params: { rpm: 12000, feed: 800, plungeFeed: 300, stepDown: 1, stepOverFraction: 0.45, peckFraction: 1, air: true }, status: 'unmeasured' as const, provenance: 'probe' }];
  const shop = { tools: VENDOR_SET.map((t, i) => ({ key: `inv:${i}`, tool: t, provenance: 'probe' })), feeds };
  const t0 = performance.now();
  const input = await buildModelPlanInputForGoal(job, target, BALL6, shop);
  const plan = await planModelCam(input, { restLadder: true });
  console.log(`#1028 plate: total ${((performance.now() - t0) / 1000).toFixed(1)} s, rows ${JSON.stringify(plan.ladderRows?.map((r) => r.diameterMm))}`);
}

async function targetFor(file: string, stock: [number, number], modelTop: number): Promise<EngraveTargetObject> {
  const bytes = fs.readFileSync(file);
  const read = await stepToMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'recognition');
  const { min, max } = read.mesh.bbox;
  const stl = buildBinaryStl([{ positions: read.mesh.positions, indices: read.mesh.indices }]);
  const sha256 = createHash('sha256').update(Buffer.from(stl)).digest('hex');
  return {
    id: sha256.slice(0, 16), name: path.basename(file), format: 'stl', sha256,
    data: Buffer.from(stl).toString('base64'),
    size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
    position: { x: stock[0] / 2, y: stock[1] / 2, z: modelTop }, rotation: 0, enabled: true, role: 'goal',
  } as EngraveTargetObject;
}

async function run(name: string, file: string, stock: [number, number], thickness: number, modelTop: number): Promise<void> {
  const target = await targetFor(file, stock, modelTop);
  const base = defaultEngraveJob();
  const job: EngraveJob = {
    ...base, labels: [], shapes: [], targetObject: target, toolKey: '', tool: BALL6,
    stock: { ...base.stock, length: stock[0], width: stock[1], thickness, material: 'hardwood' },
  };
  const shop = { tools: VENDOR_SET.map((t, i) => ({ key: `inv:${i}`, tool: t, provenance: 'probe' })), feeds: null };
  const t0 = performance.now();
  const input = await buildModelPlanInputForGoal(job, target, BALL6, shop);
  const plan = await planModelCam(input, { restLadder: true });
  console.log(`#1028 ${name}: total ${((performance.now() - t0) / 1000).toFixed(1)} s, rows ${JSON.stringify(plan.ladderRows)}`);
}

describe('#1028 k3 probe', () => {
  it('plate ladder', async () => {
    await plateRun();
    expect(true).toBe(true);
  }, 600_000);
  it.skipIf(process.env.CM_959_TRAY_STEP === undefined)('tray + organizer ladder', async () => {
    await run('tray', process.env.CM_959_TRAY_STEP!, [110, 140], 27.2, -1.2);
    await run('organizer', process.env.CM_959_ORGANIZER_STEP!, [170, 170], 26.8, -0.8);
    expect(true).toBe(true);
  }, 3_600_000);
});
