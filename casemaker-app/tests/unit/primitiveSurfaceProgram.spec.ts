/**
 * #786 slice 4a-2 — A CONE AND A SPHERE POST AS SURFACE PROGRAMS.
 *
 * The two shapes the region CAM refused are now analytic heightfields cut by the 3D surfacing CAM:
 * each posts its own program, carries a `surfaceCheck` (no 2.5D verifier can judge a curved
 * surface), and no cutting move goes below the field it cuts. Beside ordinary items the surface
 * programs come first (the item program cuts its cut-outs last), and the old refusals are gone.
 *
 * #966/#979 — SKIPPED, not deleted. #966 removed `generateSurfacePrimitiveProgram` (the CAM path
 * this whole file exercises) whole, with the old engine; a job carrying an enabled cone or sphere
 * now refuses on one finding naming #979 (covered directly in `engravePrimitives.spec.ts`'s
 * "#435 — refusals are by name" describe). #979 is restoring this exact path onto `cam/model` —
 * its own acceptance criteria says the #966 refusal finding comes back out — so this file is
 * revived (and almost certainly rewritten against `planModelCam`, not `generateSurfacePrimitiveProgram`
 * which #966's main deletion commit removes) by #979, not retired for good.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { primitiveHeightfield, type SurfacePrimitive } from '@/engine/cnc/engrave/primitiveSurface';
import { setupPrograms } from '@/engine/cnc/engrave/programs';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import { parseGcode } from '@/engine/cnc/gcode/interpreter';
import type { EngraveJob } from '@/types/engraveJob';
import { NO_SHOP } from '../tools/noShop';

const FLAT: Tool = flatEndMill(1, { name: '1 mm flat end', fluteLength: 20, centreCutting: true });
const KEY = 'inv:flat-1x20';

const CONE: SurfacePrimitive = {
  id: 'funnel',
  name: 'funnel',
  kind: 'cone',
  position: { x: 50, y: 30 },
  rotation: 0,
  enabled: true,
  depth: 2,
  diameter: 10,
  tipDiameter: 2,
};
const SPHERE: SurfacePrimitive = {
  ...CONE,
  id: 'dimple',
  name: 'dimple',
  kind: 'sphere',
  diameter: 10,
};

function job(primitives: SurfacePrimitive[]): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    shapes: [],
    traces: [],
    drills: [],
    threads: [],
    primitives,
    toolKey: KEY,
    tool: FLAT,
  };
}

/** Every feed move inside the field's footprint, with the field's own Z at its XY. */
function cutsBelowTheSurface(nc: string, primitive: SurfacePrimitive): { count: number; below: number } {
  const field = primitiveHeightfield(primitive, { maxCells: NO_SHOP.goalMaxCells })!;
  let count = 0;
  let below = 0;
  for (const e of parseGcode(nc).events) {
    if (e.kind !== 'move' || e.mode !== 'cut' || e.frame !== 'work') continue;
    const x = e.to[0] ?? NaN;
    const y = e.to[1] ?? NaN;
    const z = e.to[2] ?? NaN;
    const rho = Math.hypot(x - primitive.position.x, y - primitive.position.y);
    const rim = primitive.kind === 'cone' ? primitive.diameter / 2 : Math.sqrt((primitive.diameter / 2) ** 2 - (primitive.diameter / 2 - primitive.depth) ** 2);
    if (rho > rim) continue;
    count += 1;
    // The field's closed form at this point (from the same function the CAM sampled).
    const i = Math.round((x - field.x0) / field.pitch);
    const j = Math.round((y - field.y0) / field.pitch);
    const k = j * field.nx + i;
    if (k < 0 || k >= field.z.length || field.covered[k] !== 1) continue;
    // 0.02 mm: the finishing pass follows the field; the slack is the grid's chord error.
    if (z < field.z[k]! - 0.02) below += 1;
  }
  return { count, below };
}

