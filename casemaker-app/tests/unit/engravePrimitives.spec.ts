// #435 — 3D primitives as cut-aways: where they reduce to the existing region CAM, and where the
// job refuses them BY NAME instead of approximating.
//
// Pure plan/validation only: no React, no wasm, no worker. `toPartPlan` is the one funnel every
// item kind goes through, so a cuttable primitive is asserted there rather than in a second CAM
// path; `validateJob` is where the refusals live.

import { describe, it, expect } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  primitiveLabel,
  primitiveReducesToRegion,
  toPartPlan,
} from '@/engine/cnc/engrave/partPlan';
import { jobSetups, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { jobForSetup } from '@/engine/cnc/engrave/programs';
import { aabbOfProfile } from '@/engine/compiler/profile';
import type { EngraveJob, EngravePrimitive, EngraveTargetObject } from '@/types/engraveJob';

const BASE = {
  id: 'prm-1',
  position: { x: 50, y: 30 },
  rotation: 0,
  depth: 2,
  enabled: true,
} as const;

function primitive(over: Partial<EngravePrimitive> & Pick<EngravePrimitive, 'kind'>): EngravePrimitive {
  return { ...BASE, ...over } as EngravePrimitive;
}

/** A job whose only work is the given primitives (no labels/shapes/traces). */
function jobWith(primitives: EngravePrimitive[], extra: Partial<EngraveJob> = {}): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    primitives,
    ...extra,
  };
}

function codes(job: EngraveJob): string[] {
  return validateJob(job).map((f) => f.code);
}

describe('#435 — which primitives reduce to the region CAM', () => {
  it('reduces a vertical box and a vertical cylinder only', () => {
    expect(primitiveReducesToRegion(primitive({ kind: 'box', width: 20, height: 10 }))).toBe(true);
    expect(primitiveReducesToRegion(primitive({ kind: 'cylinder', diameter: 6 }))).toBe(true);
    expect(primitiveReducesToRegion(primitive({ kind: 'cone', diameter: 8, tipDiameter: 1 }))).toBe(false);
    expect(primitiveReducesToRegion(primitive({ kind: 'sphere', diameter: 8 }))).toBe(false);
    expect(primitiveReducesToRegion(primitive({ kind: 'box', width: 20, height: 10, axis: 'x' }))).toBe(false);
    expect(primitiveReducesToRegion(primitive({ kind: 'cylinder', diameter: 6, axis: 'y' }))).toBe(false);
  });

  it('puts a vertical box in `engraves` with its dimensions, rotation and depth', () => {
    const box = primitive({ kind: 'box', width: 20, height: 10, rotation: 90, depth: 1.5 });
    const plan = toPartPlan(jobWith([box]));
    const eng = plan.engraves.find((e) => e.id === box.id);
    expect(eng).toBeDefined();
    if (!eng) return;
    expect(eng.depth).toBe(1.5);
    const box90 = aabbOfProfile(eng.profile)!;
    // A 20 × 10 rectangle turned 90° occupies 10 × 20 about the same centre.
    expect(box90.max[0] - box90.min[0]).toBeCloseTo(10, 5);
    expect(box90.max[1] - box90.min[1]).toBeCloseTo(20, 5);
    expect((box90.min[0] + box90.max[0]) / 2).toBeCloseTo(50, 5);
    expect((box90.min[1] + box90.max[1]) / 2).toBeCloseTo(30, 5);
  });

  it('puts a vertical cylinder in `engraves` as a circle of its diameter', () => {
    const cyl = primitive({ kind: 'cylinder', diameter: 6 });
    const plan = toPartPlan(jobWith([cyl]));
    const eng = plan.engraves.find((e) => e.id === cyl.id);
    expect(eng).toBeDefined();
    if (!eng) return;
    const box = aabbOfProfile(eng.profile)!;
    expect(box.max[0] - box.min[0]).toBeCloseTo(6, 5);
    expect(box.max[1] - box.min[1]).toBeCloseTo(6, 5);
  });

  it('leaves a cone, a sphere, a side-opening primitive and a disabled one out of `engraves`', () => {
    const plan = toPartPlan(
      jobWith([
        primitive({ id: 'cone', kind: 'cone', diameter: 8, tipDiameter: 1 }),
        primitive({ id: 'sphere', kind: 'sphere', diameter: 8 }),
        primitive({ id: 'side', kind: 'box', width: 10, height: 10, axis: 'x' }),
        primitive({ id: 'off', kind: 'box', width: 10, height: 10, enabled: false }),
      ]),
    );
    expect(plan.engraves).toEqual([]);
  });
});

