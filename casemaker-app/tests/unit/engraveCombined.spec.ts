// Combined shapes (#215): borders, frames and cut-aways built from other items or the stock
// outline, through the SAME `itemProfile`/`toPartPlan`/`PartPlan` pipeline as a label or a
// simple shape.
//
// Every geometric assertion is against a CLOSED FORM (the area the definition implies), never
// against another run of the same code. The reference/cycle half is pure; the finding and
// engravability checks drive the real Manifold evaluator the workers use.
//
// The three kinds live in `EngraveJob.combined`, their own union, so the panel's exhaustive
// `EngraveShape` switch is untouched (the batch is engine-only). This file is the engine's.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import {
  itemProfile,
  itemReferences,
  labelProfile,
  resolveItems,
  toPartPlan,
} from '@/engine/cnc/engrave/partPlan';
import { engravableProfile } from '@/engine/cnc/engrave/engravable';
import { engravabilityFindings, measureLabels } from '@/workers/sim/engraveGeometry';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { type Profile } from '@/engine/compiler/profile';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import type {
  EngraveBorderShape,
  EngraveCircleShape,
  EngraveCombinedShape,
  EngraveCutawayShape,
  EngraveFrameShape,
  EngraveJob,
  EngraveRectShape,
} from '@/types/engraveJob';

/** Area of a profile, with the CrossSection released. */
function area(p: Profile): number {
  const cs = executeProfile(tl, p);
  const a = cs.area();
  cs.delete();
  return a;
}

/** The opened area of a profile at tool radius `r`, released. */
function openedArea(p: Profile, r: number): number {
  const cs = executeProfile(tl, engravableProfile(p, r));
  const a = cs.area();
  cs.delete();
  return a;
}

/** Opening ratio of a profile at tool radius `r`; 1 when the region is empty. */
function ratio(p: Profile, r: number): number {
  const g = area(p);
  return g === 0 ? 1 : openedArea(p, r) / g;
}

/** The real axis-aligned bounds of an evaluated profile (NOT `aabbOfProfile`, which is
 * conservative for negative offsets). */
function bounds(p: Profile): { min: [number, number]; max: [number, number] } {
  const cs = executeProfile(tl, p);
  const b = cs.bounds();
  cs.delete();
  return { min: [b.min[0], b.min[1]], max: [b.max[0], b.max[1]] };
}

const base = { position: { x: 50, y: 30 }, rotation: 0, depth: 1, enabled: true };

function rect(over: Partial<EngraveRectShape> = {}): EngraveRectShape {
  return { id: 'r', kind: 'rect', width: 20, height: 10, cornerRadius: 0, ...base, ...over };
}
function circle(over: Partial<EngraveCircleShape> = {}): EngraveCircleShape {
  return { id: 'i', kind: 'circle', diameter: 10, ...base, ...over };
}
function border(over: Partial<EngraveBorderShape> = {}): EngraveCombinedShape {
  return { id: 'b', kind: 'border', inset: 3, width: 2, ...base, ...over };
}
function frame(over: Partial<EngraveFrameShape> = {}): EngraveCombinedShape {
  return { id: 'f', kind: 'frame', around: 'r', gap: 1, width: 2, ...base, ...over };
}
function cutaway(over: Partial<EngraveCutawayShape> = {}): EngraveCombinedShape {
  return { id: 'c', kind: 'cutaway', outer: 'o', islands: [], ...base, ...over };
}

/** The default job (100 × 60 stock) with its labels cleared and the given lists. */
function jobOf(over: Partial<EngraveJob> = {}): EngraveJob {
  return { ...defaultEngraveJob(), labels: [], shapes: [], combined: [], ...over };
}

