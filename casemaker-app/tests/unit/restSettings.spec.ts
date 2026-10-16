/**
 * #436 — the two numbers rest machining runs on, their provenance, and what a job's own geometry
 * says about them.
 *
 * The point of every case here is the same one: a number an operator reads at the machine has to
 * carry where it came from, and the seam band has to be the one THIS job's cutters need rather than
 * the one the shop happened to store. Neither number is compiled in — both live in the location
 * document's shop `defaults` — so what this file pins is (a) the pair used when there is no location
 * at all, (b) that the registry in `defaultsClient.ts` reads ITS fallback from here rather than
 * restating it, (c) the band's derivation and the floor under it, and (d) the words, because a
 * sentence that quietly stops saying where its number came from is the defect this whole module
 * exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import {
  REST_MACHINING_FALLBACK,
  REST_OVERLAP_KEY,
  REST_THIRD_TOOL_KEY,
  overlapForJob,
  restSeamFacts,
  restSeamSentence,
  restSourceWords,
  thirdToolAdvice,
  type RestSettingSource,
  type SeamCutter,
  type SeamFactsInput,
} from '@/engine/cnc/engrave/restSettings';
import { KNOWN_DEFAULTS } from '@/platform/defaultsClient';

/** The badge blank's pair: the numbers #410 measured with. */
const ROUGH: SeamCutter = { key: 'o-flute-2', diameter: 2, stepOver: 0.9 };
const REST: SeamCutter = { key: 'o-flute-0.6', diameter: 0.6, stepOver: 0.24 };

/** The badge's pair, with the location storing `stored` and nothing typed for the run. */
function badge(stored: number, source: RestSettingSource = 'chosen'): SeamFactsInput {
  return { stored, source, rough: ROUGH, rest: REST };
}

/**
 * A band TYPED for one run. Since the stored number is a floor rather than the band, this is the only
 * way a band narrower than the residues need can reach a run — which is what makes it a diagnostic.
 */
function typed(band: number, source: RestSettingSource = 'user'): SeamFactsInput {
  return { stored: REST_MACHINING_FALLBACK.overlap, typed: band, source, rough: ROUGH, rest: REST };
}

describe('the no-service fallback pair (#436)', () => {
  it('is 0.5 mm of overlap and a 2 % third-tool threshold, both labelled a fallback', () => {
    expect(REST_MACHINING_FALLBACK.overlap).toBe(0.5);
    expect(REST_MACHINING_FALLBACK.thirdToolFraction).toBe(0.02);
    expect(REST_MACHINING_FALLBACK.source).toBe('fallback');
  });

  it('is the SAME pair the defaults registry publishes — one literal, two readers', () => {
    // If these ever diverge, a web build with no service and a fresh bench would run different
    // numbers from the same source of truth, which is the failure this test exists to catch.
    expect(KNOWN_DEFAULTS[REST_OVERLAP_KEY]!.fallback).toBe(REST_MACHINING_FALLBACK.overlap);
    expect(KNOWN_DEFAULTS[REST_THIRD_TOOL_KEY]!.fallback).toBe(
      REST_MACHINING_FALLBACK.thirdToolFraction * 100,
    );
  });

  it('brackets the values a stored number is allowed to hold', () => {
    expect(KNOWN_DEFAULTS[REST_OVERLAP_KEY]!.rule.safeParse(0.5).success).toBe(true);
    expect(KNOWN_DEFAULTS[REST_OVERLAP_KEY]!.rule.safeParse(-0.1).success).toBe(false);
    expect(KNOWN_DEFAULTS[REST_THIRD_TOOL_KEY]!.rule.safeParse(2).success).toBe(true);
    expect(KNOWN_DEFAULTS[REST_THIRD_TOOL_KEY]!.rule.safeParse(0).success).toBe(false);
  });

  it('offers the same bounds to a TYPED band, so the flag cannot accept what the document refuses', () => {
    // The command line is checked against the registry's own rule, not against a second opinion
    // (#436 review): a band the document would reject must not be acceptable on the command line.
    expect(KNOWN_DEFAULTS[REST_OVERLAP_KEY]!.rule.safeParse(0.1).success).toBe(true);
    expect(KNOWN_DEFAULTS[REST_OVERLAP_KEY]!.rule.safeParse(25).success).toBe(false);
    expect(KNOWN_DEFAULTS[REST_THIRD_TOOL_KEY]!.rule.safeParse(0.05).success).toBe(false);
    expect(KNOWN_DEFAULTS[REST_THIRD_TOOL_KEY]!.rule.safeParse(50).success).toBe(true);
  });
});

