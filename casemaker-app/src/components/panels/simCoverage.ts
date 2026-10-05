/**
 * The coverage half of the Simulate panel's disclaimer (#243, `/Makera-Parity.md` §14.2 A2).
 *
 * The old disclaimer was physics only — "rigid, ideal machine" — and said nothing about the
 * geometry the sweep never saw. Bantam names its blind spots and we did not, so a green result
 * could be read as "nothing can be hit". This builds the blind-spot sentences from the run
 * itself: which obstacles the sweep was given (#204's fixture boxes), whether a collet nut was
 * modelled, which "cannot be proven" findings the run raised, and whether it was a full sweep or
 * a path-only refusal. Assembled from data, it cannot drift out of date the way prose does.
 *
 * Pure — no store and no React — so every branch is exercised in `simCoverage.spec.ts` without a
 * worker. The physics sentence stays a constant in the panel; this is the part that changes per run.
 */

/** What the load did: a full sweep, the runner only (sweep refused), or nothing at all. */
export type SimRunOutcome = 'swept' | 'path-only' | 'refused';

export interface SimCoverageInput {
  outcome: SimRunOutcome;
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
  /** The machine states a collet-nut holder (#182). False = the nut above the cutter is unmodelled. */
  holderKnown: boolean;
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

    const blind: string[] = [
      'the spindle body, head and gantry',
      'anything on the bed other than the declared stock, workholding and sacrificial material',
    ];
    if (input.fixtureLabels.length === 0) {
      blind.push('any fixture — none is modelled as an obstacle, so the workholding is not checked');
    }
    if (!input.holderKnown || input.codes.includes('holder-vs-fixture-unproven')) {
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
      out.push('The modelled fixture is a shipped default, not a measurement.');
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
