/**
 * #1097 — THE PLACEMENT IS NOT A ONE-RADIUS RELIEF, STATED.
 *
 * A goal whose axis passes outside the body has two facts a one-radius relief cannot cut: the rays
 * from the axis meet AIR where the body is absent (491k of the panther's 1,244k map cells), and the
 * surface can come inside the finishing ball's own radius (11.25 % within 2 mm, 84,743 cells). The
 * generator states them as a `goal-rotary-unreachable` WARNING with the placement's own numbers —
 * informed, never refused — and leaves the share the FINISH leaves standing to the goal block after
 * the run. This fixture is the smallest body with both facts: a thin slab 0.5–0.7 mm from the axis
 * spanning 20 mm of X, so every covered cell is inside a ⌀2 ball's radius and most of the map is air.
 *
 * RED at m1-land14 01515ebc1: no such finding exists.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import { sampleGoalRadialField } from '@/engine/cnc/cam/rotaryRelief';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

type V = [number, number, number];
type Tri = [V, V, V];

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

/** A rectangular slab: x ∈ [x0,x1], y ∈ [y0,y1], z ∈ [z0,z1] (the axis is the mesh's local X). */
function slab(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Tri[] {
  const v = (x: number, y: number, z: number): V => [x, y, z];
  return [
    [v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1)], [v(x0, y1, z0), v(x1, y1, z1), v(x0, y1, z1)],
    [v(x0, y0, z1), v(x1, y0, z1), v(x1, y0, z0)], [v(x0, y0, z1), v(x1, y0, z0), v(x0, y0, z0)],
    [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1)], [v(x0, y0, z1), v(x1, y1, z1), v(x0, y1, z1)],
    [v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0)], [v(x0, y1, z0), v(x1, y0, z0), v(x0, y0, z0)],
    [v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1)], [v(x1, y0, z0), v(x1, y1, z1), v(x1, y0, z1)],
    [v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)], [v(x0, y0, z1), v(x0, y1, z0), v(x0, y0, z0)],
  ];
}

let serial = 0;

function goal(tris: Tri[], size: { x: number; y: number; z: number }): EngraveTargetObject {
  return {
    id: 'part',
    name: 'slab.stl',
    format: 'stl',
    sha256: (serial++).toString(16).padStart(64, 'e'),
    data: stl(tris),
    size,
    position: { x: 30, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

const BALL = flatEndMill(2, { shape: 'ball', name: '2 mm ball', fluteLength: 12, shoulderLength: 20 });
const ROD_RADIUS = 10;

function rotaryJob(target: EngraveTargetObject): EngraveJob {
  return {
    ...defaultEngraveJob(),
    name: 'rotary unreachable',
    stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 60, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' },
    },
    labels: [],
    shapes: [],
    targetObject: target,
    toolKey: 'ball-2',
  };
}

describe('#1097 the rotary placement states what a one-radius relief cannot cut', () => {
  // A thin slab 0.5–0.7 mm from the axis: every ray that hits it exits within 0.7 mm, so the whole
  // covered surface is inside a ⌀2 ball's radius, and every other direction is air.
  const job = rotaryJob(goal(slab(-10, 10, 0.5, 0.7, -5, 5), { x: 20, y: 0.2, z: 10 }));

  it('states the air share, the near-axis share with its X spans, and the ball’s-radius share', async () => {
    const out = await engraveGenerate(tl, job, BALL, [], null, undefined, {});
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.programs).toHaveLength(1);
    const finding = out.findings.find((f) => f.code === 'goal-rotary-unreachable');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warning');
    // The numbers ARE the field's: recompute them from the same sampler the generator used.
    const field = sampleGoalRadialField(job.targetObject!, ROD_RADIUS);
    const cells = field.nx * field.ny;
    let near = 0;
    let under = 0;
    let closest = Infinity;
    for (let k = 0; k < cells; k++) {
      if (field.covered[k] !== 1) continue;
      const r = field.radius + field.z[k]!;
      if (r < closest) closest = r;
      if (r < 2) near++;
      if (r < 1) under++;
    }
    const covered = field.coveredCount;
    const f = finding!.rotaryUnreachable!;
    expect(f.unsampledFraction).toBeCloseTo(1 - covered / cells, 12);
    expect(f.nearAxisFraction).toBeCloseTo(near / covered, 12);
    expect(f.unreachableFraction).toBeCloseTo(under / covered, 12);
    expect(f.reachLimitMm).toBeCloseTo(1, 12);
    expect(f.closestRadiusMm).toBeCloseTo(closest, 9);
    // The slab's covered band is ONE component over its 20 mm of X.
    expect(f.nearAxisXRangesMm).toHaveLength(1);
    expect(f.nearAxisXRangesMm[0]!.from).toBeCloseTo(20, 6);
    expect(f.nearAxisXRangesMm[0]!.to).toBeCloseTo(40, 6);
    // The sentence names the placement's geometry, the ball, and defers the finish's own share.
    const message = finding!.message;
    expect(message).toContain(`${(f.unsampledFraction * 100).toFixed(2)} %`);
    expect(message).toContain(`${(f.nearAxisFraction * 100).toFixed(2)} %`);
    expect(message).toContain('⌀2');
    expect(message).toContain('air');
    expect(message).toContain('goal block');
    expect(message).toContain('after the run');
    expect(message).toContain('X 20–40 mm');
  });

  it('says nothing on a one-radius turned part (full coverage, well outside the ball)', async () => {
    // A solid of revolution 4 → 9 mm: every ray hits, none inside the ball's radius.
    const TAU = Math.PI * 2;
    const tris: Tri[] = [];
    const radiusAt = (x: number): number => 4 + ((x + 15) / 30) * 5;
    const at = (x: number, a: number): V => [x, radiusAt(x) * Math.sin(a), radiusAt(x) * Math.cos(a)];
    for (let i = 0; i < 180; i++) {
      const a0 = (i / 180) * TAU;
      const a1 = ((i + 1) / 180) * TAU;
      tris.push([at(-15, a0), at(15, a0), at(15, a1)], [at(-15, a0), at(15, a1), at(-15, a1)]);
    }
    const clean = rotaryJob(goal(tris, { x: 30, y: 18, z: 18 }));
    const out = await engraveGenerate(tl, clean, BALL, [], null, undefined, {});
    expect(out.ok, out.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(out.findings.some((f) => f.code === 'goal-rotary-unreachable')).toBe(false);
  });
});