describe('combined geometry (#215): area vs closed form', () => {
  it('border on a 100 × 60 stock, inset 3, width 2: (94·54) − (90·50) = 576 mm²', () => {
    const plan = toPartPlan(jobOf({ combined: [border()] }));
    expect(plan.engraves).toHaveLength(1);
    // A round-join inward offset of a rectangle keeps SHARP corners, so the issue's closed form
    // holds exactly.
    expect(Math.abs(area(plan.engraves[0]!.profile) - 576)).toBeLessThan(0.5);
    // The ring runs from the 3 mm inset to the 5 mm inset: outer 94 × 54 about the stock centre.
    const b = bounds(plan.engraves[0]!.profile);
    expect(b.min[0]).toBeCloseTo(3, 1);
    expect(b.min[1]).toBeCloseTo(3, 1);
    expect(b.max[0]).toBeCloseTo(97, 1);
    expect(b.max[1]).toBeCloseTo(57, 1);
  });

  it('frame round a 20 × 10 rect, gap 1, width 2: within 1 % of 152 − (4−π)·8', () => {
    const plan = toPartPlan(jobOf({ shapes: [rect()], combined: [frame()] }));
    expect(plan.engraves.map((e) => e.id)).toEqual(['r', 'f']);
    // offset(+3) of 20×10 is a 26×16 rounded rect (r = 3); offset(+1) is 22×12 (r = 1).
    const exact = 26 * 16 - (4 - Math.PI) * 9 - (22 * 12 - (4 - Math.PI) * 1);
    const measured = area(plan.engraves[1]!.profile);
    expect(Math.abs(measured - exact) / exact).toBeLessThan(0.01);
  });

  it('cutaway of a 40 × 20 rect with a 10 mm circle island: 800 − 25π', () => {
    const plan = toPartPlan(
      jobOf({
        shapes: [rect({ id: 'o', width: 40, height: 20 }), circle({ id: 'i', diameter: 10 })],
        combined: [cutaway({ islands: ['i'] })],
      }),
    );
    const exact = 800 - 25 * Math.PI;
    const measured = area(plan.engraves[2]!.profile);
    expect(Math.abs(measured - exact) / exact).toBeLessThan(0.005);
  });

  it('position and rotation are ignored: a border always follows the stock', () => {
    const moved = toPartPlan(
      jobOf({ combined: [border({ position: { x: 5, y: 5 }, rotation: 37 })] }),
    );
    const plain = toPartPlan(jobOf({ combined: [border()] }));
    expect(area(moved.engraves[0]!.profile)).toBeCloseTo(area(plain.engraves[0]!.profile), 5);
  });

  it('raised text: a construction label island is subtracted and cuts nothing itself', () => {
    const job = defaultEngraveJob();
    const label = { ...job.labels[0]!, construction: true };
    const plan = toPartPlan({
      ...job,
      labels: [label],
      shapes: [rect({ id: 'o', width: 80, height: 50, position: { x: 50, y: 30 } })],
      combined: [cutaway({ id: 'c', outer: 'o', islands: [label.id] })],
    });
    // The label is reference-only, so the ONLY operation is the cut-away.
    expect(plan.engraves.map((e) => e.id)).toEqual(['o', 'c']);
    const outer = 80 * 50;
    const labelArea = area(labelProfile(label, job.customFonts));
    const measured = area(plan.engraves[1]!.profile);
    expect(Math.abs(measured - (outer - labelArea)) / (outer - labelArea)).toBeLessThan(0.005);
  });
});

describe('schema round-trip (#215)', () => {
  it('keeps combined shapes and the construction flag through a save/load', () => {
    const job = jobOf({
      shapes: [rect({ construction: true })],
      combined: [border(), frame(), cutaway({ islands: ['r'] })],
    });
    const parsed = parseEngraveJob(job);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.combined).toHaveLength(3);
    expect(parsed.job.combined!.map((c) => c.kind)).toEqual(['border', 'frame', 'cutaway']);
    expect(parsed.job.shapes[0]!.construction).toBe(true);
  });

  it('rejects a non-positive ring width and an empty reference id', () => {
    expect(parseEngraveJob(jobOf({ combined: [border({ width: 0 })] })).ok).toBe(false);
    expect(parseEngraveJob(jobOf({ combined: [frame({ around: '' })] })).ok).toBe(false);
    expect(parseEngraveJob(jobOf({ combined: [cutaway({ outer: '' })] })).ok).toBe(false);
  });

  it('rejects a negative inset or gap', () => {
    expect(parseEngraveJob(jobOf({ combined: [border({ inset: -1 })] })).ok).toBe(false);
    expect(parseEngraveJob(jobOf({ combined: [frame({ gap: -1 })] })).ok).toBe(false);
  });

  it('a version-1 job loads with no combined shapes', () => {
    const v2 = defaultEngraveJob();
    const v1 = {
      schemaVersion: 1 as const,
      name: v2.name,
      stock: v2.stock,
      labels: v2.labels,
      toolKey: v2.toolKey,
      workholding: v2.workholding,
      minFloor: v2.minFloor,
      edgeMargin: v2.edgeMargin,
      customFonts: v2.customFonts,
    };
    const parsed = parseEngraveJob(v1);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Optional and absent, so an old job round-trips byte-for-byte.
    expect(parsed.job.combined).toBeUndefined();
  });
});

