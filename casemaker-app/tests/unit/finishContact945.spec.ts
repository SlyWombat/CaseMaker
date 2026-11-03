// #945 — WHERE THE FINISH DROPS THE CUTTER.
//
// The tip field is the finish's Z: it must keep the ball's whole surface at or above the goal.
// Measuring the ball's rise to a cell SQUARE's nearest point (p/2 inside its centre) against the
// cell's CENTRE value — the pre-fix stencil — rode ≈ (pitch/2)·tan θ high per neighbour on a
// slope, and the max over the disc kept the highest neighbour: E measured the elephant's leftover
// as ≈ pitch·tan θ, bin by bin with the goal's slope. The fix measures a ball at the cell's own
// sample (the same point the swept-top oracle stamps) on smooth ground, so the tip is the ball on
// the surface it touches — independent of the grid pitch — and keeps the SQUARE rule at a WALL,
// where the goal's step is a face and the column's whole square is at the cell's value (#909).
//
// RED-FIRST: the contact test's tolerance (0.05 mm) is under the pre-fix field's own bias at a
// 0.1 mm pitch (≈ 0.14 mm at 70°); the pipeline ramp's leftover band and max are the numbers the
// pre-fix field posted on #945 (12.68 % of cells over 0.3 mm, max 0.545 mm).
import { it, expect } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { planGoalOvercut, finishTipField, type GoalHeightfield } from '@/engine/cnc/cam/surface3d';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import { createSimSession } from '@/workers/sim/session';
import { readTargetObjectFile } from '@/engine/import/targetObject';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { CamMove } from '@/engine/cnc/cam/ir';

/** A plane descending at `deg` along +x, sampled at `pitch`; the interior is covered. */
function plane(deg: number, pitch: number, nx = 61, ny = 41): GoalHeightfield {
  const s = Math.tan((deg * Math.PI) / 180);
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = -(i * pitch) * s;
  const covered = new Uint8Array(nx * ny).fill(1);
  return { nx, ny, pitch, x0: 0, y0: 0, z, topZ: 0, covered, coveredCount: nx * ny };
}

/** The height a ball of `r` rides above a plane of slope `s` where it touches it. */
function contactRise(r: number, s: number): number {
  return r * (Math.sqrt(1 + s * s) - 1);
}

it('drops the ball on the surface it touches — the contact height, not half a cell above it', () => {
  const s = Math.tan((70 * Math.PI) / 180);
  const exact = contactRise(1, s); // 1.923 mm at 70°
  for (const pitch of [0.1, 0.05]) {
    const hf = plane(70, pitch);
    const tip = finishTipField(hf, { ball: true, radius: 1 }, 1e9);
    // An interior cell, clear of the grid's edges (the sampler's border rides on the stock top).
    const k = 20 * hf.nx + 40;
    expect(tip[k]! - (hf.z[k] as number)).toBeCloseTo(exact, 1); // within 0.05 mm
  }
});

it('keeps the square rule at a wall: a pit cell beside a plateau cannot cut the plateau', () => {
  // A plateau at 0 for x >= 0 and a pit at -5 for x < 0, at a 0.1 mm pitch.
  const pitch = 0.1;
  const nx = 81;
  const ny = 41;
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = i >= 40 ? 0 : -5;
  const covered = new Uint8Array(nx * ny).fill(1);
  const hf: GoalHeightfield = { nx, ny, pitch, x0: -4, y0: 0, z, topZ: 0, covered, coveredCount: nx * ny };
  const tip = finishTipField(hf, { ball: true, radius: 1 }, 1e9);
  // Raster the pit beside the wall with those tips, as `finishingMoves` does: a hop to each row's
  // start, then feeds, so no segment crosses ground the raster does not cut.
  const moves: CamMove[] = [];
  for (let j = 10; j <= 30; j += 4) {
    const y = hf.y0 + j * pitch;
    moves.push({ kind: 'rapid', x: hf.x0 + 10 * pitch, y, z: 5 });
    for (let i = 10; i <= 38; i++) {
      moves.push({ kind: 'feed', x: hf.x0 + i * pitch, y, z: tip[j * nx + i] as number, f: 600 });
    }
    moves.push({ kind: 'rapid', x: hf.x0 + 38 * pitch, y, z: 5 });
  }
  const report = planGoalOvercut(hf, [{ moves, tool: { ball: true, radius: 1 } }], pitch);
  expect(report.cells).toBe(0);
  expect(report.worstMm).toBe(0);
});

