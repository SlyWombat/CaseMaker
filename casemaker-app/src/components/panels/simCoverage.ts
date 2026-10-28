/**
 * The coverage half of the Simulate panel's disclaimer (#243, `/Makera-Parity.md` §14.2 A2).
 *
 * The old disclaimer was physics only — "rigid, ideal machine" — and said nothing about the
 * geometry the sweep never saw. Bantam names its blind spots and we did not, so a green result
 * could be read as "nothing can be hit". This builds the blind-spot sentences from the run
 * itself: which obstacles the sweep was given (#204's fixture boxes), which "cannot be proven"
 * findings the run raised — the unmeasured collet nut and the unstated shank among them — and
 * whether it was a full sweep or a path-only refusal. Assembled from data, it cannot drift out of
 * date the way prose does, and a check the run did not actually need is not reported as a gap
 * (#314).
 *
 * #744 — A RUN, NOT ONE FILE. The claims are about every program the run loads, in cut order, each
 * on the stock the earlier ones left. A run of several programs says how many were checked, names
 * the ones a later sweep had to re-run from the blank (the column engine and indexed rotary cannot
 * be seeded), names a sampled engine per program, and — when the walk stopped — names the program
 * that stopped it and says what was therefore never checked. The ORACLE's comparison is program 1's
 * alone, and the sentence says so rather than implying it covers the run. A single-program caller
 * (the Simulate panel's own loaded file, a one-file job) sees exactly the sentences it always did.
 *
 * Pure — no store and no React — so every branch is exercised in `simCoverage.spec.ts` without a
 * worker. The physics sentence stays a constant in the panel; this is the part that changes per run.
 */

import { rowSummary } from '@/components/panels/engraveRowText';

/** What the load did: a full sweep, the runner only (sweep refused), or nothing at all. */
export type SimRunOutcome = 'swept' | 'path-only' | 'refused';

/**
 * One program of the run, as the coverage sentences read it (#744). Structurally a
 * `ProgramSweepSummary` (`engine/cnc/engrave/programSweep.ts`) plus the codes its own sweep raised.
 */
export interface SimSweptProgram {
  /** The run's own name for it: `program 2 (flat-3.175x12)` or `the facing pass (fly-22)`. */
  label: string;
  outcome: SimRunOutcome;
  engine?: 'exact' | 'column' | null;
  /** True when the simulator could not start this program from the earlier programs' stock. */
  fromBlank?: boolean;
  /** The codes this program's OWN sweep raised, when the caller carries them. */
  codes?: readonly string[];
  /** How many ERROR diagnostics this program's sweep raised; absent reads as 0. */
  errorCount?: number;
}

