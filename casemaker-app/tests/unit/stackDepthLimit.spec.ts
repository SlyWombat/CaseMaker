// #285 — the depth limit a two-colour blank actually has, as a unit of its own.
//
// `engraveGenerate.spec.ts` drives this through the whole generate → verify pipeline and pins the
// acceptance pair. What it cannot reach cleanly are the two seams this module owns: the gate that
// turns the whole path off for a job with no print, and the fallback that reads the stack's "no
// material here" OUTSIDE the part outline as "the sacrificial material's job", not "no cutting".
// Both are pure data and one real Manifold, so they are cheap to pin here.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { defaultBadgeParams } from '@/types/badge';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { viseForNewJob } from '@/engine/cnc/fixture';
import { presetJawStrips, stripHeight } from '@/engine/cnc/sacrificial';
import { sacrificialDepthLimit } from '@/engine/cnc/verify';
import { colourBoundaryFor, stackDepthLimit } from '@/workers/sim/stackDepthLimit';
import { depthLimitReason } from '@/workers/sim/engraveGenerate';
import type { EngraveJob } from '@/types/engraveJob';

/** The brand-default badge blank (76.2 × 38.1 × 3.81, a 45 × 13 × 2.3 pocket centred) as a job. */
function badgeJob(print: boolean): EngraveJob {
  const badge = defaultBadgeParams(print ? { print: { layerHeight: 0.2, firstLayerHeight: 0.2 } } : {});
  const blank = badgeBlankFor(badge);
  return {
    // The blank is thinner than the shipped 4 mm standoff, so the vise is the stock-derived
    // default (#231 item 2); the flat default would refuse the job before the stack ever runs.
    ...defaultEngraveJob(viseForNewJob(undefined, blank.stock)),
    stock: blank.stock,
    keepOuts: blank.pocket ? [blank.pocket] : [],
  };
}

describe('stackDepthLimit (#285): the gate', () => {
  it('is off entirely for a job that states no print', () => {
    const job = badgeJob(false);
    const plan = toPartPlan(job);
    expect(stackDepthLimit(tl, plan, job)).toBeNull();
    // The boundary is off for the same reason: no print, no layer grid, no colour to be wrong about.
    expect(colourBoundaryFor(plan, job)).toBeNull();
  });

  it('reads the colour boundary off the grid, on a real layer line', () => {
    const job = badgeJob(true);
    // 3.81 − 3.0 = 0.81 below the engraved face; the nearest 0.2 mm layer line is 0.8.
    expect(colourBoundaryFor(toPartPlan(job), job)).toBeCloseTo(0.8, 9);
  });
});

describe('stackDepthLimit (#285): what binds where', () => {
  const job = badgeJob(true);
  const plan = toPartPlan(job);

  it('names the void over the pocket and the stock floor away from it', () => {
    const stack = stackDepthLimit(tl, plan, job);
    expect(stack).not.toBeNull();
    expect(stack!.boundary).toBeCloseTo(0.8, 9);
    try {
      // Over the pocket: the solid stops the cutter, so the reason is the void.
      expect(stack!.reasonAt(38.1, 19.05)).toBe('void');
      // Left of the pocket, on solid stock: the limit is the job's own floor and NOTHING in the
      // blank is in the way, so the reason is the stock.
      expect(stack!.reasonAt(10, 19.05)).toBe('stock');
      // The limit agrees with the reason: 1.4 mm of solid over the pocket (0.2 mm layers under the
      // 1.51 mm membrane) less the 0.2 mm boundary margin the ceiling's `above` bound carries
      // (#345), the full stock floor elsewhere.
      expect(stack!.limit(38.1, 19.05)).toBeCloseTo(1.2, 6);
      expect(stack!.limit(10, 19.05)).toBeCloseTo(job.stock.thickness - job.minFloor, 6);
    } finally {
      stack!.dispose();
    }
  });

  it('words the limiter: the void ceiling it names, or the job’s own floor', () => {
    // The tail of the `cut-too-deep` sentence is built here rather than inside the pipeline,
    // because over SOLID stock nothing reaches the verifier — `validateJob` refuses the same
    // depth first — so the floor half has no end-to-end route to test it through.
    const stack = stackDepthLimit(tl, plan, job);
    expect(stack).not.toBeNull();
    try {
      // #345: the bound the void's ceiling makes speaks of the PLANE, and `ceilingName` words it —
      // the same namer the per-item finding uses, so the two cannot describe one plane two ways.
      expect(depthLimitReason(stack!, job, 38.1, 19.05)).toBe("— the magnet pocket's ceiling");
      expect(depthLimitReason(stack!, job, 10, 19.05)).toBe('— the floor the job keeps under the stock');
    } finally {
      stack!.dispose();
    }
  });

  it('falls back to the sacrificial limit outside the part outline, not to "no cutting"', () => {
    // The stack is told the blank's outline and the voids in it and nothing else, so beside the
    // part it reports NO material. Reading that as "no cutting" would refuse the side strip the
    // setup exists to put there, so the limit must be the sacrificial answer unchanged.
    const withStrips: EngraveJob = { ...job, sacrificial: presetJawStrips() };
    const stack = stackDepthLimit(tl, toPartPlan(withStrips), withStrips);
    expect(stack).not.toBeNull();
    const sac = sacrificialDepthLimit(withStrips.stock, withStrips.sacrificial, {
      minFloor: withStrips.minFloor,
      breakthrough: withStrips.breakthrough,
    });
    // A point over the LEFT strip: X ∈ [−6, 0] in the work frame.
    const x = -3;
    const y = 19.05;
    try {
      expect(stripHeight({ thickness: 6, height: 'flush' }, withStrips.stock.thickness)).toBeCloseTo(3.81, 9);
      expect(sac(x, y)).toBeGreaterThan(0);
      expect(stack!.limit(x, y)).toBeCloseTo(sac(x, y), 9);
      expect(stack!.reasonAt(x, y)).toBe('stock');
    } finally {
      stack!.dispose();
    }
  });
});
