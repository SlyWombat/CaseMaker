/**
 * #846 follow-up — THE GOAL PATH TAKES THE ROUGHING CHOICE.
 *
 * The chooser (#846) was wired into surface primitives only; a mesh goal — where most 3D
 * roughing happens — still always rastered. These tests pin the goal path's wiring through
 * `generateGoalProgram`, with the decision read from the shop's own two `rough3d.*` numbers:
 *
 *   - a DEEP PLA goal on a FLAT cutter chooses the adaptive rough and states that both roughs
 *     were measured;
 *   - a SHALLOW softwood goal keeps the raster by the rule, saying the comparison was skipped —
 *     the cell budget it quotes is the shop default handed in below, which is the wiring under
 *     test;
 *   - a BALL goal states that the adaptive rough cannot run (the 2D engine sweeps a flat end
 *     mill only) and keeps the raster — the real j27 cutter's answer.
 *
 * The fixture is a 10 × 10 mm ramp: its top face falls from the stock top to `depth` across Y,
 * so the sampled goal is exactly `depth` deep and the finish has a real surface to ride.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { generateGoalProgram, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject, StockMaterial } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

type Tri = [[number, number, number], [number, number, number], [number, number, number]];

/** A 10 × 10 mm ramp whose top face falls from z = 0 at y = 0 to -depth at y = 10. */
function rampTris(depth: number): Tri[] {
  return [
    [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, -depth],
    ],
    [
      [0, 0, 0],
      [10, 10, -depth],
      [0, 10, -depth],
    ],
  ];
}

function binaryStl(tris: Tri[]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12; // normal left 0
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2; // attribute byte count
  }
  return buf;
}

let shaCounter = 0;
function rampGoal(depth: number): EngraveTargetObject {
  return {
    id: 'ramp-goal',
    name: 'ramp.stl',
    format: 'stl',
    sha256: `ramp-${shaCounter++}`,
    data: Buffer.from(new Uint8Array(binaryStl(rampTris(depth)))).toString('base64'),
    size: { x: 10, y: 10, z: depth },
    position: { x: 50, y: 30, z: 0 },
    rotation: 0,
    enabled: true,
  };
}

const FLAT: Tool = flatEndMill(3.175);
const BALL: Tool = flatEndMill(3.175, { shape: 'ball', name: '3.175 mm ball nose' });

function jobFor(depth: number, material: StockMaterial): EngraveJob {
  const job = defaultEngraveJob();
  return {
    ...job,
    labels: [],
    shapes: [],
    stock: { ...job.stock, material },
    targetObject: rampGoal(depth),
  };
}

/** The shop default under test: a cell budget small enough that the rule decides alone (its
 *  own rule floor is 1000 cells, so this is the smallest value the registry accepts). */
const SMALL_BUDGET: EngraveShopOpts = {
  defaults: {
    'rough3d.compareCellBudget': {
      value: 1000,
      source: 'seeded',
      setAt: '2026-11-01',
      unit: 'cells',
      note: null,
    },
  },
};

describe('#846 — the goal path chooses its rough, and says so', () => {
  it('a deep PLA goal on a flat cutter posts the adaptive rough, with both roughs measured', () => {
    const job = jobFor(8, 'pla');
    const out = generateGoalProgram(job, job.targetObject!, FLAT, [], null, {});
    expect(out.ok, JSON.stringify(out.errors)).toBe(true);
    expect(out.nc).not.toBeNull();
    // The operation the post names, and the one line the run carries.
    expect(out.nc!).toContain('3D rough (adaptive)');
    const note = (out.surface3d?.notes ?? []).find((n) => n.includes('roughing chosen'));
    expect(note, 'the chooser must state its choice').toBeDefined();
    expect(note!).toContain('Adaptive roughing chosen');
    expect(note!).toContain('both were measured');
    expect(note!).toMatch(/max engagement .* mm under the .* mm cap/);
  });

  it('a shallow softwood goal keeps the raster by the rule, quoting the shop’s own budget', () => {
    const job = jobFor(1, 'softwood');
    const out = generateGoalProgram(job, job.targetObject!, FLAT, [], null, SMALL_BUDGET);
    expect(out.ok, JSON.stringify(out.errors)).toBe(true);
    expect(out.nc).not.toBeNull();
    expect(out.nc!).not.toContain('(adaptive)');
    const note = (out.surface3d?.notes ?? []).find((n) => n.includes('roughing chosen'));
    expect(note, 'the chooser must state its choice').toBeDefined();
    expect(note!).toContain('Raster roughing chosen by rule');
    // The budget in the sentence is the shop default handed in, not the built-in fallback.
    expect(note!).toContain('skipped above 1,000 cells');
    expect(note!).toContain('rough3d.compareCellBudget');
  });

  it('a ball goal states that the adaptive rough cannot run and keeps the raster', () => {
    const job = jobFor(8, 'pla');
    const out = generateGoalProgram(job, job.targetObject!, BALL, [], null, {});
    expect(out.ok, JSON.stringify(out.errors)).toBe(true);
    expect(out.nc).not.toBeNull();
    expect(out.nc!).not.toContain('(adaptive)');
    const note = (out.surface3d?.notes ?? []).find((n) => n.includes('not possible'));
    expect(note, 'a refusal must be stated, not silent').toBeDefined();
    expect(note!).toContain('adaptive clearing needs a flat end mill');
    expect(note!).toContain('the raster runs instead');
  });
});