export interface SimCoverageInput {
  outcome: SimRunOutcome;
  /**
   * Which backend swept the material (#222/#405): the exact 2.5D boolean sweeper (`'exact'`) or the
   * sampled column engine (`'column'`). Undefined means the caller did not say — the disclaimer
   * makes no claim about the backend then. A `'column'` sweep is stated because its numbers carry a
   * grid resolution the exact sweeper's do not, and since #405 a V-bit trace is swept that way.
   * On a whole run the per-program engines in `programs` are read instead: one file's backend
   * cannot describe another's.
   */
  engine?: 'exact' | 'column';
  /**
   * The band the oracle judged the prediction with (#408), mm — the width by which a boundary may
   * disagree before it counts as a CAM error. Undefined when the caller checked no prediction, or
   * has not checked one yet, and then the disclaimer makes no claim about a comparison. It is the
   * OTHER half of the `'column'` sentence: that one says the numbers are sampled, this one says how
   * far apart two sampled answers may be and still be the same answer.
   */
  oracleBand?: number;
  /**
   * Labels of the fixture obstacles the sweep was given (#204), in order. Empty means no fixture
   * was modelled — the default setup, where `fixture-unchecked` reports the workholding is not an
   * obstacle yet.
   */
  fixtureLabels: readonly string[];
  /** Where the modelled fixture's dimensions came from, when one is modelled. */
  fixtureSource?: 'default' | 'saved' | 'measured';
  /** True when the run modelled sacrificial material (#213) as a second body. */
  sacrificialModelled: boolean;
  /** The tool the program was written for, when known, so the shank caveat can name it. */
  toolName?: string | null;
  /** The codes this run reported, so "cannot be proven" is named from the run, not from prose. */
  codes: readonly string[];
  /**
   * #724 W7 — a rotary job's workholding is the map's two keep-out BANDS, not a vise envelope.
   * Its cuts are refused where they enter them (the findings and the verifier), which is a
   * different check from a fixture modelled as a solid — so the facts say that, and never name a
   * vise whose envelope belongs to a mount that is not on the machine. The two lengths are the
   * EFFECTIVE bands (`rotaryBandFacts`): already clamped by the stick-out, so a short rod's
   * sentence names the figure the findings judge.
   */
  rotaryBands?: { jawsMm: number; tailstockMm: number; tailstock: boolean } | null;
  /**
   * #744 — EVERY program's sweep, in cut order. Absent on a caller that swept one file (the
   * Simulate panel's loaded file, the bench scripts); present for a generated run. A list of ONE
   * program still reads exactly as the single-file sentences did, so a one-program job's output is
   * unchanged.
   */
  programs?: readonly SimSweptProgram[];
  /**
   * How many programs the RUN has, when that differs from what `programs` carries — a walk that
   * stopped part-way reports fewer results than the run has files. Defaults to `programs.length`.
   */
  expectedPrograms?: number;
}

/** `a`, `a and b`, `a, b and c`. */
function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The geometry every swept program was checked against, in the order the reader needs it. */
function obstacleWords(input: SimCoverageInput): string {
  const obstacles = ['the stock'];
  if (input.sacrificialModelled) obstacles.push('the sacrificial material');
  if (input.fixtureLabels.length > 0) obstacles.push(`the modelled fixture (${input.fixtureLabels.join(', ')})`);
  return joinAnd(obstacles);
}

/**
 * #724 W7 — the rotary's own facts. The chuck and tailstock are the map's bands; the sweep models
 * no solid for them, and the sentence says which check stands instead of naming a vise that is not
 * on the machine. (#729 will swap "as keep-out bands" for "as solids".)
 */
function rotaryBandSentence(input: SimCoverageInput): string | null {
  const bands = input.rotaryBands ?? null;
  if (bands === null) return null;
  const jaws = rowSummary(bands.jawsMm);
  return bands.tailstock
    ? `The jaws and the tailstock are checked as keep-out bands on the map — the first ${jaws} of the stick-out at the jaws, and the last ${rowSummary(bands.tailstockMm)} at the free end — the findings and the verifier refuse a cut into them, and the sweep models neither as a solid.`
    : `The jaws are checked as a keep-out band on the map — the first ${jaws} of the stick-out — the findings and the verifier refuse a cut into it, and the sweep models no chuck body as a solid.`;
}

/**
 * #408 — what the "matches prediction" claim is about, and to what tolerance. Derived, never
 * hand-set: the band is the pipeline's own approximations added up (the sweep's simplification and
 * one arc chord each, plus a column grid's cell diagonal when the material was sampled). Printed
 * because the claim is otherwise unfalsifiable to its reader: "matches" to what, over what? The
 * LEVELS are named for the same reason — a V trace's groove is a different width at every level, so
 * which levels were asked decides what the answer covers. Null when no prediction was checked.
 */
function oracleSentences(input: SimCoverageInput): string[] {
  if (input.oracleBand === undefined) return [];
  return [
    "Checked against the CAM's predicted regions at every level the plan cuts to — and, where the job cuts a V-bit trace, whose groove is a different width at each depth, at one derived level just under the top face, where that groove is widest.",
    // §4 — at most three decimals, trailing zeros dropped (`0.1`, never `0.100`).
    `The comparison's band is ${Number(input.oracleBand.toFixed(3))} mm: a boundary that disagrees by less than that is the two engines' own resolution, not a CAM error.`,
  ];
}

