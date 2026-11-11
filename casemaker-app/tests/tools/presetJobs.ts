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
import { labelGlyphMeasure } from '@/engine/cnc/engrave/partPlan';
import { TAB_SETTINGS_FALLBACK } from '@/engine/cnc/cam/tabSettings';
import { HOUSE_STOCK } from '@/components/welcome/workShape';
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

/** The house's stick, as the sign's proposal (a block worked on its 36 × 100 face). */
function stickStock(): EngraveJob['stock'] {
  return {
    length: HOUSE_STOCK.length,
    width: HOUSE_STOCK.width,
    thickness: HOUSE_STOCK.thickness,
    material: HOUSE_STOCK.material,
  };
}

/** A preset plate, mm. */
function plateStock(length: number, width: number, thickness: number): EngraveJob['stock'] {
  return { length, width, thickness, material: 'hardwood' };
}

export function presetDefaultJob(id: ReceiptPresetId): EngraveJob {
  const base = bare(defaultEngraveJob());
  switch (id) {
    case 'sign': {
      const stock = stickStock();
      // The same fit the store's addEngraveText runs: the line is sized to the blank's band.
      const label =
        blankLabelSeed({
          blank: { length: stock.length, width: stock.width, pocket: null },
          edgeMargin: base.edgeMargin,
          text: 'Hello',
          font: DEFAULT_FONT_ID,
          weight: 'bold',
          depth: 0.5,
          textAlong: 'x',
          bandFill: BLANK_BAND_FILL_FALLBACK,
          measure: labelGlyphMeasure([]),
          avoid: [],
        }) ?? null;
      return { ...base, name: 'preset-sign', stock, labels: label === null ? [] : [label] };
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
      return {
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
        // The one radio the cut needs: a waste board under the part.
        sacrificial: {
          under: { thickness: 6, overhang: { left: 5, right: 5, front: 5, back: 5 }, attach: 'tape' },
          sides: { left: null, right: null, front: null, back: null },
          source: 'default',
        },
      };
    }
    case 'pocket': {
      const stock = plateStock(80, 60, 12);
      return {
        ...base,
        name: 'preset-pocket',
        stock,
        shapes: [
          {
            id: 'preset-pocket',
            kind: 'rect',
            width: 60,
            height: 40,
            cornerRadius: 3,
            position: { x: stock.length / 2, y: stock.width / 2 },
            rotation: 0,
            depth: 6,
            enabled: true,
          },
        ],
      };
    }
  }
}
