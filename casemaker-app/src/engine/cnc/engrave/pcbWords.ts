/**
 * #743 P-5/P-6 — THE COPPER'S SENTENCE, shared by the Cut confirm and the run sheet, so the two
 * cannot word one verdict two ways.
 *
 * #743 P-8 — A TWO-SIDED BOARD IS ONE VERDICT PER FACE. The run report's `sides` carry each
 * face's own counts, and the sentence names the faces and the one that failed; a single-sided
 * board keeps the sentence it has always had.
 *
 * Its own module, and its only import is a TYPE: `store/engraveRunGate.ts` prints this sentence,
 * and that module must stay loadable outside a browser (a node script imports its gates), which
 * `pcbTopology.ts` — the module that computes the report — is not promised to be.
 */
import type { CopperTopologyReport, CopperTopologyCounts } from './pcbTopology';

/** `0.452` — the sheet's own figure: three decimals at most, trailing zeros dropped. */
function figure(n: number): string {
  return String(Number(n.toFixed(3)));
}

/** The operator's name for a face the board is cut from. */
function faceWords(face: string): string {
  return face === 'top' ? 'the top face' : face === 'bottom' ? 'the bottom face' : `the ${face} face`;
}

/** `2 pieces, 2 of 2 still there, no short` — and the stray copper when there is some. */
function counts(c: CopperTopologyCounts, floorMm: number): string {
  const pieces = `${c.pieces} piece${c.pieces === 1 ? '' : 's'}`;
  const still = `${c.matched} of ${c.designPieces} still there`;
  const short = c.shorts === 0 ? 'no short' : `${c.shorts} short${c.shorts === 1 ? '' : 's'}`;
  const left = c.bandLeftMm2 > floorMm ? `, ${figure(c.bandLeftMm2)} mm² of copper left in the isolation` : '';
  return `${pieces}, ${still}, ${short}${left}`;
}

export function copperSentence(copper: CopperTopologyReport, floorMm = 0.001): string {
  const sides = copper.sides ?? [];
  if (sides.length > 1) {
    const per = sides.map((s) => `${faceWords(s.face)}: ${counts(s, floorMm)}`).join('; ');
    const failing = sides.filter((s) => !s.ok);
    return failing.length === 0
      ? `The copper came out as designed on both faces — ${per}.`
      : `The copper does not match the design on ${failing.map((s) => faceWords(s.face)).join(' and ')} — ${per}.`;
  }
  const single = sides.length === 1 ? sides[0]! : copper;
  return single.ok
    ? `The copper came out as designed: ${counts(single, floorMm)}.`
    : `The copper does not match the design: ${counts(single, floorMm)}.`;
}
