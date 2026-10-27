/**
 * The tape hold rule (#707 BM-4, `docs/design/bed-mounts-flow.md` §3.4).
 *
 * A cutter pushes the stock sideways with a force that grows with its BITE — its diameter times
 * the deepest pass's step-down — and the tape resists with the AREA it covers. So:
 *
 *     taped area  ≥  hold ratio × (cutter ⌀ × step-down)
 *
 * The hold ratio is `tape.holdRatio`, a shop setting (100 until a tape coupon at the bench
 * measures it, §7 — the one number in this rule that is not geometry). The rule is checked at
 * Generate, when the cutter and its passes are known, against THE STOCK and against EVERY PIECE a
 * through cut leaves free: a released piece that passes needs no tabs, which is why a bed job can
 * cut a part out clean.
 *
 * THIS MODULE IS THE ARITHMETIC AND THE WORDS. The areas are the caller's: the stock's is plain
 * geometry, but a freed piece's is a region only the worker's Manifold can measure (its footprint
 * eroded by the tape's inset), so a piece arrives measured.
 */

import type { JobFinding } from './jobSetup';
import type { TapeHold } from '@/types/engraveJob';

/** The area the tape covers under a part, mm²: its footprint, `inset` mm in from every edge. */
export function tapedArea(lengthMm: number, widthMm: number, insetMm: number): number {
  return Math.max(0, lengthMm - 2 * insetMm) * Math.max(0, widthMm - 2 * insetMm);
}

/** What the tape must cover against one cutter bite, mm²: `holdRatio × (⌀ × step-down)`. */
export function requiredHoldArea(holdRatio: number, diameterMm: number, stepDownMm: number): number {
  return holdRatio * diameterMm * stepDownMm;
}

/** A piece a through cut frees, as the worker measured it. */
export interface TapedPiece {
  /** The item's own name ("Star"), for the refusal's subject. */
  name: string;
  /** Its footprint, mm — the sentence quotes it ("a 12 × 12 mm piece"). */
  widthMm: number;
  heightMm: number;
  /** The tape under it, mm²: the footprint eroded by the job's tape inset. */
  tapedAreaMm2: number;
}

export interface TapeHoldInput {
  stock: { length: number; width: number; thickness: number };
  tape: TapeHold;
  /** The cutter's name in the operator's words — "flat end" in the design's sentence. */
  cutterWords: string;
  /**
   * The cutter's bite width at its deepest pass, mm (#405: a V-bit's groove is wider with depth,
   * so a cone answers its width at the job's deepest cut, not its tip). Null: no usable width,
   * and the rule cannot be judged — nothing is claimed.
   */
  biteDiameterMm: number | null;
  /** The deepest pass's step-down, mm. */
  stepDownMm: number;
  /** The shop's `tape.holdRatio`. */
  holdRatio: number;
  /** Every piece a through cut frees, as the worker measured it. */
  pieces: readonly TapedPiece[];
}

/** `2 462.02` — the design writes areas with two decimals (the Technical line quotes them). */
const area = (mm2: number): string => mm2.toFixed(2);
const dim = (n: number): string => String(Math.round(n * 1000) / 1000);

/**
 * The findings a taped job's hold raises — nothing when it holds. An ERROR for the stock and for
 * a freed piece whose tape is too small; a WARNING (never a blocker) for a block taller than its
 * narrowest width, which the same side load levers off tape at its top.
 *
 * Every refusal is the design's sentence, in the operator's words, with the numbers after it: the
 * sentence says what is wrong and what to do; the parenthetical is the arithmetic behind it ("2
 * 462.02 mm² taped; 50.00 mm² needed at 100 × the cutter's bite"), which the design puts in the
 * finding's Technical line — the engine's findings carry one string, so the numbers travel in it.
 */
export function tapeHoldFindings(input: TapeHoldInput): JobFinding[] {
  const findings: JobFinding[] = [];
  const { stock, tape } = input;

  // The tall-block note is geometry, not the bite: a block taller than it is wide is levered off
  // tape at the top by the same side load. A warning — the bracket and clamps are the fix.
  const narrowest = Math.min(stock.length, stock.width);
  if (stock.thickness > narrowest) {
    findings.push({
      severity: 'warning',
      code: 'tape-tall-stock',
      message:
        `The block is ${dim(stock.thickness)} mm tall and ${dim(narrowest)} mm wide: tape alone may ` +
        'let it tip — hold it in the bracket and clamps.',
    });
  }

  if (input.biteDiameterMm === null || !(input.biteDiameterMm > 0) || !(input.stepDownMm > 0)) {
    // No cutter width or no pass: the rule cannot be judged, and guessing either number would
    // refuse or pass a job on an invented figure. The rest of the findings still stand.
    return findings;
  }
  const need = requiredHoldArea(input.holdRatio, input.biteDiameterMm, input.stepDownMm);
  const bite = `the ⌀${dim(input.biteDiameterMm)} mm ${input.cutterWords}`;
  const numbers = `${area(need)} mm² needed at ${dim(input.holdRatio)} × the cutter’s bite.)`;

  const stockArea = tapedArea(stock.length, stock.width, tape.inset);
  if (stockArea < need) {
    findings.push({
      severity: 'error',
      code: 'tape-hold-stock',
      message:
        `The tape under this ${dim(stock.length)} × ${dim(stock.width)} mm plate cannot hold it ` +
        `against ${bite} — clamp it in the bracket, or cut it with a smaller cutter. ` +
        `(${area(stockArea)} mm² taped; ${numbers}`,
    });
  }

  for (const piece of input.pieces) {
    if (piece.tapedAreaMm2 >= need) continue;
    findings.push({
      severity: 'error',
      code: 'tape-hold-piece',
      message:
        `“${piece.name}” is cut free as a ${dim(piece.widthMm)} × ${dim(piece.heightMm)} mm piece; ` +
        `the tape under it cannot hold it against ${bite} — leave two tabs, or cut it with a ` +
        `smaller cutter. (${area(piece.tapedAreaMm2)} mm² taped; ${numbers}`,
    });
  }
  return findings;
}
