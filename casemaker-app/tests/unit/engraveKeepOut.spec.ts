// Under-surface voids the job can carry (#231 item 3). Pure: schema, `toPartPlan`, the analytic
// depth limit and the run sheet — no wasm. The generator's refusal of a too-deep cut over a void
// is exercised with real Manifold in `engraveGenerate.spec.ts`.

import { describe, it, expect } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import {
  jobDepthLimit,
  keepOutLimitAt,
  keepOutLimitParts,
  keepOutMembrane,
  pointInKeepOut,
  toPartPlan,
} from '@/engine/cnc/engrave/partPlan';
import { buildRunSheet, runSheetDiagramSvg, type RunSheetGenerated } from '@/engine/cnc/engrave/runSheet';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { aabbOfProfile } from '@/engine/compiler/profile';
import { defaultBadgeParams } from '@/types/badge';
import type { EngraveJob, EngraveKeepOut } from '@/types/engraveJob';

const rectKeepOut = (over: Partial<EngraveKeepOut & { kind: 'rect' }> = {}): EngraveKeepOut => ({
  id: 'pocket',
  name: 'Magnet pocket',
  kind: 'rect',
  position: { x: 50, y: 30 },
  rotation: 0,
  enabled: true,
  zCeiling: 10,
  width: 20,
  height: 10,
  cornerRadius: 0,
  ...over,
});

/** A job that reaches the run sheet with a void declared: the default blank plus one keep-out. */
function jobWithKeepOut(keepOut: EngraveKeepOut = rectKeepOut()): EngraveJob {
  return { ...defaultEngraveJob(), keepOuts: [keepOut] };
}

const NO_GENERATED: RunSheetGenerated = { findings: [], feeds: null, cam: null, nc: null, verify: null, frameNc: null };

