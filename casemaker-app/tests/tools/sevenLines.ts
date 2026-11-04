/**
 * #964 — THE SEVEN-LINE SCORER (plan v2 §3, `docs/reviews/2026-11-03-plan-v2.md`).
 *
 * ONE function both callers use for the pass/fail of a reference card: the vitest specs import
 * `scoreSevenLines` directly, and the demo page's build calls the CLI (`tests/tools/seven-lines.ts`)
 * which wraps the same function. The page prints these lines; the specs assert them; neither does
 * its own arithmetic, so the two cannot name different rules.
 *
 * WHAT THIS FILE IS: RULES, NOT GEOMETRY. Every number a `ProgramScore` carries is MEASURED
 * elsewhere — the page's `goal_check.py` (multi-tool `mkr_goal_check.py`) or the app's
 * `checkGoalCutInto` for coverage and cut-into; `parseGcode` + #927's `estimateCycleSeconds` /
 * `efficiencyOf` for the posted program's clock, air and hops (see `postedFacts.ts`). This file
 * consumes those numbers and nothing else: it never stamps a cutter, samples a field or times a
 * move, so a rule change here cannot silently change a measured value.
 *
 * A card with no vendor score is "UNREFERENCED" (plan §5.2): never a pass, whatever the numbers
 * say on our side. A line whose input could not be measured (the cut-into rule before a checker
 * applies it, a card with no posted program) is STATED — `pass: 'stated'` — never passed by
 * default.
 */

/** The seven lines' identifiers, in plan v2 §3's order. */
export type SevenLineKey =
  | 'coverage'
  | 'cutInto'
  | 'cycle'
  | 'air'
  | 'rapids'
  | 'cutters'
  | 'postsAsFiled';

/** A line's verdict. `stated` = the line could not be judged from the inputs; it is not a pass. */
export type LineState = 'pass' | 'fail' | 'stated';

/**
 * The cut-into figures a checker reports.
 *
 * The LINE is judged at the 0.1 mm floor on the cells the checker can adjudicate: cells cut
 * beyond the goal by more than 0.1 mm, after excluding the three shares that are measurement
 * artefacts, not program defects (E's measurement on Makera's own tray, #955, 2026-11-03):
 *
 *   - EDGE BREAK — the chamfer bit's deliberate break, within its reach of a design edge and no
 *     deeper than its leg;
 *   - WALL CELLS — a cell straddling a goal wall step, whose sample reads the surface on the
 *     other side;
 *   - WALL SHADOW — cells within the largest cutting tool's radius of a wall step, which a
 *     heightfield stamp lowers although the cutter cannot reach behind the wall.
 *
 * The three excluded shares are PRINTED beside the line and are never part of the pass. The 0.01
 * floor's residue is Studio's own ~0.03 mm Z quantisation, so it is advisory only: it is reported
 * as `rawFraction` and does not decide the card.
 */
export interface CutIntoScore {
  /**
   * The judged share: `cutInto0p1Pct / 100` from the checker that applies the exclusions. NULL
   * when the checker did not apply them — the line is then STATED, never a pass.
   */
  adjudicatedFraction: number | null;
  /** The edge-break share the checker excluded, 0..1 (printed, not judged). */
  edgeBreakFraction: number | null;
  /** The wall-cell share excluded, 0..1 (printed, not judged). */
  wallNotScoredFraction: number | null;
  /** The wall-shadow share excluded, 0..1 (printed, not judged). */
  shadowNotScoredFraction: number | null;
  /** Advisory: the 0.01 mm-floor figure before exclusions, 0..1. */
  rawFraction: number | null;
  /** The deepest cut below the goal, mm (advisory). */
  maxMm: number;
}

/** How a program was posted — line 7's input. */
export interface PostsAsFiled {
  /** The job posted at the card's holding and pitch, with no refusal and no operator change. */
  ok: boolean;
  /** The holding the reference was cut in (e.g. `bed + tape`, `vise`). */
  holding: string;
  /** The pitch the card states, mm. */
  pitchMm: number;
  /** The refusal's own words, when it did not post. */
  note?: string;
}