describe('the band is worked out per job, floored by the shop’s own number (#436)', () => {
  it('keeps the stored 0.5 mm for the badge’s pair, which needs 0.493 — the floor is the wider one', () => {
    const choice = overlapForJob({ stored: 0.5, rough: ROUGH, rest: REST });
    expect(choice.needed).toBeCloseTo(0.4930286, 6);
    expect(choice.band).toBe(0.5);
    expect(choice.derived).toBe(false);
    expect(choice.typed).toBe(false);
  });

  it('RAISES a stored band the job’s own cutters have outgrown', () => {
    // The maintainer's rule is "~0.5 mm, worked out per job": a shop that stores 0.1 mm no longer
    // puts a too-narrow band in front of the operator — the derivation is what sets the band, and the
    // stored number is the floor it starts from.
    const choice = overlapForJob({ stored: 0.1, rough: ROUGH, rest: REST });
    expect(choice.band).toBeCloseTo(0.4930286, 6);
    expect(choice.derived).toBe(true);
    const facts = restSeamFacts(badge(0.1));
    expect(facts.derivedFromCutters).toBe(true);
    expect(facts.keepsSlivers).toBe(true);
    expect(facts.coversScallop).toBe(true);
  });

  it('raises it for a pair whose residues need more than the shop ever stored', () => {
    // ⌀3 mm at a 1.5 mm step-over leaves 0.201 mm slivers, and a ⌀1 mm rest cutter closes anything
    // under 1 mm, so this pair needs about 0.799 mm — wider than the 0.5 mm the shop holds.
    const choice = overlapForJob({
      stored: 0.5,
      rough: { key: 'o-flute-3', diameter: 3, stepOver: 1.5 },
      rest: { key: 'o-flute-1', diameter: 1, stepOver: 0.4 },
    });
    expect(choice.needed).toBeCloseTo(0.7990381, 6);
    expect(choice.band).toBeCloseTo(0.7990381, 6);
    expect(choice.derived).toBe(true);
  });

  it('cannot derive a band with no step-over for the first cutter, so the stored number stands', () => {
    const choice = overlapForJob({
      stored: 0.5,
      rough: { key: 'o-flute-2', diameter: 2, stepOver: null },
      rest: REST,
    });
    expect(choice.needed).toBeNull();
    expect(choice.band).toBe(0.5);
    expect(choice.derived).toBe(false);
  });

  it('uses a TYPED band exactly — never floored, never raised — even below what the job needs', () => {
    const choice = overlapForJob({ stored: 0.5, typed: 0.1, rough: ROUGH, rest: REST });
    expect(choice.band).toBe(0.1);
    expect(choice.typed).toBe(true);
    expect(choice.derived).toBe(false);
    // The derivation is still reported: the sheet has to be able to say what the typed band misses.
    expect(choice.needed).toBeCloseTo(0.4930286, 6);
    const facts = restSeamFacts(typed(0.1));
    expect(facts.typed).toBe(true);
    expect(facts.keepsSlivers).toBe(false);
    expect(facts.coversScallop).toBe(false);
  });

  it('uses a typed band as typed even when it is wider than everything', () => {
    expect(overlapForJob({ stored: 0.5, typed: 3, rough: ROUGH, rest: REST }).band).toBe(3);
  });
});