/**
 * The blind-spot line, from the run's own codes. With a whole run's `programs` the SHANK caveat
 * names the program whose cutter states no lengths — a later cutter's unmeasured shank is not
 * program 1's — while the collet nut stays the machine's one sentence, because it is the same nut
 * whichever program needed it.
 */
function blindSpotSentence(input: SimCoverageInput, programs: readonly SimSweptProgram[] | null): string {
  const blind: string[] = [
    'the spindle body, head and gantry',
    'anything on the bed other than the declared stock, workholding and sacrificial material',
  ];
  const bands = input.rotaryBands ?? null;
  if (input.fixtureLabels.length === 0 && bands === null) {
    blind.push('any fixture — none is modelled as an obstacle, so the workholding is not checked');
  }
  // #314 — from the run's own codes, like the shank caveat below. The sweep raises
  // `holder-vs-fixture-unproven` only when an obstacle rises ABOVE the stock top and the nut's
  // size is unstated; below the top the nut is held off by the shoulder gate, so a vise job —
  // the ordinary job — says nothing here. Moot is not unknown, and a sentence that named it
  // anyway would put a blind spot in every report this panel writes.
  if (input.codes.includes('holder-vs-fixture-unproven')) {
    blind.push('the collet nut, which this machine states no dimensions for');
  }
  if (input.codes.includes('holder-unproven')) {
    const holders = (programs ?? []).filter((p) => p.codes?.includes('holder-unproven')).map((p) => p.label);
    if (holders.length > 0) {
      blind.push(`the shank of the cutter in ${joinAnd(holders)}, which states no shoulder or flute length`);
    } else if (input.toolName) {
      blind.push(`the shank of “${input.toolName}” above the cutter, which states no shoulder or flute length`);
    } else {
      blind.push('the shank above the cutter, whose length is unstated');
    }
  }
  return `Not checked: ${blind.join('; ')}.`;
}

/** Why the walk stopped at this program, in the words the run's own outcome supports. */
function stopWords(program: SimSweptProgram): string {
  if (program.outcome === 'path-only') return 'the sweep was refused, so only its tool path was drawn';
  if (program.outcome === 'refused') return 'the file was refused before a tool path existed';
  const errors = program.errorCount ?? 1;
  return errors === 1 ? 'its sweep reported an error' : `its sweep reported ${errors} errors`;
}

/**
 * #744 — a run of several programs. The claims speak for the WHOLE run: which programs were
 * checked and on what stock, which could not be seeded, which were sampled, whether the run
 * reached the end, and what the oracle's comparison does and does not cover.
 *
 * Called only when the run has more than one program (`expectedPrograms` > 1), so a one-program
 * job never reaches these sentences.
 */
