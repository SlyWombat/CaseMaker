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
 * Throws a NAMED error; the plan's per-step catch states it (`unplanned`/notes), so a corrupt
 * metadata record is never posted silently.
 */
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
        throw new Error(
          `plan metadata inconsistent: ${id} (${where}) — recorded depth ${op.depth} does not reach its ` +
            `${op.depthPasses} passes at ${op.passStepMm} mm (needs ${needed})`,
        );
      }
    }
    const own = estimateCycleSeconds(op.moves, rapid);
    const tolerance = 1e-6 * Math.max(1, Math.abs(own));
    if (Math.abs(own - op.estimatedSeconds) > tolerance) {
      throw new Error(
        `plan metadata inconsistent: ${id} (${where}) — estimate ${op.estimatedSeconds} is not the estimate ` +
          `of its own moves (${own})`,
      );
    }
  }
}
