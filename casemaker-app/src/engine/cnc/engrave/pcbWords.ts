/**
 * #743 P-5/P-6 — THE COPPER'S SENTENCE, shared by the Cut confirm and the run sheet, so the two
 * cannot word one verdict two ways.
 *
 * Its own module, and its only import is a TYPE: `store/engraveRunGate.ts` prints this sentence,
 * and that module must stay loadable outside a browser (a node script imports its gates), which
 * `pcbTopology.ts` — the module that computes the report — is not promised to be.
 */
import type { CopperTopologyReport } from './pcbTopology';

/** `0.452` — the sheet's own figure: three decimals at most, trailing zeros dropped. */
function figure(n: number): string {
  return String(Number(n.toFixed(3)));
}

export function copperSentence(copper: CopperTopologyReport, floorMm = 0.001): string {
  const pieces = `${copper.pieces} piece${copper.pieces === 1 ? '' : 's'}`;
  const still = `${copper.matched} of ${copper.designPieces} still there`;
  const short = copper.shorts === 0 ? 'no short' : `${copper.shorts} short${copper.shorts === 1 ? '' : 's'}`;
  const left = copper.bandLeftMm2 > floorMm ? `, ${figure(copper.bandLeftMm2)} mm² of copper left in the isolation` : '';
  return copper.ok
    ? `The copper came out as designed: ${pieces}, ${still}, ${short}${left}.`
    : `The copper does not match the design: ${pieces}, ${still}, ${short}${left}.`;
}
