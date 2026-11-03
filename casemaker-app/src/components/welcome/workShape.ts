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
import type { StockItem } from '@/platform/stockClient';

/** A millimetre figure as the step's sentences print it: at most two decimals, zeros dropped. */
const mm = (v: number): string => String(Number(v.toFixed(2)));
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

/**
 * #M1R §3.4 — THE HOUSE STOCK IS THE SHELF'S, NOT A CONSTANT. The house's stick is a SHOP fact (the
 * location's `/stock`), and the app already loads it (`useStockStore`); a hard-coded 36 × 100 × 36
 * asserts a blank the shelf may not hold, and would keep asserting it after the shop changed. This
 * reads the shelf's own planed hardwood block — the M1 stick the bench cuts — and the sentence names
 * the entry, so the wizard says where the blank came from rather than what a constant remembers.
 *
 * `null` when the shelf has no such entry: the caller then falls back to {@link houseStockProposal},
 * which STATES the fallback. A shelf that has not loaded yet is indistinguishable from an empty one
 * here — the wizard re-proposes when it does, and a job already started is never re-seeded.
 */
export function shelfHouseStockProposal(items: readonly StockItem[]): StockProposal | null {
  const entry = items.find(
    (s) =>
      s.material === 'hardwood' &&
      s.form === 'block' &&
      s.finish === 'finished' &&
      s.size.length != null &&
      s.size.width != null &&
      s.size.thickness != null,
  );
  if (entry === undefined) return null;
  const length = entry.size.length as number;
  const width = entry.size.width as number;
  const thickness = entry.size.thickness as number;
  return {
    form: 'block',
    material: 'hardwood',
    length,
    width,
    thickness,
    finish: 'finished',
    sentence:
      `The shelf’s stock: “${entry.id}”, a ${mm(length)} × ${mm(thickness)} × ${mm(width)} mm hardwood block, ` +
      `planed, worked on its ${mm(length)} × ${mm(width)} face.`,
  };
}

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
  /** The location's shelf, as the wizard has it: the house stock is a shop fact (#M1R §3.4). */
  shelf: readonly StockItem[] = [],
): StockProposal | null {
  if (work.kind === 'mesh' || work.kind === 'pcb') return proposed;
  if (rotaryMapOf(job) !== null) return proposed;
  return shelfHouseStockProposal(shelf) ?? houseStockProposal();
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

/** What this step's answer is, for the stock proposal. */
export function workShapeFor(choice: OperationChoice | null, job: EngraveJob): WorkShape {
  if (choice === null) return { kind: 'none' };
  // A ROD in the chuck is sized by its own start (the dowel/template flow), not by its goal's box.
  if (rotaryMapOf(job) !== null) return { kind: 'none' };
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
    case 'engrave': {
      if (choice.text.trim() === '') return { kind: 'none' };
      // Measured where the face is up, and `inkBoxOf`'s documented upper-bound estimate until it is
      // (the wizard asks for the face as the line changes; a cold first render sizes a generous
      // blank rather than none at all).
      const box = inkBoxOf(
        choice.text,
        choice.font,
        'bold',
        PROPOSED_TEXT_SIZE_MM,
        labelGlyphMeasure(job.customFonts ?? []),
      );
      return { kind: 'text', size: { length: box.width, width: box.height }, depth: choice.depth };
    }
    default:
      return { kind: 'none' };
  }
}