describe('#435 — refusals are by name, never an approximation', () => {
  it('refuses a side-opening primitive and points at the 3D engine', () => {
    const job = jobWith([primitive({ kind: 'box', width: 10, height: 10, axis: 'x' })]);
    const found = validateJob(job).find((f) => f.code === 'primitive-not-vertical');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('error');
    expect(found?.labelId).toBe('prm-1');
    expect(found?.message).toContain('side-opening');
    expect(found?.message).toContain('#222');
  });

  it('refuses a cone and names the sloped wall and the two routes to cut it', () => {
    const job = jobWith([primitive({ kind: 'cone', diameter: 8, tipDiameter: 1 })]);
    const found = validateJob(job).find((f) => f.code === 'primitive-cone-needs-cam');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('error');
    expect(found?.message).toContain('sloped wall');
    expect(found?.message).toContain('#221');
    expect(found?.message).toContain('#222');
    expect(codes(job)).not.toContain('primitive-sphere-needs-3d');
  });

  it('refuses a sphere as the dexel job it is (#222)', () => {
    const job = jobWith([primitive({ kind: 'sphere', diameter: 8 })]);
    const found = validateJob(job).find((f) => f.code === 'primitive-sphere-needs-3d');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('error');
    expect(found?.message).toContain('dexel job (#222)');
    expect(found?.message).toContain('refused rather than approximated');
  });

  it('does not say the job is empty when a cuttable primitive is its only work', () => {
    const job = jobWith([primitive({ kind: 'box', width: 20, height: 10 })]);
    expect(codes(job)).not.toContain('no-items');
  });

  it('names a sphere-only job as having nothing it can cut, and names the sphere', () => {
    const job = jobWith([primitive({ kind: 'sphere', diameter: 8 })]);
    const found = codes(job);
    expect(found).toContain('primitive-sphere-needs-3d');
    // The refusal is the error, not a second "nothing to do" about a shape the person drew.
    expect(found).not.toContain('no-items');
  });

  it('warns that an enabled target object is a reference, not a cut', () => {
    const targetObject: EngraveTargetObject = {
      id: 'tgt-1',
      name: 'bracket.stl',
      format: 'stl',
      sha256: 'a'.repeat(64),
      data: 'AAAA',
      size: { x: 10, y: 8, z: 4 },
      position: { x: 5, y: 5, z: 0 },
      rotation: 0,
      enabled: true,
    };
    const job = jobWith([primitive({ kind: 'box', width: 20, height: 10 })], { targetObject });
    const found = validateJob(job).find((f) => f.code === 'target-object-not-cut');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('warning');
    expect(found?.message).toContain('bracket.stl');
    expect(found?.message).toContain('#218');
  });

  it('labels each shape in words for the findings to use', () => {
    expect(primitiveLabel(primitive({ kind: 'box', width: 20, height: 10, name: 'tray' }))).toBe(
      'Box "tray" 20×10',
    );
    expect(primitiveLabel(primitive({ kind: 'cone', diameter: 8, tipDiameter: 1 }))).toBe('Cone ⌀8→⌀1');
    expect(primitiveLabel(primitive({ kind: 'sphere', diameter: 8 }))).toBe('Sphere ⌀8');
  });
});

describe('#435 — setups see the primitives that actually cut', () => {
  it('puts a cuttable primitive in the implicit setup and leaves refused forms out', () => {
    const job = jobWith([
      primitive({ id: 'box', kind: 'box', width: 20, height: 10 }),
      primitive({ id: 'sphere', kind: 'sphere', diameter: 8 }),
    ]);
    const [setup] = jobSetups(job);
    expect(setup?.itemIds).toEqual(['box']);
  });

  it('filters primitives by the setup that owns them', () => {
    const box = primitive({ id: 'box', kind: 'box', width: 20, height: 10 });
    const other = primitive({ id: 'other', kind: 'cylinder', diameter: 6 });
    const job = jobWith([box, other]);
    const filtered = jobForSetup(job, {
      setupIndex: 1,
      setupId: 'setup-1',
      toolKey: job.toolKey,
      itemIds: ['box'],
    });
    expect(filtered.primitives?.map((p) => p.id)).toEqual(['box']);
  });
});
