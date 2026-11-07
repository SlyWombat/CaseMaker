import { estimateCycleSeconds, type CamOperation, type RapidEstimate } from '@/engine/cnc/cam/ir';

/**
 * #1025 — A POCKET OP'S RECORDED METADATA MUST DESCRIBE ITS OWN PASSES AND MOVES.
 *
 * The organizer card once showed thirteen pocket ops carrying another pocket's `depth` and
 * `estimatedSeconds` while posting their own moves — a silent corruption in the plan's report
 * (never in the post: the moves were byte-identical). The acceptance pin guards the tests; this
 * guard runs in the product, where a long-lived worker planning several jobs is the firing
 * condition.
 *
 * The depth rule: a recorded depth must reach the op's own last pass —
 * `depth >= (depthPasses - 1) * passStepMm` (plus the last, shorter pass's own cut). The estimate
 * rule: `estimatedSeconds` must equal `estimateCycleSeconds` on the operation's own moves.
 *
 * THE FAULT IS ITS OWN CLASS (the review's ruling): a corrupt record is evidence the process
 * state is suspect — the mechanism is still unknown (#1025's own record), and at the
 * stress-compaction rate it can appear in ANY region, not only the one whose moves it distorts —
 * so it REFUSES THE WHOLE PLAN at every site. Every catch on the planning path rethrows this
 * class rather than recording the region/step as unplanned: `planPocketsForTree`'s chain catch,
 * its rest-prefix and coverage callbacks, and `priceSequence`'s per-step catch. The other two
 * guard sites (the step's post-loop re-check and `planModelCam`'s assembly) throw it directly.
 * The worker's seam then states `planModelCam refused — …` and posts nothing; a plan missing the
 * region the bug touched is exactly what the operator must never get.
 */
export class PlanMetadataInconsistentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanMetadataInconsistentError';
  }
}

/** #1025 — what the operator does about it; every metadata refusal ends with this sentence. */
const METADATA_FAULT_GUIDANCE =
  'Re-run Generate; if it recurs, keep the plan dump and the command and attach them to #1025.';

const refuse = (sentence: string): never => {
  throw new PlanMetadataInconsistentError(`${sentence}. ${METADATA_FAULT_GUIDANCE}`);
};

export function assertOwnPocketMetadata(
  where: string,
  id: string,
  operations: readonly CamOperation[],
  rapid: RapidEstimate,
): void {
  for (const op of operations) {
    if (op.depthPasses !== undefined && op.passStepMm !== undefined) {
      const needed = (op.depthPasses - 1) * op.passStepMm;
      if (op.depth + 1e-3 < needed - 1e-3) {
        refuse(
          `plan metadata inconsistent: ${id} (${where}) — recorded depth ${op.depth} does not reach its ` +
            `${op.depthPasses} passes at ${op.passStepMm} mm (needs ${needed})`,
        );
      }
    }
    const own = estimateCycleSeconds(op.moves, rapid);
    const tolerance = 1e-6 * Math.max(1, Math.abs(own));
    if (Math.abs(own - op.estimatedSeconds) > tolerance) {
      refuse(
        `plan metadata inconsistent: ${id} (${where}) — estimate ${op.estimatedSeconds} is not the estimate ` +
          `of its own moves (${own})`,
      );
    }
  }
}
