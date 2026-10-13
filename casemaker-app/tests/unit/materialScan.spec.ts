// The material-position scan (#391): the positions, what each touch should find, and the cap.
//
// The physics this module is built on — a ball tip descending outside an edge meets the blank's
// CORNER until its centre is a full radius past it, then the jaw's top — is what makes a Z-only
// probe able to place an edge at all, so it is tested THROUGH the plan's own expectations rather
// than beside them: `expect` is a prediction, and these are the numbers it produces on two real
// blanks (the shipped default and the bench's committed badge blank).
//
// The bench job is read from disk rather than restated: if its geometry moves, the expectations
// below move with it and a stale test fails loudly instead of proving nothing.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planMaterialScan,
  alongWord,
  inOutWord,
  surfaceWord,
  SCAN_COARSE_STEP_MM,
  SCAN_MISS_MARGIN_MM,
  type MaterialScanPlan,
  type ScanTouch,
  type TouchSurface,
} from '@/engine/cnc/engrave/materialScan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The bench's own committed blank, as clamped on 2026-10-08 (38.1 × 76.2 × 3.81 badge stock). */
function benchJob(): EngraveJob {
  const path = join(APP, '..', 'docs', 'bench', '165-depth-ladder-row-A.job.json');
  const parsed = parseEngraveJob(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.ok) throw new Error(`${path} should parse: ${parsed.errors.join('; ')}`);
  return parsed.job;
}

/** A plan, insisting it is not a refusal — the tests below are all about what it plans. */
function planned(job: EngraveJob): MaterialScanPlan {
  const plan = planMaterialScan(job);
  if ('refuse' in plan) throw new Error(`expected a plan, got a refusal: ${plan.message}`);
  return plan;
}

/** One edge's expectations, as `offsetMm:expect` pairs — compact enough to read as a line. */
function expectations(plan: MaterialScanPlan, edge: string): string[] {
  const scan = plan.edges.find((e) => e.edge === edge);
  if (!scan) throw new Error(`no ${edge} edge in the plan`);
  return scan.touches.map((t) => `${t.offsetMm}:${t.expect}`);
}

/** The touches of one edge, for the position assertions. */
function touchesOf(plan: MaterialScanPlan, edge: string): ScanTouch[] {
  return plan.edges.find((e) => e.edge === edge)!.touches;
}

describe('planMaterialScan — the shipped default blank (#391)', () => {
  // The default job is 100 × 60 × 12 with the shipped vise: 4 mm proud, jaws 15 mm thick,
  // 80 mm long, starting 10 mm ahead of the blank's front edge.
  const plan = () => planned(defaultEngraveJob());

  it('reads its bands from the job: the blank’s dome, and the height it stands proud', () => {
    const p = plan();
    // 0.33 mm of dome (the badge figure, used because the job states none) plus the dial's 0.05.
    expect(p.bands.blankMm).toBeCloseTo(0.38, 6);
    expect(p.bands.belowMm).toBeCloseTo(3.95, 6);
    // The reference is the blank's top face, at the middle: the touch everything is read against.
    expect(p.reference.at).toEqual([50, 30]);
    expect(p.reference.expect).toBe('blank');
    expect(p.tipRadiusMm).toBe(1.5);
  });

  it('places the scan’s resolution where the corner contact sinks past the dome', () => {
    const p = plan();
    // sqrt(2·1.5·0.38 − 0.38²) — the outward distance at which the corner reading reaches the
    // dome's own depth, which is the finest this tip can place an edge on this blank.
    expect(p.resolutionMm).toBeCloseTo(0.998, 3);
    expect(p.missTravelMm).toBeCloseTo(4 + SCAN_MISS_MARGIN_MM, 6);
    expect(p.missTravelMm).toBeLessThan(0.5 * defaultEngraveJob().stock.thickness);
  });

  it('steps across each edge: on the blank, at the edge, past it', () => {
    const p = plan();
    const step = SCAN_COARSE_STEP_MM;
    // Two touches that should still be on the blank (clear of the edge, and close to it), one
    // aimed at the edge itself, one past it. The offsets are the same on all four edges.
    for (const scan of p.edges) {
      expect(scan.touches.map((t) => t.offsetMm)).toEqual([
        -(1.5 + step),
        -1.5,
        1.2,
        1.5 + step,
      ]);
    }
    // Left and right step in X along the jaws; front and back step in Y away from the operator.
    expect(p.edges.map((e) => [e.edge, e.axis, e.dir, e.nominalMm, e.alongMm])).toEqual([
      ['left', 'x', -1, 0, 30],
      ['right', 'x', 1, 100, 30],
      ['front', 'y', -1, 0, 50],
      ['back', 'y', 1, 60, 50],
    ]);
    // The touches are positions in the WORK frame, so the left edge's outward touch is at negative
    // X — over the fixed jaw — and the back edge's is at Y beyond the blank.
    expect(touchesOf(p, 'left').map((t) => t.at)).toEqual([
      [3.5, 30],
      [1.5, 30],
      [-1.2, 30],
      [-3.5, 30],
    ]);
    expect(touchesOf(p, 'back').map((t) => t.at)).toEqual([
      [50, 56.5],
      [50, 58.5],
      [50, 61.2],
      [50, 63.5],
    ]);
  });

  it('predicts the blank on the inside touches, the jaw past an end, a miss past a side', () => {
    const p = plan();
    // A jaw reaches only along the blank's ENDS, so only the left and right edges have a jaw top
    // under their outward touches. Past the front and back edges at the middle of a side there is
    // the gap between the jaws: nothing at jaw height, and the cap is what stops the tip.
    expect(p.edges.map((e) => [e.edge, e.jawOutboard])).toEqual([
      ['left', true],
      ['right', true],
      ['front', false],
      ['back', false],
    ]);
    expect(expectations(p, 'left')).toEqual(['-3.5:blank', '-1.5:blank', '1.2:corner', '3.5:below']);
    expect(expectations(p, 'front')).toEqual(['-3.5:blank', '-1.5:blank', '1.2:corner', '3.5:miss']);
    expect(expectations(p, 'back')).toEqual(['-3.5:blank', '-1.5:blank', '1.2:corner', '3.5:miss']);
  });

  it('says which edges the jaws already reference, and that rotation is not in reach', () => {
    const p = plan();
    expect(p.notes.join(' ')).toContain('already fixes X and rotation to within ±2 mm');
    expect(p.notes.join(' ')).toContain('cannot find rotation');
    // Two sides have no jaw under them, and the note names them without repeating the jaw hints.
    expect(p.notes.join(' ')).toContain('the front edge and the back edge');
    expect(p.notes.join(' ')).toContain('a miss there is the expected reading, not a fault');
  });

  it('judges the reads against the dome the job states, when it states one', () => {
    const job = defaultEngraveJob();
    const p = planned({
      ...job,
      stock: { ...job.stock, flatness: { dome: 0.05, across: 'width', source: 'measured' } },
    });
    expect(p.bands.blankMm).toBeCloseTo(0.1, 6);
    expect(p.resolutionMm).toBeCloseTo(0.539, 3);
    expect(p.notes.join(' ')).toContain('is the one the job states (measured, across the width)');
    // A flatter blank is a sharper scan: the same tip places the edge twice as finely.
    expect(p.resolutionMm).toBeLessThan(planned(job).resolutionMm / 1.5);
  });
});

