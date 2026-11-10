/**
 * #1158 — WHICH PROGRAM'S GOAL CHECK IS THE SAMPLE'S VERDICT.
 *
 * A run's early programs are rough/rest passes: they leave stock by design, so their own goal
 * checks read low coverage (heart-gear-b: 5.72 %, 25.22 %, then three at 100 %). Judging every
 * program made the sample's verdict depend on how many programs the plan split into — the same
 * end state passed or failed by the plan's shape.
 *
 * The rule:
 *
 *   - the run's FINAL goal check (the last program that carries one) is the coverage verdict;
 *   - a cut-into reading is a NEVER-MISS at any stage — a rough pass that cuts into the design is
 *     a real defect, whatever the later programs do;
 *   - an intermediate program's coverage is stated on the result, never judged.
 *
 * Pure: the harness feeds it the receipt's raw `details.programs[].goal` blocks, and the unit spec
 * feeds it the same blocks built by hand.
 */

export interface SampleCheckVerdict {
  status: 'pass' | 'fail';
  note: string;
}

interface GoalFacts {
  ran: boolean;
  adjudicated: number | null;
  leftover: number[];
  passCoverage: number | null;
  coverage: number | null;
  passLineOk: boolean | null;
  reason: string | null;
}

const numberOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function factsOf(goal: Record<string, unknown>): GoalFacts {
  const ran = goal['ran'] === true;
  const leftover = Array.isArray(goal['leftoverFractions']) ? (goal['leftoverFractions'] as number[]) : [];
  const passCoverage = numberOrNull(goal['passCoverage']);
  const coverage = leftover.length === 0 ? null : 1 - (leftover[0] as number);
  return {
    ran,
    adjudicated: numberOrNull(goal['adjudicatedMaxMm']),
    leftover,
    passCoverage,
    coverage,
    passLineOk: coverage === null || passCoverage === null ? null : coverage + 1e-9 >= passCoverage,
    reason: typeof goal['reason'] === 'string' ? (goal['reason'] as string) : null,
  };
}

/** One goal block in the harness's own words (the sentence the old note carried per program). */
function goalWords(f: GoalFacts): string {
  return f.ran
    ? `adjudicated cut-into ${f.adjudicated === null ? '?' : f.adjudicated.toFixed(4)} mm, coverage ${
        f.coverage === null ? '?' : `${(f.coverage * 100).toFixed(2)} %`
      } vs ${f.passCoverage === null ? '?' : `${(f.passCoverage * 100).toFixed(2)} %`}, leftover bands ${f.leftover
        .map((v) => `${(v * 100).toFixed(2)} %`)
        .join('/')}`
    : `not compared: ${f.reason ?? 'no reason stated'}`;
}

/**
 * #1157 — A GOAL THE STAGING CANNOT REPRODUCE IS A FEASIBILITY VERDICT, NOT A BARE FAIL.
 *
 * When a receipt says the goal cannot be reached from its setup (`goal-unreached`: the shares that
 * face away or sit in shadow) and names regions deeper than the longest ball's reach
 * (`goal-finish-unreachable`), the check's note leads with those numbers. A 3D bevel gear staged
 * as a one-setup relief cannot meet the pass line by construction; the output should say so, with
 * the plan's own measure, rather than read as a plan that merely failed.
 *
 * Returns null when the receipt carries no `goal-unreached` — an ordinary check keeps its note.
 */
export function feasibilityNote(diagnostics: readonly Record<string, unknown>[]): string | null {
  const unreached = diagnostics.find((d) => d['code'] === 'goal-unreached');
  if (unreached === undefined) return null;
  const reach = diagnostics.filter((d) => d['code'] === 'goal-finish-unreachable');
  const floors = reach
    .map((d) => /floor ([\d.]+) mm below the stock top/.exec(String(d['message'] ?? ''))?.[1])
    .filter((v): v is string => v !== undefined);
  const parts = [`feasibility — ${String(unreached['message'] ?? 'the goal cannot be reproduced from one top setup')}`];
  if (reach.length > 0) {
    parts.push(
      `${reach.length} region${reach.length === 1 ? ' is' : 's are'} deeper than the longest ball's reach${
        floors.length === 0 ? '' : ` (${floors.join('/')} mm below the stock top)`
      }.`,
    );
  }
  return parts.join(' ');
}

/**
 * The sample's check verdict from its programs' goal blocks, in program order — or `null` when no
 * program carried one (the harness records that as `n/a`).
 */
export function judgeSampleGoals(goals: readonly Record<string, unknown>[]): SampleCheckVerdict | null {
  if (goals.length === 0) return null;
  const facts = goals.map(factsOf);
  const finalIndex = facts.length - 1;
  const final = facts[finalIndex]!;
  const failReasons: string[] = [];
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i]!;
    if (f.ran && f.adjudicated !== null && f.adjudicated > 0) {
      failReasons.push(`program ${i + 1}'s check adjudicated ${f.adjudicated.toFixed(4)} mm cut-into the goal`);
    }
  }
  if (!final.ran) {
    failReasons.push(`the run's final goal check (program ${finalIndex + 1} of ${facts.length}) did not run: ${final.reason ?? 'no reason stated'}`);
  } else if (final.passLineOk === false) {
    failReasons.push(`the run's final goal check (program ${finalIndex + 1} of ${facts.length}) is under the pass line`);
  }
  const intermediates = facts
    .slice(0, finalIndex)
    .map((f, i) => `program ${i + 1} — ${goalWords(f)}`);
  return {
    status: failReasons.length === 0 ? 'pass' : 'fail',
    note: [
      `the run's final goal check (program ${finalIndex + 1} of ${facts.length}) is the verdict: ${goalWords(final)}`,
      ...(intermediates.length === 0
        ? []
        : [
            `intermediate program checks, stated not judged (a rough/rest pass leaves stock by design): ${intermediates.join('; ')}`,
          ]),
      ...failReasons,
    ].join('. '),
  };
}
