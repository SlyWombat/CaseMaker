// #435 — 3D primitives as cut-aways: where they reduce to the existing region CAM, and where the
// job refuses them BY NAME instead of approximating.
//
// Plan/validation, plus one GENERATE case for the side-opening warning (#786 slice 4a). `toPartPlan`
// is the one funnel every item kind goes through, so a cuttable primitive is asserted there rather
// than in a second CAM path; `validateJob` is where the refusals live.

import { describe, it, expect } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  primitiveLabel,
  primitiveReducesToRegion,
  toPartPlan,
} from '@/engine/cnc/engrave/partPlan';
import { jobSetups, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { jobForSetup } from '@/engine/cnc/engrave/programs';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { tl } from './helpers/manifoldExec';
import { reachabilityFor } from '@/engine/cnc/engrave/reachability';
import { flatEndMill } from '@/engine/cnc/tool';
import { aabbOfProfile } from '@/engine/compiler/profile';
import type { LabelEngravability } from '@/workers/sim/engraveGeometry';
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
  it('warns that a side-opening primitive stays in the stock, and names the setup face that could reach it', () => {
    const job = jobWith([primitive({ kind: 'box', width: 10, height: 10, axis: 'x' })]);
    const found = validateJob(job).find((f) => f.code === 'primitive-not-vertical');
    expect(found).toBeDefined();
    // #786 slice 4a — the rest of the job generates; this cut stays in the stock, stated.
    expect(found?.severity).toBe('warning');
    expect(found?.labelId).toBe('prm-1');
    expect(found?.message).toContain('side-opening');
    expect(found?.message).toContain('stays');
    expect(found?.message).toContain("No setup has the stock's right face up");

    // A saved setup with the right face up is NAMED as the way to cut it.
    const base = jobSetups(defaultEngraveJob())[0]!;
    const withSide = jobWith([primitive({ kind: 'box', width: 10, height: 10, axis: 'x' })], {
      toolKey: 'flat-1.0',
      setups: [
        { ...base, id: 's1', orientation: { ...base.orientation }, itemIds: [], tools: ['flat-1.0'] },
        {
          ...base,
          id: 's2',
          orientation: { top: 'right', bottom: 'left', left: 'top', right: 'bottom', front: 'front', back: 'back' },
          itemIds: [],
          tools: ['flat-1.0'],
        },
      ],
    });
    const named = validateJob(withSide).find((f) => f.code === 'primitive-not-vertical');
    expect(named?.severity).toBe('warning');
    expect(named?.message).toContain("Setup 2 has the stock's right face up");
  });

  it('GENERATES the rest of the job with a side-opening primitive left in the stock (#786 slice 4a)', async () => {
    const job = jobWith([
      primitive({ id: 'side', kind: 'box', width: 10, height: 10, axis: 'x' }),
      primitive({ id: 'top', kind: 'box', width: 8, height: 8 }),
    ]);
    job.toolKey = 'flat-1.0';
    job.tool = flatEndMill(1);
    const out = await engraveGenerate(tl, job, flatEndMill(1), [], null);
    expect(out.errors, JSON.stringify(out.errors)).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.programs.length).toBeGreaterThan(0);
    expect(out.findings.find((f) => f.code === 'primitive-not-vertical')?.severity).toBe('warning');
  }, 60_000);

  it('REFUSES a cone by name (#966/#979 — the 3D surface CAM path was removed with the old engine)', async () => {
    const job = jobWith([primitive({ kind: 'cone', diameter: 8, tipDiameter: 1 })], {
      toolKey: 'flat-1.0',
      tool: flatEndMill(1, { fluteLength: 20, centreCutting: true }),
    });
    const found = codes(job);
    expect(found).not.toContain('primitive-cone-needs-cam');
    expect(found).not.toContain('primitive-sphere-needs-3d');
    const out = await engraveGenerate(tl, job, job.tool!, [], null);
    expect(out.ok).toBe(false);
    expect(out.programs).toEqual([]);
    expect(out.findings.some((f) => f.code === 'surface-primitive-removed' && f.severity === 'error')).toBe(true);
  }, 60_000);

  it('REFUSES a sphere the same way (#966/#979)', async () => {
    const job = jobWith([primitive({ kind: 'sphere', diameter: 8 })], {
      toolKey: 'flat-1.0',
      tool: flatEndMill(1, { fluteLength: 20, centreCutting: true }),
    });
    expect(codes(job)).not.toContain('primitive-sphere-needs-3d');
    const out = await engraveGenerate(tl, job, job.tool!, [], null);
    expect(out.ok).toBe(false);
    expect(out.programs).toEqual([]);
    expect(out.findings.some((f) => f.code === 'surface-primitive-removed' && f.severity === 'error')).toBe(true);
  }, 60_000);

  it('does not say the job is empty when a cuttable primitive is its only work', () => {
    const job = jobWith([primitive({ kind: 'box', width: 20, height: 10 })]);
    expect(codes(job)).not.toContain('no-items');
  });

  it('a sphere-only job is WORK: it is cut, so it says neither "nothing to do" nor refused', () => {
    const job = jobWith([primitive({ kind: 'sphere', diameter: 8 })]);
    const found = codes(job);
    expect(found).not.toContain('no-items');
    expect(found).not.toContain('primitive-sphere-needs-3d');
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
    expect(found?.message).toContain('profile cut-out work');
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
  it('puts every cuttable primitive in the implicit setup — a sphere is surface work now (#786 4a-2)', () => {
    const job = jobWith([
      primitive({ id: 'box', kind: 'box', width: 20, height: 10 }),
      primitive({ id: 'sphere', kind: 'sphere', diameter: 8 }),
      // A side-opening cut stays out: no top-face program owns it.
      primitive({ id: 'side', kind: 'box', width: 10, height: 10, axis: 'x' }),
    ]);
    const [setup] = jobSetups(job);
    expect(setup?.itemIds).toEqual(['box', 'sphere']);
  });

  it('puts a cuttable primitive in the reach table, so the two-tool split sees its area', () => {
    const tool = { key: 'flat', tool: flatEndMill(2), provenance: 'engravePrimitives test' };
    const box = primitive({ id: 'box', kind: 'box', width: 20, height: 10 });
    const cyl = primitive({ id: 'cyl', kind: 'cylinder', diameter: 6 });
    const sphere = primitive({ id: 'sphere', kind: 'sphere', diameter: 8 });
    const measure = (): LabelEngravability[] => [
      { labelId: 'box', glyphArea: 200, openedArea: 50, ratio: 0.25, emptyChars: [], outsideArea: 0, polygons: [] },
    ];
    const reach = reachabilityFor(jobWith([box, cyl, sphere]), [tool], [], null, measure);
    // The refused sphere is not a region; the two cuttable forms are, with the names the findings
    // use, so the run sheet's "cannot enter" sentence can name them rather than print an id.
    expect(reach.items.map((i) => [i.id, i.name, i.depth])).toEqual([
      ['box', 'Box 20×10', 2],
      ['cyl', 'Cylinder ⌀6', 2],
    ]);
    const flat = reach.cutters.find((c) => c.key === 'flat');
    expect(flat?.rows.map((r) => [r.itemId, r.ratio])).toEqual([
      ['box', 0.25],
      ['cyl', 1],
    ]);
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