describe('what a job says about its own seam band (#436)', () => {
  it('derives the residue sliver and the band the closing needs from the two cutters', () => {
    const facts = restSeamFacts(badge(0.6));
    // r₁ − √(r₁² − s₁²/4) for ⌀2 mm at a 0.9 mm step-over: 0.10697 mm wide.
    expect(facts.sliver).toBeCloseTo(0.1069714, 6);
    // The closing erases anything narrower than the second cutter, so sliver + overlap ≥ 0.6 mm.
    expect(facts.needed).toBeCloseTo(0.4930286, 6);
    expect(facts.keepsSlivers).toBe(true);
    expect(facts.coversScallop).toBe(true);
  });

  it('judges the 0.5 mm the shop now seeds as sufficient for the badge pair', () => {
    const facts = restSeamFacts(badge(REST_MACHINING_FALLBACK.overlap));
    expect(facts.keepsSlivers).toBe(true); // 0.5 ≥ the 0.493 the residues need
    expect(facts.coversScallop).toBe(true); // 0.5 ≥ the second cutter's 0.24 mm scallop
  });

  it('states a band FORCED below both, rather than staying quiet about it', () => {
    // The value #436 replaced, now only reachable by typing it. The judgement has to survive it: a
    // band this narrow is still reported as too narrow, whichever source the number came from.
    const facts = restSeamFacts(typed(0.1, 'chosen'));
    expect(facts.keepsSlivers).toBe(false); // 0.1 < the 0.493 the residues need
    expect(facts.coversScallop).toBe(false); // 0.1 < the second cutter's 0.24 mm scallop
  });

  it('treats the band as covering the scallop exactly at the second cutter’s step-over', () => {
    expect(restSeamFacts(typed(0.24)).coversScallop).toBe(true);
    expect(restSeamFacts(typed(0.2399)).coversScallop).toBe(false);
  });

  it('refuses to derive a required band when the first cutter’s step-over is unknown', () => {
    const facts = restSeamFacts({
      stored: 0.6,
      source: 'chosen',
      rough: { key: 'o-flute-2', diameter: 2, stepOver: null },
      rest: REST,
    });
    // An unknown step-over is a MISSING number, not a zero one: nothing is claimed either way.
    expect(facts.needed).toBeNull();
    expect(facts.keepsSlivers).toBe(false);
  });

  it('states what it could not judge when the second cutter has no step-over row', () => {
    const facts = restSeamFacts({
      ...badge(0.6),
      rest: { key: 'o-flute-0.6', diameter: 0.6, stepOver: null },
    });
    expect(facts.coversScallop).toBe(false);
    const { text } = restSeamSentence(facts);
    expect(text).toContain('states no step-over for the second cutter');
    // …and it still judges the half it CAN: the residues are still derived.
    expect(text).toContain('keeps them cuttable');
  });
});

describe('where a number came from, in the sheet’s own words (#436)', () => {
  it('names every source, and only `user` names the flag it was typed with', () => {
    const sources: RestSettingSource[] = ['seeded', 'chosen', 'measured', 'fallback', 'user'];
    for (const source of sources) {
      const words = restSourceWords(source, '--overlap');
      expect(words.length).toBeGreaterThan(0);
      if (source === 'user') expect(words).toContain('--overlap');
      else expect(words).not.toContain('--overlap');
    }
    // The three document sources never read as each other.
    expect(restSourceWords('seeded', '--overlap')).toContain('seeded');
    expect(restSourceWords('chosen', '--overlap')).toContain('stored in this location');
    expect(restSourceWords('measured', '--overlap')).toContain('measured on this bench');
  });

  it('does not claim “no location” for a fallback the location’s own value forced', () => {
    // `readDefault` answers its fallback both when there is no location at all AND when the location
    // holds a value that fails the key's rule, so the words must be true of both — claiming "there is
    // no location to read" would be a false statement about a machine that has one (#436 review).
    const words = restSourceWords('fallback', '--overlap');
    expect(words).toContain('holds no value it could read');
    expect(words).not.toContain('no location to read');
  });

  it('carries the flag of the setting it is describing, not the other one', () => {
    expect(restSourceWords('user', '--third-tool')).toContain('--third-tool');
  });
});

describe('the seam sentence (#436)', () => {
  it('names a stored value as chosen, and the gap in millimetres', () => {
    const { text, value } = restSeamSentence(restSeamFacts(badge(0.5, 'chosen')));
    expect(text).toContain('chosen rather than measured');
    expect(text).toContain('stored in this location');
    expect(text).toContain('0.493 mm');
    expect(text).toContain('0.107 mm');
    expect(text).toContain('they are cut');
    expect(text).not.toContain('THIS BAND IS BELOW THAT');
    // 0.5 is the floor being the wider number, so nothing was raised and the sheet says nothing.
    expect(text).not.toContain('not the one this location stores');
    expect(value).toBe('0.5 mm overlap');
  });

  it('says the band was RAISED off the stored number when the cutters set it', () => {
    const { text, value } = restSeamSentence(restSeamFacts(badge(0.1, 'chosen')));
    expect(text).toContain('not the one this location stores (0.1 mm)');
    expect(text).toContain('0.493 mm');
    expect(text).toContain('they are cut');
    expect(value).toBe('0.493 mm overlap');
  });

  it('warns in the same words when the band is a narrow one, whatever its source', () => {
    const { text, value } = restSeamSentence(restSeamFacts(typed(0.1, 'chosen')));
    expect(text).toContain('NARROWER than the second cutter’s own scallop');
    expect(text).toContain('THIS BAND IS BELOW THAT');
    expect(value).toBe('0.1 mm overlap');
  });

  it('calls a typed band typed, without the stored-value wording', () => {
    const { text } = restSeamSentence(restSeamFacts(typed(0.6, 'user')));
    expect(text).toContain('typed for this run on the command line (--overlap)');
    expect(text).not.toContain('chosen rather than measured');
    expect(text).toContain('no ridge can survive there');
  });

  it('names the no-service fallback as exactly that', () => {
    const { text } = restSeamSentence(restSeamFacts(badge(0.5, 'fallback')));
    expect(text).toContain('holds no value it could read');
    expect(text).not.toContain('stored in this location');
  });
});