describe('EngraveKeepOut schema (#231)', () => {
  it('round-trips a job that carries every keep-out kind', () => {
    const keepOuts: EngraveKeepOut[] = [
      rectKeepOut(),
      { id: 'c', kind: 'circle', position: { x: 10, y: 10 }, rotation: 0, enabled: true, zCeiling: 2, diameter: 6 },
      { id: 's', kind: 'slot', position: { x: 20, y: 20 }, rotation: 45, enabled: true, zCeiling: 3, length: 12, width: 4 },
      {
        id: 'p',
        kind: 'polygon',
        position: { x: 30, y: 30 },
        rotation: 0,
        enabled: true,
        zCeiling: 1.5,
        points: [
          [0, 0],
          [5, 0],
          [0, 5],
        ],
      },
    ];
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify({ ...defaultEngraveJob(), keepOuts })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.keepOuts).toEqual(keepOuts);
  });

  it('a pre-#231 document keeps no keepOuts key', () => {
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(defaultEngraveJob())));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect('keepOuts' in parsed.job).toBe(false);
  });

  it('rejects a non-positive zCeiling, naming the path', () => {
    const parsed = parseEngraveJob({ ...defaultEngraveJob(), keepOuts: [rectKeepOut({ zCeiling: 0 })] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.some((e) => e.includes('keepOuts[0].zCeiling'))).toBe(true);
  });

  it('rejects a rect whose corner radius exceeds half its shorter side', () => {
    const parsed = parseEngraveJob({
      ...defaultEngraveJob(),
      keepOuts: [rectKeepOut({ width: 10, height: 4, cornerRadius: 3 })],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.some((e) => e.includes('keepOuts[0].cornerRadius'))).toBe(true);
  });

  it('rejects a slot shorter than it is wide', () => {
    const parsed = parseEngraveJob({
      ...defaultEngraveJob(),
      keepOuts: [{ ...rectKeepOut(), kind: 'slot', length: 3, width: 5 }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.some((e) => e.includes('keepOuts[0].length'))).toBe(true);
  });
});

describe('toPartPlan carries the voids (#231)', () => {
  it('keeps the default job void-free', () => {
    expect(toPartPlan(defaultEngraveJob()).stock.keepOuts).toEqual([]);
  });

  it('places an enabled void footprint and copies zCeiling and name through', () => {
    const plan = toPartPlan(jobWithKeepOut());
    expect(plan.stock.keepOuts).toHaveLength(1);
    const ko = plan.stock.keepOuts[0]!;
    expect(ko.id).toBe('pocket');
    expect(ko.name).toBe('Magnet pocket');
    expect(ko.zCeiling).toBe(10);
    const box = aabbOfProfile(ko.footprint)!;
    // Centred on (50, 30), 20 × 10.
    expect(box.min[0]).toBeCloseTo(40, 6);
    expect(box.min[1]).toBeCloseTo(25, 6);
    expect(box.max[0]).toBeCloseTo(60, 6);
    expect(box.max[1]).toBeCloseTo(35, 6);
  });

  it('drops a disabled void', () => {
    expect(toPartPlan(jobWithKeepOut(rectKeepOut({ enabled: false }))).stock.keepOuts).toEqual([]);
  });
});

describe('pointInKeepOut (#231)', () => {
  it('rect: inside, outside, and the rotated frame', () => {
    const ko = rectKeepOut();
    expect(pointInKeepOut(ko, 50, 30)).toBe(true);
    expect(pointInKeepOut(ko, 59, 30)).toBe(true); // |dx| = 9 < 10
    expect(pointInKeepOut(ko, 61, 30)).toBe(false);
    // 90°: the 20-wide rect now runs in Y. (50, 39) is 9 along local x.
    expect(pointInKeepOut({ ...ko, rotation: 90 }, 50, 39)).toBe(true);
    expect(pointInKeepOut({ ...ko, rotation: 90 }, 59, 30)).toBe(false);
  });

  it('circle and slot', () => {
    const circle: EngraveKeepOut = { ...rectKeepOut(), kind: 'circle', diameter: 10 };
    expect(pointInKeepOut(circle, 54, 30)).toBe(true);
    expect(pointInKeepOut(circle, 56, 30)).toBe(false);

    const slot: EngraveKeepOut = { ...rectKeepOut(), kind: 'slot', length: 20, width: 6 };
    expect(pointInKeepOut(slot, 57, 30)).toBe(true); // on the centre line, within the end cap
    expect(pointInKeepOut(slot, 50, 34)).toBe(false); // 4 mm off the axis, radius 3
    expect(pointInKeepOut(slot, 58, 30)).toBe(true); // 1 mm past the cap centre, r 3
    expect(pointInKeepOut(slot, 61, 30)).toBe(false);
  });

  it('polygon (even-odd)', () => {
    const tri: EngraveKeepOut = {
      ...rectKeepOut(),
      kind: 'polygon',
      points: [
        [-5, -5],
        [5, -5],
        [0, 5],
      ],
    };
    expect(pointInKeepOut(tri, 50, 30)).toBe(true);
    expect(pointInKeepOut(tri, 50, 31)).toBe(true);
    expect(pointInKeepOut(tri, 50, 40)).toBe(false);
    expect(pointInKeepOut(tri, 50, 20)).toBe(false);
  });
});

describe('the void depth limit (#231, #351)', () => {
  it('a void permits only its membrane less the margin its ceiling keeps', () => {
    // 12 thick, zCeiling 10 -> membrane 2. #345 takes a margin off it, and on a blank that states
    // no print that margin is `max(boundaryMargin, minFloor)` — 1.0 here, not the 0.2 the boundary
    // margin would be (#345 decision A: with no layer grid the structural floor is the number with
    // a basis). So 2 − 1.0 = 1.0.
    const job = jobWithKeepOut();
    expect(keepOutLimitAt(job, 50, 30)).toBeCloseTo(1.0, 9);
    expect(keepOutLimitAt(job, 5, 5)).toBeNull();
    // A user who typed a boundary margin LARGER than their own floor gets that margin instead:
    // the rule is `max`, not "always the floor".
    expect(keepOutLimitAt(job, 50, 30, 1.4)).toBeCloseTo(0.6, 9);
    // The limit is never below 0: a void reaching the face permits nothing.
    expect(keepOutLimitAt(jobWithKeepOut(rectKeepOut({ zCeiling: 12 })), 50, 30)).toBe(0);
  });

  it('a void on a blank that STATES its print keeps the boundary margin, not the floor (#345 A)', () => {
    // The layer grid is what makes one printed layer a distance the printer can hold, so a printed
    // blank's ceiling keeps the Z-error margin like every other plane.
    const job: EngraveJob = {
      ...jobWithKeepOut(),
      stock: {
        ...defaultEngraveJob().stock,
        print: { split: 3, layerHeight: 0.2, firstLayerHeight: 0.2 },
      },
    };
    expect(keepOutLimitAt(job, 50, 30)).toBeCloseTo(1.8, 9); // 2 − 0.2
  });

  it('a disabled void does not limit the cut', () => {
    expect(keepOutLimitAt(jobWithKeepOut(rectKeepOut({ enabled: false })), 50, 30)).toBeNull();
  });

  it('takes the shallowest of overlapping voids', () => {
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      keepOuts: [rectKeepOut({ id: 'a', zCeiling: 10 }), rectKeepOut({ id: 'b', zCeiling: 11 })],
    };
    // Membranes 2 and 1, less the same 1.0: 1.0 and 0 — the shallower void wins, and a void whose
    // membrane is exactly the floor it must keep permits no cut at all.
    expect(keepOutLimitAt(job, 50, 30)).toBeCloseTo(0, 9); // 12 - 11 - 1.0
  });

  it('jobDepthLimit is the stock limit with no void, and 0 outside the stock', () => {
    const flat = jobDepthLimit(defaultEngraveJob()); // 12 - 1 = 11
    expect(flat(50, 30)).toBe(11);
    expect(flat(-1, 30)).toBe(0);
    expect(flat(101, 30)).toBe(0);
    expect(flat(50, 61)).toBe(0);
  });

  it('jobDepthLimit tightens over a void and leaves the rest of the blank alone', () => {
    const limit = jobDepthLimit(jobWithKeepOut());
    expect(limit(50, 30)).toBeCloseTo(1.0, 9); // over the pocket: 2 − max(0.2, 1.0)
    expect(limit(5, 5)).toBe(11); // solid stock
  });

  it('snaps a roof that is off the printer’s layer grid, so the limit is the enforced one (#351)', () => {
    // The badge's magnet pocket: a 3.81 mm blank, ceiling 2.3 from the BOTTOM face, so 1.51 mm of
    // membrane as the document declares it. The 0.2 mm layer grid puts the roof at 1.40 mm, and a
    // blank that STATES its print keeps the 0.2 mm boundary margin there — 1.20 mm, not the
    // analytic 1.51 − 0.2 = 1.31. That 1.31 is what the panel's row and the viewport label printed
    // while the verifier refused every cut below 1.20, which is #351.
    const blank = badgeBlankFor(defaultBadgeParams({ print: { layerHeight: 0.2, firstLayerHeight: 0.2 } }));
    const pocket = blank.pocket!;
    const job: EngraveJob = { ...defaultEngraveJob(), stock: blank.stock, keepOuts: [pocket] };
    const depth = keepOutLimitParts(job, keepOutMembrane(job, pocket.zCeiling), 0.2);
    expect(depth.membrane).toBeCloseTo(1.51, 9);
    expect(depth.ceiling).toBeCloseTo(1.4, 9);
    expect(depth.overVoid).toBeCloseTo(1.2, 9);
    expect(depth.limit).toBeCloseTo(1.2, 9);
    // The blank's own floor is 3.81 − 1.0 = 2.81, so the VOID is what binds here, not the stock.
    expect(depth.stockFloor).toBeCloseTo(2.81, 9);

    // The run sheet states the same number, from the same owner: the sheet and the panel cannot
    // drift the way the panel and the verifier did.
    const need = buildRunSheet(job, NO_GENERATED, null, new Date('2026-10-05T00:00:00Z')).sections.find(
      (s) => s.id === 'need',
    )!;
    expect(need.steps.find((s) => s.text.includes('Under-surface void'))!.value).toBe('deepest cut 1.2 mm');

    // Without a stated print there is no grid to snap the roof to: the declared membrane IS the
    // ceiling, and the whole answer is #213's arithmetic again.
    const blind = { ...job, stock: badgeBlankFor(defaultBadgeParams()).stock };
    const blindDepth = keepOutLimitParts(blind, keepOutMembrane(blind, pocket.zCeiling), 1.0);
    expect(blindDepth.ceiling).toBeCloseTo(blindDepth.membrane, 9);
    expect(blindDepth.limit).toBeCloseTo(0.51, 9); // 1.51 − max(0.2, 1.0)
  });
});

describe('the run sheet reports the void (#231)', () => {
  it('states each void in section 1 with the material left over it', () => {
    const sheet = buildRunSheet(jobWithKeepOut(), NO_GENERATED, null, new Date('2026-10-05T00:00:00Z'));
    const need = sheet.sections.find((s) => s.id === 'need')!;
    const step = need.steps.find((s) => s.text.includes('Under-surface void'))!;
    expect(step.text).toContain('Magnet pocket');
    expect(step.text).toContain('2 mm thick'); // 12 - 10
    // 2 less the 1.0 the ceiling keeps on a blank with no stated print (#345 A). The blank's own
    // `thickness − minFloor` floor is 11 here, so nothing else is capping it and the row does not
    // credit the floor — see the thin-blank case below for when it does.
    expect(step.value).toBe('deepest cut 1 mm');
  });

  it('says which cut sits over the void and the depth it allows', () => {
    const base = defaultEngraveJob();
    const job: EngraveJob = {
      ...base,
      labels: [],
      shapes: [
        {
          id: 'a',
          name: 'A',
          kind: 'rect',
          position: { x: 50, y: 30 },
          rotation: 0,
          depth: 2.2,
          enabled: true,
          width: 10,
          height: 10,
          cornerRadius: 0,
        },
        {
          id: 'b',
          name: 'B',
          kind: 'rect',
          position: { x: 85, y: 30 },
          rotation: 0,
          depth: 2.0,
          enabled: true,
          width: 10,
          height: 10,
          cornerRadius: 0,
        },
      ],
      keepOuts: [rectKeepOut({ width: 30, height: 20 })],
    };
    const cut = buildRunSheet(job, NO_GENERATED, null, new Date('2026-10-05T00:00:00Z')).sections.find(
      (s) => s.id === 'cut',
    )!;
    const overPocket = cut.steps.find((s) => s.text.includes('"A"'));
    expect(overPocket).toBeTruthy();
    expect(overPocket!.text).toContain('Magnet pocket');
    expect(overPocket!.text).toContain('only 2 mm of material');
    expect(overPocket!.text).toContain('DEEPER than the 1 mm');
    // The clear item is not tagged with the void.
    const clear = cut.steps.find((s) => s.text.includes('"B"'))!;
    expect(clear.text).not.toContain('Magnet pocket');
  });

  it('draws the void on the diagram and in the SVG', () => {
    const sheet = buildRunSheet(jobWithKeepOut(), NO_GENERATED, null, new Date('2026-10-05T00:00:00Z'));
    expect(sheet.diagram.keepOuts).toHaveLength(1);
    expect(sheet.diagram.keepOuts[0]!.name).toBe('Magnet pocket');
    expect(sheet.diagram.keepOuts[0]!.solidThickness).toBeCloseTo(2, 9);
    const svg = runSheetDiagramSvg(sheet.diagram);
    expect(svg).toContain('data-keepout-id="pocket"');
    expect(svg).toContain('Magnet pocket');
  });

  it('clamps a void taller than the blank to 0 mm, never a negative thickness', () => {
    // zCeiling 20 on a 12 mm blank: the void pokes through the top. No material remains over it.
    const sheet = buildRunSheet(
      jobWithKeepOut(rectKeepOut({ zCeiling: 20 })),
      NO_GENERATED,
      null,
      new Date('2026-10-05T00:00:00Z'),
    );
    expect(sheet.diagram.keepOuts[0]!.solidThickness).toBe(0);
    const step = sheet.sections.find((s) => s.id === 'need')!.steps.find((s) => s.text.includes('Under-surface void'))!;
    expect(step.text).toContain('0 mm thick');
    expect(step.text).not.toContain('-8');
  });

  it('prints the sheet’s own number, and names WHICH half of it is binding (#285 review)', () => {
    // A void high in a THIN blank leaves a membrane deeper than `thickness − minFloor`. The sheet
    // composes the two with a `min` the way `jobDepthLimit` does — it used to print the membrane's
    // own answer, and here that is 3.0 mm against the 2.81 the verifier refuses past, an operator
    // reading a depth the machine will not cut.
    const thin = (print?: { split: number; layerHeight: number }): EngraveJob => ({
      ...defaultEngraveJob(),
      stock: { length: 76.2, width: 38.1, thickness: 3.81, material: 'pla', ...(print ? { print } : {}) },
      keepOuts: [rectKeepOut({ zCeiling: 0.5 })], // 3.31 mm of membrane, over a 2.81 mm floor
    });
    const sheetVoid = (job: EngraveJob): string =>
      buildRunSheet(job, NO_GENERATED, null, new Date('2026-10-05T00:00:00Z'))
        .sections.find((s) => s.id === 'need')!
        .steps.find((s) => s.text.includes('Under-surface void'))!.value ?? '';

    // With a print the ceiling is on the layer grid (3.2 mm of solid, less 0.2) while the blank's
    // own floor is 2.81 — so the FLOOR is the shallower half, and the row says so rather than
    // crediting a void that is not what limits the cut.
    expect(sheetVoid(thin({ split: 3.0, layerHeight: 0.2 }))).toBe(
      'deepest cut 2.81 mm (the blank’s own 1 mm floor, not the void, sets this)',
    );

    // With no print the ceiling keeps the job's own 1 mm minimum instead of a 0.2 layer (#345
    // decision A), so 3.31 − 1.0 = 2.31 is now the shallower half — and that IS the number
    // `jobDepthLimit` enforces, because this is the path the verifier keeps for a blank with no
    // stated print. The sheet and the limit agree.
    const blind = thin();
    expect(jobDepthLimit(blind)(50, 30)).toBeCloseTo(2.31, 9);
    expect(sheetVoid(blind)).toBe('deepest cut 2.31 mm');
  });

  it('leaves a job with no void unchanged — no extra steps, no diagram voids', () => {
    const sheet = buildRunSheet(defaultEngraveJob(), NO_GENERATED, null, new Date('2026-10-05T00:00:00Z'));
    expect(sheet.diagram.keepOuts).toEqual([]);
    expect(sheet.sections.every((s) => s.steps.every((st) => !st.text.includes('Under-surface void')))).toBe(true);
  });
});