describe.skip('#786 4a-2 the cone posts its own surface program', () => {
  it('posts, carries a surfaceCheck, and no cut goes below the field', async () => {
    const g = await generate(tl, job([CONE]));
    expect(g.errors).toEqual([]);
    expect(g.ok, JSON.stringify(g.findings.map((f) => `${f.severity}:${f.code}`))).toBe(true);
    expect(g.programs).toHaveLength(1);
    const program = g.programs[0]!;
    expect(program.surfaceCheck).toBeTruthy();
    expect(program.surfaceCheck!.kind).toBe('surface');
    expect(program.surfaceCheck!.gridPitchMm).toBeCloseTo(0.1, 6);
    expect(program.surfaceCheck!.roughingLayers).toBeGreaterThan(0);
    expect(program.surfaceCheck!.bbox.min[0]).toBeLessThan(46);
    expect(program.surfaceCheck!.bbox.max[0]).toBeGreaterThan(54);
    expect(program.verify).toBeNull();
    // The refusals are gone; the info states the program and the stepped finish.
    const codes = g.findings.map((f) => f.code);
    expect(codes).not.toContain('primitive-cone-needs-cam');
    const info = g.findings.find((f) => f.code === 'primitive-surface-program');
    expect(info?.severity).toBe('info');
    expect(info?.message).toContain('3D surface program');
    expect(info?.message).toContain('stepped');
    // Gouge-safety: every feed move inside the rim is at or above the field.
    const { count, below } = cutsBelowTheSurface(program.nc, CONE);
    expect(count).toBeGreaterThan(0);
    expect(below).toBe(0);
  }, 60_000);

  it('the sphere posts the same way, and its refusal is gone too', async () => {
    const g = await generate(tl, job([SPHERE]));
    expect(g.ok).toBe(true);
    expect(g.programs).toHaveLength(1);
    expect(g.programs[0]!.surfaceCheck).toBeTruthy();
    expect(g.findings.map((f) => f.code)).not.toContain('primitive-sphere-needs-3d');
    const { count, below } = cutsBelowTheSurface(g.programs[0]!.nc, SPHERE);
    expect(count).toBeGreaterThan(0);
    expect(below).toBe(0);
  }, 60_000);

  it('beside a pocket the surface is its own program, cut first', async () => {
    const j = job([CONE]);
    j.shapes = [
      { id: 'pocket', name: 'pocket', kind: 'circle', position: { x: 20, y: 20 }, rotation: 0, depth: 2, enabled: true, diameter: 8 },
    ];
    const g = await generate(tl, j);
    expect(g.ok, JSON.stringify(g.findings.map((f) => `${f.severity}:${f.code}`))).toBe(true);
    expect(g.programs).toHaveLength(2);
    expect(g.programs[0]!.surfaceCheck).toBeTruthy();
    expect(g.programs[1]!.surfaceCheck ?? null).toBeNull();
    expect(g.programs[1]!.verify).toBeTruthy();
  }, 60_000);

  it('names a ball that fits, one click away, instead of leaving the search to the operator', async () => {
    // The owner is a FLAT cutter (that is when the offer exists); a 2 mm ball fits the cone's
    // 1 mm tip curvature and a 4 mm one does not.
    const j = job([CONE]);
    const g = await generate(tl, j, null, [], undefined, {
      tools: [
        { key: 'inv:ball-small', tool: flatEndMill(2, { name: '2 mm ball', typeText: 'Ball End', shape: 'ball', tipDiameter: 2, diameter: 2, fluteLength: 20 }), provenance: 'test' },
        { key: 'inv:ball-big', tool: flatEndMill(4, { name: '4 mm ball', typeText: 'Ball End', shape: 'ball', tipDiameter: 4, diameter: 4, fluteLength: 20 }), provenance: 'test' },
      ],
    });
    expect(g.ok).toBe(true);
    const offer = g.findings.find((f) => f.code === 'primitive-surface-ball-offer');
    expect(offer?.suggestedCutterKey).toBe('inv:ball-small');
  }, 60_000);

  it('validateJob no longer refuses the primitives, and a plain job is untouched', async () => {
    expect(validateJob(job([CONE, SPHERE])).filter((f) => f.severity === 'error')).toEqual([]);
    const plain = await generate(tl, { ...job([]), shapes: [
      { id: 'p', name: 'p', kind: 'circle', position: { x: 20, y: 20 }, rotation: 0, depth: 2, enabled: true, diameter: 8 },
    ] });
    expect(plain.ok).toBe(true);
    expect(plain.programs).toHaveLength(1);
    expect(plain.programs[0]!.surfaceCheck ?? null).toBeNull();
    // And the refs of a job with no primitive carry no surface refs.
    expect(setupPrograms(job([])).every((r) => r.surface !== true)).toBe(true);
  }, 60_000);
});
