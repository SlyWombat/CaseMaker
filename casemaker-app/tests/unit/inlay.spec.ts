/**
 * #673 — THE V-CARVE INLAY PAIR: the female pocket and the male plug, its own job on its own blank.
 *
 * The review seams. FITTING: the male's island, mirrored back onto the female, sits strictly
 * inside her cavity at every depth, clears its wall by the glue gap's slant, and ends the gap
 * above her floor — and an UNMIRRORED island on an asymmetric design pokes through the wall.
 * NUMBERS: one derivation (`inlayNumbers`), quoted by the row, the findings, the builder and both
 * sheets. DOCUMENT: a mixed, non-happy round trip on each half.
 */

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import { itemProfile, toPartPlan, type PartPlan } from '@/engine/cnc/engrave/partPlan';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import {
  DEFAULT_INLAY_GLUE_GAP_MM,
  inlayMaleJob,
  inlayMaleJobName,
  inlayNumbers,
  mirrorShapeInY,
} from '@/engine/cnc/engrave/inlay';
import { vCone } from '@/engine/cnc/vProfile';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngravePolygonShape, EngraveRectShape, EngraveShape } from '@/types/engraveJob';

const TOOL_KEY = 'chamfer-90-vcarve';

/** A 90° V: tan(halfAngle) = 1, point tip. */
const V_TOOL: Tool = flatEndMill(3.175, {
  id: null,
  name: '3.175 mm 90° V',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: null,
  diameter: 3.175,
  angle: 90,
  halfAngle: null,
});

const CONE = vCone(V_TOOL)!;

/** A 60° included-angle V: tan(30°) = 0.577…, so sin and cos cannot hide behind 45°. */
const V60_TOOL: Tool = flatEndMill(6.35, {
  id: null,
  name: '6.35 mm 60° V',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: null,
  diameter: 6.35,
  angle: 60,
  halfAngle: null,
});
const CONE60 = vCone(V60_TOOL)!;

function rect(id = 'design', extra: Partial<EngraveRectShape> = {}): EngraveRectShape {
  return {
    id,
    name: 'design',
    kind: 'rect',
    position: { x: 20, y: 15 },
    rotation: 0,
    depth: 2,
    enabled: true,
    width: 20,
    height: 10,
    cornerRadius: 0,
    inlay: { role: 'female' },
    ...extra,
  };
}

/** An L-shaped polygon (asymmetric: the mirror is not itself), 20 × 14 over the blank. */
function lShape(id = 'design'): EngravePolygonShape {
  return {
    id,
    name: 'L',
    kind: 'polygon',
    position: { x: 20, y: 15 },
    rotation: 0,
    depth: 2,
    enabled: true,
    points: [
      [-10, -7],
      [10, -7],
      [10, 0],
      [-2, 0],
      [-2, 7],
      [-10, 7],
    ],
    inlay: { role: 'female' },
  };
}

function femaleJob(
  shape: EngraveShape = rect(),
  over: Partial<EngraveJob> = {},
  bit: { key: string; tool: Tool } = { key: TOOL_KEY, tool: V_TOOL },
): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    // A small blank: the male clears its whole top, and 40 × 30 keeps that quick and its numbers
    // easy to read.
    stock: { ...base.stock, length: 40, width: 30 },
    labels: [],
    traces: [],
    toolKey: bit.key,
    tool: bit.tool,
    shapes: [shape],
    ...over,
  };
}

describe('inlayNumbers — one derivation, with the gap bounded', () => {
  it('derives the plug, its insets and the wall clearance from F, g and the cone', () => {
    const check = inlayNumbers(CONE, 2, 0.2);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const n = check.numbers;
    expect(n.plugDepthMm).toBeCloseTo(1.8, 9);
    expect(n.topInsetMm).toBeCloseTo(0.2, 9);
    expect(n.endInsetMm).toBeCloseTo(2, 9);
    expect(n.wallClearanceMm).toBeCloseTo(0.2 / Math.SQRT2, 9);
    // SQUARE to the flank it is `g·sinθ`, not `g·cosθ`: at 60° included (θ = 30°) the clearance is
    // 0.1 mm, where a cosine rule would still say 0.173 — and a near-vertical flank (θ → 0) gives
    // ~0, not ~g.
    const sixty = inlayNumbers(CONE60, 2, 0.2);
    expect(sixty.ok).toBe(true);
    if (!sixty.ok) return;
    expect(sixty.numbers.wallClearanceMm).toBeCloseTo(0.1, 9);
    expect(sixty.numbers.plugDepthMm).toBeCloseTo(1.8, 9);
    expect(sixty.numbers.topInsetMm).toBeCloseTo(0.2 * Math.tan(Math.PI / 6), 9);
    expect(sixty.numbers.endInsetMm).toBeCloseTo(2 * Math.tan(Math.PI / 6), 9);
  });

  it('refuses a gap of zero, a gap at the pocket depth, and a pocket with no depth', () => {
    expect(inlayNumbers(CONE, 2, 0).ok).toBe(false);
    expect(inlayNumbers(CONE, 2, 2).ok).toBe(false);
    expect(inlayNumbers(CONE, 0, 0.2).ok).toBe(false);
    // The default gap derives.
    expect(inlayNumbers(CONE, 2, DEFAULT_INLAY_GLUE_GAP_MM).ok).toBe(true);
  });
});

