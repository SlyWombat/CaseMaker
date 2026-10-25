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
 * Pure — no store and no React — so every branch is exercised in `simCoverage.spec.ts` without a
 * worker. The physics sentence stays a constant in the panel; this is the part that changes per run.
 */

/** What the load did: a full sweep, the runner only (sweep refused), or nothing at all. */
export type SimRunOutcome = 'swept' | 'path-only' | 'refused';

export interface SimCoverageInput {
  outcome: SimRunOutcome;
  /**
   * Which backend swept the material (#222/#405): the exact 2.5D boolean sweeper (`'exact'`) or the
   * sampled column engine (`'column'`). Undefined means the caller did not say — the disclaimer
   * makes no claim about the backend then. A `'column'` sweep is stated because its numbers carry a
   * grid resolution the exact sweeper's do not, and since #405 a V-bit trace is swept that way.
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
}

/** `a`, `a and b`, `a, b and c`. */
function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * One sentence per fact, in the order the reader needs them: what was checked, what was not, and
 * — for a run that did not sweep — why. A path-only or refused run says so here too.
 */
export function coverageDisclaimer(input: SimCoverageInput): string[] {
  const out: string[] = [];

  if (input.outcome === 'swept') {
    const obstacles = ['the stock'];
    if (input.sacrificialModelled) obstacles.push('the sacrificial material');
    if (input.fixtureLabels.length > 0) obstacles.push(`the modelled fixture (${input.fixtureLabels.join(', ')})`);
    out.push(`Checked: the tool against ${joinAnd(obstacles)}.`);

    // #405 — a rotary job or a V-bit trace keeps its material as a sampled grid, so its numbers
    // carry a resolution the exact boolean sweeper's do not. The claim is about the NUMBERS, not a
    // blind spot, so it sits with `Checked:` rather than `Not checked:`.
    if (input.engine === 'column') {
      out.push(
        'The material was swept by the sampled column engine, not the exact 2.5D boolean, so its removed volume and gouge depths carry a grid resolution.',
      );
    }

    // #408 — what the "matches prediction" claim is about, and to what tolerance. Derived, never
    // hand-set: the band is the pipeline's own approximations added up (the sweep's simplification
    // and one arc chord each, plus a column grid's cell diagonal when the material was sampled).
    // Printed because the claim is otherwise unfalsifiable to its reader: "matches" to what, over
    // what? The LEVELS are named for the same reason — a V trace's groove is a different width at
    // every level, so which levels were asked decides what the answer covers.
    if (input.oracleBand !== undefined) {
      out.push(
        "Checked against the CAM's predicted regions at every level the plan cuts to — and, where the job cuts a V-bit trace, whose groove is a different width at each depth, at one derived level just under the top face, where that groove is widest.",
      );
      out.push(
        `The comparison's band is ${input.oracleBand.toFixed(3)} mm: a boundary that disagrees by less than that is the two engines' own resolution, not a CAM error.`,
      );
    }

    const blind: string[] = [
      'the spindle body, head and gantry',
      'anything on the bed other than the declared stock, workholding and sacrificial material',
    ];
    if (input.fixtureLabels.length === 0) {
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
      blind.push(
        input.toolName
          ? `the shank of “${input.toolName}” above the cutter, which states no shoulder or flute length`
          : 'the shank above the cutter, whose length is unstated',
      );
    }
    out.push(`Not checked: ${blind.join('; ')}.`);

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