/**
 * One side's measured card numbers. The same shape for ours and the vendor's, so a rule can only
 * ever compare like with like. Every field is in a unit the page prints:
 *   coverage, airFraction, cutInto fractions — 0..1; cycleSeconds — s; rapidsPer1000 — count.
 */
export interface ProgramScore {
  /** The side's name for the page: a job name, or the vendor's file/card. */
  label: string;
  /**
   * Top-surface coverage (figures: whole-surface after setups): 1 − leftover > 0.1 mm. NULL when
   * the card carries no coverage measurement (a 2.5D card measured by the design check, or an
   * artefact set that predates the goal check) — the line is then STATED, never zero.
   */
  coverage: number | null;
  cutInto: CutIntoScore;
  /** #927's estimate on the POSTED file (ours); the vendor NC's own `;@MKR|TIME` (vendor). */
  cycleSeconds: number;
  /** Rapid seconds / cycle seconds, from the same estimate on the posted file. */
  airFraction: number;
  /** `summary.rapids / summary.cuts × 1000` from `parseGcode` on the posted file. */
  rapidsPer1000FeedLines: number;
  /** Distinct tools with cutting moves in the posted file(s). */
  cutters: number;
  /**
   * TRUE when every cutting tool is one the location owns (a bench card); FALSE when one is not;
   * NULL for a card that is not a bench card (the demo's full-library references) and for the
   * vendor side, where the rule has nothing to say.
   */
  cuttersOwned: boolean | null;
  /** Line 7's input; NULL for the vendor side (its file is the reference, by definition). */
  postsAsFiled: PostsAsFiled | null;
  /** Where each number came from, in words, for the page's provenance line. */
  sources?: Partial<Record<'coverage' | 'cutInto' | 'cycle' | 'air' | 'rapids' | 'cutters', string>>;
}

/** The pass thresholds of plan v2 §3, with the shop's own pass line supplied by the caller. */
export interface SevenLineRules {
  /** `goal.passCoverage`, seeded 0.95 — the same key the in-app goal check reads. */
  passCoverage: number;
  /** Coverage may trail the vendor's by this many points (plan: 1). */
  coverageSlackPoints: number;
  /** Cycle may be this multiple of the vendor's (plan: 2). */
  cycleMultiple: number;
  /** The goal multiple, printed but not a pass condition (plan: 1.25). */
  cycleGoalMultiple: number;
  /** Air fraction may exceed the vendor's by this many points (plan: +10). */
  airSlackPoints: number;
  /** Rapids per 1,000 feed lines may be this multiple of the vendor's (plan: 2). */
  rapidsMultiple: number;
  /** Cutters may exceed the vendor's count by this many (plan: +1). */
  cutterSlack: number;
  /** Cut-into is judged at this floor, mm — 0.1 on the card (the 0.01 residue is Z quantisation). */
  cutIntoFloorMm: number;
  /** A tolerance for the exact-boundary comparisons (`≤` and `≥` are inclusive). */
  epsilon: number;
}

/** Plan v2 §3 with the shop's seeded pass line; a caller with a location overrides `passCoverage`. */
export const PLAN_V2_RULES: SevenLineRules = {
  passCoverage: 0.95,
  coverageSlackPoints: 1,
  cycleMultiple: 2,
  cycleGoalMultiple: 1.25,
  airSlackPoints: 10,
  rapidsMultiple: 2,
  cutterSlack: 1,
  cutIntoFloorMm: 0.1,
  epsilon: 1e-9,
};

/** One line, as the page prints it and the spec asserts it. */
export interface SevenLine {
  key: SevenLineKey;
  /** The line's number in plan v2 §3 (1-based). */
  number: number;
  /** The rule in words, with the numbers that were applied. */
  rule: string;
  /** Our measured value (fraction 0..1, seconds, count, or a boolean for line 7). */
  oursValue: number | boolean | null;
  /** The vendor's measured value, or null when the card has no vendor program. */
  vendorValue: number | boolean | null;
  /** The two values formatted as the page prints them. */
  ours: string;
  vendor: string | null;
  state: LineState;
  /** Why a line is failed or stated; null when it passes cleanly. */
  note: string | null;
  /** TRUE when the cycle line passes the 3× stop rule's converse — it is within the 1.25× goal. */
  goalMet?: boolean;
}

