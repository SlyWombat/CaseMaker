/**
 * #1103 — WHAT THE WORK TAKES, from the question step's choice and the blank the stock step
 * proposed. The Holding step's recommended seat reads these facts (a 19.1 mm surfacing pass on a
 * 20.1 mm plate is not a job for the block seat); the geometry and the seats are unchanged.
 *
 * Pure: the choice and the proposal in, three numbers out. `reachesEdgeWithinMm` is not derivable
 * from the choice alone and stays null until a caller measures it.
 */
import type { StockProposal, WorkShape } from '@/engine/cnc/stockProposal';

import type { OperationChoice } from './OperationStep';

export interface WorkFacts {
  /** The deepest cut below the blank's top, mm. */
  deepestCutMm: number;
  /** The work goes through the blank. */
  through: boolean;
  /** How close the work comes to the blank's edge, mm; null when not known. */
  reachesEdgeWithinMm: number | null;
}

const NOTHING: WorkFacts = { deepestCutMm: 0, through: false, reachesEdgeWithinMm: null };

/** The facts the Holding step's recommendation reads for one question-step choice. */
export function workFactsOf(
  choice: OperationChoice | null,
  proposal: StockProposal | null,
  work: WorkShape | null = null,
): WorkFacts {
  if (choice === null) return NOTHING;
  const thickness = proposal?.thickness ?? 0;
  // The item's smallest margin to the blank's edge, from the work the stock was sized around.
  const margin: number | null = (() => {
    if (proposal === null || work === null) return null;
    if (work.kind === 'text') return Math.max(0, Math.min((proposal.length - work.size.length) / 2, (proposal.width - work.size.width) / 2));
    if (work.kind === 'outline') return Math.max(0, Math.min((proposal.length - work.length) / 2, (proposal.width - work.width) / 2));
    if (work.kind === 'mesh') return 0;
    // #1103 — a preset's cut-out or pocket: the proposal's margin each side.
    if (work.kind === 'cutout' || work.kind === 'pocket') {
      return Math.max(0, Math.min((proposal.length - work.length) / 2, (proposal.width - work.width) / 2));
    }
    return null;
  })();
  switch (choice.type) {
    case 'engrave':
      return { deepestCutMm: choice.depth, through: false, reachesEdgeWithinMm: margin };
    case 'surface':
      // The surfacing pass cuts the MARGIN around the mesh, so it reaches the blank's edge (the
      // analyst's correction: 0, not null — the pass is not a centred cut).
      return { deepestCutMm: choice.target?.size.z ?? 0, through: false, reachesEdgeWithinMm: 0 };
    case 'pcb':
      // The board's outline is cut through; the Gerber set writes its own items.
      return { deepestCutMm: thickness, through: true, reachesEdgeWithinMm: 0 };
    case 'flat':
      return { deepestCutMm: choice.depth, through: false, reachesEdgeWithinMm: null };
    case 'cutout':
      // #1103 — Cut out a shape goes through the blank, whatever its margin.
      return { deepestCutMm: thickness, through: true, reachesEdgeWithinMm: margin };
    case 'pocket':
      // #1103 — A preset pocket: its own depth (a bare chip with none states 0), not through.
      return { deepestCutMm: choice.depth ?? 0, through: false, reachesEdgeWithinMm: margin };
    case 'faces-all-round':
      // The flats are turned on a rod (the rotary mount), not seated in the vise.
      return { ...NOTHING };
    case 'cross-hole':
      // A cross-hole is drilled through; a rod, on the rotary.
      return { deepestCutMm: choice.diameter, through: true, reachesEdgeWithinMm: null };
    case 'outline':
      if (choice.use === 'profile') return { deepestCutMm: thickness, through: true, reachesEdgeWithinMm: 0 };
      return { deepestCutMm: choice.depth ?? 0, through: false, reachesEdgeWithinMm: margin };
  }
  // Unreachable for the union above; a new choice type lands here until its facts are stated.
  return { ...NOTHING };
}
