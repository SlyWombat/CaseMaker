/**
 * #897 — THE WORK, IN THE TERMS A BLANK IS SIZED FROM.
 *
 * The wizard asks what is being cut before it asks for a blank, so the step's answer is read here
 * into the neutral {@link WorkShape} `stockProposal.ts` sizes a blank from. A mesh gives its box, a
 * board its outline, a line of text its measured extent at the size the proposal starts from (the
 * blank's own fit later enlarges or shrinks the line); anything else proposes nothing and keeps
 * today's default stock.
 */

import { inkBoxOf } from '@/engine/cnc/engrave/inkBox';
import { labelGlyphMeasure } from '@/engine/cnc/engrave/partPlan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { isShippedDemoLabelSet } from '@/engine/cnc/engrave/blankLabelSeed';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { WORK_STOCK_MATERIAL, type StockProposal, type WorkShape } from '@/engine/cnc/stockProposal';
import type { EngraveJob } from '@/types/engraveJob';
import type { OperationChoice } from './OperationStep';

/** The cap height a proposed blank is sized for, mm; the label's own fit resizes the line to it. */
export const PROPOSED_TEXT_SIZE_MM = 10;

/**
 * #930 — THE HOUSE'S STOCK, in one place: a 36 × 36 × 100 mm hardwood stick, the shop's material
 * (maintainer, 2026-11-02) and the blank the milestone's samples are cut on.
 *
 * The wizard PROPOSES this for work that does not size its own blank (a line of text, a pocket,
 * a chamfer …). Before #930 a line of text proposed a plate sized from its ink — 60.3 × 20.1 ×
 * 1.5 mm for "Zoomba" — which the wizard's own facing pass then drove into the vise jaws, and the
 * pocket proposed nothing at all. A first job is cut from the stick the shop has on the shelf, so
 * that is what the blank step opens on; the operator can change every number.
 *
 * THE STICK LIES ALONG THE JAWS: 100 mm along Y (the jaws are 100 mm long, a calipered product
 * constant), 36 mm along X (between them). The other way round — 100 mm between the jaws — would
 * need a maximum opening nobody has measured, so only this orientation rests on known numbers.
 * That is the `block` form, worked on its 36 × 100 face; its 36 mm height puts it on the vise's
 * body (16 mm above the jaw tops) rather than on the 3.1 mm ledge.
 */
export const HOUSE_STOCK = {
  form: 'block' as const,
  material: 'hardwood' as const,
  length: 36,
  width: 100,
  thickness: 36,
} as const;

/** The blank step's proposal for the house stock, with the sentence that says where it came from. */
export function houseStockProposal(): StockProposal {
  return {
    ...HOUSE_STOCK,
    // #934 — THE STICKS ARE TAKEN AS PLANED STOCK (maintainer, 2026-11-02): a finished face is cut
    // as it is, so the first-job path does not face — and the post-facing re-touch, which this
    // milestone hides until its bench run, is not on it. The operator can still choose "as bought".
    finish: 'finished',
    sentence: 'The house’s stock: a 36 × 36 × 100 mm hardwood stick, worked on its 36 × 100 face.',
  };
}

/**
 * #930 — the blank a new job is proposed: the work's own when it sizes one (a mesh's box, a
 * board's outline), the house's stick for everything else. A job already held in the rotary chuck
 * keeps its own start (`workShapeFor` answers `none` for it), so nothing here invents a stick.
 */
export function proposedStockFor(
  work: WorkShape,
  job: EngraveJob,
  proposed: StockProposal | null,
): StockProposal | null {
  // #1098 — a drawing is work that sizes its own blank, exactly as a mesh or a board does.
  // #1100 — a cut-out and a pocket size their own too (the presets' proposals).
  // #1107 — a rod answer sizes the rod.
  if (
    work.kind === 'mesh' ||
    work.kind === 'pcb' ||
    work.kind === 'outline' ||
    work.kind === 'cutout' ||
    work.kind === 'pocket' ||
    work.kind === 'rod'
  ) {
    return proposed;
  }
  if (rotaryMapOf(job) !== null) return proposed;
  return houseStockProposal();
}

/**
 * The material a proposed blank opens on.
 *
 * #897 — the house's own (hardwood, #879) for a job that has not said otherwise; a job that STATES
 * a material keeps it, exactly as the stock step's own opening rule does — the proposal sizes the
 * blank, it does not overrule the piece the operator has already named. A board's blank is the
 * exception: copper-clad IS what the work is, and the import does not restate it.
 */
