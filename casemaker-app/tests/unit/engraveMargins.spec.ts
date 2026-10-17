// #345 — depth bounds, and the one margin a floor keeps clear of them.
//
// The pure half of the issue: the bound model (`checkBounds`, `boundsFor`, the floors it implies),
// the house setting and the per-job resolution (`effectiveMargins`), the recommendation arithmetic
// (`recommendMargins`), and the two documents the number reaches — the run sheet's margins block and
// the posted `.nc`. The per-item finding (`item-depth-bound`) is exercised over a real preview in
// `engravePreview.spec.ts`, and the verifier's limit over a real stack in `engraveGenerate.spec.ts`;
// both are listed in this file's last describe as the places a regression would show up first.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { buildTimeline, parseGcode, Z1 } from '@/engine/cnc';
import { sweepTimeline } from '@/workers/geometry/sweep';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  boundFloor,
  boundsFor,
  checkBounds,
  DEFAULT_BOUNDARY_MARGIN_MM,
  defaultBoundaryMargin,
  type DepthBound,
  effectiveMargins,
  MARGIN_DEFAULTS,
  marginSourceWords,
  MEASURED_THICKNESS_TOLERANCE_MM,
  recommendLabelDepth,
  recommendMargins,
  splitBound,
  splitDepthOf,
  undersideBound,
  voidBound,
  voidFloor,
  voidMargin,
  type LabelDepthInputs,
  type MarginSettings,
} from '@/engine/cnc/engrave/depthBounds';
import { buildRunSheet, type RunSheetGenerated } from '@/engine/cnc/engrave/runSheet';
import { labelGlyphMeasure, labelJawReach, voidLimitForItem } from '@/engine/cnc/engrave/partPlan';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { viseForNewJob } from '@/engine/cnc/fixture';
import { WIRED_PROBE_Z_RESIDUAL_MM } from '@/engine/cnc/probePlan';
import { defaultBadgeParams } from '@/types/badge';
import type { EngraveJob, EngraveKeepOut, EngraveLabel } from '@/types/engraveJob';
import { itemDepthBoundFindings } from '@/workers/sim/engraveGeometry';

/** A printed blank's facts, as a job carries them (#285/#345): no wasm, so the numbers are exact. */
function printedJob(colour: EngraveJob['stock']['colour'], flatness?: EngraveJob['stock']['flatness']): EngraveJob {
  return { ...defaultEngraveJob(), stock: { ...defaultEngraveJob().stock, colour, flatness } };
}

const PRINT_0_2 = { kind: 'printed', capMm: 9.0, layerHeight: 0.2, firstLayerHeight: 0.2 } as const;

describe('the depth-bound model (#345)', () => {
  it('refuses a floor ON the plane from either side, and passes one margin clear', () => {
    const above = voidBound('Magnet pocket', 2.0);
    const below: typeof above = { at: 2.0, side: 'below', name: 'the colour split', source: 'split' };

    // `above`: `d ≤ at − m`. The plane itself is out; one margin shallower is in.
    expect(checkBounds(2.0, [above], 0.2)).not.toBeNull();
    expect(checkBounds(1.8, [above], 0.2)).toBeNull();

    // `below`: `d ≥ at + m`, and the equality goes the same way — a floor in the plane is in it.
    expect(checkBounds(2.0, [below], 0.2)).not.toBeNull();
    expect(checkBounds(2.2, [below], 0.2)).toBeNull();

    // #285's review found each side of this pair was decided by whichever of `≥`/`≤` the code
    // happened to use. Always subtracting is what leaves no equality to argue about.
    expect(checkBounds(1.8, [above], 0.2)).toBeNull();
  });

  it('judges the bound to the float tail, and no further (#362 review)', () => {
    // The checker re-derives `at ± m` from the two numbers the document holds, while the
    // recommendation quantises its floor to the thousandth — so the two land a few bits apart. On a
    // split 1.2 mm down with a 0.28 mm margin, `at − m` is `0.9199999999999999` to a float and `0.92`
    // to the rounding, and the app's own recommended floor was refused by the bound it was computed
    // against. Both sides carry the same `DEPTH_EPS`, so they cannot disagree; the shipped 0.8/0.2
    // pair only ever passed because its tail happens to round the other way.
    const above: DepthBound = { at: 1.2, side: 'above', name: 'the colour split', source: 'split' };
    expect(checkBounds(0.92, [above], 0.28)).toBeNull();
    // …and the tolerance is the representation, not the cut: a thousandth past the floor is still
    // refused, which is what makes this a rounding fix rather than a loosened check.
    expect(checkBounds(0.921, [above], 0.28)).not.toBeNull();

    // The same, on the other side: a floor the user typed as exactly the grid line a `reveal` bound
    // asks for (0.92 + 0.28 = 1.2000000000000002 in binary) is ON that bound, not short of it.
    const below: DepthBound = { ...above, at: 0.92, side: 'below' };
    expect(checkBounds(1.2, [below], 0.28)).toBeNull();
    expect(checkBounds(1.199, [below], 0.28)).not.toBeNull();
  });

  it('a bound carries its own margin where its rule is a different quantity', () => {
    // The stock's underside is `minFloor` (material that must remain), never `boundaryMargin`.
    const under = undersideBound({ ...defaultEngraveJob(), minFloor: 1.0 });
    expect(under.margin).toBe(1.0);
    expect(under.at).toBe(12);
    // A floor at 11 mm is exactly what the 1 mm floor allows; 11.1 is through it.
    expect(checkBounds(11, [under], 0.2)).toBeNull();
    expect(checkBounds(11.1, [under], 0.2)).not.toBeNull();
    // …and the job's own margin does not move it.
    expect(checkBounds(11.1, [under], 0.05)).not.toBeNull();
  });

  it('the intent chooses the SIDE, and no intent chooses nothing', () => {
    expect(splitBound('surface', 0.8)).toMatchObject({ at: 0.8, side: 'above', name: 'the colour split' });
    expect(splitBound('reveal', 0.8)).toMatchObject({ at: 0.8, side: 'below' });
    // `custom` is the advanced override, and absent is every item authored before the control.
    expect(splitBound('custom', 0.8)).toBeNull();
    expect(splitBound(undefined, 0.8)).toBeNull();
    // A blank that states no split has no boundary to keep clear of: two-colour costs nothing absent.
    expect(splitBound('surface', null)).toBeNull();
    expect(splitBound('reveal', null)).toBeNull();
  });

  it('names a void’s ceiling as a clause, and a bound’s floor is its plane less its margin', () => {
    expect(voidBound('Magnet pocket', 1.51).name).toBe("the magnet pocket's ceiling");
    expect(voidBound('', 1.51).name).toBe("the void's ceiling");
    // `at − margin`: what a `DepthLimit` field is made of, and the bound's OWN margin wins where it
    // has one — which is the stock's underside (`minFloor`) and every void.
    expect(boundFloor(voidBound('p', 1.51), 0.2)).toBeCloseTo(1.31, 9);
    expect(boundFloor(undersideBound(defaultEngraveJob()), 0.2)).toBeCloseTo(11, 9);
    // The job's own margin does not move the underside: 11 is what `minFloor` leaves either way.
    expect(boundFloor(undersideBound(defaultEngraveJob()), 0.05)).toBeCloseTo(11, 9);
    // A plane nearer the face than the margin leaves nothing to cut, not a negative depth.
    expect(voidFloor(0.1, 0.2)).toBe(0);
  });

  it('a void on a blank that states NO print keeps the larger of the two numbers (#345 A)', () => {
    // The layer grid is what makes one printed layer a distance a printer can hold, so a blank that
    // states no print has nothing to align a Z-error margin to — and it is also the blank the app
    // knows least about. The LEAST-known blank must not get the THINNEST membrane.
    const blind = defaultEngraveJob(); // no print, minFloor 1.0
    expect(voidMargin(blind, 0.2)).toBe(1.0);
    // A user who typed a boundary margin bigger than their own floor still gets that margin: the
    // rule is `max`, not "always the floor".
    expect(voidMargin(blind, 1.4)).toBe(1.4);
    // With a print the layer grid carries the Z-error, so the boundary margin stands as it does on
    // every other plane — the badge's 0.2.
    expect(voidMargin(printedJob(PRINT_0_2), 0.2)).toBe(0.2);
  });

  it('gives every item the split, the void under it and the underside, in that order', () => {
    const job = defaultEngraveJob();
    const label = { ...job.labels[0]!, depthIntent: 'surface' as const };
    const planes = { split: 0.8, overVoid: { name: 'Magnet pocket', breach: 1.4 } };
    expect(boundsFor(job, label, planes).map((b) => b.source)).toEqual(['split', 'void', 'underside']);
    // The underside is carried for the model's sake, and `depth-exceeds-stock` is its owner.
    expect(boundsFor(job, label, { split: null }).map((b) => b.source)).toEqual(['underside']);
    // Decision A lives in the BOUND, not in each caller: `boundsFor` applies the void's own margin,
    // so the whole 1 mm floor travels with the plane however the caller resolved its boundary margin.
    expect(boundsFor(job, label, planes, 0.2)[1]!.margin).toBe(1.0);
    expect(boundsFor(printedJob(PRINT_0_2), label, planes, 0.2)[1]!.margin).toBe(0.2);
  });
});