describe('the male document — its own job, its own blank, the design mirrored', () => {
  it('mirrors positions, rotation and polygon points exactly', () => {
    const shape = lShape();
    const mirrored = mirrorShapeInY(shape, 60);
    expect(mirrored.position.y).toBeCloseTo(60 - shape.position.y, 9);
    expect(mirrored.points.map(([, y]) => y)).toEqual(shape.points.map(([, y]) => -y));
  });

  it('builds the male: a construction island, one cutaway, the numbers it was built for', () => {
    const female = femaleJob();
    const check = inlayNumbers(CONE, 2, 0.2);
    if (!check.ok) throw new Error(check.reason);
    const male = inlayMaleJob(female, CONE);
    expect(male.ok).toBe(true);
    if (!male.ok) return;
    const job = male.job;
    expect(job.name).toBe(inlayMaleJobName(female.name));
    expect(job.id).not.toBe(female.id);
    expect(job.stock).toEqual(female.stock);
    expect(job.toolKey).toBe(TOOL_KEY);
    expect(job.setups).toBeUndefined();
    // The island is construction-only and mirrored; the cutaway is the one operation.
    const island = job.shapes.find((s) => s.construction === true && s.id !== 'inlay-blank');
    expect(island).toBeDefined();
    expect(island!.position.y).toBeCloseTo(30 - 15, 9);
    expect(job.shapes.filter((s) => s.construction !== true)).toHaveLength(0);
    expect(job.combined).toHaveLength(1);
    const cut = job.combined![0]!;
    if (cut.kind !== 'cutaway') throw new Error('the male operation is not a cutaway');
    expect(cut.depth).toBeCloseTo(1.8, 9);
    expect(cut.inlay?.role).toBe('male');
    expect(cut.inlay?.islandInsetMm).toBeCloseTo(2, 9);
    // And the derived job is a document the schema accepts unchanged.
    const parsed = parseEngraveJob(job);
    expect(parsed.ok, parsed.ok ? '' : parsed.errors.join('; ')).toBe(true);
  });

  it('generates and verifies as an ordinary job', () => {
    const male = inlayMaleJob(femaleJob(), CONE);
    if (!male.ok) throw new Error(male.reason);
    const g = generate(tl, male.job);
    expect(
      g.ok,
      JSON.stringify({ stage: g.stage, errors: g.errors, findings: g.findings.filter((f) => f.severity === 'error') }),
    ).toBe(true);
    expect(g.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
    // The cutaway's plan entry carries the eroded island: its profile is a difference, and the
    // evaluated region is the blank minus the plug's footprint.
    const plan = toPartPlan(male.job);
    expect(plan.engraves).toHaveLength(1);
    const evalPlan = (p: PartPlan): [number, number][][] => {
      const cs = executeProfile(tl, p.engraves[0]!.profile);
      const polygons = cs.toPolygons() as [number, number][][];
      cs.delete();
      return polygons;
    };
    const cutPolygons = evalPlan(plan);
    expect(cutPolygons.length).toBeGreaterThan(0);
  });
});

describe('the fit — a mirrored male closes onto the female with the gap (#673)', () => {
  // THE MALE'S CUT IS WHAT IS EVALUATED. The island the male's V leaves is not the construction
  // shape: the cut region at male depth m is `R ⊖ m·tanθ`, so its HOLE — the island — is
  // `islandTop ⊕ m·tanθ`. The island at the male's top face is the plug's TIP (the female floor's
  // extent); at the male's floor it is the plug's BASE (the visible ring). Male depth m maps to
  // female depth `d = P − m`.
  const offset = makeClipperOffset(tl);

  function rings(profile: Parameters<typeof executeProfile>[1]): [number, number][][] {
    const cs = executeProfile(tl, profile);
    const polygons = cs.toPolygons() as [number, number][][];
    cs.delete();
    return polygons;
  }

  function areaOf(polygons: readonly (readonly (readonly [number, number])[])[]): number {
    let total = 0;
    for (const ring of polygons) {
      let sum = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        sum += a[0] * b[1] - b[0] * a[1];
      }
      total += sum / 2;
    }
    return Math.abs(total);
  }

  /** A polygon set's area and its bounds, through Manifold (the same fill the workers use). */
  function measure(polygons: [number, number][][]): { area: number; bounds: [number, number, number, number] } {
    if (polygons.length === 0) return { area: 0, bounds: [0, 0, 0, 0] };
    const CS = tl.CrossSection;
    const cs = CS.ofPolygons(polygons);
    const area = cs.area();
    const b = cs.bounds();
    cs.delete();
    return { area, bounds: [b.min[0], b.min[1], b.max[0], b.max[1]] };
  }

  /** Mirror a polygon set back into the female's frame: (x, y) → (x, width − y). */
  function mirrorBack(polygons: readonly (readonly (readonly [number, number])[])[], width: number): [number, number][][] {
    return polygons.map((ring) => ring.map(([x, y]) => [x, width - y] as [number, number]).reverse());
  }

  /** The standing ISLAND of the male's cut at male depth m, in the male's frame. */
  function islandAtMaleDepth(male: EngraveJob, m: number, tanHalf: number): [number, number][][] {
    const plan = toPartPlan(male);
    const region = rings(plan.engraves[0]!.profile); // R: the cut at the male's top face
    const eroded = offset(region, -m * tanHalf); // R ⊖ m·tanθ: the cut at depth m
    const blankShape = male.shapes.find((s) => s.id === 'inlay-blank');
    if (blankShape === undefined) throw new Error('the male has no blank shape');
    const blank = rings(itemProfile(blankShape, []));
    const CS = tl.CrossSection;
    const outer = CS.ofPolygons(blank);
    const cut = CS.ofPolygons(eroded.length === 0 ? [] : eroded);
    const material = outer.subtract(cut);
    outer.delete();
    cut.delete();
    const parts = material.decompose();
    material.delete();
    // The island is the component that does NOT reach the blank's boundary; the frame around the
    // cut does.
    const bound = measure(blank).bounds;
    const eps = 1e-6;
    let island: [number, number][][] = [];
    for (const part of parts) {
      const b = part.bounds();
      const touches =
        b.min[0] <= bound[0] + eps || b.min[1] <= bound[1] + eps || b.max[0] >= bound[2] - eps || b.max[1] >= bound[3] - eps;
      if (!touches) island = part.toPolygons() as [number, number][][];
      part.delete();
    }
    return island;
  }

  const BITS: { label: string; bit: { key: string; tool: Tool }; cone: ReturnType<typeof vCone> }[] = [
    { label: '90°', bit: { key: TOOL_KEY, tool: V_TOOL }, cone: CONE },
    { label: '60°', bit: { key: 'chamfer-60-vcarve', tool: V60_TOOL }, cone: CONE60 },
  ];

  for (const { label, bit, cone } of BITS) {
    it(`[${label}] the island the male's cut leaves fits the cavity at every height — and is not undersized`, () => {
      if (cone === null) throw new Error('no cone');
      const female = femaleJob(rect(), {}, bit);
      const design = rings(toPartPlan(female).engraves[0]!.profile);
      const check = inlayNumbers(cone, 2, 0.2);
      if (!check.ok) throw new Error(check.reason);
      const n = check.numbers;
      const male = inlayMaleJob(female, cone);
      if (!male.ok) throw new Error(male.reason);

      for (const m of [0, n.plugDepthMm / 2, n.plugDepthMm]) {
        const island = islandAtMaleDepth(male.job, m, n.tanHalf);
        expect(island.length, `m=${m}`).toBeGreaterThan(0);
        const fitted = mirrorBack(island, male.job.stock.width);
        const d = n.plugDepthMm - m; // the female depth the plug's section at male depth m reaches
        const cavity = offset(design, -d * n.tanHalf);
        const CS = tl.CrossSection;
        const plug = CS.ofPolygons(fitted);
        const cav = CS.ofPolygons(cavity);
        const outside = plug.subtract(cav);
        expect(outside.area(), `[${label}] m=${m}: the plug is inside the cavity`).toBeLessThan(0.05);
        outside.delete();
        // NOT TOO SMALL EITHER: an undersized plug still sits inside. The flats are what mate,
        // so the section's EXTENT must be the cavity's inset by the gap's slant (`g·tanθ`
        // horizontally) — the corners are the tool's own business (the male's cut rounds them,
        // and the female's sharp corner takes glue there).
        const reference = measure(offset(cavity, -n.topInsetMm)).bounds;
        const got = measure(plug.toPolygons() as [number, number][][]).bounds;
        expect(got[0], `[${label}] m=${m}: left`).toBeCloseTo(reference[0], 1);
        expect(got[1], `[${label}] m=${m}: bottom`).toBeCloseTo(reference[1], 1);
        expect(got[2], `[${label}] m=${m}: right`).toBeCloseTo(reference[2], 1);
        expect(got[3], `[${label}] m=${m}: top`).toBeCloseTo(reference[3], 1);
        plug.delete();
        cav.delete();
      }
    }, 120_000);
  }

  it('[90°] the base at the male’s floor is the visible ring, and the tip is the floor’s extent', () => {
    const female = femaleJob();
    const check = inlayNumbers(CONE, 2, 0.2);
    if (!check.ok) throw new Error(check.reason);
    const n = check.numbers;
    const male = inlayMaleJob(female, CONE);
    if (!male.ok) throw new Error(male.reason);
    // The tip (the island at the male's top face) is the female floor's extent: 16 × 6 at 90°
    // (the design eroded by F·tanθ). Extents, not areas: the cut rounds the island's corners.
    const tip = measure(islandAtMaleDepth(male.job, 0, n.tanHalf)).bounds;
    expect(tip[2] - tip[0]).toBeCloseTo(16, 1);
    expect(tip[3] - tip[1]).toBeCloseTo(6, 1);
    // The base (at the male's floor) is the visible ring's extent: 19.6 × 9.6.
    const base = measure(mirrorBack(islandAtMaleDepth(male.job, n.plugDepthMm, n.tanHalf), male.job.stock.width)).bounds;
    expect(base[2] - base[0]).toBeCloseTo(19.6, 1);
    expect(base[3] - base[1]).toBeCloseTo(9.6, 1);
    // The tip's own area: the cut's inward offset leaves the island's top corners sharp (an
    // inward offset of a convex region needs no join), so it is exactly the floor's extent.
    expect(areaOf(islandAtMaleDepth(male.job, 0, n.tanHalf))).toBeCloseTo(16 * 6, 1);
  }, 90_000);

  it('the OLD inset (the ring, not the tip) pokes the base out through the cavity mouth', () => {
    // The defect this test exists for: eroding the island by `g·tanθ` instead of `F·tanθ` puts the
    // BASE at the tip's cross-section, so at the male's floor the base is `design ⊕ (F − 2g)·tanθ`
    // — 1.6 mm outside the design for this fixture, which is the female's mouth.
    const female = femaleJob();
    const check = inlayNumbers(CONE, 2, 0.2);
    if (!check.ok) throw new Error(check.reason);
    const n = check.numbers;
    const male = inlayMaleJob(female, CONE);
    if (!male.ok) throw new Error(male.reason);
    const cut = male.job.combined![0]!;
    const broken: EngraveJob = {
      ...male.job,
      combined: [{ ...cut, inlay: { ...cut.inlay!, islandInsetMm: n.topInsetMm } }],
    };
    const island = islandAtMaleDepth(broken, n.plugDepthMm, n.tanHalf);
    const fitted = mirrorBack(island, male.job.stock.width);
    const design = rings(toPartPlan(female).engraves[0]!.profile);
    const CS = tl.CrossSection;
    const plug = CS.ofPolygons(fitted);
    const mouth = CS.ofPolygons(design);
    const outside = plug.subtract(mouth);
    expect(outside.area()).toBeGreaterThan(5);
    outside.delete();
    plug.delete();
    mouth.delete();
  }, 90_000);

  it('an UNMIRRORED island on an asymmetric design pokes through the cavity wall', () => {
    const female = femaleJob(lShape());
    const design = rings(toPartPlan(female).engraves[0]!.profile);
    const check = inlayNumbers(CONE, 2, 0.2);
    if (!check.ok) throw new Error(check.reason);
    const n = check.numbers;
    const male = inlayMaleJob(female, CONE);
    if (!male.ok) throw new Error(male.reason);
    // The TIP's section (male depth 0) used as stored — the wrong handedness — against the
    // female's cavity at the plug's end (d = P).
    const wrong = islandAtMaleDepth(male.job, 0, n.tanHalf);
    const cavity = offset(design, -n.plugDepthMm * n.tanHalf);
    const CS = tl.CrossSection;
    const plug = CS.ofPolygons(wrong);
    const cav = CS.ofPolygons(cavity);
    const outside = plug.subtract(cav);
    expect(outside.area()).toBeGreaterThan(1);
    outside.delete();
    plug.delete();
    cav.delete();
  }, 90_000);
});

