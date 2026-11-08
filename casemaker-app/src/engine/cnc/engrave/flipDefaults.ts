/**
 * #1073 — THE DEFAULTS THE FLIP CHOICE OPENS ON, WITH THEIR REASONS (6b's amendment C).
 *
 * The offer opens the Setups step with the planner's proposal PRE-SELECTED and writes nothing;
 * these are that proposal, and each line prints under the graphic so the operator can see why.
 *
 * METHOD: `tabs-in-blank` (the frame). It cuts the board less — the maintainer's own reading of
 * option 2 — and it holds any outline, where the vendor method needs the freed part to have a
 * straight edge long enough to pose against the arms.
 *
 * AXIS: the one under which the MOST stated-square edges meet the bracket's two arms (the front
 * and the left in side 2's work frame). A left↔right flip puts side 1's front and RIGHT edges on
 * the arms; a front↔back flip puts side 1's BACK and left edges there. An edge is square only
 * when both its corners are stated square (absent `stock.squareCorners` reads all four, so both
 * flips tie at two). A TIE — including the maintainer's one-right-angle blank, where neither axis
 * puts a square edge on the arms — goes left↔right: the front edge stays on the front arm.
 *
 * These are a PROPOSAL, never a write: the operator's choice is what the setup stores.
 */
import type { SetupFlip, StockCorner } from '@/types/engraveJob';

import { squareCornersOf } from './flipChoice';

export interface FlipDefault {
  method: SetupFlip['method'];
  axis: SetupFlip['axis'];
  /** One line under the graphic, for the method. */
  methodReason: string;
  /** One line under the graphic, for the axis. */
  axisReason: string;
}

const METHOD_REASON =
  'keep the part in the blank on tabs: it cuts the board less, and it holds any outline';

/** How many of the two named edges are square — both corners of an edge stated square. */
function squareEdges(square: ReadonlySet<StockCorner>, edges: readonly (readonly [StockCorner, StockCorner])[]): number {
  return edges.filter(([a, b]) => square.has(a) && square.has(b)).length;
}

export function defaultFlip(stock: { squareCorners?: readonly StockCorner[] }): FlipDefault {
  const square = new Set(squareCornersOf(stock.squareCorners));
  // What each flip lays against the arms: left↔right carries side 1's FRONT and RIGHT edges over;
  // front↔back carries its BACK and LEFT edges.
  const leftRightEdges = [['FL', 'FR'], ['FR', 'BR']] as const;
  const frontBackEdges = [['BL', 'BR'], ['FL', 'BL']] as const;
  const lr = squareEdges(square, leftRightEdges);
  const fb = squareEdges(square, frontBackEdges);
  const axis: SetupFlip['axis'] = fb > lr ? 'front-back' : 'left-right';
  const axisReason =
    lr === fb
      ? `left↔right: neither flip puts more square edges on the arms (${lr} of 2 each), so the front edge stays on the front arm`
      : axis === 'front-back'
        ? `front↔back: it puts ${fb} of the blank’s square edges on the arms, where left↔right leaves ${lr}`
        : `left↔right: it puts ${lr} of the blank’s square edges on the arms, where front↔back leaves ${fb}`;
  return { method: 'tabs-in-blank', axis, methodReason: METHOD_REASON, axisReason };
}
