/**
 * #1100 — THE PRESET CARDS' DEFAULT JOBS, as documents.
 *
 * One builder per preset that makes a job from its card's defaults, so the receipts spec and the
 * wizard describe the same work. The file cards (design, 3D part, Gerbers) have no default file
 * and the dowel needs a rod, so the receipted set is the three that make a job from numbers: A
 * sign or name plate, Cut out a shape, A pocket or tray.
 *
 * THE HOLD IS PART OF THE DEFAULT. A through cut is refused on the bare vise (proven on the
 * #1098 e2e: 322 depth errors without a board), so the Cut out a shape job carries the waste
 * board under it — the one radio the acceptance names. This is stated in the receipt, not hidden.
 */

import { blankLabelSeed, BLANK_BAND_FILL_FALLBACK } from '@/engine/cnc/engrave/blankLabelSeed';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { inkBoxOf } from '@/engine/cnc/engrave/inkBox';
import { labelGlyphMeasure } from '@/engine/cnc/engrave/partPlan';
import { proposeStock } from '@/engine/cnc/stockProposal';
import { readDefault } from '@/platform/defaultsClient';
import { applyHoldAnswers, defaultSetupAnswers } from '@/engine/cnc/engrave/setupFlow';
import { TAB_SETTINGS_FALLBACK } from '@/engine/cnc/cam/tabSettings';
import { DEFAULT_BOARD_MM, applyRecommendedMount, seatShopFrom } from '@/components/welcome/holdingMounts';
import { workFactsOf } from '@/components/welcome/workFacts';
import type { OperationChoice } from '@/components/welcome/OperationStep';
import type { StockProposal, WorkShape } from '@/engine/cnc/stockProposal';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import type { EngraveJob } from '@/types/engraveJob';

export type ReceiptPresetId = 'sign' | 'cutout' | 'pocket';

/** The demo document's line, cleared: a preset makes its own items. */
function bare(job: EngraveJob): EngraveJob {
  return {
    ...job,
    labels: [],
    shapes: [],
    traces: [],
    vectors: [],
    drills: [],
    cutouts: [],
    primitives: [],
    combined: [],
    keepOuts: [],
    targetObject: undefined,
  };
}

/** A preset plate, mm. */
function plateStock(length: number, width: number, thickness: number): EngraveJob['stock'] {
  return { length, width, thickness, material: 'hardwood' };
}

/**
 * #1103 item 8 — THE HOLD COMES FROM THE RECOMMENDATION, not from the default vise. The wizard's
 * Holding step arrives on the seat `applyRecommendedMount` computes from the work, so the preset's
 * default document is the same job only after the same seat is applied. The house's boards are not
 * read here (a preset carries the one board its own default names), so the typed default board is
 * the pool and the registry's fallbacks are the recommendation's chosen numbers.
 */
function seatedByRecommendation(job: EngraveJob, choice: OperationChoice, work: WorkShape | null): EngraveJob {
  const proposal: StockProposal = {
    form: 'block',
    material: job.stock.material,
    length: job.stock.length,
    width: job.stock.width,
    thickness: job.stock.thickness,
    finish: 'finished',
    sentence: '',
  };
  const seated = applyRecommendedMount(
    defaultSetupAnswers(job),
    DEFAULT_BOARD_MM,
    workFactsOf(choice, proposal, work),
    [],
    seatShopFrom(null),
  );
  return applyHoldAnswers(job, seated);
}

export function presetDefaultJob(id: ReceiptPresetId): EngraveJob {
  const base = bare(defaultEngraveJob());
  switch (id) {
    case 'sign': {
      // #1100 item 3 — THE SIGN SIZES ITS OWN PLATE: the card's default medium letter (35 mm cap
      // height), its line's measured extent, and the shop's sign margin on every side. The line
      // is laid at that cap height (the field the panel's Size control edits).
      const sizeMm = 35;
      const measure = labelGlyphMeasure([]);
      const box = inkBoxOf('Hello', DEFAULT_FONT_ID, 'bold', sizeMm, measure);
      const work: WorkShape = { kind: 'text', size: { length: box.width, width: box.height }, depth: 0.5, sign: true };
      const signMarginMm = readDefault(null, 'stock.signMarginMm').value;
      const proposal = proposeStock(work, { signMarginMm })!;
      const stock = plateStock(proposal.length, proposal.width, proposal.thickness);
      const seeded =
        blankLabelSeed({
          blank: { length: stock.length, width: stock.width, pocket: null },
          edgeMargin: base.edgeMargin,
          text: 'Hello',
          font: DEFAULT_FONT_ID,
          weight: 'bold',
          depth: 0.5,
          textAlong: 'x',
          bandFill: BLANK_BAND_FILL_FALLBACK,
          measure,
          avoid: [],
        }) ?? null;
      // The card states the size; the seed's position centres the ink, so the size is stamped on.
      const label = seeded === null ? null : { ...seeded, size: sizeMm };
      const job = { ...base, name: 'preset-sign', stock, labels: label === null ? [] : [label] };
      const choice: OperationChoice = { type: 'engrave', text: 'Hello', depth: 0.5, font: DEFAULT_FONT_ID, sizeMm };
      return seatedByRecommendation(job, choice, work);
    }
    case 'cutout': {
      const stock = plateStock(80, 60, 12);
      const shape = {
        id: 'preset-cutout-shape',
        kind: 'rect' as const,
        width: 60,
        height: 40,
        cornerRadius: 3,
        position: { x: stock.length / 2, y: stock.width / 2 },
        rotation: 0,
        depth: 0.5,
        enabled: true,
        // The region is the part's outline: the cutout does the freeing, not a pocket of the shape.
        construction: true,
      };
      const job: EngraveJob = {
        ...base,
        name: 'preset-cutout',
        stock,
        shapes: [shape],
        cutouts: [
          {
            kind: 'cutout',
            id: 'preset-cutout',
            enabled: true,
            of: shape.id,
            side: 'outside',
            inset: 0,
            tabs: { count: TAB_SETTINGS_FALLBACK.count, width: TAB_SETTINGS_FALLBACK.widthMm, height: TAB_SETTINGS_FALLBACK.heightMm },
          },
        ],
        // The one radio the cut needs: a waste board under the part. The recommendation leaves it
        // alone (a saved board is the operator's, not replaced).
        sacrificial: {
          under: { thickness: 6, overhang: { left: 5, right: 5, front: 5, back: 5 }, attach: 'tape' },
          sides: { left: null, right: null, front: null, back: null },
          source: 'default' as const,
        },
      };
      return seatedByRecommendation(
        job,
        { type: 'cutout', shape: 'rect', length: shape.width, width: shape.height, radius: shape.cornerRadius },
        { kind: 'cutout', length: shape.width, width: shape.height },
      );
    }
    case 'pocket': {
      const stock = plateStock(80, 60, 12);
      const shape = {
        id: 'preset-pocket',
        kind: 'rect' as const,
        width: 60,
        height: 40,
        cornerRadius: 3,
        position: { x: stock.length / 2, y: stock.width / 2 },
        rotation: 0,
        depth: 6,
        enabled: true,
      };
      const job = { ...base, name: 'preset-pocket', stock, shapes: [shape] };
      return seatedByRecommendation(
        job,
        { type: 'pocket', length: shape.width, width: shape.height, depth: shape.depth },
        { kind: 'pocket', length: shape.width, width: shape.height, depth: shape.depth },
      );
    }
  }
}