describe('the house margins and the job’s own (#345)', () => {
  it('seeds a new job’s four per-job fields from the settings, and leaves `margins` absent', () => {
    const margins: MarginSettings = { boundaryMargin: 0.3, zTolerance: 0.1, minFloor: 2, edgeMargin: 3, breakthrough: 0.5, jawClearance: 1.5, source: 'user' };
    const job = defaultEngraveJob(undefined, margins);
    expect(job.minFloor).toBe(2);
    expect(job.edgeMargin).toBe(3);
    expect(job.breakthrough).toBe(0.5);
    // #362's jaw clearance is seeded the same way — the check reads the JOB's number, not the
    // setting's, so a user who wants more room over the jaws says so per job.
    expect(job.jawClearance).toBe(1.5);
    // ABSENCE IS THE SWITCH: the job follows the house setting until someone overrides it, so no
    // stored document needs migrating and every `.nc` keeps the numbers it was cut with.
    expect(job.margins).toBeUndefined();
    // The shipped set is what these fields used to be hard-coded to, so a fresh install is unchanged.
    expect(defaultEngraveJob()).toMatchObject({ minFloor: 1.0, edgeMargin: 1.0, breakthrough: 0.3, jawClearance: 1.0 });
  });

  it('defaults the boundary margin to one printed layer, or the common 0.2 without a print', () => {
    expect(DEFAULT_BOUNDARY_MARGIN_MM).toBe(0.2);
    expect(defaultBoundaryMargin(printedJob(PRINT_0_2))).toBe(0.2);
    expect(defaultBoundaryMargin(printedJob({ kind: 'printed', capMm: 9, layerHeight: 0.3 }))).toBe(0.3);
    expect(defaultBoundaryMargin(defaultEngraveJob())).toBe(0.2);
  });

  it('resolves a job with no margins from the settings, reading the blank’s own layers', () => {
    const printed = printedJob({ kind: 'printed', capMm: 9, layerHeight: 0.3 });
    // A SHIPPED default is not a number the user chose, so the blank's own layer height is read off
    // it: a badge with 0.3 mm layers gets 0.3 without anyone typing it.
    expect(effectiveMargins(printed, MARGIN_DEFAULTS)).toEqual({
      boundaryMargin: 0.3,
      zTolerance: MARGIN_DEFAULTS.zTolerance,
      source: 'default',
    });
    // A setting the user chose is never second-guessed.
    const mine: MarginSettings = { ...MARGIN_DEFAULTS, boundaryMargin: 0.5, source: 'user' };
    expect(effectiveMargins(printed, mine)).toMatchObject({ boundaryMargin: 0.5, source: 'user' });
  });

  it('lets a job that states its own margins keep them, whatever the house setting says', () => {
    const job: EngraveJob = {
      ...printedJob(PRINT_0_2),
      margins: { boundaryMargin: 0.07, zTolerance: 0.02, source: 'user' },
    };
    expect(effectiveMargins(job, { ...MARGIN_DEFAULTS, boundaryMargin: 0.9, source: 'user' })).toEqual(job.margins);
  });

  it('says where the margins came from in words', () => {
    expect(marginSourceWords('default')).toBe('the house default');
    expect(marginSourceWords('recommended')).toBe("this job's recommendation");
    expect(marginSourceWords('user')).toBe('set for this job');
  });
});

describe('the recommendation (#345)', () => {
  it('adds the blank’s dome when the job runs no autolevel grid', () => {
    const job = printedJob(PRINT_0_2, { dome: 0.33, across: 'width', source: 'badge' });
    const rec = recommendMargins(job, MARGIN_DEFAULTS);
    // The wired probe's measured repeatability plus the dome — the two things that move Z.
    expect(rec.zTolerance).toBeCloseTo(WIRED_PROBE_Z_RESIDUAL_MM + 0.33, 9);
    expect(rec.boundaryMargin).toBeCloseTo(0.331, 9);
    expect(rec.basis.join(' ')).toContain('domed 0.33 mm across its width');
    expect(rec.basis.join(' ')).toContain('runs no autolevel grid');
  });

  it('says "flatness unknown" rather than inventing a dome for a blank that states none', () => {
    const rec = recommendMargins(printedJob(PRINT_0_2), MARGIN_DEFAULTS);
    expect(rec.zTolerance).toBeCloseTo(WIRED_PROBE_Z_RESIDUAL_MM, 9);
    expect(rec.basis.join(' ')).toContain('flatness unknown');
    // The house setting is a floor under the advice: a job with nothing special about it is not
    // talked into a tighter margin than the house runs.
    expect(rec.boundaryMargin).toBe(DEFAULT_BOUNDARY_MARGIN_MM);
  });

  it('takes the grid’s residual INSTEAD of the dome — a grid is what measures the dome away', () => {
    const job = printedJob(PRINT_0_2, { dome: 0.33, across: 'width', source: 'badge' });
    const rec = recommendMargins(job, MARGIN_DEFAULTS, { gridResidual: 0.05 });
    expect(rec.zTolerance).toBeCloseTo(WIRED_PROBE_Z_RESIDUAL_MM + 0.05, 9);
    expect(rec.basis.join(' ')).not.toContain('domed');
    expect(rec.basis.join(' ')).toContain("autolevel grid's residual");
  });

  it('adds the thickness’ own ± when the blank was measured, and never lowers the setting', () => {
    const rec = recommendMargins(printedJob(PRINT_0_2), MARGIN_DEFAULTS, {
      thicknessUncertainty: MEASURED_THICKNESS_TOLERANCE_MM,
    });
    expect(rec.zTolerance).toBeCloseTo(WIRED_PROBE_Z_RESIDUAL_MM + MEASURED_THICKNESS_TOLERANCE_MM, 9);
    expect(rec.basis.join(' ')).toContain('measured thickness');
    // max(setting, zTolerance): a big setting wins, a small recommendation does not lower it.
    expect(
      recommendMargins(printedJob(PRINT_0_2), { boundaryMargin: 0.5, source: 'user' }).boundaryMargin,
    ).toBe(0.5);
  });

  it('reads the setting as THIS blank runs it — one printed layer while it is still the default', () => {
    // #345 review: the floor under the advice must be the margin really in force. A house setting
    // left on `'default'` resolves to `defaultBoundaryMargin(job)` — the blank's own layer height —
    // so a 0.3 mm-layer blank is already running 0.3, and an advice of 0.2 would sit BELOW it. The
    // same resolver `effectiveMargins` uses, so the two cannot disagree.
    const thickLayers = printedJob({ kind: 'printed', capMm: 9, layerHeight: 0.3, firstLayerHeight: 0.3 });
    expect(
      recommendMargins(thickLayers, { boundaryMargin: 0.2, source: 'default' }).boundaryMargin,
    ).toBeCloseTo(0.3, 9);
    // A setting the user typed is never second-guessed: 0.2 stays 0.2 even on the 0.3 mm blank.
    expect(
      recommendMargins(thickLayers, { boundaryMargin: 0.2, source: 'user' }).boundaryMargin,
    ).toBeCloseTo(0.2, 9);
  });
});

