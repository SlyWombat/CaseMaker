/**
 * #436 — the two numbers rest machining runs on, where each came from, and what the job's own
 * geometry says about them.
 *
 * PURE, like `restPass.ts` beside it, and for the same reason: these are JUDGEMENTS about how a
 * two-tool job should be planned, and a judgement that can only be read inside the route that runs
 * is a judgement nobody can check.
 *
 * NEITHER NUMBER IS COMPILED IN (the maintainer, 2026-10-16: "That type of setting should be
 * something we keep in our own database and not compiled in"). Both are entries in the LOCATION
 * document's shop `defaults` (`location.json` → `defaults`, `defaults.rs` / `defaultsClient.ts`),
 * read through {@link REST_OVERLAP_KEY} and {@link REST_THIRD_TOOL_KEY}. What lives in this file is
 * only the pair used when there is no location to read at all — the hosted web build — and
 * {@link REST_MACHINING_FALLBACK} says that in its own name and in every sentence it produces.
 * Wherever the number came from, the sheet prints which; a value this machine's own document holds
 * is `chosen` or `measured` there and never reads as one of those when it is not.
 *
 * BOTH ARE **CHOSEN, NOT MEASURED** (maintainer decision Q19, `docs/design/cnc-job-workflow.md` §8).
 * The distinction is not decoration: `MarginSettings.source` already carries it for the depth
 * margins (#345), and the run sheet prints it here for the same purpose — an operator who reads
 * "0.5 mm overlap" has to be able to tell whether that is a number this bench produced or a number
 * somebody wrote down, because the two mean different things when the part comes out wrong.
 *
 * THE BAND IS WORKED OUT PER JOB FROM THE CUTTERS (the maintainer, 2026-10-16: "~0.5 mm, worked out
 * per job"), and the stored number is the FLOOR it sits on rather than the band itself — see
 * {@link overlapForJob}. The stored 0.5 mm is that derivation's outcome for the badge's pair, and
 * {@link neededBand} re-derives it for whatever pair the job actually runs. For a ⌀2 mm cutter at a
 * 0.9 mm step-over against a ⌀0.6 mm rest cutter:
 *
 *   - the seam band a residue sliver needs is `⌀₂ − sliver` = 0.493 mm, because the generator runs
 *     every item through a morphological opening that erases anything narrower than the cutter, and
 *     a sliver is only about 0.107 mm wide to begin with;
 *   - the second cutter's own scallop is 0.24 mm, so a band narrower than that can leave a ridge.
 *
 * The first two-tool cut (the Single Barrel job from `single.3mf`) is the measurement that updates
 * the stored value.
 */

import type { Mm } from '@/types/units';

/**
 * Where a rest-machining number came from. The first four are the location document's own provenance
 * vocabulary (`ShopDefaultSchema.source`); `user` is a value typed for one run.
 */
export type RestSettingSource = 'seeded' | 'chosen' | 'measured' | 'fallback' | 'user';

/** The keys these two numbers are stored under, in the location's shop `defaults` section. */
export const REST_OVERLAP_KEY = 'rest.overlapMm';
export const REST_THIRD_TOOL_KEY = 'rest.thirdToolPct';

export interface RestMachiningSettings {
  /**
   * How far the rest pass reaches back into the first cutter's territory, mm. The band BOTH programs
   * cut is `max(this, the band the job's own two cutters need)` — {@link overlapForJob} — so this is
   * the LEAST a job may run rather than the number it necessarily runs.
   */
  overlap: Mm;
  /**
   * How big the remainder has to be before a THIRD cutter is suggested: a fraction of the job's own
   * removal area (`RestResult.cutArea`), so the threshold travels between a badge blank and a plate
   * without being re-typed.
   */
  thirdToolFraction: number;
  source: RestSettingSource;
}

/**
 * The pair used when there is NO LOCATION TO READ — the hosted web build, and any caller that has
 * not been handed the document. Named for what it is: a fallback, never the shop's setting. The
 * numbers match the seeds the Rust side writes into a fresh `location.json` (`UNMEASURED_SEEDS` in
 * `defaults.rs`), so a build with no service behaves the same as a fresh bench; the two literals are
 * duplicated by necessity (one language per side) and `scripts/engrave-job.ts` prints which one a
 * run used.
 *
 * Both are CHOSEN (Q19); both are updated from the first two-tool cut. Nothing here is derived from
 * the bench, and nothing here may be read as if it were — `source: 'fallback'` is what the run sheet
 * turns into the words "the fallback this build carries for it".
 */
export const REST_MACHINING_FALLBACK: RestMachiningSettings = {
  overlap: 0.5,
  thirdToolFraction: 0.02,
  source: 'fallback',
};