export interface SevenLineCard {
  card: string;
  /** FALSE when no vendor program was scored beside ours: "unreferenced", never a pass. */
  referenced: boolean;
  /** TRUE only when every judged line passes and the card is referenced. */
  pass: boolean;
  lines: SevenLine[];
  /** The keys of the lines that fail (or the single `unreferenced` entry). */
  failing: string[];
  /** One sentence for the page's card, never "Matches" on an unreferenced card. */
  sentence: string;
}

export interface ScoreInput {
  card: string;
  ours: ProgramScore;
  vendor: ProgramScore | null;
  rules?: Partial<SevenLineRules>;
}

const pct = (v: number): string => `${(v * 100).toFixed(2)} %`;
const minutes = (s: number): string => {
  const m = s / 60;
  return m >= 60 ? `${(m / 60).toFixed(1)} h` : `${m.toFixed(1)} min`;
};
const count = (v: number): string => `${Math.round(v)}`;

/**
 * Score one reference card against plan v2 §3.
 *
 * The rules are the plan's, applied in its order. A missing vendor is `unreferenced`; a cut-into
 * figure the checker did not adjudicate states line 2; a missing `postsAsFiled` states line 7. A
 * line that is stated is never counted as passing, and the card passes only when every line
 * passes.
 */
export function scoreSevenLines(input: ScoreInput): SevenLineCard {
  const r: SevenLineRules = { ...PLAN_V2_RULES, ...(input.rules ?? {}) };
  const { ours, vendor } = input;
  const referenced = vendor !== null;
  const lines: SevenLine[] = [];

  const add = (line: Omit<SevenLine, 'number'>): void => {
    lines.push({ ...line, number: lines.length + 1 });
  };

  // 1 — coverage ≥ vendor − 1 point AND ≥ the shop's pass line.
  {
    const oursCoverage = ours.coverage;
    const vendorCoverage = vendor?.coverage ?? null;
    const stated = !referenced || oursCoverage === null || vendorCoverage === null;
    const vendorOk =
      oursCoverage !== null &&
      vendorCoverage !== null &&
      oursCoverage >= vendorCoverage - r.coverageSlackPoints / 100 - r.epsilon;
    const passOk = oursCoverage !== null && oursCoverage >= r.passCoverage - r.epsilon;
    const notes: string[] = [];
    if (!referenced) notes.push('no vendor program beside it');
    else if (oursCoverage === null) notes.push('the card carries no coverage measurement');
    else if (vendorCoverage === null) notes.push('the vendor score carries no coverage measurement');
    else {
      if (!vendorOk) notes.push(`trails the vendor by ${((vendorCoverage - oursCoverage) * 100).toFixed(2)} points (the line allows ${r.coverageSlackPoints})`);
      if (!passOk) notes.push(`below the shop's ${(r.passCoverage * 100).toFixed(2)} % pass line`);
    }
    add({
      key: 'coverage',
      rule: `≥ vendor − ${r.coverageSlackPoints} point and ≥ ${(r.passCoverage * 100).toFixed(2)} %`,
      oursValue: oursCoverage,
      vendorValue: vendorCoverage,
      ours: oursCoverage === null ? 'not measured' : pct(oursCoverage),
      vendor: vendor === null ? null : vendorCoverage === null ? 'not measured' : pct(vendorCoverage),
      state: stated ? 'stated' : vendorOk && passOk ? 'pass' : 'fail',
      note: notes.length > 0 ? notes.join('; ') : null,
    });
  }

  // 2 — zero cut-into at the 0.1 mm floor beyond the checker's three exclusions.
  {
    const judged = ours.cutInto.adjudicatedFraction;
    const stated = judged === null;
    const ok = !stated && judged <= r.epsilon;
    const exclusions: string[] = [];
    const pctOrNull = (v: number | null): string | null => (v === null ? null : pct(v));
    const edge = pctOrNull(ours.cutInto.edgeBreakFraction);
    const wall = pctOrNull(ours.cutInto.wallNotScoredFraction);
    const shadow = pctOrNull(ours.cutInto.shadowNotScoredFraction);
    if (edge !== null) exclusions.push(`edge break ${edge}`);
    if (wall !== null) exclusions.push(`wall cells ${wall}`);
    if (shadow !== null) exclusions.push(`wall shadow ${shadow}`);
    const excludedText = exclusions.length > 0 ? `${exclusions.join(', ')} excluded` : 'no exclusions stated';
    const excluded = exclusions.length > 0 ? ` (${excludedText})` : '';
    const note = stated
      ? 'the checker has not applied the cut-into rule (0.1 mm floor with edge break, wall cells and wall shadow excluded) — cut-into is not judged'
      : ok
        ? excludedText
        : `${pct(judged)} of cells cut beyond the exclusions (${excludedText})`;
    add({
      key: 'cutInto',
      rule: `0 at the ${r.cutIntoFloorMm} mm floor beyond the excluded shares`,
      oursValue: judged,
      vendorValue: vendor?.cutInto.adjudicatedFraction ?? null,
      ours: stated ? `not judged${excluded}` : `${pct(judged)}${excluded}`,
      vendor:
        vendor === null
          ? null
          : vendor.cutInto.adjudicatedFraction === null
            ? 'not judged'
            : pct(vendor.cutInto.adjudicatedFraction),
      state: stated ? 'stated' : ok ? 'pass' : 'fail',
      note,
    });
  }

  // 3 — cycle ≤ 2× vendor's; the 1.25× goal is printed, not required.
  {
    const ok = vendor !== null && ours.cycleSeconds <= vendor.cycleSeconds * r.cycleMultiple * (1 + r.epsilon);
    const goalMet = vendor !== null && ours.cycleSeconds <= vendor.cycleSeconds * r.cycleGoalMultiple * (1 + r.epsilon);
    add({
      key: 'cycle',
      rule: `≤ ${r.cycleMultiple}× the vendor's (goal ${r.cycleGoalMultiple}×)`,
      oursValue: ours.cycleSeconds,
      vendorValue: vendor?.cycleSeconds ?? null,
      ours: minutes(ours.cycleSeconds),
      vendor: vendor === null ? null : minutes(vendor.cycleSeconds),
      state: !referenced ? 'stated' : ok ? 'pass' : 'fail',
      note: !referenced
        ? 'no vendor program beside it'
        : ok
          ? goalMet
            ? `meets the ${r.cycleGoalMultiple}× goal`
            : `within the ${r.cycleMultiple}× line but above the ${r.cycleGoalMultiple}× goal`
          : `${(ours.cycleSeconds / vendor.cycleSeconds).toFixed(2)}× the vendor's time`,
      goalMet,
    });
  }

  // 4 — air fraction ≤ vendor's + 10 points.
  {
    const ok = vendor !== null && ours.airFraction <= vendor.airFraction + r.airSlackPoints / 100 + r.epsilon;
    add({
      key: 'air',
      rule: `≤ vendor + ${r.airSlackPoints} points`,
      oursValue: ours.airFraction,
      vendorValue: vendor?.airFraction ?? null,
      ours: pct(ours.airFraction),
      vendor: vendor === null ? null : pct(vendor.airFraction),
      state: !referenced ? 'stated' : ok ? 'pass' : 'fail',
      note: !referenced
        ? 'no vendor program beside it'
        : ok
          ? null
          : `${((ours.airFraction - vendor.airFraction) * 100).toFixed(2)} points above the vendor's`,
    });
  }

  // 5 — rapids per 1,000 feed lines ≤ 2× vendor's.
  {
    let ok = false;
    if (vendor !== null) {
      ok =
        vendor.rapidsPer1000FeedLines <= r.epsilon
          ? ours.rapidsPer1000FeedLines <= r.epsilon
          : ours.rapidsPer1000FeedLines <= vendor.rapidsPer1000FeedLines * r.rapidsMultiple * (1 + r.epsilon);
    }
    add({
      key: 'rapids',
      rule: `≤ ${r.rapidsMultiple}× the vendor's`,
      oursValue: ours.rapidsPer1000FeedLines,
      vendorValue: vendor?.rapidsPer1000FeedLines ?? null,
      ours: count(ours.rapidsPer1000FeedLines),
      vendor: vendor === null ? null : count(vendor.rapidsPer1000FeedLines),
      state: !referenced ? 'stated' : ok ? 'pass' : 'fail',
      note: !referenced
        ? 'no vendor program beside it'
        : ok
          ? null
          : vendor.rapidsPer1000FeedLines > r.epsilon
            ? `${(ours.rapidsPer1000FeedLines / vendor.rapidsPer1000FeedLines).toFixed(2)}× the vendor's rate`
            : 'the vendor\'s file has no rapids; this one does',
    });
  }

  // 6 — cutters ≤ vendor + 1; a bench card may use only the location's cutters.
  {
    const countOk = vendor !== null && ours.cutters <= vendor.cutters + r.cutterSlack;
    const ownedOk = ours.cuttersOwned !== false;
    const ok = countOk && ownedOk;
    const notes: string[] = [];
    if (vendor !== null && !countOk) notes.push(`${ours.cutters} cutters against the vendor's ${vendor.cutters} (the line allows +${r.cutterSlack})`);
    if (!ownedOk) notes.push('a bench card may only use cutters the location owns');
    add({
      key: 'cutters',
      rule: `≤ vendor + ${r.cutterSlack}, and only the location's cutters for a bench card`,
      oursValue: ours.cutters,
      vendorValue: vendor?.cutters ?? null,
      ours: count(ours.cutters),
      vendor: vendor === null ? null : count(vendor.cutters),
      state: !referenced ? (ownedOk ? 'stated' : 'fail') : ok ? 'pass' : 'fail',
      note: !referenced
        ? ownedOk
          ? 'no vendor program beside it'
          : 'a bench card may only use cutters the location owns'
        : notes.length > 0
          ? notes.join('; ')
          : null,
    });
  }

  // 7 — posts as filed, in the vendor's own holding, with no operator change to the pitch.
  {
    const p = ours.postsAsFiled;
    const stated = p === null;
    const ok = p !== null && p.ok;
    add({
      key: 'postsAsFiled',
      rule: 'posts as filed, in the vendor’s holding, without changing the pitch',
      oursValue: p === null ? null : p.ok,
      vendorValue: null,
      ours: stated ? 'not stated' : p.ok ? `yes — ${p.holding}, ${p.pitchMm} mm` : `no — ${p.note ?? 'refused or changed'}`,
      vendor: null,
      state: stated ? 'stated' : ok ? 'pass' : 'fail',
      note: stated ? 'the card does not state a posted program’s holding and pitch' : ok ? null : p.note ?? null,
    });
  }

  const failing = lines.filter((l) => l.state !== 'pass').map((l) => l.key);
  const pass = referenced && failing.length === 0;
  const sentence = !referenced
    ? 'Unreferenced — no vendor program beside this card, so it cannot be called a match'
    : pass
      ? 'Passes the seven lines of plan v2 §3'
      : `Deviates — ${failing.map((f) => LABELS[f] ?? f).join(', ')}`;

  return { card: input.card, referenced, pass, lines, failing, sentence };
}

/** Display names for the line keys, used in the card sentence and the specs' messages. */
export const LABELS: Record<string, string> = {
  coverage: 'coverage',
  cutInto: 'cut-into',
  cycle: 'cycle time',
  air: 'air fraction',
  rapids: 'rapids per 1,000 feed lines',
  cutters: 'cutters',
  postsAsFiled: 'posts as filed',
  unreferenced: 'unreferenced',
};