describe('the run sheet prints the margins (#345)', () => {
  const NO_GENERATED: RunSheetGenerated = { findings: [], feeds: null, cam: null, nc: null, verify: null, frameNc: null };
  const NOW = new Date('2026-10-05T00:00:00Z');

  /** The default blank with one under-surface void declared — a job that HAS a `boundaryMargin` bound. */
  function voidJob(): EngraveJob {
    const pocket: EngraveKeepOut = {
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
    };
    return { ...defaultEngraveJob(), keepOuts: [pocket] };
  }

  function marginsStepOf(job: EngraveJob, margins?: Parameters<typeof buildRunSheet>[4]) {
    const sheet = margins ? buildRunSheet(job, NO_GENERATED, null, NOW, margins) : buildRunSheet(job, NO_GENERATED, null, NOW);
    return sheet.sections.find((s) => s.id === 'need')!.steps.find((s) => s.text.includes('Depth margins'));
  }

  it('states the value, its source and the arithmetic behind it', () => {
    const step = marginsStepOf(voidJob())!;
    expect(step).toBeTruthy();
    // #345 A — a blank that states no print keeps the larger of the two numbers over a void, and
    // this is the only place the operator can read that the margin beside it is not the one the
    // ceiling kept.
    expect(step.value).toBe(
      '0.2 mm boundary margin · the house default · no print grid stated: a void’s ceiling keeps the ' +
        'job’s minimum floor, 1 mm',
    );
    expect(step.text).toContain('Recommended for this blank: 0.2 mm');
    expect(step.text).toContain('flatness unknown');
  });

  it('recommends more than the house default for a blank that says it is domed', () => {
    // The badge is the case the block exists for: the shipped 0.2 mm is smaller than the 0.33 mm
    // the blank is domed by, and the operator reading the printout has no panel to check it against.
    const badge = badgeBlankFor(defaultBadgeParams({ print: { layerHeight: 0.2, firstLayerHeight: 0.2 } }));
    const job: EngraveJob = {
      ...defaultEngraveJob(viseForNewJob(undefined, badge.stock)),
      stock: badge.stock,
      keepOuts: badge.pocket ? [badge.pocket] : [],
      labels: [],
    };
    const step = marginsStepOf(job)!;
    expect(step.value).toBe('0.2 mm boundary margin · the house default');
    expect(step.text).toContain('Recommended for this blank: 0.331 mm');
    // The dome is 0.33 mm across the badge's 38.1 mm side, which the blank's quarter turn (#383)
    // makes the STOCK's length — the sentence names a span in the job's frame, as `flatness.across`
    // does, so it reads "length" rather than the badge's own "width".
    expect(step.text).toContain('domed 0.33 mm across its length');
  });

  it('leaves a job with no bound alone — the block would have nothing to say in it', () => {
    // The shipped default: one colour, solid stock. Its sheet is what it always was.
    expect(marginsStepOf(defaultEngraveJob())).toBeUndefined();
    // A print with no item stating an intent is the same case: a split nobody asked about.
    expect(marginsStepOf(printedJob(PRINT_0_2))).toBeUndefined();
    // An item WITH an intent is a bound, so the block appears.
    const surface: EngraveJob = {
      ...printedJob(PRINT_0_2),
      labels: [{ ...printedJob(PRINT_0_2).labels[0]!, depthIntent: 'surface' }],
    };
    expect(marginsStepOf(surface)).toBeTruthy();
  });

  it('leaving the house setting out resolves to the same sheet as posting it', () => {
    const job = voidJob();
    // The sheet resolves the margins itself (#345 review), from the HOUSE setting — so the panel
    // handing it the setting and a caller handing it nothing are the same sheet. Passing a job's
    // resolved margins back in would skip `effectiveMargins`, and with it the blank's own layers.
    expect(buildRunSheet(job, NO_GENERATED, null, NOW, MARGIN_DEFAULTS)).toEqual(
      buildRunSheet(job, NO_GENERATED, null, NOW),
    );
  });
});

