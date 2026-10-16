// #410 review item 1 — the two-tool Z0 has to be ARITHMETIC OVER TWO BLANKS ON THE PAPER.
//
// The swap routine sets the second program's Z0 from `surface + (cutter PRB − reference PRB)` and
// never from a second touch-off (the surface has been cut since; re-touching it sinks every floor of
// program 2 by program 1's depth). That formula is only usable if both of its terms were written
// down when they were taken, and for a while they were not: the step named "the probe PRB" while
// nothing on the sheet had recorded any PRB, and the surface Z was a number the operator was
// expected to remember from the origin step.
//
// So this spec is about RECORDS, not prose. It asserts, through `buildRunSheet`:
//
//   * the cutter-fitting step has a `record` blank for the cutter's PRB — the reading program 1's
//     whole Z axis is built on;
//   * the origin step records the surface Z AND the PRB of the tool that made the touch, as ONE
//     blank, and calls that tool "the tool that set Z0" — because the sheet cannot know whether the
//     touch was made by the freshly calibrated cutter or by the probe;
//   * the second program's Z0 step cites both, by the place they were written rather than by section
//     number, so adding a section can never turn the citation into a lie.
//
// Sections are addressed by ID everywhere below for that last reason: with a rest section present
// the origin step is §6 and the Cut section §8, and a spec that pinned those numbers would be
// asserting the layout rather than the routine.

import { describe, it, expect } from 'vitest';

import { buildRunSheet, type RunSheet, type RunSheetGenerated, type RunSheetStep } from '@/engine/cnc/engrave/runSheet';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { RestPassFacts } from '@/engine/cnc/engrave/restPass';
import { REST_MACHINING_FALLBACK, restSeamFacts, thirdToolAdvice } from '@/engine/cnc/engrave/restSettings';
import type { EngraveJob } from '@/types/engraveJob';

const NOW = new Date('2026-10-15T00:00:00Z');

/** A job with one decent-sized item, so the origin plan has something to register. */
function job(): EngraveJob {
  const j = defaultEngraveJob();
  j.stock.material = 'pla';
  j.labels = [
    {
      id: 'title',
      text: 'TITLE',
      font: 'sans-default',
      weight: 'bold' as const,
      size: 8,
      position: { x: 30, y: 30 },
      rotation: 0,
      depth: 1,
      enabled: true,
    },
  ];
  return j;
}

/** The generated half, stubbed: the sheet only hashes the program and reads the findings. */
function generated(): RunSheetGenerated {
  return {
    findings: [],
    feeds: null,
    cam: { operations: 2, cuttingMoves: 40, estimatedSeconds: 200, passes: 1 },
    nc: 'G21 G90\nT1 M6\nM2',
    verify: null,
    frameNc: null,
  };
}

/**
 * The two-tool facts, as the route measures them. Only the fields the swap routine prints matter
 * here, and they are the pair's own: a 2 mm O-flute first, a 0.6 mm second.
 */
function facts(): RestPassFacts {
  const rough = {
    key: 'o-flute-2',
    diameter: 2,
    nc: 'single-rough.nc',
    frame: 'single-rough.frame.nc',
    moves: 1200,
    seconds: 900,
    removedVolume: 250,
    share: 0.62,
    score: 2.48,
    reason: 'A 2 mm O-flute reaches 62 % of the design.',
  };
  const rest = {
    key: 'o-flute-0.6',
    diameter: 0.6,
    nc: 'single-rest.nc',
    frame: null,
    moves: 3400,
    seconds: 1300,
    removedVolume: 99.6,
    reason: 'The 0.6 mm O-flute is the finest cutter the table has a row for in PLA.',
  };
  return {
    rough,
    rest,
    unroughed: [],
    regions: [{ name: 'TITLE', depth: 1, area: 120, cutArea: 100, clearedArea: 40 }],
    cutArea: 100,
    clearedArea: 40,
    restArea: 60,
    overlap: 0.6,
    // #436 — derived the way the route derives it, from the badge's own pair: ⌀2 mm at a 0.9 mm
    // step-over first, ⌀0.6 mm cleaning up, with the location storing 0.6 mm. A hand-written literal
    // here would be a second answer to a question `restSettings` already answers, and the specs below
    // would then be checking the copy.
    seam: restSeamFacts({
      stored: 0.6,
      source: 'chosen',
      rough: { key: 'o-flute-2', diameter: 2, stepOver: 0.9 },
      rest: { key: 'o-flute-0.6', diameter: 0.6, stepOver: 0.24 },
    }),
    thirdTool: null,
    restRemovedVolume: 99.6,
    leftover: { area: 0, byItem: [] },
  };
}