function wholeRunDisclaimer(
  input: SimCoverageInput,
  programs: readonly SimSweptProgram[],
  expected: number,
): string[] {
  const out: string[] = [];
  const clean = (p: SimSweptProgram): boolean => p.outcome === 'swept' && (p.errorCount ?? 0) === 0;

  if (programs.length === 0) {
    out.push(`Nothing was swept: none of the run's ${expected} programs has a simulation result.`);
    return out;
  }

  // The walk stops at the first program that cannot sweep cleanly; a caller that hands fewer
  // results than the run has files stopped before the last one, so the list cannot claim the run.
  const firstNotClean = programs.findIndex((p) => !clean(p));
  const stopAt = firstNotClean >= 0 ? firstNotClean : programs.length < expected ? programs.length - 1 : -1;
  const stopped = stopAt >= 0 ? programs[stopAt] ?? null : null;

  if (stopped !== null) {
    const checked = programs.slice(0, stopAt).filter(clean);
    const unchecked = Math.max(0, expected - stopAt - 1);
    if (checked.length > 0) {
      out.push(
        `Checked: ${checked.length} of the run's ${expected} programs — ${joinAnd(checked.map((p) => p.label))} — in cut order, each on the stock the earlier programs left, against ${obstacleWords(input)}.`,
      );
    }
    out.push(
      `The run stopped at ${stopped.label} — ${stopWords(stopped)}` +
        (unchecked > 0
          ? ` — so the ${unchecked === 1 ? 'program' : `${unchecked} programs`} after it ${unchecked === 1 ? 'was' : 'were'} not checked.`
          : '.'),
    );
    return out;
  }

  out.push(
    `Checked: all ${programs.length} programs in the run — ${joinAnd(programs.map((p) => p.label))} — in cut order, each on the stock the earlier programs left, against ${obstacleWords(input)}.`,
  );

  const bands = rotaryBandSentence(input);
  if (bands !== null) out.push(bands);

  // #405 — a rotary job or a V-bit trace keeps its material as a sampled grid, so its numbers carry
  // a resolution the exact boolean sweeper's do not. Per program, because a run can mix engines.
  const column = programs.filter((p) => p.engine === 'column').map((p) => p.label);
  if (column.length > 0) {
    out.push(
      column.length === programs.length
        ? 'Every program was swept by the sampled column engine, not the exact 2.5D boolean, so their removed volumes and gouge depths carry a grid resolution.'
        : `The material was swept by the sampled column engine for ${joinAnd(column)}, not the exact 2.5D boolean, so those programs' removed volumes and gouge depths carry a grid resolution.`,
    );
  }

  // #744 — a program the simulator could not seed is a real check of its own cuts, not a gap; say
  // which ones so a smaller removed volume is read as the blank it was swept on, not a quiet cut.
  const blank = programs.filter((p) => p.fromBlank).map((p) => p.label);
  if (blank.length > 0) {
    out.push(
      blank.length === 1
        ? `Swept from the blank: ${blank[0]} — its engine cannot start from the material the earlier programs left, so its result covers its own cuts only.`
        : `Swept from the blank: ${joinAnd(blank)} — their engines cannot start from the material the earlier programs left, so each result covers its own cuts only.`,
    );
  }

  if (input.oracleBand !== undefined) {
    out.push(...oracleSentences(input));
    // The prediction the oracle compares is the FIRST engraving program's (`generated.predicted`);
    // saying so keeps a green comparison from reading as a verdict on the whole run.
    out.push('The comparison covers program 1 only: the later programs have no predicted regions to compare.');
  }

  out.push(blindSpotSentence(input, programs));
  if (input.fixtureLabels.length > 0 && input.fixtureSource === 'default') {
    out.push('The modelled fixture is a shipped default.');
  }
  return out;
}

/**
 * One sentence per fact, in the order the reader needs them: what was checked, what was not, and
 * — for a run that did not sweep — why. A path-only or refused run says so here too.
 */
export function coverageDisclaimer(input: SimCoverageInput): string[] {
  const programs = input.programs ?? null;
  const expected = input.expectedPrograms ?? programs?.length ?? 0;
  // #744 — the run's own sentence when the run has more than one program. A one-program run keeps
  // the single-file wording byte-for-byte, list or no list.
  if (programs !== null && expected > 1) return wholeRunDisclaimer(input, programs, expected);

  const out: string[] = [];

  if (input.outcome === 'swept') {
    out.push(`Checked: the tool against ${obstacleWords(input)}.`);
    const bands = rotaryBandSentence(input);
    if (bands !== null) out.push(bands);

    // #405 — a rotary job or a V-bit trace keeps its material as a sampled grid, so its numbers
    // carry a resolution the exact boolean sweeper's do not. The claim is about the NUMBERS, not a
    // blind spot, so it sits with `Checked:` rather than `Not checked:`.
    if (input.engine === 'column') {
      out.push(
        'The material was swept by the sampled column engine, not the exact 2.5D boolean, so its removed volume and gouge depths carry a grid resolution.',
      );
    }

    out.push(...oracleSentences(input), blindSpotSentence(input, null));

    if (input.fixtureLabels.length > 0 && input.fixtureSource === 'default') {
      out.push('The modelled fixture is a shipped default.');
    }
    return out;
  }

  if (input.outcome === 'path-only') {
    out.push(
      'This run is path-only: the sweep was refused, so no fixture, holder or material geometry was checked — only the tool path is drawn.',
    );
    return out;
  }

  out.push('Nothing was swept: the file was refused before a tool path existed, so no geometry was checked.');
  return out;
}