describe('resolveItems (#215)', () => {
  it('orders dependencies before their referrers, document order otherwise', () => {
    const job = jobOf({
      shapes: [rect({ id: 'later' }), circle({ id: 'target' })],
      combined: [cutaway({ id: 'c', outer: 'later', islands: ['target'] })],
    });
    expect(resolveItems(job).order.map((i) => i.id)).toEqual(['later', 'target', 'c']);
    expect(resolveItems(job).errors).toEqual([]);
  });

  it('itemReferences names the frame target and the cut-away outer + islands', () => {
    expect(itemReferences(frame({ around: 'r' }))).toEqual(['r']);
    expect(itemReferences(cutaway({ outer: 'o', islands: ['a', 'b'] }))).toEqual(['o', 'a', 'b']);
    expect(itemReferences(rect())).toEqual([]);
  });

  it('a reference to a missing, disabled or self id is an error and drops the referrer', () => {
    const missing = jobOf({ combined: [frame({ around: 'nope' })] });
    expect(resolveItems(missing).errors).toEqual([
      { itemId: 'f', referencedId: 'nope', reason: 'missing' },
    ]);
    expect(resolveItems(missing).order).toEqual([]);

    const disabled = jobOf({
      shapes: [rect({ id: 'r', enabled: false })],
      combined: [frame({ around: 'r' })],
    });
    expect(resolveItems(disabled).errors).toEqual([
      { itemId: 'f', referencedId: 'r', reason: 'disabled' },
    ]);

    const self = jobOf({ combined: [frame({ id: 's', around: 's' })] });
    expect(resolveItems(self).errors).toEqual([
      { itemId: 's', referencedId: 's', reason: 'self' },
    ]);
  });

  it('a cycle is reported and nothing in it resolves', () => {
    const job = jobOf({
      combined: [frame({ id: 'a', around: 'b' }), frame({ id: 'b', around: 'a' })],
    });
    const { order, errors } = resolveItems(job);
    expect(order).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.reason === 'cycle')).toBe(true);
    expect(errors.map((e) => e.itemId).sort()).toEqual(['a', 'b']);
    // Nothing is generated for a cycle.
    expect(toPartPlan(job).engraves).toEqual([]);
  });

  it('a construction item resolves (so it can be referenced) but cuts nothing', () => {
    const job = jobOf({
      shapes: [rect({ id: 'r', construction: true })],
      combined: [frame({ around: 'r' })],
    });
    const plan = toPartPlan(job);
    // The rect is absent from the cuts; the frame that follows it is present.
    expect(plan.engraves.map((e) => e.id)).toEqual(['f']);
    expect(area(plan.engraves[0]!.profile)).toBeGreaterThan(0);
  });
});

describe('item-reference finding (#215)', () => {
  it('validateJob reports a missing reference and a cycle', () => {
    const missing = validateJob(jobOf({ combined: [frame({ around: 'nope' })] }));
    const f = missing.find((x) => x.code === 'item-reference');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.labelId).toBe('f');
    expect(f!.message).toContain('not in the job');

    const cyclic = validateJob(
      jobOf({ combined: [frame({ id: 'a', around: 'b' }), frame({ id: 'b', around: 'a' })] }),
    );
    expect(cyclic.filter((x) => x.code === 'item-reference').length).toBeGreaterThan(0);
  });

  it('a construction item does not make an otherwise empty job read as "has work"', () => {
    const job = jobOf({ shapes: [rect({ construction: true })] });
    expect(validateJob(job).some((x) => x.code === 'no-items')).toBe(true);
  });
});