describe('the inlay findings (#673)', () => {
  it('refuses a flat cutter, a gap at the pocket depth, and a variable-depth region', () => {
    const flat: EngraveJob = { ...femaleJob(), tool: flatEndMill(3.175, { name: '3.175 flat' }) };
    expect(validateJob(flat).map((f) => f.code)).toContain('inlay-needs-cone');

    const wide = femaleJob(rect('design', { inlay: { role: 'female', glueGapMm: 2 } }));
    const gap = validateJob(wide).find((f) => f.code === 'inlay-gap');
    expect(gap?.severity).toBe('error');
    expect(gap?.message).toContain('must be below the pocket depth');

    const variable = femaleJob(rect('design', { vCarveDepth: 'variable' }));
    expect(validateJob(variable).map((f) => f.code)).toContain('inlay-plane-depth');
    // A plane-depth inlay is clean.
    expect(
      validateJob(femaleJob()).filter((f) => f.code.startsWith('inlay-')),
    ).toEqual([]);
  });

  it('holds the male to the numbers it was built for', () => {
    const male = inlayMaleJob(femaleJob(), CONE);
    if (!male.ok) throw new Error(male.reason);
    const cut = male.job.combined![0]!;
    // Editing the male's cutaway depth no longer matches `pocket − gap`.
    const broken: EngraveJob = {
      ...male.job,
      combined: [{ ...cut, depth: 3 }],
    };
    const finding = validateJob(broken).find((f) => f.code === 'inlay-gap');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('Save the male blank from the female’s job again');
    // And a male marker with no stored inset is refused too.
    const noInset: EngraveJob = {
      ...male.job,
      combined: [{ ...cut, inlay: { role: 'male', glueGapMm: 0.2, pocketDepthMm: 2 } }],
    };
    expect(validateJob(noInset).map((f) => f.code)).toContain('inlay-gap');
  });
});