/**
 * Where a number came from, as the run sheet says it. Every source is stated — including the good
 * ones — because a sheet that only spoke up when a value was doubtful would be implying that silence
 * means the number is sound.
 */
export function restSourceWords(source: RestSettingSource, flag: string): string {
  switch (source) {
    case 'user':
      return `typed for this run on the command line (${flag})`;
    case 'measured':
      return 'measured on this bench (#436)';
    case 'chosen':
      return 'chosen rather than measured, and stored in this location’s own defaults (#436)';
    case 'seeded':
      return (
        'the value this location was seeded with, chosen rather than measured (#436) — the first ' +
        'two-tool cut replaces it'
      );
    case 'fallback':
      // TRUE IN BOTH CASES IT IS USED FOR (#436 review): there is no location to read at all, or
      // there is one and the value it holds does not satisfy this key's rule. `readDefault` answers
      // its fallback for both, so the words must not claim the first while the second is what
      // happened.
      return (
        'the fallback this build carries for it, used because this location holds no value it ' +
        'could read (#436), chosen rather than measured'
      );
  }
}

/** `0.1 mm`, at the precision a sheet prints a band at. */
function mm(v: number): string {
  return `${Number(v.toFixed(3))} mm`;
}

/** `4 mm²`, the same, for an area. */
function mm2(v: number): string {
  return `${Number(v.toFixed(2))} mm²`;
}

/** A fraction as the sheet's own `2 %`. */
function pctf(v: number): string {
  return `${Number((v * 100).toFixed(v * 100 < 1 ? 2 : 0))} %`;
}

/** One cutter, as the seam facts need it: its diameter, and the step-over that shaped its scallop. */
export interface SeamCutter {
  key: string;
  diameter: Mm;
  /**
   * The step-over this cutter runs at in this material, mm, or null when the feeds table has no row
   * for it. Null is NOT zero: an unknown step-over is a missing number, and the facts say what they
   * could not derive rather than deriving it from a stand-in.
   */
  stepOver: Mm | null;
}

/**
 * The residue the first cutter's scalloped boundary leaves between two adjacent passes, mm — the
 * sagitta of a chord one step-over long on a circle of radius r₁: `r₁ − √(r₁² − s₁²/4)`.
 *
 * Zero when the step-over is unknown, and the caller must NOT read that zero as "nothing is left":
 * {@link neededBand} answers null in that case, which is the distinction the sheet prints.
 */
export function residueSliver(rough: SeamCutter): Mm {
  const r1 = rough.diameter / 2;
  const s1 = rough.stepOver;
  if (s1 === null || s1 <= 0 || r1 <= 0) return 0;
  return r1 - Math.sqrt(Math.max(0, r1 * r1 - (s1 * s1) / 4));
}

/**
 * The band that keeps those residues cuttable, mm — `diameter₂ − sliver`. The second cutter's own
 * opening erases anything narrower than its diameter, so a sliver survives to be cut only when the
 * band makes it at least that wide.
 *
 * Null when the first cutter's step-over is unknown: the requirement is then not derived, rather
 * than derived from a stand-in for a missing number.
 */
export function neededBand(rough: SeamCutter, rest: SeamCutter): Mm | null {
  if (rough.stepOver === null || rough.diameter / 2 <= 0) return null;
  return rest.diameter - residueSliver(rough);
}

/**
 * The band this run cuts with, mm, and where it came from (#436 review item 1).
 *
 * THE JOB'S OWN CUTTERS SET THE BAND, with the location's stored number as the FLOOR under it: the
 * band is `max(stored, needed)` unless an operator typed one. Two reasons that is the shape it is:
 *
 *   - the maintainer's rule is "~0.5 mm, worked out per job" — a job whose residues need 0.9 mm must
 *     not run the badge's 0.5 mm and quietly leave the seam standing, and one whose residues need
 *     0.19 mm should not be forced to 0.9 by a plate's pair;
 *   - the floor is what keeps the shop's own number meaningful. A bench that has learned its single
 *     cut wants a wider band than any derivation asks for says so once, in the document, instead of
 *     editing this module.
 *
 * A TYPED BAND IS AN OVERRIDE, used exactly as typed — never floored, never raised. That is what
 * makes `--overlap 0.1` a diagnostic rather than a no-op: the sheet then says the band is below what
 * the pair needs, which is a thing an operator wants to be told when they asked for it.
 */
export interface BandChoice {
  /** The band the second program actually cuts at, mm. */
  band: Mm;
  /** What the location stores under {@link REST_OVERLAP_KEY} — the floor under a derived band, mm. */
  stored: Mm;
  /** The band this job's own cutters need, mm — null when it cannot be derived. */
  needed: Mm | null;
  /** True when the derivation, not the stored number, is what the band came from. */
  derived: boolean;
  /** True when an operator typed this band for this one run. */
  typed: boolean;
}