describe('the third-tool threshold (#436)', () => {
  it('suggests nothing when the job states no removable area to take a share of', () => {
    expect(thirdToolAdvice(5, 0, REST_MACHINING_FALLBACK)).toBeNull();
  });

  it('stays quiet under the threshold and says so, with the share it measured', () => {
    const advice = thirdToolAdvice(1, 100, REST_MACHINING_FALLBACK);
    expect(advice).not.toBeNull();
    expect(advice!.share).toBeCloseTo(0.01, 9);
    expect(advice!.suggested).toBe(false);
    expect(advice!.text).toContain('1 mm² of the 100 mm²');
    expect(advice!.text).toContain('1 % of it');
    expect(advice!.text).toContain('2 %');
    expect(advice!.text).toContain('no third program is suggested');
    // #436 review item 3 — under the threshold it says the remainder is too small to act on, and
    // claims nothing about what is left beyond that.
    expect(advice!.text).toContain('too small to act on');
    expect(advice!.text).not.toContain('another cutter would not open');
  });

  it('suggests a third cutter once the remainder is over it, and says whose threshold it is', () => {
    const advice = thirdToolAdvice(3, 100, { thirdToolFraction: 0.02, source: 'chosen' });
    expect(advice!.suggested).toBe(true);
    expect(advice!.text).toContain('a third cutter');
    expect(advice!.text).toContain('stored in this location');
    expect(advice!.text).toContain('chosen rather than measured');
  });

  it('is a strict threshold, so a remainder of exactly 2 % does not trip it', () => {
    expect(thirdToolAdvice(2, 100, REST_MACHINING_FALLBACK)!.suggested).toBe(false);
    expect(thirdToolAdvice(2.0001, 100, REST_MACHINING_FALLBACK)!.suggested).toBe(true);
  });

  it('says a threshold was typed when the job was given its own', () => {
    const advice = thirdToolAdvice(6, 100, { thirdToolFraction: 0.05, source: 'user' });
    expect(advice!.suggested).toBe(true);
    expect(advice!.text).toContain('typed for this run on the command line (--third-tool)');
    expect(advice!.text).not.toContain('chosen rather than measured');
  });

  it('points at the BAND, not another cutter, when the seam is what is standing (#436 review)', () => {
    // The state a job reaches by typing a band the residues cannot survive. A third cutter would be
    // closed away from the same slivers, so the advice has to be to widen the band.
    const advice = thirdToolAdvice(40, 400, REST_MACHINING_FALLBACK, restSeamFacts(typed(0.1)));
    expect(advice!.suggested).toBe(true);
    expect(advice!.text).toContain('what is standing is the SEAM');
    expect(advice!.text).toContain('Widen the band to about 0.493 mm');
    expect(advice!.text).not.toContain('reach for the next cutter down');
  });

  it('still names the next cutter down when the band is not the reason', () => {
    // The same remainder, on a job whose band reaches past the residues: what is left really is the
    // geometry a smaller cutter would get into.
    const advice = thirdToolAdvice(40, 400, REST_MACHINING_FALLBACK, restSeamFacts(badge(0.5)));
    expect(advice!.suggested).toBe(true);
    expect(advice!.text).toContain('reach for the next cutter down');
    expect(advice!.text).not.toContain('Widen the band');
  });

  it('keeps the next-cutter advice when no seam was handed in at all', () => {
    const advice = thirdToolAdvice(40, 400, REST_MACHINING_FALLBACK);
    expect(advice!.text).toContain('reach for the next cutter down');
  });
});
