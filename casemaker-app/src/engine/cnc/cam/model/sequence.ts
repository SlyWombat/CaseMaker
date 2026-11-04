/**
 * cam/model/sequence.ts — cutter sequence by cost (#961, C), §4 of
 * `docs/design/cam-model-engine.md`.
 *
 * Candidate sequences (the Makera pattern: largest flat first, smaller for rest, ball to finish,
 * chamfer to break edges) from `ModelPlanInput.cutters`. Each candidate's `OpOutcome`s are grouped
 * by cutter and concatenated with the EXISTING `concatToolpathIR` (`cam/ir.ts:1138`) into one
 * `ToolpathIR` per cutter, then priced with the EXISTING `estimateCycleTerms` (`cam/ir.ts:692`) —
 * #927's own method, not a separate cost model. The cheapest sequence that meets reach (§957's
 * `reach()`) and scallop; which candidates `cutters` holds depends on the card (§7, A's R5): the
 * vendor's own set for a simulation-only reference card, the house's cutters for a bench card — this
 * module does not know or care which.
 */

import type { CycleTerms, RapidEstimate } from '@/engine/cnc/cam/ir';
import type { CutterCandidates } from './types';
import type { OpOutcome } from './linking';

export interface SequencedCutter {
  cutterKey: string;
  cost: CycleTerms;
  pinned: boolean;
  house: boolean;
}

/**
 * Prices every candidate cutter's grouped `OpOutcome`s and returns the cheapest sequence that meets
 * reach and scallop, honouring a pinned key as given (an absent key is this function's own choice).
 */
export function sequenceCutters(
  _candidates: CutterCandidates,
  _outcomesByCutter: ReadonlyMap<string, OpOutcome[]>,
  _rapid: RapidEstimate,
): SequencedCutter[] {
  throw new Error('cam/model/sequence: sequenceCutters() not implemented (#961)');
}