export interface BandInput {
  /** The location's stored floor, mm. */
  stored: Mm;
  /** `--overlap`, when the operator typed one. */
  typed?: Mm | undefined;
  /** The cutter that cuts first — its scalloped boundary is what leaves the residue. */
  rough: SeamCutter;
  /** The cutter that cleans up — its own width is what the opening erases. */
  rest: SeamCutter;
}

export function overlapForJob(input: BandInput): BandChoice {
  const needed = neededBand(input.rough, input.rest);
  const stored = input.stored;
  if (input.typed !== undefined) {
    return { band: input.typed, stored, needed, derived: false, typed: true };
  }
  if (needed === null) return { band: stored, stored, needed, derived: false, typed: false };
  const derived = needed > stored + 1e-9;
  return { band: derived ? needed : stored, stored, needed, derived, typed: false };
}

/**
 * Everything the seam facts are made of. The two cutters ARE the input, and {@link restSeamFacts}
 * derives the band from them rather than being handed one — a caller that could pass a band and a
 * pair that disagree would be a caller that can produce facts which are not true of either.
 */
export interface SeamFactsInput extends BandInput {
  /** Where the band's number came from — the location's entry, or the command line. */
  source: RestSettingSource;
}

/**
 * What this job's own geometry says about the band it is running with. Every derived number comes
 * from the two cutters — never from the overlap, which is the thing being judged.
 */
export interface SeamFacts {
  /** The provenance clause the sheet puts after the number. */
  note: string;
  /** The band itself, mm — the one this run cuts at, so the sentence needs nothing but these facts. */
  overlap: Mm;
  /** What the location stores under {@link REST_OVERLAP_KEY}, mm — the floor the band sits on. */
  stored: Mm;
  /** True when the job's own cutters, and not the stored number, is what set the band. */
  derivedFromCutters: boolean;
  /** True when an operator typed the band for this run, so nothing floored or raised it. */
  typed: boolean;
  /** The second cutter's cutting diameter, mm — the width its own opening erases. */
  restDiameter: Mm;
  /** The second cutter's step-over, mm, or null where the table has no row for it. */
  restStepOver: Mm | null;
  /** Residual sliver width the first cutter's scallop leaves, mm — `r₁ − √(r₁² − s₁²/4)`. */
  sliver: Mm;
  /**
   * The band that keeps those slivers wide enough to survive the second cutter's opening, mm —
   * `diameter₂ − sliver`. Null when the first cutter's step-over is unknown.
   */
  needed: Mm | null;
  /** True when the band is wide enough to reach past the second cutter's own scallop. */
  coversScallop: boolean;
  /** True when the band is at or above `needed` — so the slivers are cut rather than closed away. */
  keepsSlivers: boolean;
}

export function restSeamFacts(input: SeamFactsInput): SeamFacts {
  const choice = overlapForJob(input);
  const sliver = residueSliver(input.rough);
  const band = choice.band;
  const needed = choice.needed;
  return {
    note: restSourceWords(input.source, '--overlap'),
    overlap: band,
    stored: choice.stored,
    derivedFromCutters: choice.derived,
    typed: choice.typed,
    restDiameter: input.rest.diameter,
    restStepOver: input.rest.stepOver,
    sliver,
    needed,
    coversScallop: input.rest.stepOver !== null && band >= input.rest.stepOver,
    keepsSlivers: needed !== null && band + 1e-9 >= needed,
  };
}

/**
 * The seam band, as the run sheet's sentence: the number, where it came from, and what this job's
 * own two cutters say about it.
 *
 * The last clauses are the point of the exercise. Each is a fact about the BAND and not about the
 * measurement, so each is stated whichever way it comes out — a sheet that only spoke up when the
 * band was too narrow would be implying that silence means the number is right.
 */