describe('the documents round-trip, and say nothing more (#673)', () => {
  it('keeps the female marker and the male numbers, and refuses what the schema does not know', () => {
    const female = parseEngraveJob(femaleJob(rect('design', { inlay: { role: 'female', glueGapMm: 0.25 } })));
    expect(female.ok).toBe(true);
    if (!female.ok) return;
    expect(female.job.shapes[0]!.inlay).toEqual({ role: 'female', glueGapMm: 0.25 });

    const male = inlayMaleJob(femaleJob(), CONE);
    if (!male.ok) throw new Error(male.reason);
    const parsedMale = parseEngraveJob(male.job);
    expect(parsedMale.ok).toBe(true);
    if (!parsedMale.ok) return;
    const cut = parsedMale.job.combined![0]!;
    expect(cut.inlay?.role).toBe('male');
    expect(cut.inlay?.glueGapMm).toBeCloseTo(0.2, 9);
    expect(cut.inlay?.pocketDepthMm).toBeCloseTo(2, 9);
    expect(cut.inlay?.tanHalf).toBeCloseTo(1, 9);
    expect(cut.inlay?.islandInsetMm).toBeCloseTo(2, 9);
    // An unknown role, and a gap outside the schema's bounds, are refused outright.
    expect(
      parseEngraveJob(femaleJob(rect('design', { inlay: { role: 'sideways' } as never }))).ok,
    ).toBe(false);
    expect(
      parseEngraveJob(femaleJob(rect('design', { inlay: { role: 'female', glueGapMm: 25 } }))).ok,
    ).toBe(false);
  });
});

describe('the run sheet names each half (#673)', () => {
  it('says FEMALE on one job and MALE on the other, with the numbers', () => {
    const female = femaleJob();
    const gF = generate(tl, female);
    expect(gF.ok).toBe(true);
    const femaleTexts = buildRunSheet(female, gF, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    const femaleStep = femaleTexts.find((t) => t.includes('FEMALE blank'));
    expect(femaleStep).toBeDefined();
    expect(femaleStep).toContain('2 mm deep with a 0.2 mm glue gap');
    expect(femaleStep).toContain('0.2 mm inside the design');

    const male = inlayMaleJob(female, CONE);
    if (!male.ok) throw new Error(male.reason);
    const gM = generate(tl, male.job);
    expect(gM.ok).toBe(true);
    const maleTexts = buildRunSheet(male.job, gM, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    const maleStep = maleTexts.find((t) => t.includes('MALE blank'));
    expect(maleStep).toBeDefined();
    expect(maleStep).toContain('1.8 mm proud');
    expect(maleStep).toContain('plane the male blank away');
  }, 120_000);
});
