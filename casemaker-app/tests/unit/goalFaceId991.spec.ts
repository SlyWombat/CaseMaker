/**
 * #991 — A USER'S STEP REACHES THE CARD'S PATH. The door tessellates a picked STEP at the
 * acceptance cards' recognition read (0.01 mm absolute chord) and keeps the kernel's per-triangle
 * B-rep face id beside the stored STL; the seam decodes it and hands the feature tree
 * `{ triangles, faceId }`, so a user's STEP is classified by whole B-rep faces (the cards' 38 rims
 * on the tray) instead of as a plain triangulation (63 rims). An open sheet the skirt has to
 * close cannot keep its ids — the seam refuses it by name rather than planning the wrong path.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readTargetObjectFile } from '@/engine/import/targetObject';
import { base64ToArrayBuffer } from '@/engine/import/base64';
import { parseStl } from '@/engine/import/stlParser';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import { buildModelPlanInputForGoal, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { planModelCam } from '@/engine/cnc/cam/model/plan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

const FIXTURES = path.resolve(__dirname, '../fixtures/step');

function fixture(name: string): ArrayBuffer {
  const bytes = fs.readFileSync(path.join(FIXTURES, name));
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

const BALL: Tool = { ...flatEndMill(2), name: '2 mm ball nose', shape: 'ball', typeText: 'Ball', diameter: 2, cornerRadius: 1 };
// #1195 — the fixture's flat states a flute: the freeing cut needs a STATED reach.
const FLAT: Tool = { ...flatEndMill(6, { fluteLength: 30 }), id: 'flat-6-991', name: 'flat-6' };
const SHOP: EngraveShopOpts = {
  tools: [{ key: 'inv:flat-6-991', tool: FLAT, provenance: 'test' }],
};

/** The door's read as a job's target: the read's own fields, placed at the stock's centre. */
function targetOf(read: { id: string; name: string; format: string; sha256: string; data: string; size: { x: number; y: number; z: number }; faceId?: string }, at: { x: number; y: number; z: number }): EngraveTargetObject {
  return {
    id: read.id,
    name: read.name,
    format: read.format as EngraveTargetObject['format'],
    sha256: read.sha256,
    data: read.data,
    size: read.size,
    position: at,
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...(read.faceId === undefined ? {} : { faceId: read.faceId }),
  };
}

function jobFor(target: EngraveTargetObject): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    shapes: [],
    targetObject: target,
    toolKey: '',
    tool: BALL,
    stock: { ...base.stock, length: 60, width: 40, thickness: 12, material: 'pla' },
  };
}

describe('#991 the door keeps a STEP’s face ids', () => {
  it('a picked STEP yields an STL target whose faceId has one entry per triangle', async () => {
    const read = await readTargetObjectFile(new File([fixture('box.step')], 'box.step'), 'step-faceid-991');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.format).toBe('stl');
    expect(read.faceId).toBeDefined();
    const mesh = parseStl(base64ToArrayBuffer(read.data!));
    const faceId = new Uint32Array(base64ToArrayBuffer(read.faceId!));
    expect(faceId.length).toBe(mesh.triangleCount);
    // A box's six planar faces: every triangle carries one of six ids, none is 0xffffffff.
    const ids = new Set(Array.from(faceId));
    expect(ids.size).toBe(6);
    expect([...ids].some((id) => id === 0xffffffff)).toBe(false);
  }, 120_000);

  it('the seam plans the door-imported STEP by its B-rep faces: report.source is "step"', async () => {
    const read = await readTargetObjectFile(new File([fixture('box.step')], 'box.step'), 'step-faceid-991');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const goal = targetOf(read, { x: 30, y: 20, z: 0 });
    const input = await buildModelPlanInputForGoal(jobFor(goal), goal, BALL, SHOP);
    expect(input.geometry.faceId?.length).toBe(input.geometry.triangles.triangleCount);
    const out = await planModelCam(input);
    expect(out.perSetup[0]!.features.report.source).toBe('step');
  }, 120_000);

  it('an open sheet carrying face ids is refused by name — the skirt cannot keep them aligned', async () => {
    // A single 10 × 10 quad: open, closeable with a skirt, and carrying two fabricated face ids of
    // the right length. The skirt re-indexes the triangles, so the seam must refuse rather than
    // plan the mesh path under a STEP's ids.
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const stl = buildBinaryStl([{ positions, indices }]);
    const faceId = new Uint32Array([0, 0]);
    const goal: EngraveTargetObject = {
      id: 'open-sheet-991',
      name: 'sheet.stl',
      format: 'stl',
      sha256: 'f'.repeat(64),
      data: Buffer.from(new Uint8Array(stl)).toString('base64'),
      faceId: Buffer.from(new Uint8Array(faceId.buffer)).toString('base64'),
      size: { x: 10, y: 10, z: 0.001 },
      position: { x: 30, y: 20, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
    } as EngraveTargetObject;
    await expect(buildModelPlanInputForGoal(jobFor(goal), goal, BALL, SHOP)).rejects.toThrow(
      /open sheet the skirt had to close — its STEP face ids no longer match/,
    );
  }, 120_000);
});
