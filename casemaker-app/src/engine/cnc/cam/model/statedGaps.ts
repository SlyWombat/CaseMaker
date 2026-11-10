/**
 * #1123 item 56(b) — THE PLAN'S STATED GAPS, AS CHECKS THE OPERATOR CAN MAKE.
 *
 * The plan states what it does not model, so the gap is never silent. `goal-fixture-unmodelled`
 * used to read as an engine note ("the bracket fixture envelope is not one of this plan's own
 * region obstacles — the posted program is checked against it by the verifier and the sweep"):
 * it said what the software does, not what the person at the machine should do. The row is a
 * Check, so it has to answer the Check's two questions — what do I check, and where.
 *
 * The answer is the same fact the guide's own row states: the posted program is still swept
 * against the fixture, so the operator reads the program's moves near the fixture in the dry run,
 * where a move the plan did not see would show before the spindle starts.
 */

import type { Mount } from '@/engine/cnc/setups/types';

/** The fixture in the operator's words, and the pronoun that follows it. */
function fixtureWords(mount: Mount): { what: string; them: string } {
  switch (mount) {
    case 'bracket':
      return { what: "the bracket's arms and clamps", them: 'them' };
    case 'vise':
      return { what: "the vise's jaws", them: 'them' };
    case 'tape':
      return { what: 'the bed', them: 'it' };
    default:
      return { what: 'the fixture', them: 'it' };
  }
}

/** One sentence: what the plan does not model, what to check, and where. */
export function fixtureUnmodelledSentence(mount: Mount): string {
  const { what, them } = fixtureWords(mount);
  return (
    `The plan does not model ${what}: check the program's moves near ${them} in the dry run — ` +
    `the posted program is still swept against ${them}.`
  );
}