export function restSeamSentence(facts: SeamFacts): { text: string; value: string } {
  const parts: string[] = [
    `The second program reaches ${mm(facts.overlap)} back into the first one’s territory — ` +
      `${facts.note}.`,
  ];
  // #436 review item 1 — the band is no longer simply the stored number, so when the derivation is
  // what set it the sheet says so, and names the floor it was raised off. An operator comparing two
  // runs has to be able to tell a wider band from a differently-typed one.
  if (facts.derivedFromCutters && facts.needed !== null) {
    parts.push(
      `That is not the one this location stores (${mm(facts.stored)}): the band this job’s own two ` +
        `cutters need is ${mm(facts.needed)}, and the wider of the two is what runs.`,
    );
  }
  if (facts.restStepOver === null) {
    parts.push(
      'This material states no step-over for the second cutter, so whether the band reaches past its ' +
        'own scallop is not judged here.',
    );
  } else if (facts.coversScallop) {
    parts.push(
      `That is at or past the second cutter’s own scallop (${mm(facts.restStepOver)}), so the ` +
        'material its teeth leave at the seam is material the first program already took: no ridge ' +
        'can survive there.',
    );
  } else {
    parts.push(
      `That is NARROWER than the second cutter’s own scallop (${mm(facts.restStepOver)}), so a ` +
        'ridge can survive where the two programs meet — cut the pair and look at the seam.',
    );
  }
  if (facts.needed === null) {
    parts.push(
      'With no step-over for the first cutter, the width of the residue it leaves is unknown, so the ' +
        'band this job needs is not derived here.',
    );
  } else if (facts.keepsSlivers) {
    parts.push(
      `The first cutter’s scalloped boundary leaves slivers about ${mm(facts.sliver)} wide, and this ` +
        `generator’s opening erases anything narrower than the second cutter (${mm(facts.restDiameter)}), so a ` +
        `band of about ${mm(facts.needed)} is what keeps them cuttable. This band is at or past that: ` +
        'they are cut.',
    );
  } else {
    parts.push(
      `The first cutter’s scalloped boundary leaves slivers about ${mm(facts.sliver)} wide, and this ` +
        `generator’s opening erases anything narrower than the second cutter (${mm(facts.restDiameter)}), so a ` +
        `band of about ${mm(facts.needed)} is what keeps them cuttable. THIS BAND IS BELOW THAT: the ` +
        'slivers are erased rather than cut, and they are counted in the leftover number below ' +
        'instead of being removed.',
    );
  }
  return { text: parts.join(' '), value: `${mm(facts.overlap)} overlap` };
}

/**
 * Whether the remainder after two cutters is worth a third one (Q19's threshold).
 *
 * The denominator is the area the job asked to remove (`RestResult.cutArea` over the design's own
 * cuts), and the numerator is what neither program removed — the same solid, so the ratio is a
 * fraction of one thing and not of two.
 */
export interface ThirdToolAdvice {
  fraction: number;
  leftoverArea: number;
  removalArea: number;
  /** `leftoverArea / removalArea`. */
  share: number;
  suggested: boolean;
  text: string;
}

/**
 * The half of a seam verdict the third-tool advice has to defer to (#436 review item 2): a remainder
 * that is really the seam band's own shortfall is not a reason for another cutter.
 */
export type SeamVerdict = Pick<SeamFacts, 'needed' | 'keepsSlivers'>;

/**
 * Null when the job states no removable area: a share of nothing is not 0 %, and a suggestion built
 * on it would be a sentence about a measurement that does not exist.
 *
 * `seam` is what stops the advice pointing at the wrong remedy. A band narrower than the residues
 * need leaves the seam ITSELF standing — the second program's opening erases those slivers away
 * instead of cutting them — and a third cutter would face the same opening on the same slivers.
 * When that is what the numbers show, the advice is to widen the band, and it says so.
 */
export function thirdToolAdvice(
  leftoverArea: number,
  removalArea: number,
  settings: Pick<RestMachiningSettings, 'thirdToolFraction' | 'source'>,
  seam?: SeamVerdict | null,
): ThirdToolAdvice | null {
  if (!(removalArea > 0)) return null;
  const fraction = settings.thirdToolFraction;
  const share = leftoverArea / removalArea;
  const suggested = share > fraction;
  const base =
    `${mm2(leftoverArea)} of the ${mm2(removalArea)} this design asks for is still standing when both ` +
    `programs have run — ${pctf(share)} of it. This job suggests a third cutter past ` +
    `${pctf(fraction)}, ` +
    `${restSourceWords(settings.source, '--third-tool')}.`;

  let consequence: string;
  if (!suggested) {
    consequence = 'That is under it: too small to act on, so no third program is suggested.';
  } else if (seam !== undefined && seam !== null && seam.needed !== null && !seam.keepsSlivers) {
    const need = mm(seam.needed);
    consequence =
      'That is over it, but another cutter is not what this remainder needs: the band the two ' +
      `programs run is narrower than the ${need} the first cutter’s residues need to survive the ` +
      'second one’s opening, so what is standing is the SEAM, and the third cutter’s opening would ' +
      `erase it the same way. Widen the band to about ${need} and cut the pair again before ` +
      'reaching for one.';
  } else {
    consequence =
      'That is over it: reach for the next cutter down and cut what is left, or accept the ' +
      'remainder knowingly — the corners a round cutter cannot open will survive whatever you do.';
  }

  return { fraction, leftoverArea, removalArea, share, suggested, text: `${base} ${consequence}` };
}