describe('planMaterialScan — the bench’s badge blank (#391)', () => {
  const plan = () => planned(benchJob());

  it('reads the blank’s own height as the jaw depth, not the default’s 4 mm', () => {
    const p = plan();
    // The bench blank stands 1.2 mm proud, so "off the blank" starts at 1.15 mm, not 3.95.
    expect(p.bands.belowMm).toBeCloseTo(1.15, 6);
    expect(p.missTravelMm).toBeCloseTo(2.2, 6);
  });

  it('expects a MISS past the back edge — the jaw stops 6.2 mm short of it', () => {
    const p = plan();
    const back = p.edges.find((e) => e.edge === 'back')!;
    // The jaws span Y ∈ [−10, 70] and this blank is 76.2 wide, so there is no jaw top past its
    // back edge (and none past the front either, which is between the jaws): those touches run to
    // the cap instead. The ends are the other way round — the blank's left and right edges are the
    // faces the jaws bear on, so they have a jaw top 1.2 mm below the blank.
    expect(back.jawOutboard).toBe(false);
    expect(expectations(p, 'back')).toEqual(['-3.5:blank', '-1.5:blank', '1.2:corner', '3.5:miss']);
    expect(p.edges.filter((e) => e.jawOutboard).map((e) => e.edge)).toEqual(['left', 'right']);
    expect(expectations(p, 'left')).toEqual(['-3.5:blank', '-1.5:blank', '1.2:corner', '3.5:below']);
  });

  it('names the edges that run to the cap in its notes', () => {
    const p = plan();
    expect(p.notes.join(' ')).toContain('the front edge and the back edge');
    expect(p.notes.join(' ')).toContain('keeps them off the bed');
  });

  it('refuses when the job states no dome and the blank is thin', () => {
    const job = benchJob();
    // 0.15 mm proud is inside the dial's own tolerance: nothing tells the blank from the jaw.
    const plan = planMaterialScan({
      ...job,
      workholding: { kind: 'vise', vise: { ...job.workholding.vise, stockProud: 0.05 } },
    });
    expect(plan).toMatchObject({ refuse: true, code: 'not-proud-enough' });
    // And a dome as deep as the height it stands leaves the same nothing.
    const domed = planMaterialScan({
      ...job,
      stock: { ...job.stock, flatness: { dome: 1.2, across: 'width', source: 'badge' } },
    });
    expect(domed).toMatchObject({ refuse: true, code: 'dome-covers-the-jaw' });
  });
});

describe('the words the run sheet prints (#391)', () => {
  it('reads an offset as inside or outside the edge', () => {
    expect(inOutWord(-1.5)).toBe('1.5 mm inside');
    expect(inOutWord(1.2)).toBe('1.2 mm outside');
  });

  it('names where a touch sits along the edge', () => {
    expect(alongWord('left')).toBe('the middle of the blank’s width');
    expect(alongWord('back')).toBe('the middle of the blank’s length');
  });

  it('says what each reading means, misses included', () => {
    const words: TouchSurface[] = ['blank', 'corner', 'below', 'miss'];
    for (const w of words) expect(surfaceWord(w).length).toBeGreaterThan(10);
    expect(surfaceWord('miss')).toContain('travel cap');
    expect(surfaceWord('corner')).toContain('edge');
  });
});