describe('the margins reach the program only where a bound does (#345)', () => {
  it('posts byte-identical nc for a job with no bound, whatever margin is in force', () => {
    const job = defaultEngraveJob();
    const absent = generate(tl, job);
    const stated = generate(tl, job, null, [], { boundaryMargin: 0.5, zTolerance: 0.4, source: 'user' });
    expect(absent.ok).toBe(true);
    expect(stated.nc).toBe(absent.nc);
  });

  /** The 12 mm blank with a void under a 1.9 mm cut — the job the two verdict tests below share. */
  function deepCutOverVoid(colour?: EngraveJob['stock']['colour']): EngraveJob {
    const pocket: EngraveKeepOut = {
      id: 'pocket',
      name: 'Magnet pocket',
      kind: 'rect',
      position: { x: 50, y: 30 },
      rotation: 0,
      enabled: true,
      zCeiling: 10,
      width: 30,
      height: 20,
      cornerRadius: 0,
    };
    const base = defaultEngraveJob();
    const label = { ...(base.labels[0] as EngraveLabel) };
    return {
      ...base,
      stock: colour === undefined ? base.stock : { ...base.stock, colour },
      labels: [{ ...label, text: 'CASE', size: 10, depth: 1.9, position: { x: 50, y: 30 } }],
      keepOuts: [pocket],
    };
  }

  const LOOSE = { boundaryMargin: 0.05, zTolerance: 0.05, source: 'user' } as const;

  it('moves the verdict on a PRINTED blank — the margin comes off the layer-aligned ceiling', () => {
    // #345 A: with a print, the layer grid carries the Z-error, so the margin in force is the
    // boundary margin and the raw limit is the layer-aligned ceiling. The ceiling is 12 − 10 = 2 mm
    // of membrane and 2 mm is a layer line (0.2 × 10), so it is 2.0 exactly.
    const job = deepCutOverVoid({ kind: 'printed', capMm: 9, layerHeight: 0.2, firstLayerHeight: 0.2 });
    // 2.0 − 0.2 = 1.8, so 1.9 is out — and #345 B says the ITEM is what gets named, against the
    // plane it crossed, rather than a move the operator never typed.
    const f = generate(tl, job).findings.find((x) => x.code === 'item-depth-bound');
    expect(f?.message).toContain("the magnet pocket's ceiling");
    expect(f?.message).toContain('0.2 mm above it');
    // …and 2.0 − 0.05 = 1.95, so the same cut is in and the job runs through. The user has to
    // regenerate to see it, which is the whole reason this number is on the run sheet.
    const loose = generate(tl, job, null, [], LOOSE);
    expect(loose.ok).toBe(true);
    expect(loose.findings.some((x) => x.code === 'item-depth-bound')).toBe(false);
  });

  it('does NOT move it on a blank that states no print — the floor is the number there (#345 A)', () => {
    // Same job, no print. The ceiling keeps `max(boundaryMargin, minFloor)` = 1.0, so the limit is
    // 2 − 1.0 = 1.0 and 1.9 stays refused however small the boundary margin gets. This is the
    // decision: with no layer grid there is nothing to align a 0.2 to, the structural floor is the
    // only number with a basis, and a setting must not talk the least-known blank into a thinner
    // membrane.
    const job = deepCutOverVoid();
    const tight = generate(tl, job).findings.find((x) => x.code === 'item-depth-bound');
    expect(tight?.message).toContain("the magnet pocket's ceiling");
    // `1` mm, not `0.2`: the sentence quotes the margin the ceiling actually kept.
    expect(tight?.message).toContain('1 mm above it');
    expect(generate(tl, job, null, [], LOOSE).findings.some((x) => x.code === 'item-depth-bound')).toBe(
      true,
    );
  });

  it('refuses a `reveal` floor over a void, though its intent is the deeper one (#345 review)', () => {
    // A `reveal` is the one item that WANTS a deep floor — below the colour split. A void under it
    // is a plane it still may not cross, and the per-move limit knows nothing about intent: it is
    // the material's own number (`jobDepthLimit`), so an item whose intent is satisfied can still
    // be refused, and the two findings are answers to two different questions.
    const pocket: EngraveKeepOut = {
      id: 'pocket',
      name: 'Magnet pocket',
      kind: 'rect',
      position: { x: 50, y: 30 },
      rotation: 0,
      enabled: true,
      zCeiling: 10, // depth 12 − 10 = 2 mm of membrane, so the floor is 2 − 0.2 = 1.8
      width: 30,
      height: 20,
      cornerRadius: 0,
    };
    const base = defaultEngraveJob();
    const label = { ...(base.labels[0] as EngraveLabel) };
    const job: EngraveJob = {
      // Split depth 12 − 10.6 = 1.4, so a reveal needs 1.4 + 0.2 = 1.6 — shallower than the
      // 1.8 the void allows. 1.9 is a legal reveal AND past the void's floor.
      ...base,
      stock: { ...base.stock, colour: { kind: 'printed', capMm: 1.4, layerHeight: 0.2, firstLayerHeight: 0.2 } },
      labels: [
        { ...label, text: 'CASE', size: 10, depth: 1.9, position: { x: 50, y: 30 }, depthIntent: 'reveal' },
      ],
      keepOuts: [pocket],
    };

    // The intent's own bound is satisfied at 1.9: it is on the deep side of the split.
    expect(checkBounds(1.9, [splitBound('reveal', 1.4)!], 0.2)).toBeNull();

    // #345 B — the item is refused against the void's ceiling, at the findings stage, and the
    // finding names the item, the plane and the side. The intent's own bound is NOT what fired:
    // the same job with the pocket removed cuts, which is what makes this the void's doing.
    const item = generate(tl, job).findings.find((f) => f.code === 'item-depth-bound');
    expect(item?.message).toContain("the magnet pocket's ceiling");
    expect(item?.message).toContain('cuts to 1.9 mm');
    const without: EngraveJob = { ...job, keepOuts: [] };
    expect(generate(tl, without).findings.some((f) => f.code === 'item-depth-bound')).toBe(false);
  });
});

