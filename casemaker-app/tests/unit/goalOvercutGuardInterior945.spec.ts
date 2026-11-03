// #945 — does planGoalOvercut catch a segment whose INTERIOR dips into the goal while both
// endpoints are drop-cutter-safe? A step goal (plateau z=0 for x<10, floor z=-10 for x>=10,
// vertical wall at x=10), a ball r=1, the finish tip field, and the single diagonal feed between
// the two adjacent columns straddling the steepest tip-field drop. Adapted from the 2026-11-03
// maintainer review's scratch spec (docs/reviews/2026-11-03-m1-progress-review/B-reviewGuard945.spec.ts.txt).
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_FINISH_TIP_OPS,
  sampleGoalHeightfield,
  planGoalOvercut,
  finishTipField,
  finishingMoves,
  type SurfaceTool,
  type SurfaceFeeds,
} from '@/engine/cnc/cam/surface3d';
import { HOP_Z, SAFE_Z, type CamMove } from '@/engine/cnc/cam/ir';
import type { EngraveTargetObject } from '@/types/engraveJob';

type Tri = [[number, number, number], [number, number, number], [number, number, number]];
function binaryStl(tris: Tri[]): ArrayBuffer {
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
  return buf;
}
function quad(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
): Tri[] {
  return [
    [a, b, c],
    [a, c, d],
  ];
}
function stepGoal(): EngraveTargetObject {
  const tris: Tri[] = [
    ...quad([0, 0, 0], [10, 0, 0], [10, 20, 0], [0, 20, 0]), // plateau
    ...quad([10, 0, -10], [20, 0, -10], [20, 20, -10], [10, 20, -10]), // floor
    ...quad([10, 0, 0], [10, 20, 0], [10, 20, -10], [10, 0, -10]), // wall
  ];
  return {
    id: 'step',
    name: 'step.stl',
    format: 'stl',
    sha256: 'review-step',
    data: Buffer.from(new Uint8Array(binaryStl(tris))).toString('base64'),
    size: { x: 1, y: 1, z: 1 },
    position: { x: 10, y: 10, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}
const FEEDS: SurfaceFeeds = { feed: 500, plungeFeed: 200, stepDown: 0.5, roughStepOver: 0.8, finishStepOver: 0.4 };

describe('#945 the overcut guard on an interior dip', () => {
  it('a single steep diagonal between two drop-cutter-safe columns is reported as a gouge', () => {
    const hf = sampleGoalHeightfield(stepGoal(), { pitchMm: 0.1 });
    const ball: SurfaceTool = { radius: 1, ball: true };
    const tip = finishTipField(hf, ball, DEFAULT_MAX_FINISH_TIP_OPS);
    const j = Math.floor(hf.ny / 2);
    const y = hf.y0 + j * hf.pitch;
    // the adjacent column pair with the largest tip drop on this row
    let best = -1;
    let bi = -1;
    for (let i = 0; i + 1 < hf.nx; i++) {
      const dz = Math.abs((tip[j * hf.nx + i] as number) - (tip[j * hf.nx + i + 1] as number));
      if (dz > best) {
        best = dz;
        bi = i;
      }
    }
    const xa = hf.x0 + bi * hf.pitch;
    const za = tip[j * hf.nx + bi] as number;
    const xb = hf.x0 + (bi + 1) * hf.pitch;
    const zb = tip[j * hf.nx + bi + 1] as number;
    expect(best).toBeGreaterThan(hf.pitch); // slope > 1: the class #945 names
    // endpoints alone are safe (each is its own drop-cutter tip)
    const ends: CamMove[] = [
      { kind: 'rapid', x: xa, y, z: HOP_Z },
      { kind: 'feed', x: xa, y, z: za, f: 200 },
      { kind: 'rapid', x: xb, y, z: HOP_Z },
      { kind: 'feed', x: xb, y, z: zb, f: 200 },
    ];
    const endsReport = planGoalOvercut(hf, [{ moves: ends, tool: ball }], hf.pitch);
    expect(endsReport.worstMm).toBe(0);
    // the diagonal between them must read the gouge the endpoints alone cannot show
    const diag: CamMove[] = [
      { kind: 'rapid', x: xa, y, z: HOP_Z },
      { kind: 'feed', x: xa, y, z: za, f: 200 },
      { kind: 'feed', x: xb, y, z: zb, f: 500 },
    ];
    const report = planGoalOvercut(hf, [{ moves: diag, tool: ball }], hf.pitch);
    expect(report.worstMm).toBeGreaterThan(0.1);
    // and the emitter's own raster on this field posts clean
    const moves = finishingMoves(hf, tip, FEEDS, hf.pitch, SAFE_Z, HOP_Z);
    const clean = planGoalOvercut(hf, [{ moves, tool: ball }], hf.pitch);
    expect(clean.worstMm).toBe(0);
  });
});