export function proposedMaterialFor(
  proposal: StockProposal,
  job: EngraveJob,
): EngraveJob['stock']['material'] {
  if (proposal.material === 'pcb') return 'pcb';
  const shipped = defaultEngraveJob();
  const untouchedDemo = isShippedDemoLabelSet(job) && job.stock.material === shipped.stock.material;
  return untouchedDemo ? WORK_STOCK_MATERIAL : job.stock.material;
}

/**
 * #1099 — THE PART'S FOOTPRINT, in the terms the blanks' drawings use. One reading from the
 * question's answer, so the thumbnail, the Stock step's blank and the Holding top view all draw
 * the same part rather than three near-copies of it.
 */
export interface PartFootprint {
  kind: 'mesh' | 'outline' | 'text' | 'pcb';
  length: number;
  width: number;
  /** How far it stands above the blank's top (a mesh's Z, a line's depth); null when none. */
  height: number | null;
}

export function partFootprintFor(work: WorkShape): PartFootprint | null {
  switch (work.kind) {
    case 'mesh':
      return { kind: 'mesh', length: work.size.x, width: work.size.y, height: work.size.z };
    case 'text':
      return { kind: 'text', length: work.size.length, width: work.size.width, height: work.depth };
    case 'pcb':
      return { kind: 'pcb', length: work.outline.length, width: work.outline.width, height: null };
    default:
      return null;
  }
}

/** What this step's answer is, for the stock proposal. */
export function workShapeFor(choice: OperationChoice | null, job: EngraveJob): WorkShape {
  if (choice === null) return { kind: 'none' };
  // A ROD in the chuck is sized by its own start (the dowel/template flow), not by its goal's box.
  if (rotaryMapOf(job) !== null) return { kind: 'none' };
  // #1107 — a ROD INTENT on a flat run: the blank the question asks for is the rod. A relief's
  // diameter is the mesh's own section (the smaller side), not an invented 20 mm.
  if ('frame' in choice && choice.frame === 'rotary') {
    if (choice.type === 'surface' && choice.target !== null) {
      const section = Math.min(choice.target.size.x, choice.target.size.y);
      const diameter = Math.max(3, Math.round(section * 10) / 10);
      return { kind: 'rod', diameter, length: 100 };
    }
    return { kind: 'rod', diameter: 20, length: 100 };
  }
  switch (choice.type) {
    case 'surface':
      return choice.target === null ? { kind: 'none' } : { kind: 'mesh', size: choice.target.size };
    case 'pcb':
      return choice.board === undefined
        ? { kind: 'none' }
        : {
            kind: 'pcb',
            outline: choice.board,
            // The blank the set was laid on — the import centres the board's items on it, so the
            // proposal keeps that size rather than leaving the items off a tighter piece.
            laidOn: { length: job.stock.length, width: job.stock.width },
          };
    case 'outline':
      // #1098 — the drawing's extent in mm, as the importer measured it. Cut it out is the one
      // use that needs the blank to be a plate the profile can free the part from.
      return { kind: 'outline', length: choice.outline.width, width: choice.outline.height, through: choice.use === 'profile' };
    case 'cutout':
      // #1100 — the shape the card drew, through the blank.
      return { kind: 'cutout', length: choice.length, width: choice.width };
    case 'pocket':
      // A bare pocket chip carries no numbers (it keeps the house's stick); the preset's does.
      return choice.length === undefined || choice.width === undefined || choice.depth === undefined
        ? { kind: 'none' }
        : { kind: 'pocket', length: choice.length, width: choice.width, depth: choice.depth };
    case 'engrave': {
      if (choice.text.trim() === '') return { kind: 'none' };
      // Measured where the face is up, and `inkBoxOf`'s documented upper-bound estimate until it is
      // (the wizard asks for the face as the line changes; a cold first render sizes a generous
      // blank rather than none at all).
      const box = inkBoxOf(
        choice.text,
        choice.font,
        'bold',
        // #1100 — the sign card's letter size is the size the blank is sized for; the other
        // engrave entries keep the proposal's documented 10 mm cap.
        choice.sizeMm ?? PROPOSED_TEXT_SIZE_MM,
        labelGlyphMeasure(job.customFonts ?? []),
      );
      return { kind: 'text', size: { length: box.width, width: box.height }, depth: choice.depth };
    }
    default:
      return { kind: 'none' };
  }
}