describe('combined shapes reach the engravability check (#215)', () => {
  it('a frame narrower than the cutter is item-empty', () => {
    // ⌀3.175 cutter; a 0.5 mm ring has no reachable opening.
    const job = jobOf({
      toolKey: 'flat-3.175x12-metal',
      shapes: [rect({ id: 'r' })],
      combined: [frame({ id: 'f', around: 'r', gap: 0.5, width: 0.5 })],
    });
    const m = measureLabels(tl, toPartPlan(job), 3.175 / 2, job.edgeMargin, () => []);
    const row = m.find((x) => x.labelId === 'f')!;
    expect(row.openedArea).toBe(0);
    const f = engravabilityFindings(job, m, () => 0).find((x) => x.code === 'item-empty');
    expect(f).toBeDefined();
    expect(f!.labelId).toBe('f');
  });

  it('a cut-away whose cleared channels are thinner than the cutter loses detail', () => {
    // Two islands leave a 1.5 mm channel between them; a ⌀3.175 cutter cannot enter it.
    const job = jobOf({
      toolKey: 'flat-3.175x12-metal',
      shapes: [
        rect({ id: 'o', width: 40, height: 20, position: { x: 50, y: 30 } }),
        rect({ id: 'a', width: 10, height: 14, position: { x: 36, y: 30 } }),
        rect({ id: 'b', width: 10, height: 14, position: { x: 47.5, y: 30 } }),
      ],
      combined: [cutaway({ id: 'c', outer: 'o', islands: ['a', 'b'] })],
    });
    const m = measureLabels(tl, toPartPlan(job), 3.175 / 2, job.edgeMargin, () => []);
    const row = m.find((x) => x.labelId === 'c')!;
    expect(row.ratio).toBeGreaterThan(0);
    expect(row.ratio).toBeLessThan(0.9);
    const f = engravabilityFindings(job, m, () => 0).find((x) => x.code === 'item-detail-lost');
    expect(f).toBeDefined();
    expect(f!.labelId).toBe('c');
  });
});

// #214's open ask: which of rounded rectangle, slot and polygon can land in the (0, 0.9)
// opened-ratio band that `completeCompromiseReason` reports on. A circle provably cannot (0 or
// ≥ 0.986). Measured here at the two flat-cutter radii the tool library uses: ⌀1 (r = 0.5) and
// ⌀3.175 (r = 1.5875).
describe('opened-ratio band per kind (#214 ask carried by #215)', () => {
  it('a rounded rectangle reaches the band', () => {
    const p = itemProfile(rect({ width: 1.2, height: 1.2, cornerRadius: 0.2 }), []);
    const q = ratio(p, 0.5);
    expect(q).toBeGreaterThan(0);
    expect(q).toBeLessThan(0.9);
    expect(q).toBeCloseTo(0.8674, 2);
  });

  it('a polygon reaches the band', () => {
    // A thin four-point diamond, 4 mm across; a ⌀1 cutter rounds it heavily.
    const p = itemProfile(
      { id: 'p', kind: 'polygon', points: [[-2, 0], [0, -0.667], [2, 0], [0, 0.667]], ...base },
      [],
    );
    const q = ratio(p, 0.5);
    expect(q).toBeGreaterThan(0);
    expect(q).toBeLessThan(0.9);
    expect(q).toBeCloseTo(0.6664, 2);
  });

  it('a slot cannot: its ratio is 0 or ≥ 0.9, never in between', () => {
    for (const width of [0.8, 1.2, 2, 3, 5]) {
      for (const length of [width, Math.max(width, 5), 10]) {
        const p = itemProfile(
          { id: 's', kind: 'slot', length, width, ...base },
          [],
        );
        for (const r of [0.5, 1.5875]) {
          const q = ratio(p, r);
          expect(q === 0 || q >= 0.9).toBe(true);
        }
      }
    }
    // Pinned samples.
    expect(ratio(itemProfile({ id: 's', kind: 'slot', length: 5, width: 2, ...base }, []), 0.5)).toBeCloseTo(0.9992, 2);
    expect(ratio(itemProfile({ id: 's', kind: 'slot', length: 5, width: 2, ...base }, []), 1.5875)).toBe(0);
  });

  it('the ~0.986 floor is a property of the circle, not of how opening is measured', () => {
    // A rounded rectangle at a coarse cutter dips BELOW 0.986 while staying above the band, so a
    // universal measurement floor does not exist: the circle's floor is its own geometry.
    const q = ratio(itemProfile(rect({ width: 5, height: 5, cornerRadius: 1 }), []), 1.5875);
    expect(q).toBeGreaterThan(0.9);
    expect(q).toBeLessThan(0.986);
  });
});
