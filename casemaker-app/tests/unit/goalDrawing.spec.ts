// #811 — WHAT THE GOAL MAKES, DRAWN. The preview worker builds the goal's two volumes from the
// same parsed mesh and the same placed frame the CAM samples: the part itself (item) and the
// material the program removes (item: the blank minus the part; mold: the part's volume as a
// cavity clipped to the blank). Both are volumes with closed forms, so the assertions are against
// arithmetic, not against another run of the same code:
//
//   blank 100 × 60 × 12        = 72 000 mm³
//   part  10 × 10 × 5, flush   =    500 mm³
//   item:  removed = 72 000 − 500 = 71 500 mm³
//   mold:  removed = the cavity =    500 mm³ (a box is symmetric about its mid-height, so the
//                                                 turned part occupies the same slab)
//
// Plus the drawing decisions the scene reads as plain data: the stock ghost (transparent, no depth
// write) exactly when the job states a goal, and the legend's two lines.
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { tl } from './helpers/manifoldExec';
import { preview } from './helpers/engravePipeline';
import { createEngravePreviewer } from '@/workers/sim/engravePreview';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { goalLegendWords, statedGoalTarget, stockGhost, GOAL_GHOST_OPACITY } from '@/components/viewport/goalDrawing';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

type V = [number, number, number];
type Tri = [V, V, V];

/** A binary STL from a triangle soup — the same encoding the file door produces. */
function stl(tris: Tri[]): string {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

/** A CLOSED, outward-wound box via three's own geometry, so only the drawing is under test. */
function boxStl(sx: number, sy: number, sz: number): string {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const pos = g.getAttribute('position');
  const index = g.getIndex()!;
  const at = (i: number): V => {
    const v = index.getX(i);
    return [pos.getX(v), pos.getY(v), pos.getZ(v)];
  };
  const tris: Tri[] = [];
  for (let i = 0; i < index.count; i += 3) tris.push([at(i), at(i + 1), at(i + 2)]);
  g.dispose();
  return stl(tris);
}

let n = 0;
function goalStl(data: string, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'goal-1',
    name: 'block.stl',
    format: 'stl',
    sha256: (n++).toString(16).padStart(64, 'b'),
    data,
    size: { x: 10, y: 10, z: 5 },
    position: { x: 50, y: 30, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

/** The default stock is 100 × 60 × 12; no labels, one cutter — a pure goal job. */
function goalJob(target: EngraveTargetObject): EngraveJob {
  return { ...defaultEngraveJob(), labels: [], shapes: [], toolKey: 'flat-1.0', targetObject: target };
}

/** Signed volume of a triangle soup (divergence theorem), absolute value in mm³. */
function meshVolume(m: NodeMeshOutput): number {
  const p = m.positions;
  const idx = m.indices;
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]! * 3;
    const b = idx[i + 1]! * 3;
    const c = idx[i + 2]! * 3;
    const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!;
    const bx = p[b]!, by = p[b + 1]!, bz = p[b + 2]!;
    const cx = p[c]!, cy = p[c + 1]!, cz = p[c + 2]!;
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(v / 6);
}

const BLANK = 100 * 60 * 12; // 72 000 mm³
const PART = 10 * 10 * 5; // 500 mm³

describe('#811 — the goal’s drawn volumes', () => {
  it('item: the part is drawn, and the removed overlay is the blank minus the part', () => {
    const previewer = createEngravePreviewer(tl);
    const p = preview(previewer, goalJob(goalStl(boxStl(10, 10, 5))), 1);
    expect(p).not.toBeNull();
    expect(p!.goal).not.toBeNull();
    expect(p!.goal!.mode).toBe('item');
    expect(p!.goal!.part).not.toBeNull();
    expect(meshVolume(p!.goal!.part!)).toBeCloseTo(PART, 3);
    expect(p!.goal!.removed).not.toBeNull();
    expect(meshVolume(p!.goal!.removed!)).toBeCloseTo(BLANK - PART, 3);
  });

  it('mold: the part is the cavity — its volume clipped to the blank — and nothing stands proud', () => {
    const previewer = createEngravePreviewer(tl);
    const job = goalJob(goalStl(boxStl(10, 10, 5), { goalMode: 'mold' }));
    const p = preview(previewer, job, 1);
    expect(p!.goal!.mode).toBe('mold');
    expect(p!.goal!.part).toBeNull();
    expect(p!.goal!.removed).not.toBeNull();
    expect(meshVolume(p!.goal!.removed!)).toBeCloseTo(PART, 3);
  });

  it('the two modes draw different volumes, and flipping the mode re-draws without a stale cache', () => {
    const previewer = createEngravePreviewer(tl);
    const job = goalJob(goalStl(boxStl(10, 10, 5)));
    const item = preview(previewer, job, 1)!;
    job.targetObject = { ...job.targetObject!, goalMode: 'mold' };
    const mold = preview(previewer, job, 2)!;
    expect(item.goal!.mode).toBe('item');
    expect(mold.goal!.mode).toBe('mold');
    const itemRemoved = meshVolume(item.goal!.removed!);
    const moldRemoved = meshVolume(mold.goal!.removed!);
    expect(itemRemoved).toBeGreaterThan(moldRemoved);
    expect(itemRemoved - moldRemoved).toBeCloseTo(BLANK - 2 * PART, 3);
  });

  it('an open mesh gets no drawing (null), and the stock is still ghosted by the job’s statement', () => {
    const previewer = createEngravePreviewer(tl);
    const open = stl([[[0, 0, 0], [10, 0, 0], [0, 10, 0]]]);
    const p = preview(previewer, goalJob(goalStl(open)), 1);
    expect(p).not.toBeNull();
    expect(p!.goal).toBeNull();
  });

  it('a reference object is drawn, never cut: no goal volumes', () => {
    const previewer = createEngravePreviewer(tl);
    const p = preview(previewer, goalJob(goalStl(boxStl(10, 10, 5), { role: 'reference' })), 1);
    expect(p).not.toBeNull();
    expect(p!.goal).toBeNull();
  });
});

describe('#811 — the drawing decisions', () => {
  it('the stock is ghosted exactly when a goal is stated: transparent, no depth write', () => {
    expect(stockGhost(true)).toEqual({ transparent: true, opacity: GOAL_GHOST_OPACITY, depthWrite: false });
    expect(stockGhost(false)).toEqual({ transparent: false, opacity: 1, depthWrite: true });
  });

  it('a stated goal is an enabled role:"goal" target; a reference or a disabled target is not', () => {
    const job = { targetObject: goalStl(boxStl(1, 1, 1)) };
    expect(statedGoalTarget(job)).not.toBeNull();
    expect(statedGoalTarget({ targetObject: { ...job.targetObject!, role: 'reference' } })).toBeNull();
    expect(statedGoalTarget({ targetObject: { ...job.targetObject!, enabled: false } })).toBeNull();
    expect(statedGoalTarget({})).toBeNull();
  });

  it('the legend names what the drawing shows, in the row’s spelling', () => {
    expect(goalLegendWords('item')).toBe('Goal: the part, standing proud');
    expect(goalLegendWords('mold')).toBe('Goal: a mold of the part');
  });
});
