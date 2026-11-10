import { PLANNER_OUT_OF_MEMORY_SENTENCE } from '@/engine/cnc/rendererBits';

/**
 * #931 — A RUN'S FAILURE, IN THE OPERATOR'S WORDS, for both surfaces that print it.
 *
 * Design's `engrave-run-errors` and Cut's step 1 must say the same thing about the same run: the
 * sweep's message names the program, the checkpoint and the obstacle by their internal ids —
 * `the facing pass (flat-1.0): checkpoint 0: the cutter drives 0.477 mm³ into the fixture 'Vise
 * moving jaw (right)' (vise-moving-jaw)` — which is a developer's sentence, not a person's. This
 * keeps the fact (what would be cut, how much, by what) and drops the ids; the raw sentence stays
 * under Technical. A finding's own sentence (a verifier refusal) has no ids and passes through
 * unchanged, capitalisation included.
 */

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * #1124 (the landing ruling, 2026-11-09) — A PLANNER OUT-OF-MEMORY FAILURE IS NAMED. The bench's
 * failure surfaced as "Array buffer allocation failed" mid-plan; the operator gets the cause and
 * the remedy instead of the raw allocation text. The matching is deliberately narrow: allocation
 * failures, not any sentence that mentions memory — and NOT a generic wasm trap like "memory access
 * out of bounds", which is often a genuine bug and would send the operator to the wrong fix.
 */
function looksLikePlannerOom(message: string): boolean {
  return /array ?buffer allocation failed|cannot enlarge memory|out of memory/i.test(
    message,
  );
}

/** One run error's message, as the operator reads it (§4's copy rules; no ids, no checkpoint). */
export function operatorRunError(message: string): string {
  if (looksLikePlannerOom(message)) return PLANNER_OUT_OF_MEMORY_SENTENCE;
  const before = message;
  let text = message
    // `(flat-1.0)`, `(vise-moving-jaw)` — parenthesised registry keys and obstacle ids.
    .replace(/\s*\([a-z0-9]+(?:[.-][a-z0-9]+)+\)/gi, '')
    // `checkpoint 3:` is the sweep's own coordinate, not a place on the part.
    .replace(/\bcheckpoint \d+:\s*/gi, '');
  // The program's label keeps its name ("the facing pass") and becomes the subject of the clause.
  text = text.replace(/^(.+?):\s+the cutter drives\b/i, '$1 would cut');
  text = text.replace(/\bthe cutter drives\b/i, 'the cutter would cut');
  // A named obstacle is a fixture with a label: "into the fixture 'Vise moving jaw (right)'" →
  // "into the vise's moving jaw (right)".
  text = text.replace(/into the fixture 'Vise ([^']+)'/g, (_m, rest: string) => {
    const lower = rest.charAt(0).toLowerCase() + rest.slice(1);
    return `into the vise’s ${lower}`;
  });
  text = text.replace(/into the fixture '([^']+)'/g, 'into the $1');
  return text === before ? message : sentenceCase(text.trim());
}