// #362 — where the depth of a label COMES FROM, on a blank the job did not choose the defaults for.
//
// The clash this closes: a 3.81 mm badge blank, a vise standing it 1.905 mm proud, and the 2 mm
// label depth the 12 mm softwood job shipped with — three defaults that never knew about each
// other, so the wizard handed over a job its own blank step complained about. The route that knows
// the blank now also says how deep it may be cut (`recommendLabelDepth`), and these are the four
// floors that answer is the shallowest of.
describe('the label depth a blank allows (#362)', () => {
  /** The badge's own blank — 3.81 mm — as the job's stock, with the vise the store seeds for it.
   *  A badge stating NO print (#368): these are the four floors of the analytic limit, and each test
   *  that wants a colour boundary states the print it is about (`PRINT_0_2`). */
  function badgeJob(over: Partial<EngraveJob> = {}): EngraveJob {
    const blank = badgeBlankFor(defaultBadgeParams({ print: undefined }));
    const base = defaultEngraveJob();
    return {
      ...base,
      stock: blank.stock,
      workholding: { kind: 'vise', vise: { ...viseForNewJob(undefined, blank.stock), stockProud: 1.905 } },
      keepOuts: blank.pocket ? [blank.pocket] : [],
      ...over,
    };
  }
  const label = (over: Partial<EngraveLabel> = {}): EngraveLabel => ({
    ...(defaultEngraveJob().labels[0] as EngraveLabel),
    ...over,
  });

  /**
   * The demo 'CASE' line placed where the JAWS can reach it (#394). The line MEASURES 46.28 mm
   * wide, and since the blank is TURNED for the vise (#383) the stock runs 38.1 mm in X, so the
   * line's default x = 50 hangs off the moving end. At x = 24 its box comes 0.86 mm off the FIXED
   * jaw face: the jaw floor is in play, and it overhangs the moving jaw outright, so the two gaps
   * are 0.86 mm and 0 — the FIXED jaw is still the nearer, which is the one the clause names.
   */
  const nearJaw = (over: Partial<EngraveLabel> = {}): EngraveLabel =>
    label({ position: { x: 24, y: 43 }, ...over });

  /**
   * The inputs a caller hands `recommendLabelDepth`, with the JAW reach worked out for the very line
   * being judged — the way all three app callers do it (`EngravePanel`, `engraveJobStore`,
   * `runSheet`), so a test cannot pass on a reach no caller would have supplied (#369).
   */
  function inputsFor(
    job: EngraveJob,
    line: EngraveLabel,
    over: Partial<LabelDepthInputs> = {},
  ): LabelDepthInputs {
    const boundaryMargin = over.boundaryMargin ?? 0.2;
    return {
      voidLimit: null,
      jawReach: labelJawReach(job, line),
      boundaryMargin,
      ...over,
    };
  }

  it('borrows the layer GRID’s answer for where the colour split is, not the nominal height', () => {
    // 3.81 mm blank, split 3.0 → the boundary is 0.81 mm down, quantised onto 0.2 mm layers.
    // The NOMINAL number is what a recommendation that did its own arithmetic would use, and it
    // is half a layer away from the plane `item-depth-bound` then judges the floor against.
    const printed = badgeJob({ stock: { ...badgeJob().stock, colour: { kind: 'printed', capMm: 0.81, layerHeight: 0.2, firstLayerHeight: 0.2 } } });
    expect(splitDepthOf(printed)).toBe(0.8);
    expect(splitDepthOf(badgeJob())).toBeNull(); // no stated print → no split at all
    expect(splitDepthOf({ stock: { ...badgeJob().stock, colour: { kind: 'printed', capMm: 0.81, layerHeight: 0.2 } } })).toBe(0.8);
  });

  it('recommends the split’s depth when the blank states its print — and says what it means', () => {
    // A 12 mm printed blank whose top colour is 1.4 mm thick: a reveal needs 1.6 mm, and both other
    // floors are deeper (the jaws 4 − 1 = 3, the underside 12 − 1 = 11). The split is the shallowest,
    // so the recommendation is the reveal the blank is FOR — and 1.4 is a LAYER LINE, which is what
    // lets `checkBounds` accept exactly `at + m` against the plane the checker computes for itself.
    const job = printedJob({ kind: 'printed', capMm: 1.4, layerHeight: 0.2, firstLayerHeight: 0.2 });
    expect(splitDepthOf(job)).toBeCloseTo(1.4, 9);
    const rec = recommendLabelDepth(job, label(), inputsFor(job, label()))!;
    expect(rec.depth).toBe(1.6);
    expect(rec.depthIntent).toBe('reveal');
    // The recommendation CANNOT fail the bound it is aiming at: the same plane, the same margin.
    expect(checkBounds(rec.depth, [splitBound('reveal', splitDepthOf(job))!], 0.2)).toBeNull();
    expect(rec.basis[0]).toContain('the colour split is 1.4 mm under the face');
    expect(rec.basis[1]).toContain('not binding');
  });

  it('stops in the TOP colour when the shallowest floor lands inside the split band (#362 review)', () => {
    // The badge's own seating: 1.905 mm proud leaves 0.905 mm over the jaws. The blank's split sits
    // at 0.8 mm with a ±0.2 mm band around it, and 0.905 is inside that band — neither colour is
    // decided there, so a floor at 0.905 is a floor whose colour the app cannot name. The review's
    // ruling: the recommendation comes back UP to the top colour, 0.8 − 0.2 = 0.6, and says so.
    //
    // The intent it stamps is `'surface'`, which is a real statement and not a formality: this floor
    // DOES stay in the top colour, and saying so is what lets `checkBounds` hold it to the plane
    // from the right side — and it is stamped as the app's own, so a thicker blank or a moved split
    // gets a fresh answer rather than a floor frozen against this one.
    const badge = badgeJob();
    const job: EngraveJob = { ...badge, stock: { ...badge.stock, colour: { kind: 'printed', capMm: 0.81, layerHeight: 0.2, firstLayerHeight: 0.2 } }, keepOuts: [] };
    const rec = recommendLabelDepth(job, nearJaw(), inputsFor(job, nearJaw()))!;
    expect(rec.depth).toBe(0.6);
    expect(rec.depthIntent).toBe('surface');
    expect(rec.basis[0]).toContain('which lands inside the colour split');
    expect(rec.basis[0]).toContain('stops in the top colour at 0.6 mm');
    // The demotion quotes the clause that was binding (the jaws, 0.905 mm) and then every other
    // constraint considered, in the candidates' own order — the split, the blank's underside.
    expect(rec.basis[0]).toContain('above the jaw tops');
    expect(rec.basis[1]).toContain('the colour split is 0.8 mm under the face');
    expect(rec.basis[1]).toContain('not binding');
    expect(rec.basis[2]).toContain('minimum floor allows');
    expect(rec.basis[2]).toContain('not binding');
    expect(rec.basis).toHaveLength(3);
    // A floor the checker accepts from the side the demotion claims: exactly one margin above the
    // plane, which is what `surface` means.
    expect(checkBounds(rec.depth, [splitBound('surface', splitDepthOf(job))!], 0.2)).toBeNull();
    // …and one 0.1 mm deeper, still inside the band, would keep a distance no colour claim survives.
    expect(checkBounds(0.7, [splitBound('surface', splitDepthOf(job))!], 0.2)).not.toBeNull();
  });

  it('recommends a demotion the checker accepts, on a margin that floats the other way (#362 review)', () => {
    // The same demotion on a margin whose float tail rounds DOWN. The peer review's case: the colour
    // boundary lands 1.2 mm down on the grid, and the job runs a 0.28 mm boundary margin — a number
    // a job states for itself (#345), not necessarily one printed layer. `1.2 − 0.28` is
    // `0.9199999999999999` in binary, so the demoted floor `0.92` is a few bits PAST the `at − m` the
    // checker derives, and the app reported `item-depth-bound` against its own recommendation. The
    // shipped 0.8/0.2 pair passes only because 0.8 − 0.2 floats UP.
    //
    // The winner is the jaws at 1.2 mm — the split's own depth — which is inside the band by
    // construction: 2.2 mm proud less the 1 mm clearance.
    const base = badgeJob();
    const job: EngraveJob = {
      ...base,
      stock: { ...base.stock, colour: { kind: 'printed', capMm: 1.2, layerHeight: 0.2, firstLayerHeight: 0.2 } },
      workholding: { kind: 'vise', vise: { ...base.workholding.vise, stockProud: 2.2 } },
      keepOuts: [],
      // Stated BY THE JOB so the whole path runs at 0.28: `effectiveMargins` gives a job its own
      // margin, and `engraveGenerate` judges at `margins.boundaryMargin`. Nothing here is derived
      // from the layer height — that is the point of a job's own margin.
      margins: { boundaryMargin: 0.28, zTolerance: MARGIN_DEFAULTS.zTolerance, source: 'user' },
    };
    const margin = effectiveMargins(job, MARGIN_DEFAULTS).boundaryMargin;
    expect(margin).toBe(0.28);
    expect(splitDepthOf(job)).toBe(1.2);

    const rec = recommendLabelDepth(job, nearJaw(), inputsFor(job, nearJaw(), { boundaryMargin: margin }))!;
    expect(rec.depthIntent).toBe('surface');
    expect(rec.depth).toBe(0.92);
    expect(rec.basis[0]).toContain('stops in the top colour at 0.92 mm');

    // The two checks the app actually makes, on the recommendation as the store writes it onto the
    // label: the bound in isolation, and the finding `engraveGenerate` raises from it
    // (`itemDepthBoundFindings(job, colourBoundaryDepth, margins.boundaryMargin, bindingVoids)`).
    const applied: EngraveJob = {
      ...job,
      labels: [{ ...label(), depth: rec.depth, depthIntent: rec.depthIntent }],
    };
    const bound = splitBound(rec.depthIntent, splitDepthOf(job))!;
    expect(checkBounds(rec.depth, [bound], margin)).toBeNull();
    expect(itemDepthBoundFindings(applied, splitDepthOf(job), margin)).toEqual([]);
    // …and through the real generate path, which is where the operator would have met the finding.
    expect(generate(tl, applied).findings.some((f) => f.code === 'item-depth-bound')).toBe(false);
  });

  it('leaves the intent OFF where the split is out of reach — the jaws win and say so', () => {
    // The same seating, on a blank whose split sits 1.4 mm down (`split: 2.41` on a 3.81 mm blank).
    // Reaching the bottom colour would need 1.4 + 0.2 = 1.6 mm and the jaws leave 0.905, so the
    // reveal is simply not available on a blank seated this low: the answer says so rather than
    // stamping a `reveal` the item would then be refused for. 0.905 is also well below the split's
    // band (1.2–1.6), so the top-colour demotion above does not apply either — the jaws win plainly.
    const badge = badgeJob();
    const job: EngraveJob = {
      ...badge,
      stock: { ...badge.stock, colour: { kind: 'printed', capMm: 1.4, layerHeight: 0.2, firstLayerHeight: 0.2 } },
      keepOuts: [],
    };
    expect(splitDepthOf(job)).toBeCloseTo(1.4, 9);
    const rec = recommendLabelDepth(job, nearJaw(), inputsFor(job, nearJaw()))!;
    expect(rec.depth).toBe(0.905);
    expect(rec.depthIntent).toBeUndefined();
    expect(rec.basis[0]).toContain('above the jaw tops');
    expect(rec.basis[1]).toContain('the colour split is 1.4 mm under the face');
    expect(rec.basis[1]).toContain('not binding');
  });

  it('binds a line to the voids ITS OWN extent reaches, and names the one that binds (#365)', () => {
    // The pocket's own arithmetic is what it always was: 3.81 − 2.3 = 1.51 mm of membrane, less the
    // 1 mm structural floor a blank with no stated print keeps over it → 0.51. What #365 changed is
    // WHO is charged for it: a line is bound by the voids its own ink box reaches, and by nothing
    // else on the blank.
    const job = badgeJob();
    const measure = labelGlyphMeasure([]);
    const over = label({ position: { x: 19.05, y: 38.1 } }); // the pocket's own centre
    const bound = voidLimitForItem(job, over, undefined, measure)!;
    expect(bound.name).toBe('Magnet pocket');
    expect(bound.limit).toBe(0.5100000000000002);
    const rec = recommendLabelDepth(job, over, inputsFor(job, over, { voidLimit: bound }))!;
    expect(rec.depth).toBe(0.51);
    expect(rec.basis[0]).toBe('"Magnet pocket" leaves 0.51 mm of material');

    // The line the badge route seeds: 'Name' at 8 mm, turned with the blank so it reads along Y —
    // (31.325, 38.1) at 90° (#383). Its ink box comes ~1.7 mm clear of the pocket's x band
    // (12.55–25.55), so it reaches NO void, and since #369 it is clear of the JAWS too — the
    // MEASURED box is 28.2857 mm long, so turned it stops ~2.7 mm short of the moving jaw face,
    // past the 1 mm reach the jaws are judged by (`uncertainty + radius`, 0.5 mm of band and a 1 mm
    // cutter, #391/#394). With no item limit binding, #440 makes the answer the label's OWN depth,
    // not the blank's 2.81 mm ceiling: this fixture's label carries the demo 'CASE' line's 2 mm, and
    // the ceiling merely bounds it. The basis says both, and the jaws set no limit rather than
    // staying silent about them.
    const beside = label({ text: 'Name', size: 8, position: { x: 31.325, y: 38.1 }, rotation: 90 });
    expect(voidLimitForItem(job, beside, undefined, measure)).toBeNull();
    const besideRec = recommendLabelDepth(job, beside, inputsFor(job, beside))!;
    expect(besideRec.depth).toBe(2);
    expect(besideRec.basis[0]).toBe(
      "the blank's 1 mm minimum floor allows 2.81 mm, and the label's own 2 mm depth is within it",
    );
    expect(besideRec.basis[1]).toContain('clear of both jaws by at least 2.729 mm; the jaws set no limit here');

    // A blank with nothing declared under it has no void floor to keep, and a void that does not cut
    // cannot bind anything either.
    expect(voidLimitForItem({ ...job, keepOuts: [] }, over)).toBeNull();
    expect(
      voidLimitForItem({ ...job, keepOuts: job.keepOuts!.map((k) => ({ ...k, enabled: false })) }, over),
    ).toBeNull();
  });

  it('measures the line with the face where it can, and says so in the basis where it cannot (#365)', () => {
    const job = badgeJob();
    const over = label({ position: { x: 19.05, y: 38.1 } });
    // No measure injected is the hand-off's own case: `inkBoxOf`'s documented upper-bound estimate,
    // and the answer carries that fact so the clause does not read as a measurement nobody made.
    // The estimate is the TIMID box, so a number worked out with it can only move deeper later.
    const estimated = voidLimitForItem(job, over)!;
    expect(estimated.estimated).toBe(true);
    expect(recommendLabelDepth(job, over, inputsFor(job, over, { voidLimit: estimated }))!.basis[0]).toContain(
      'its face is not parsed yet',
    );

    // The app's own measure — the one the seed, the walk and the panel all use — answers with the
    // real glyphs, and the sentence about the estimate is gone.
    const measured = voidLimitForItem(job, over, undefined, labelGlyphMeasure([]))!;
    expect(measured.estimated).toBe(false);
    expect(measured.name).toBe('Magnet pocket');
    expect(recommendLabelDepth(job, over, inputsFor(job, over, { voidLimit: measured }))!.basis[0]).toBe(
      '"Magnet pocket" leaves 0.51 mm of material',
    );
  });

  it('reads every void kind in the void’s OWN frame, rotation included (#365 decision 1)', () => {
    const job = badgeJob();
    const measure = labelGlyphMeasure([]); // the app's own adapter, so the box is the real ink
    // The seeded 'Name' line at 8 mm, centred on the pocket — the turned blank's centre (#383),
    // widened into a box by that face.
    const line = label({ text: 'Name', size: 8, position: { x: 19.05, y: 38.1 } });
    // Four voids, four kinds, each one reaching that line: a rect's face, a circle's disc, a slot
    // lying ACROSS the line (its rotated frame, not the blank's) and a ring whose bounding box the
    // line crosses.
    const reaching: EngraveKeepOut[] = [
      { id: 'r', name: 'R', kind: 'rect', position: { x: 19.05, y: 38.1 }, rotation: 0, enabled: true, zCeiling: 2.3, width: 20, height: 6, cornerRadius: 0 },
      { id: 'c', name: 'C', kind: 'circle', position: { x: 19.05, y: 38.1 }, rotation: 0, enabled: true, zCeiling: 2.3, diameter: 6 },
      { id: 's', name: 'S', kind: 'slot', position: { x: 19.05, y: 38.1 }, rotation: 90, enabled: true, zCeiling: 2.3, length: 12, width: 4 },
      { id: 'p', name: 'P', kind: 'polygon', position: { x: 19.05, y: 38.1 }, rotation: 30, enabled: true, zCeiling: 2.3, points: [[-6, -2], [6, -2], [6, 2], [-6, 2]] },
    ];
    for (const ko of reaching) {
      expect(voidLimitForItem({ ...job, keepOuts: [ko] }, line, undefined, measure)?.name, ko.kind).toBe(ko.name);
    }
    // The same four, moved clear of the line's box: none of them binds it. (Their CENTRES stay in
    // the line's x range — x = 10 against 4.91–33.19 — so a check that reached for the wrong axis
    // would fail here.)
    for (const ko of reaching) {
      expect(
        voidLimitForItem({ ...job, keepOuts: [{ ...ko, position: { x: 10, y: 8 } }] }, line, undefined, measure),
        ko.kind,
      ).toBeNull();
    }

    // Rotation is the LINE's extent turning, read in the void's frame: the pocket is 13 mm across X
    // and 45 mm along Y (a 12.55–25.55 x band, 15.6–60.6 in y). This line clears the pocket's y
    // band upright at (19.05, 68) — its ink half-height is 4.05 — even though its 28.29 mm width
    // spans the x band; turned 90° about the same centre the half-LENGTH faces the pocket in Y and
    // reaches it.
    const upright = label({ text: 'Name', size: 8, position: { x: 19.05, y: 68 }, rotation: 0 });
    expect(voidLimitForItem(job, upright, undefined, measure)).toBeNull();
    expect(voidLimitForItem(job, { ...upright, rotation: 90 }, undefined, measure)?.name).toBe('Magnet pocket');
  });

  it('takes the JAWs when they are the tightest floor, and asks for no intent there', () => {
    const job = badgeJob({ keepOuts: [] });
    // 1.905 mm proud less the job's own 1 mm clearance. The blank's underside (3.81 − 1 = 2.81)
    // is nowhere near binding: this is the jaw check's own budget, said before the wizard opens.
    // `stockProud < deepest + jawClearance` is strict, so a floor landing exactly on it is inside.
    const rec = recommendLabelDepth(job, nearJaw(), inputsFor(job, nearJaw()))!;
    expect(rec.depth).toBe(0.905);
    expect(1.905 < rec.depth + job.jawClearance).toBe(false);
    // NOT a reveal: there is no split on this blank, and stamping one would make the item fail the
    // bound of an intent nobody stated.
    expect(rec.depthIntent).toBeUndefined();
    expect(rec.basis[0]).toContain('stands 1.905 mm above the jaw tops');
    // #345's rule: the recommendation may be STRICTER than the setting. A domed blank keeps its
    // 0.5 mm boundary margin over the jaws, not the house 1 mm... which is the looser of the two.
    const loose = badgeJob({ keepOuts: [], jawClearance: 0.1 });
    expect(
      recommendLabelDepth(loose, nearJaw(), inputsFor(loose, nearJaw(), { boundaryMargin: 0.5 }))!.depth,
    ).toBe(1.405);
  });

  it('says nothing about an item that has stated its own intent, or cut nothing at all', () => {
    const job = badgeJob();
    // Since #365 the void bound is the LINE's own, so this one is placed over the pocket for the
    // limit to be in play at all — the 'CASE' line itself sits at (50, 43), clear of it.
    const inputs = inputsFor(job, label(), {
      voidLimit: voidLimitForItem(job, label({ position: { x: 19.05, y: 38.1 } })),
    });
    expect(recommendLabelDepth(job, label({ depthIntent: 'surface' }), inputs)).toBeNull();
    expect(recommendLabelDepth(job, label({ depthIntent: 'custom' }), inputs)).toBeNull();
    expect(recommendLabelDepth(job, label({ construction: true }), inputs)).toBeNull();
    // …and a blank with no room for any cut gives NO depth rather than a made-up one: the jaw
    // check goes on saying what is wrong with the setup, which is a thing to fix, not to cut.
    const tight = badgeJob({ keepOuts: [], jawClearance: 3 });
    expect(recommendLabelDepth(tight, nearJaw(), inputsFor(tight, nearJaw()))).toBeNull();
  });

  it('bounds the label’s own depth by the blank’s underside — never answers with the ceiling (#440)', () => {
    // A 12 mm blank that must keep 10 mm leaves a 2 mm ceiling. With no split, void or jaw binding,
    // the answer is the depth the label ITSELF asks for; the underside only lowers it when that
    // asks for more than the blank can keep under the floor. Before #440 the ceiling was the
    // answer here, and `redepthLabelsForBlank` wrote it onto every unclaimed label.
    const job: EngraveJob = { ...defaultEngraveJob(), minFloor: 10, keepOuts: [] };
    // The demo plank's jaws reach its lines (the 100 × 60 acceptance job is re-depthed to 3 / 3 / 3
    // by that bound), so these cases state a line clear of them: this is about the underside being
    // a cap, not about the jaw rule.
    const clear = (line: EngraveLabel) =>
      inputsFor(job, line, { jawReach: { jaw: 'fixed', gap: 20, reaches: false, overJaw: false } });

    // The fixture's own 2 mm is within the ceiling, so it stands — not the 2 mm ceiling by
    // coincidence, but because the label asked for it.
    const within = recommendLabelDepth(job, label(), clear(label()))!;
    expect(within.depth).toBe(2);
    expect(within.basis[0]).toBe(
      "the blank's 10 mm minimum floor allows 2 mm, and the label's own 2 mm depth is within it",
    );

    // A shallower design stands too, untouched: the blank does not talk a label into a deeper cut.
    const shallow = label({ depth: 1.5 });
    expect(recommendLabelDepth(job, shallow, clear(shallow))!.depth).toBe(1.5);

    // Deeper than the ceiling: the ceiling BOUNDS the design rather than replacing it, and the
    // clause says which is which.
    const deep = label({ depth: 2.5 });
    const capped = recommendLabelDepth(job, deep, clear(deep))!;
    expect(capped.depth).toBe(2);
    expect(capped.basis[0]).toBe(
      "the blank's 10 mm minimum floor allows 2 mm, but the label's own 2.5 mm depth asks for more — " +
        "the floor stops at the blank's limit",
    );

    // The issue's own example, inverted: a 60 mm blank with nothing else constraining it used to
    // recommend 59 mm. It now recommends what the design asks for.
    const thick: EngraveJob = {
      ...defaultEngraveJob(),
      stock: { ...defaultEngraveJob().stock, thickness: 60 },
      keepOuts: [],
    };
    const face = label({ text: 'Face', depth: 0.5 });
    const faceClear = inputsFor(thick, face, {
      jawReach: { jaw: 'fixed', gap: 20, reaches: false, overJaw: false },
    });
    expect(recommendLabelDepth(thick, face, faceClear)!.depth).toBe(0.5);
  });

  it('revises its OWN past intent, and declines every other stated one (#362 review)', () => {
    // The recommendation stamps `'reveal'` on a two-colour blank, and the guard that declines a
    // stated intent would then lock the label out of every later re-depth — a label frozen to the
    // blank it was first measured against. `inputs.intent` is the way out: `'computed'` says the
    // intent is OURS, so it may be rewritten. Everything else — `'user'`, `'catalogue'`,
    // `'measured'` — is a person's statement, and so is a stated intent with NO provenance at all,
    // which is every document written by hand (#362: an absent key means "still the shipped
    // default", and a default intent is not the app's to overwrite).
    const job = badgeJob();
    // Since #365 the void bound is the LINE's own, so this one is placed over the pocket for the
    // limit to be in play at all — the 'CASE' line itself sits at (50, 43), clear of it.
    const inputs = inputsFor(job, label(), {
      voidLimit: voidLimitForItem(job, label({ position: { x: 19.05, y: 38.1 } })),
    });
    const stated = label({ depthIntent: 'surface' });
    expect(recommendLabelDepth(job, stated, inputs)).toBeNull();
    expect(recommendLabelDepth(job, stated, { ...inputs, intent: 'computed' })).not.toBeNull();
    expect(recommendLabelDepth(job, stated, { ...inputs, intent: 'computed' })!.depth).toBe(0.51);
    for (const intent of ['user', 'catalogue', 'measured'] as const) {
      expect(recommendLabelDepth(job, stated, { ...inputs, intent })).toBeNull();
    }
    // A construction label cuts nothing, so no intent and no provenance can conjure a depth for it.
    expect(
      recommendLabelDepth(job, label({ construction: true, depthIntent: 'surface' }), {
        ...inputs,
        intent: 'computed',
      }),
    ).toBeNull();
  });

  // #369 — the jaw bound is XY-aware, exactly as #365 made the void bound: a jaw limits only the
  // lines whose own ink box comes within its reach (the vise's uncertainty and the cutter's radius,
  // #394), and a line clear of both jaws is bound by something else — or nothing.
  it('charges a jaw only to the lines it can reach, and names the jaw that binds (#369)', () => {
    const job = badgeJob({ keepOuts: [] });
    // The blank is TURNED for the vise (#383), so its jaws face each other 38.1 mm apart in X and
    // span the whole 76.2 mm of Y. A 'Name' line 8 mm tall MEASURES 28.2857 mm wide (#394), so
    // centred on the blank (x = 19.05) it stops 4.907 mm short of either jaw face — past the 1.0 mm
    // reach the shipped vise's own 0.5 mm uncertainty (calipered 2026-10-13/15, #208) plus the
    // cutter's 0.5 mm radius opens up. Clear: no jaw bound.
    const centred = label({ text: 'Name', size: 8, position: { x: 19.05, y: 6.775 } });
    const clear = labelJawReach(job, centred);
    expect(clear.jaw).toBe('fixed');
    expect(clear.gap).toBeCloseTo(4.907, 3);
    expect(clear.reaches).toBe(false);
    const clearRec = recommendLabelDepth(job, centred, inputsFor(job, centred))!;
    // #440 — the line's own depth (the demo 'CASE' 2 mm), not the blank's 2.81 mm ceiling. The
    // ceiling is the upper bound the basis quotes, not the answer.
    expect(clearRec.depth).toBe(2);
    expect(clearRec.basis[0]).toContain("the label's own 2 mm depth is within it");
    // The jaws are still SAID, in the not-binding tail the panel row does not print: a clause that
    // named the floor and stayed silent about the jaws would read as if none had been considered.
    expect(clearRec.basis[1]).toBe('clear of both jaws by at least 4.907 mm; the jaws set no limit here');

    // …and the issue's own example, the same line 2 mm off the fixed jaw, is CLEAR now: the reach is
    // 0.5 + 0.5 = 1.0 mm, so 2 mm is twice it. Pinned because it moved with the caliper, not with
    // any change to this rule.
    expect(labelJawReach(job, label({ text: 'Name', size: 8, position: { x: 16.1429, y: 6.775 } })).reaches).toBe(
      false,
    );

    // The same line moved until its measured box comes 0.75 mm off the fixed jaw — inside the reach,
    // outside the radius alone. Its half-width is 14.1429 mm, so x = 14.8929 puts the left face at
    // 0.7500 mm. Now the jaw bound is the shallowest floor, and the clause says which jaw and why.
    const nearFixed = label({ text: 'Name', size: 8, position: { x: 14.8929, y: 6.775 } });
    const at = labelJawReach(job, nearFixed);
    expect(at.jaw).toBe('fixed');
    expect(at.gap).toBeCloseTo(0.75, 3);
    expect(at.reaches).toBe(true);
    expect(at.overJaw).toBe(false);
    const rec = recommendLabelDepth(job, nearFixed, inputsFor(job, nearFixed))!;
    expect(rec.depth).toBe(0.905);
    expect(rec.basis[0]).toContain('within 0.75 mm of the fixed jaw');
    expect(rec.basis[0]).toContain('stands 1.905 mm above the jaw tops');
    // …and it is the jaws, not the blank's underside, that bind: the not-binding tail says so.
    expect(rec.basis[1]).toContain('not binding');

    // A line wide enough to hang past BOTH jaw faces reaches both, and the tie goes to the fixed one
    // — the first the envelope declares — so the clause names one jaw rather than flickering between
    // two. 'CASE' at 30 mm measures 99.171 mm, wider than the turned blank is long (38.1 mm in X),
    // and centred at x = 19.05 it pokes out of each end; a line whose box overlaps a jaw is 0 mm
    // from it, not a negative gap.
    expect(labelJawReach(job, label({ size: 30, position: { x: 19.05, y: 43 } }))).toMatchObject({
      jaw: 'fixed',
      gap: 0,
      reaches: true,
    });

    // Rotation turns the line's extent about its centre, read in the jaws' own frame: a line 8 mm
    // tall and 28.2857 mm wide faces the fixed jaw with its 4.046 mm half-HEIGHT once turned 90°, so
    // at x = 19.05 it comes 15.004 mm clear of either jaw — three times the 4.907 mm its 14.1429 mm
    // half-WIDTH leaves upright — and the projection is what answers that.
    const turned = label({ text: 'Name', size: 8, position: { x: 19.05, y: 6.775 }, rotation: 90 });
    expect(labelJawReach(job, turned).gap).toBeCloseTo(15.004, 3);
  });

  it('hands the seeded badge line over clean through the real generate path (#369)', () => {
    // What `takeBadgeBlank` leaves behind for the badge the template makes (#363, #369): one 'Name'
    // line, 8 mm tall, running along Y on the TURNED blank (#383) — (31.325, 38.1) at 90°, the
    // badge's own 6.775 mm front-edge inset now measured from the moving jaw — re-depth-ed by the
    // walk to the blank's own 1.0 mm reveal (`engraveJob.spec.ts` pins the store's own answer).
    // This runs that job through the real pipeline, which is where the operator would have met any
    // finding the hand-off left on it — and the walk's 1.0 mm is DEEPER than the 0.905 the jaws allow
    // a line beside them, so a blank-wide jaw check would refuse the job the wizard just built.
    const blank = badgeBlankFor(defaultBadgeParams());
    const base = defaultEngraveJob();
    const job: EngraveJob = {
      ...base,
      stock: blank.stock,
      workholding: { kind: 'vise', vise: viseForNewJob(undefined, blank.stock) },
      keepOuts: blank.pocket ? [blank.pocket] : [],
      labels: [
        {
          ...(base.labels[0] as EngraveLabel),
          text: 'Name',
          size: 8,
          position: { x: 31.325, y: 38.1 },
          rotation: 90,
          depth: 1.0,
          depthIntent: 'reveal',
        },
      ],
    };
    const gen = generate(tl, job);
    const found = gen.findings;
    expect(found.filter((f) => f.severity === 'error')).toEqual([]);
    expect(found.map((f) => f.code)).not.toContain('item-depth-bound');
    expect(found.map((f) => f.code)).not.toContain('vise-jaw-collision');

    // The fixture check lives in the SWEEP, not in `generate` (#369 follow-up): `engraveGenerate`
    // returns the program but never builds a timeline, so `tool-into-fixture` has no way to fire
    // above — the run above is clean whatever the cutter would have hit. So the assembled job is
    // swept too, over the app's OWN assembly: `toSetup` carries the very `viseEnvelope` the run
    // sheet and the preview describe, where a hand-built fixture could pass against an envelope the
    // app never uses.
    //
    // WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves the seeded line, cut where the walk put it,
    // gouges nothing — the hand-off is clean end to end, which is the operator's question. It does
    // NOT show the jaw bound was consulted, and it cannot: this line is bound by the blank's colour
    // split exactly BECAUSE it stands clear of both jaws, so a sweep that never read the jaw bound
    // passes this assertion exactly as it passes below. The bound itself is pinned by the reach and
    // sentence assertions above; this is the other half — the part only a sweep can state.
    expect(gen.nc).not.toBeNull();
    const cutter = jobTool(job);
    // A null here would mean the sweep never ran, which is the vacuous pass this whole block
    // exists to prevent — the job names a built-in cutter, so it cannot be null in this fixture.
    if (cutter === null) throw new Error('the seeded job names a cutter the registry does not hold');
    const setup = toSetup(job, Z1);
    const out = sweepTimeline(tl, buildTimeline(parseGcode(gen.nc as string), setup, Z1), cutter, setup, {
      machine: Z1,
    });
    if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
    expect(out.value.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    // Named separately from the severity check so a reader can see the collision codes were looked
    // for on purpose: the cutter, the collet nut, a feed and a rapid all have their own.
    expect(out.value.diagnostics.map((d) => d.code).filter((c) => c.endsWith('into-fixture'))).toEqual([]);
  });
});
