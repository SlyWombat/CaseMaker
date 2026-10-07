/**
 * The bare blank as a stock patch (issue #280) — the badge's twin (#271 route 1).
 *
 * `fromBadge.ts` established the shape: the blank a job is for is already in the project, so the
 * app should not ask anyone to retype it. A `case.blank` is exactly that object with the badge's
 * specifics stripped off — no pocket, no colour split — so what is left to carry across is the
 * one thing the archetype is: a slab of known size.
 *
 * What the blank knows, and in which frame:
 *
 *   - `width`/`height`/`thickness` are the blank's X, Y and Z, and they map straight onto
 *     `EngraveJob.stock`'s `length`/`width`/`thickness` (decision on naming in `types/blank.ts`).
 *   - The blank's outline is CENTRED on its own XY origin (`blankOutline`), while the job's stock
 *     is `rectProfile(length, width)` with the front-left corner at the origin — the same offset
 *     the badge documents. A blank has no voids of its own, so nothing here depends on it; it
 *     matters the moment a label is placed relative to the part.
 *   - The stock is the blank's bounding rectangle: `BlankParams.cornerRadius` is not represented,
 *     so a rounded blank reports its square-cornered extent (about 5.6 mm² of phantom material on
 *     the default R3 blank — the same approximation `fromBadge` makes).
 *
 * **What it deliberately does NOT carry: the material.** A badge is a 3D print on one filament, so
 * `fromBadge` can say PLA. A blank is whatever the operator put in the vise — softwood, MDF,
 * acrylic or aluminium — and this module cannot see the shop. So it patches the DIMENSIONS only,
 * leaving `stock.material` (and everything else) exactly as the user set it: feeding a wrong
 * material into `feedsFor` would silently pick the wrong feeds and spindle speed, which is a
 * safety-relevant guess rather than a convenience.
 *
 * This module is PURE and returns a patch, not a job: the caller decides what to do with it, and
 * `engraveJobStore` owns the write (and the `sources` stamping, #254).
 */

import type { BlankParams } from '@/types/blank';
import type { EngraveJob } from '@/types/engraveJob';

/** What the blank contributes — dimensions only, so the caller's material survives. */
export interface BlankStock {
  /** The blank's size in `EngraveJob.stock`'s shape, as a patch the store can merge. */
  stock: Pick<EngraveJob['stock'], 'length' | 'width' | 'thickness'>;
  /** One sentence per thing the blank set, for the panel to state back to the user. */
  notes: string[];
}

/** `100` rather than `100.00` — the notes are read, not parsed, so trailing zeros go. */
function mm(v: number): string {
  return `${Number(v.toFixed(3))}`;
}

/**
 * Read `blank` as the job's stock.
 *
 * Deliberately narrow, like `badgeBlankFor`: it does not touch labels, tool, vise, feeds,
 * `minFloor` or the material. The blank settles what the BLANK is; where the cut goes is the
 * user's business, and a label that no longer fits the new stock is reported by `validateJob`
 * as it always is, not silently moved.
 */
export function blankStockFor(blank: BlankParams): BlankStock {
  return {
    stock: { length: blank.width, width: blank.height, thickness: blank.thickness },
    notes: [
      `The blank, ${mm(blank.width)} × ${mm(blank.height)} × ${mm(blank.thickness)} mm, is now the stock ` +
        `(its bounding rectangle — the corner radii are not modelled here).`,
      'The material is left as you set it: a blank does not know what it is made of.',
    ],
  };
}