function sheet(over: Partial<RestPassFacts> = {}): RunSheet {
  return buildRunSheet(job(), generated(), null, NOW, undefined, { restPass: { ...facts(), ...over } });
}

function section(id: string, s: RunSheet = sheet()): RunSheetStep[] {
  const found = s.sections.find((x) => x.id === id);
  expect(found, `section ${id}`).toBeTruthy();
  return found!.steps;
}

/** The text of the first step whose text or record matches, or a failure naming what was looked for. */
function stepMatching(steps: RunSheetStep[], re: RegExp): RunSheetStep {
  const found = steps.find((s) => re.test(s.text) || re.test(s.record ?? ''));
  expect(found, `a step matching ${re}`).toBeTruthy();
  return found!;
}

describe('the run sheet records what the second program’s Z0 is worked out from (#410 review item 1)', () => {
  it('has a blank for the cutter’s PRB, where the cutter is fitted', () => {
    const fit = stepMatching(section('cutter'), /tool-length calibration/);
    expect(fit.record).toMatch(/PRB/);
    // Naming the reading's owner: "the cutter's PRB" is program 1's Z reference, and the step that
    // takes it is the only place it exists.
    expect(fit.record).toContain('cutter');
  });

  it('records the surface Z together with the tool that set it, in the origin step', () => {
    const origin = stepMatching(section('origin'), /Z0: the (blank|PART)'s top face/);
    expect(origin.record).toBeTruthy();
    // Both terms of the difference, on ONE blank, because they are taken in one act and are useless
    // apart: a surface Z with no tool named cannot be compared with the second cutter's PRB.
    expect(origin.record).toContain('surface');
    expect(origin.record).toContain('PRB');
    // …and the tool is named by its ROLE, never as "the probe": the sheet does not know which of the
    // two was in the spindle, and the origin may have been touched off by either.
    expect(origin.record).toContain('the tool that set Z0');
    expect(origin.record).not.toMatch(/\bprobe\b/i);
    // The printed text says so too, so an operator reading only the step knows the number has a
    // second use.
    expect(origin.text).toMatch(/the tool that made it|the PRB of the tool that set Z0/i);
  });

  it('works the second program’s Z0 out of those two records and not a second touch-off', () => {
    const swap = stepMatching(section('cut'), /^Set Z0 for the second program/);
    expect(swap.value).toContain('Z0 = surface + (cutter PRB − reference PRB)');
    expect(swap.record).toContain('Z0 for the second program');
    // The two inputs, cited by where they were written rather than by section number — a number
    // here would go stale the moment a section is added (#410 review item 1's own complaint).
    expect(swap.text).toContain('when you set the origin');
    expect(swap.text).toContain('the tool that set Z0');
    expect(swap.text).not.toMatch(/§\s*\d/);
    // And the reason it may not be re-touched, which is the whole point of the formula.
    expect(swap.text).toMatch(/NOT by touching the surface again/);
  });

  it('takes the new cutter’s own PRB as a reading, with its own blank', () => {
    const step = stepMatching(section('cut'), /Calibrate the new cutter’s length/);
    expect(step.code).toBe('M491');
    expect(step.record).toContain('new cutter’s PRB');
    // A reading OF THIS CUTTER ALONE: it is one of the two terms, not yet a Z.
    expect(step.text).toMatch(/reference reading was written down when the origin was set/);
    expect(step.record).not.toContain('Z0');
  });

  it('cites no section number anywhere in the swap routine’s citations', () => {
    // The routine's premise, asserted over the whole of the section rather than one step: section
    // numbers are assigned by position, and the rest + reachability sections both move them.
    for (const step of section('cut')) {
      expect(step.text, step.text).not.toMatch(/§\s*\d/);
    }
  });

  it('is a DIFFERENT sheet from one without a rest pass — the swap routine is the pair’s own', () => {
    const solo = buildRunSheet(job(), generated(), null, NOW, undefined, {});
    // Without a second program there is no cutter change and no second Z0, so the routine that
    // works one out — and the warning not to re-touch the surface — are not on the sheet at all.
    expect(solo.sections.some((s) => s.id === 'rest')).toBe(false);
    expect(solo.sections.length).toBe(sheet().sections.length - 1);
    expect(section('cut', solo).some((s) => /second program/.test(s.text))).toBe(false);
  });
});

/**
 * #436 — the two numbers rest machining runs on, as the SHEET states them: the seam band with its
 * provenance and what the pair's own geometry says about it, and the threshold that decides whether
 * a third cutter is worth reaching for.
 *
 * The fixture is this file's (`facts()` above) and is the badge's pair; the interesting cases here
 * are the ones where the band is NOT enough, because those are the sentences a default has to be
 * able to produce.
 */
describe('the run sheet states the rest pass’s settings and their provenance (#436)', () => {
  it('prints the band with where it came from, and the gap to what the residues need', () => {
    // A 0.1 mm band TYPED for the run — the value #436 replaced, and since the stored number is a
    // floor the only way it can reach a job now — is below the second cutter's own scallop AND below
    // the band the residue slivers need, and the sheet has to say both rather than staying quiet.
    // The width is what decides that, and the source says how it got there.
    const pair = { key: 'o-flute-2', diameter: 2, stepOver: 0.9 };
    const narrow = restSeamFacts({
      stored: 0.5,
      typed: 0.1,
      source: 'user',
      rough: pair,
      rest: { key: 'o-flute-0.6', diameter: 0.6, stepOver: 0.24 },
    });
    const seam = stepMatching(
      section('rest', sheet({ overlap: 0.1, seam: narrow })),
      /reaches 0\.1 mm back into/,
    );
    expect(seam.text).toContain('typed for this run on the command line (--overlap)');
    expect(seam.text).toContain('NARROWER than the second cutter’s own scallop');
    expect(seam.text).toContain('THIS BAND IS BELOW THAT');
    expect(seam.text).toContain('0.493 mm');
    expect(seam.value).toBe('0.1 mm overlap');
  });

  it('says when the band was raised off the stored number, and names the floor', () => {
    // #436 review item 1 — the band is not the stored number any more. An operator comparing two runs
    // has to be able to tell a wider band from a differently-chosen one.
    const rough = { key: 'o-flute-2', diameter: 2, stepOver: 0.9 };
    const rest = { key: 'o-flute-0.6', diameter: 0.6, stepOver: 0.24 };
    const raised = restSeamFacts({ stored: 0.1, source: 'chosen', rough, rest });
    const seam = stepMatching(
      section('rest', sheet({ overlap: raised.overlap, seam: raised })),
      /reaches 0\.493 mm back into/,
    );
    expect(seam.text).toContain('not the one this location stores (0.1 mm)');
    expect(seam.text).toContain('the band this job’s own two cutters need is 0.493 mm');
    expect(seam.value).toBe('0.493 mm overlap');
  });

  it('states a wide band as sufficient rather than saying nothing', () => {
    const seam = stepMatching(section('rest'), /reaches 0\.6 mm back into/);
    expect(seam.text).toContain('no ridge can survive there');
    expect(seam.text).toContain('they are cut');
    expect(seam.text).not.toContain('THIS BAND IS BELOW THAT');
  });

  it('says nothing about a third cutter when there is no remainder to judge', () => {
    expect(section('rest').some((s) => /third cutter past/.test(s.text))).toBe(false);
  });

  it('prints the remainder as a share of the design, under the threshold', () => {
    const steps = section(
      'rest',
      sheet({
        leftover: { area: 4, byItem: [{ name: 'SUBTITLE', depth: 1, area: 4 }] },
        thirdTool: thirdToolAdvice(4, 400, REST_MACHINING_FALLBACK),
      }),
    );
    const advice = stepMatching(steps, /4 mm² of the 400 mm²/);
    expect(advice.text).toContain('no third program is suggested');
    expect(advice.text).toContain('chosen rather than measured');
    expect(advice.value).toBe('1 % of the design');
  });

  it('names the suggestion in the value column when the remainder is over it', () => {
    const steps = section(
      'rest',
      sheet({
        leftover: { area: 40, byItem: [{ name: 'SUBTITLE', depth: 1, area: 40 }] },
        thirdTool: thirdToolAdvice(40, 400, REST_MACHINING_FALLBACK),
      }),
    );
    const advice = stepMatching(steps, /40 mm² of the 400 mm²/);
    expect(advice.text).toContain('a third cutter');
    expect(advice.value).toBe('10 % of the design — a third cutter is suggested');
  });
});
