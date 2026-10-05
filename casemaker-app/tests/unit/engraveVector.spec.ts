// Imported vector outlines (#217) inside the engrave pipeline: the type's round-trip and caps
// through the schema, `itemProfile`/`toPartPlan` placement, the fill rule read by the REAL
// Manifold evaluator, and the end-to-end generate → simulate → oracle check.
//
// Geometric assertions are against closed forms (the area the ring definition implies), never
// against another run of the same code.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { itemOperationName, itemProfile, resolveItems, toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { createSimSession } from '@/workers/sim/session';
import { Z1 } from '@/engine/cnc/machine';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import type { Profile } from '@/engine/compiler/profile';
import {
  MAX_OUTLINE_CONTOURS,
  MAX_OUTLINE_POINTS,
} from '@/engine/import/outlineTypes';
import type { EngraveJob, EngraveVectorShape } from '@/types/engraveJob';

/** Area of a profile, with the CrossSection released. */
function area(p: Profile): number {
  const cs = executeProfile(tl, p);
  const a = cs.area();
  cs.delete();
  return a;
}

/** An axis-aligned square ring of half-width `half`, CCW when `ccw`. */
function squareRing(cx: number, cy: number, half: number, ccw = true): [number, number][] {
  const pts: [number, number][] = [
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx + half, cy + half],
    [cx - half, cy + half],
  ];
  return ccw ? pts : pts.slice().reverse();
}

function vector(
  contours: [number, number][][],
  fillRule: 'NonZero' | 'EvenOdd' = 'NonZero',
  over: Partial<EngraveVectorShape> = {},
): EngraveVectorShape {
  return {
    id: 'v',
    kind: 'vector',
    sourceName: 'logo.svg',
    contours,
    fillRule,
    width: 20,
    height: 20,
    position: { x: 50, y: 30 },
    rotation: 0,
    depth: 1,
    enabled: true,
    ...over,
  };
}

describe('EngraveVectorShape (#217): through the schema', () => {
  it('round-trips an imported outline, contours unchanged', () => {
    const job = defaultEngraveJob();
    const v = vector([squareRing(50, 30, 10)]);
    const parsed = parseEngraveJob({ ...job, vectors: [v] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.vectors).toHaveLength(1);
    expect(parsed.job.vectors![0]!.contours).toEqual(v.contours);
    expect(parsed.job.vectors![0]!.fillRule).toBe('NonZero');
    expect(parsed.job.vectors![0]!.sourceName).toBe('logo.svg');
  });

  it('a pre-#217 document keeps no vectors key', () => {
    const parsed = parseEngraveJob(defaultEngraveJob());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect('vectors' in parsed.job).toBe(false);
  });

  it('refuses more contours than the importer allows', () => {
    const rings = Array.from({ length: MAX_OUTLINE_CONTOURS + 1 }, (_, i) => squareRing(i, 0, 1));
    const parsed = parseEngraveJob({ ...defaultEngraveJob(), vectors: [vector(rings)] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(' ')).toMatch(/contours|limit|too/i);
  });

  it('refuses more points than the importer allows', () => {
    const perRing = 1001;
    const ringCount = Math.ceil(MAX_OUTLINE_POINTS / perRing) + 1; // just over the cap
    const big = Array.from({ length: ringCount }, () =>
      Array.from({ length: perRing }, (_, i): [number, number] => [i, 0]),
    );
    const parsed = parseEngraveJob({ ...defaultEngraveJob(), vectors: [vector(big)] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(' ')).toMatch(/points|limit/i);
  });
});

describe('EngraveVectorShape (#217): through itemProfile / toPartPlan', () => {
  it('itemProfile places the outline at its position', () => {
    const v = vector([squareRing(0, 0, 10)]);
    const a = area(itemProfile(v, []));
    expect(a).toBeCloseTo(400, 3); // 20 × 20
  });

  it('itemOperationName names it as an outline with its size', () => {
    const name = itemOperationName(vector([squareRing(0, 0, 10)]));
    expect(name).toMatch(/outline/i);
    expect(name).toMatch(/20×20/);
  });

  it('toPartPlan carries the vector into engraves', () => {
    const job: EngraveJob = { ...defaultEngraveJob(), labels: [], shapes: [], vectors: [vector([squareRing(0, 0, 10)])] };
    const plan = toPartPlan(job);
    expect(plan.engraves).toHaveLength(1);
    expect(plan.engraves[0]!.id).toBe('v');
    expect(plan.engraves[0]!.name).toMatch(/outline/i);
  });

  it('a frame may reference an imported outline', () => {
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      vectors: [vector([squareRing(0, 0, 10)])],
      combined: [
        {
          id: 'f',
          kind: 'frame',
          around: 'v',
          gap: 1,
          width: 2,
          position: { x: 0, y: 0 },
          rotation: 0,
          depth: 1,
          enabled: true,
        },
      ],
    };
    const { order } = resolveItems(job);
    expect(order.map((i) => i.id)).toContain('v');
    const plan = toPartPlan(job);
    const frame = plan.engraves.find((e) => e.id === 'f');
    expect(frame).toBeDefined();
    // A ring around a 20×20 square: a positive area, well under the solid 441 mm² it would be
    // if the frame resolved to nothing or to a filled block.
    const a = area(frame!.profile);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(200);
  });
});

describe('EngraveVectorShape (#217): the fill rule, read by Manifold', () => {
  it('NonZero keeps a hole when the inner ring winds opposite', () => {
    const v = vector([squareRing(0, 0, 10, true), squareRing(0, 0, 5, false)]);
    expect(area(itemProfile(v, []))).toBeCloseTo(400 - 100, 3);
  });

  it('NonZero fills the inner ring when both wind the same way', () => {
    const v = vector([squareRing(0, 0, 10, true), squareRing(0, 0, 5, true)]);
    expect(area(itemProfile(v, []))).toBeCloseTo(400, 3);
  });

  it('EvenOdd makes the inner ring a hole regardless of winding', () => {
    const same = vector([squareRing(0, 0, 10, true), squareRing(0, 0, 5, true)], 'EvenOdd');
    const opposite = vector([squareRing(0, 0, 10, true), squareRing(0, 0, 5, false)], 'EvenOdd');
    expect(area(itemProfile(same, []))).toBeCloseTo(300, 3);
    expect(area(itemProfile(opposite, []))).toBeCloseTo(300, 3);
  });
});

describe('EngraveVectorShape (#217): end to end', () => {
  it('a job that is only an imported outline generates, simulates and passes the oracle', () => {
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [],
      vectors: [vector([squareRing(0, 0, 10)], 'NonZero', { depth: 1 })],
    };
    const g = engraveGenerate(tl, job);
    expect(
      g.nc,
      JSON.stringify({ stage: g.stage, errors: g.errors, findings: g.findings }),
    ).not.toBeNull();

    const tool = jobTool(job)!;
    const session = createSimSession(tl);
    const loaded = session.load(g.nc!, toSetup(job, Z1), tool, Z1.id);
    if (!loaded.ok) throw new Error(`load refused: ${JSON.stringify(loaded.diagnostics)}`);
    try {
      const report = session.oracle(g.predicted);
      expect(report.levels).toHaveLength(1);
      expect(report.ok).toBe(true);
      expect(report.worst.underCut).toBeLessThanOrEqual(1e-3);
      expect(report.worst.overCut).toBeLessThanOrEqual(1e-3);
    } finally {
      session.dispose();
    }
  });
});
