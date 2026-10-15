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

/** One edge's own band and local drop — the per-edge half of the shape (#391 item 4). */
function edgeOf(plan: MaterialScanPlan, edge: string): MaterialScanPlan['edges'][number] {
  const scan = plan.edges.find((e) => e.edge === edge);
  if (!scan) throw new Error(`no ${edge} edge in the plan`);
  return scan;
}

describe('planMaterialScan — the shipped default blank (#391)', () => {
  // The default job is 100 × 60 × 12 with the shipped vise: 4 mm proud (its half-thickness rule),
  // jaws 10 mm across ±0.5 and 100 mm long — the calipered product set (#208, 2026-10-13/15) —
  // starting 10 mm ahead of the blank's front edge.
  //
  // Every offset below is written out from the TIP's own radius, which A8 measured at 1.0 mm
  // (#208, 2026-10-15: a plain cylinder 2.0 mm across, no ball): the coarse step is 2 mm, so the
  // four touches sit 3.0 / 1.0 inside and 0.7 / 3.0 outside, and the corner sample is the middle of
  // the 0.312 mm band rather than the 0.9 a 3 mm tip's band put it at.
  const plan = () => planned(defaultEngraveJob());

  it('reads its bands from the job: the blank’s dome, and the height it stands proud', () => {
    const p = plan();
    // The job's own figure for the span it names — 0.33 mm of dome (the badge figure, used because
    // the job states none) plus the dial's 0.05 — and the height it stands proud, less the dial.
    expect(p.bands.blankMm).toBeCloseTo(0.38, 6);
    expect(p.bands.belowMm).toBeCloseTo(3.95, 6);
    // The reference is the blank's top face, at the middle: the touch everything is read against.
    expect(p.reference.at).toEqual([50, 30]);
    expect(p.reference.expect).toBe('blank');
    expect(p.tipRadiusMm).toBe(1);
  });

  // #391 review item 4 — the dome is a SHAPE. One figure for the middle is not the top at the edges,
  // and a plan that judged all four by it would swallow most of a real change at the ends.
  it('judges each edge against the top where THAT edge is, not one figure for the blank', () => {
    const p = plan();
    // The stated dome is taken across the span it names (the job's X, where the left and right edges
    // are); the other span carries the badge's measured 0.1 mm. Each edge's band is its own top plus
    // the same dial, so the SIDES are allowed 0.38 mm and the ENDS 0.15 mm — not 0.38 everywhere.
    expect(p.edges.map((e) => e.edge)).toEqual(['left', 'right', 'front', 'back']);
    for (const side of ['left', 'right'] as const) {
      expect(edgeOf(p, side).dropMm).toBeCloseTo(0.33, 6);
      expect(edgeOf(p, side).bands.blankMm).toBeCloseTo(0.38, 6);
    }
    for (const end of ['front', 'back'] as const) {
      expect(edgeOf(p, end).dropMm).toBeCloseTo(0.1, 6);
      expect(edgeOf(p, end).bands.blankMm).toBeCloseTo(0.15, 6);
    }
    // The plan-level band is the OUTER bound, the job's own statement plus the dial — the most the
    // face varies by anywhere. It is what the job's own number is worth, and no edge uses it alone.
    expect(p.bands.blankMm).toBeCloseTo(Math.max(...p.edges.map((e) => e.bands.blankMm)), 6);
  });

  it('places the scan’s resolution where the corner contact sinks past the dial', () => {
    const p = plan();
    // sqrt(2·1·0.05 − 0.05²) — the outward distance at which the corner reading clears the DIAL
    // below the blank's own top at that edge, which is the finest this tip can place an edge. The
    // dial and the tip set it, nothing else: the dome is in the band, not in the bias (#391 item 4).
    // The 2.0 mm tip makes it 0.312 where the 3 mm stand-in gave 0.384.
    expect(p.resolutionMm).toBeCloseTo(0.312, 3);
    expect(p.missTravelMm).toBeCloseTo(4 + SCAN_MISS_MARGIN_MM, 6);
    expect(p.missTravelMm).toBeLessThan(0.5 * defaultEngraveJob().stock.thickness);
  });

  it('steps across each edge: on the blank, at the edge, past it', () => {
    const p = plan();
    const step = SCAN_COARSE_STEP_MM;
    // Two touches that should still be on the blank (clear of the edge, and close to it), one
    // aimed at the edge itself — the MIDDLE of the corner band, which is where the bias comes from —
    // and one past it. The offsets are the same on all four edges.
    for (const scan of p.edges) {
      expect(scan.touches.map((t) => t.offsetMm)).toEqual([
        -(1.0 + step),
        -1.0,
        0.7,
        1.0 + step,
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
      [3, 30],
      [1, 30],
      [-0.7, 30],
      [-3, 30],
    ]);
    expect(touchesOf(p, 'back').map((t) => t.at)).toEqual([
      [50, 57],
      [50, 59],
      [50, 60.7],
      [50, 63],
    ]);
  });

  it('predicts the blank on the inside touches, the jaw past an end, a miss past a side', () => {
    const p = plan();
    // A jaw reaches only along the blank's ENDS, so only the left and right edges have a jaw top
    // under their outward touches. Past the front and back edges at the middle of a side there is
    // the gap between the jaws: nothing at jaw height, and the cap is what stops the tip.
    expect(p.edges.map((e) => [e.edge, e.jawUnder])).toEqual([
      ['left', 'on'],
      ['right', 'on'],
      ['front', 'off'],
      ['back', 'off'],
    ]);
    expect(expectations(p, 'left')).toEqual(['-3:blank', '-1:blank', '0.7:corner', '3:below']);
    expect(expectations(p, 'front')).toEqual(['-3:blank', '-1:blank', '0.7:corner', '3:miss']);
    expect(expectations(p, 'back')).toEqual(['-3:blank', '-1:blank', '0.7:corner', '3:miss']);
  });

  // #391 review item 7 — a point the fixture's uncertainty reaches is not a point the plan gets to
  // decide: it carries BOTH readings, and a reading that matches the other one is not a fault. The
  // band is the calipered ±0.5 now (#208, 2026-10-15), and that is what sizes the strip below: it
  // must push the jaw's face further out than the outward touch (3.0 mm) by LESS than the band, or
  // the nominal jaw is still under the touch and there is no ambiguity to state.
  it('carries the other reading where the fixture’s uncertainty reaches the touch', () => {
    const job = defaultEngraveJob();
    // A 3.2 mm strip between the jaw and the blank moves the fixed jaw's FACE 3.2 mm out (#213): the
    // nominal jaw stops 0.2 mm short of the outward touch, while a jaw at the wide end of its ±0.5 mm
    // band (face at 2.7 mm) reaches under it. That is the ambiguity, stated as two readings.
    const strip = {
      ...job,
      sacrificial: {
        ...job.sacrificial,
        sides: {
          ...job.sacrificial.sides,
          left: { thickness: 3.2, height: 'flush' as const },
          right: { thickness: 3.2, height: 'flush' as const },
        },
      },
    };
    const p = planned(strip);
    const outward = touchesOf(p, 'left')[3]!;
    expect(outward.expect).toBe('miss');
    expect(outward.alsoMaybe).toBe('below');
    // The inside touches are untouched by it: the jaw is outboard of the blank's edge either way,
    // so there is nothing to be ambiguous about.
    for (const t of touchesOf(p, 'left').slice(0, 2)) {
      expect(t.expect).toBe('blank');
      expect(t.alsoMaybe).toBeUndefined();
    }
    // With no strip the same touch has one reading and no second one.
    expect(touchesOf(plan(), 'left')[3]!.alsoMaybe).toBeUndefined();
  });

  it('says which edges the jaws already reference, and that rotation is not in reach', () => {
    const p = plan();
    expect(p.notes.join(' ')).toContain('already fixes X and rotation to within ±0.5 mm');
    expect(p.notes.join(' ')).toContain('cannot find rotation');
    // Two sides have no jaw under them, and the note names them without repeating the jaw hints.
    expect(p.notes.join(' ')).toContain('the front edge and the back edge');
    expect(p.notes.join(' ')).toContain('a miss there is the expected reading, not a fault');
  });

  // #391 review item 2 — the tip is the one figure every other one is derived from, so it goes FIRST
  // in the plan's own words and the sheet prints it. It used to say AS ASSUMED, and that held until
  // 2026-10-15: A8 calipered it, so the sentence now names the reading, which probe it belongs to,
  // and what the figure costs — a derived position still states where its input came from.
  it('leads its notes with the measured tip, and names what the figure costs', () => {
    const p = plan();
    expect(p.notes[0]).toContain('The tip is 2 mm across, measured');
    expect(p.notes[0]).toContain('hollow cylinder, no ball');
    expect(p.notes[0]).toContain('#208 A8');
    expect(p.notes[0]).toContain('0.312 mm the reading stands past the edge');
    expect(p.notes[0]).toContain('a smaller tip is a sharper scan');
    // The dome's provenance is the second thing it says, because it is the second input.
    expect(p.notes[1]).toContain('The job states no dome');
  });

  it('judges the reads against the dome the job states, when it states one', () => {
    const job = defaultEngraveJob();
    const p = planned({
      ...job,
      stock: { ...job.stock, flatness: { dome: 0.05, across: 'width', source: 'measured' } },
    });
    expect(p.bands.blankMm).toBeCloseTo(0.1, 6);
    expect(p.notes.join(' ')).toContain('is the dome the job states (measured, across its width)');
    // A flatter blank moves what each edge is judged against — the left and right edges carry the
    // stated 0.05, the front and back the badge's 0.1 — and NOT the scan's bias, which is the tip
    // and the dial alone. The old plan's 0.998 → 0.539 was the dome-as-a-tolerance bug: a dome that
    // is a shape cannot also be the resolution.
    expect(edgeOf(p, 'left').bands.blankMm).toBeCloseTo(0.1, 6);
    expect(edgeOf(p, 'front').bands.blankMm).toBeCloseTo(0.15, 6);
    expect(p.resolutionMm).toBeCloseTo(planned(job).resolutionMm, 6);
  });

  // The word `across` belongs to the BADGE the flatness came from, and the badge's axis is the other
  // way round (`badgeBlankFor` sets `length: badge.width`): `'width'` is the job's X, `'length'` its
  // Y. Getting it backwards would judge every edge against the wrong span's figure.
  it('takes the stated dome across the span it names, in the JOB’s frame', () => {
    const job = defaultEngraveJob();
    const alongY = planned({
      ...job,
      stock: { ...job.stock, flatness: { dome: 0.2, across: 'length', source: 'measured' } },
    });
    expect(edgeOf(alongY, 'front').bands.blankMm).toBeCloseTo(0.25, 6);
    expect(edgeOf(alongY, 'back').bands.blankMm).toBeCloseTo(0.25, 6);
    // The X span now carries the badge's measured across-the-width figure instead.
    expect(edgeOf(alongY, 'left').bands.blankMm).toBeCloseTo(0.38, 6);
    expect(edgeOf(alongY, 'right').bands.blankMm).toBeCloseTo(0.38, 6);
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

  it('expects a MISS past the back edge — the jaws are beside the blank, not behind it', () => {
    const p = plan();
    const back = edgeOf(p, 'back');
    // The jaws are two BARS along Y, one either side of the blank in X, so past the back edge there
    // is no jaw top: those touches run to the cap instead. What makes that true is the touch's X —
    // the middle of the blank's length, 19.05 mm clear of either bar — and NOT the bar's length, so
    // the calipered 100 mm (this blank's 76.2 fits inside it) changes nothing here. The ends are the
    // other way round: the blank's left and right edges are the faces the jaws bear on, so those two
    // have a jaw top 1.2 mm below the blank.
    expect(back.jawUnder).toBe('off');
    expect(expectations(p, 'back')).toEqual(['-3:blank', '-1:blank', '0.7:corner', '3:miss']);
    expect(p.edges.filter((e) => e.jawUnder === 'on').map((e) => e.edge)).toEqual(['left', 'right']);
    expect(expectations(p, 'left')).toEqual(['-3:blank', '-1:blank', '0.7:corner', '3:below']);
  });

  it('measures the badge blank’s own shape: 0.33 across it, 0.1 along it', () => {
    const p = plan();
    // The badge blank's 38 mm side is its length in this job (§11.8 probed it along X), so the
    // 0.33 mm the maintainer measured across that side is the LEFT and RIGHT edges' drop, and the
    // 0.1 mm along the 76 mm side is the front and back's — the two figures §11.8 found, in the
    // axes the job puts them in.
    expect(edgeOf(p, 'left').dropMm).toBeCloseTo(0.33, 6);
    expect(edgeOf(p, 'front').dropMm).toBeCloseTo(0.1, 6);
    // And the bands follow the shape, not one number: 0.38 mm at the ends of the blank's width
    // against 0.15 down its length. Both are still far inside the 1.15 mm that means "off the blank".
    expect(edgeOf(p, 'left').bands.blankMm).toBeCloseTo(0.38, 6);
    expect(edgeOf(p, 'front').bands.blankMm).toBeCloseTo(0.15, 6);
    expect(edgeOf(p, 'front').bands.belowMm).toBeCloseTo(1.15, 6);
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
