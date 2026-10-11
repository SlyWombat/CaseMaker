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
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  boundLimit,
  boundsFor,
  checkBounds,
  DEFAULT_BOUNDARY_MARGIN_MM,
  defaultBoundaryMargin,
  effectiveMargins,
  MARGIN_DEFAULTS,
  marginSourceWords,
  MEASURED_THICKNESS_TOLERANCE_MM,
  recommendMargins,
  splitBound,
  undersideBound,
  voidBound,
  voidFloor,
  type MarginSettings,
} from '@/engine/cnc/engrave/depthBounds';
import { buildRunSheet, type RunSheetGenerated } from '@/engine/cnc/engrave/runSheet';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { viseForNewJob } from '@/engine/cnc/fixture';
import { WIRED_PROBE_Z_RESIDUAL_MM } from '@/engine/cnc/probePlan';
import { defaultBadgeParams } from '@/types/badge';
import type { EngraveJob, EngraveKeepOut, EngraveLabel } from '@/types/engraveJob';

/** A printed blank's facts, as a job carries them (#285/#345): no wasm, so the numbers are exact. */
function printedJob(print: EngraveJob['stock']['print'], flatness?: EngraveJob['stock']['flatness']): EngraveJob {
  return { ...defaultEngraveJob(), stock: { ...defaultEngraveJob().stock, print, flatness } };
}

const PRINT_0_2 = { split: 3.0, layerHeight: 0.2, firstLayerHeight: 0.2 };

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

  it('names a void’s ceiling as a clause, and one bound’s floor is the verifier’s limit', () => {
    expect(voidBound('Magnet pocket', 1.51).name).toBe("the magnet pocket's ceiling");
    expect(voidBound('', 1.51).name).toBe("the void's ceiling");
    // `min over 'above' bounds of (at − margin)`, clamped at 0 — the number a `DepthLimit` field is.
    expect(boundLimit([voidBound('p', 1.51), undersideBound(defaultEngraveJob())], 0.2)).toBeCloseTo(1.31, 9);
    expect(boundLimit([undersideBound(defaultEngraveJob())], 0.2)).toBeCloseTo(11, 9);
    // A `below` bound is never a limit: a reveal is supposed to cross it.
    expect(boundLimit([splitBound('reveal', 0.8)!], 0.2)).toBeNull();
    // A plane nearer the face than the margin leaves nothing to cut, not a negative depth.
    expect(voidFloor(0.1, 0.2)).toBe(0);
  });

  it('gives every item the split, the void under it and the underside, in that order', () => {
    const job = defaultEngraveJob();
    const label = { ...job.labels[0]!, depthIntent: 'surface' as const };
    const planes = { split: 0.8, overVoid: { name: 'Magnet pocket', breach: 1.4 } };
    expect(boundsFor(job, label, planes).map((b) => b.source)).toEqual(['split', 'void', 'underside']);
    // The underside is carried for the model's sake, and `depth-exceeds-stock` is its owner.
    expect(boundsFor(job, label, { split: null }).map((b) => b.source)).toEqual(['underside']);
  });
});

describe('the house margins and the job’s own (#345)', () => {
  it('seeds a new job’s three per-job fields from the settings, and leaves `margins` absent', () => {
    const margins: MarginSettings = { boundaryMargin: 0.3, zTolerance: 0.1, minFloor: 2, edgeMargin: 3, breakthrough: 0.5, source: 'user' };
    const job = defaultEngraveJob(undefined, margins);
    expect(job.minFloor).toBe(2);
    expect(job.edgeMargin).toBe(3);
    expect(job.breakthrough).toBe(0.5);
    // ABSENCE IS THE SWITCH: the job follows the house setting until someone overrides it, so no
    // stored document needs migrating and every `.nc` keeps the numbers it was cut with.
    expect(job.margins).toBeUndefined();
    // The shipped set is what these fields used to be hard-coded to, so a fresh install is unchanged.
    expect(defaultEngraveJob()).toMatchObject({ minFloor: 1.0, edgeMargin: 1.0, breakthrough: 0.3 });
  });

  it('defaults the boundary margin to one printed layer, or the common 0.2 without a print', () => {
    expect(DEFAULT_BOUNDARY_MARGIN_MM).toBe(0.2);
    expect(defaultBoundaryMargin(printedJob(PRINT_0_2))).toBe(0.2);
    expect(defaultBoundaryMargin(printedJob({ split: 3, layerHeight: 0.3 }))).toBe(0.3);
    expect(defaultBoundaryMargin(defaultEngraveJob())).toBe(0.2);
  });

  it('resolves a job with no margins from the settings, reading the blank’s own layers', () => {
    const printed = printedJob({ split: 3, layerHeight: 0.3 });
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
    expect(recommendMargins(printedJob(PRINT_0_2), { boundaryMargin: 0.5 }).boundaryMargin).toBe(0.5);
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
    expect(step.value).toBe('0.2 mm boundary margin · the house default');
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
    expect(step.text).toContain('domed 0.33 mm across its width');
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

  it('leaving the margins out resolves to the same sheet as posting them', () => {
    const job = voidJob();
    const resolved = effectiveMargins(job, MARGIN_DEFAULTS);
    // The panel passes the resolved value (#345); this is the proof that its absence is the same
    // thing, so a caller that does not pass one is not printing a different number.
    expect(buildRunSheet(job, NO_GENERATED, null, NOW, resolved)).toEqual(buildRunSheet(job, NO_GENERATED, null, NOW));
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

  it('moves the verdict on a job that HAS one — which is the only place this issue changes a file', () => {
    // The raw limit is the void's breach; the margin comes off it. So a 1.9 mm cut is refused at
    // the shipped 0.2 mm and permitted at 0.05, and the user has to regenerate to see it.
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
    const job: EngraveJob = {
      ...base,
      labels: [{ ...label, text: 'CASE', size: 10, depth: 1.9, position: { x: 50, y: 30 } }],
      keepOuts: [pocket],
    };
    // 12 mm blank, ceiling at 10: 2 mm of membrane. 2 − 0.2 = 1.8, so 1.9 is out.
    expect(generate(tl, job).verify!.findings.some((f) => f.code === 'cut-too-deep')).toBe(true);
    // 2 − 0.05 = 1.95, so the same cut is in.
    const loose = generate(tl, job, null, [], { boundaryMargin: 0.05, zTolerance: 0.05, source: 'user' });
    expect(loose.verify!.findings.some((f) => f.code === 'cut-too-deep')).toBe(false);
  });
});