it('a 70° ramp: the finish generation posts, cut-into stays zero, and the leftover is the step-over cusp', async () => {
  const s = Math.tan((70 * Math.PI) / 180);
  // Two triangles: a sheet 8 mm down-slope × 12 mm wide, top edge at z = 0.
  const tris: [number[], number[]][] = [
    [[0, 0, 0], [8, 0, -s * 8], [8, 12, -s * 8]],
    [[0, 0, 0], [8, 12, -s * 8], [0, 12, 0]],
  ];
  const buf = new ArrayBuffer(84 + 50 * 2);
  const dv = new DataView(buf);
  dv.setUint32(80, 2, true);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    dv.setFloat32(o, 0, true); dv.setFloat32(o + 4, 0, true); dv.setFloat32(o + 8, 1, true);
    t.forEach((v, k) => v.forEach((c, m) => dv.setFloat32(o + 12 + k * 12 + m * 4, c, true)));
  });
  const imported = await readTargetObjectFile(new File([buf], 'ramp.stl'), 'ramp.stl');
  if (!imported.ok) throw new Error(imported.error);
  const ball: Tool = {
    number: 1, id: 'ball2', name: '2 mm ball', typeText: 'Ball', shape: 'ball', handleDiameter: 6,
    tipDiameter: 2, diameter: 6, cornerRadius: 1, angle: null, halfAngle: null, fluteLength: 30,
    shoulderLength: 30, stickout: null, centreCutting: null,
  };
  const target: EngraveTargetObject = {
    id: imported.id, name: imported.name, format: imported.format, sha256: imported.sha256,
    data: imported.data, size: imported.size, position: { x: 12, y: 50, z: 0 }, rotation: 0,
    enabled: true, role: 'goal', scale: { x: 1, y: 1, z: 1 },
  };
  const base = defaultEngraveJob();
  const job: EngraveJob = {
    ...base, name: 'ramp-945', labels: [], shapes: [], drills: [],
    stock: { length: 36, width: 100, thickness: 36, material: 'hardwood' },
    toolKey: 'user:ball2', tool: ball, targetObject: target,
  };
  const g = await generate(tl, job);
  expect(g.ok, g.errors.map((e) => e.message).join('; ')).toBe(true);
  const session = createSimSession(tl);
  try {
    const load = session.load(g.nc as string, toSetup(job, Z1), ball, Z1.id);
    expect(load.ok, load.ok ? '' : load.reason).toBe(true);
    const { goalCheckForProgram } = await import('@/engine/cnc/engrave/goalCheckInput');
    const { goalInputFor } = await import('@/workers/sim/goalCheckField');
    const input = goalInputFor(session, goalCheckForProgram(job, true) as never);
    const report = session.oracle(g.predicted ?? [], undefined, g.designItems, input);
    const gc = report.goalCutInto;
    expect(gc?.ran).toBe(true);
    // The oracle's own read: nothing into the goal (the floor is 0.01 mm).
    expect(gc?.cutIntoFraction).toBe(0);
    expect(gc?.maxCutIntoMm).toBe(0);
    console.log('RAMP945', JSON.stringify({ left: gc?.leftoverFractions, maxLeft: gc?.maxLeftoverMm, cut: gc?.cutIntoFraction, maxCut: gc?.maxCutIntoMm, at: gc?.maxCutIntoAt, med: gc?.medianDeltaMm }));
    // The leftover is the raster's own step-over cusp (≈ 0.41 mm at this cutter's spacing), NOT
    // the pitch bias: the pre-fix field posted 12.68 % over 0.3 mm and 0.545 mm max here.
    expect(gc?.leftoverFractions[1]).toBeLessThan(0.02);
    expect(gc?.maxLeftoverMm).toBeLessThan(0.5);
  } finally {
    session.dispose();
  }
}, 600_000);
