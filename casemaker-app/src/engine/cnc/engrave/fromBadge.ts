/**
 * The badge blank as a stock-and-void patch (#271 route 1, #167, #174).
 *
 * #271 found `EngraveJob.keepOuts` with consumers and no producer. The panel row is route 2 — a
 * void the user types. This is route 1, the one V1 actually needs: the blank the job is for is
 * already in the project as `case.badge`, so the app should not ask anyone to retype its
 * pocket.
 *
 * What the badge knows, and in which frame:
 *
 *   - `width`/`height`/`thickness` are the badge's own X, Y and Z, and the job's stock is the
 *     blank TURNED a quarter turn from them (#383): the vise closes across the blank's 38.1 mm
 *     span, so that side runs across the jaws in X and the 76.2 mm side runs along them, in Y —
 *     the same `ccw` quarter turn `fromDesign.ts` gives the 3MF route, so both routes put the
 *     blank on the bench the same way. `job_x = height − y_badge`, `job_y = x_badge`.
 *   - The badge's outline is CENTRED on its own XY origin (`badgeOutline`), and the job's stock is
 *     `rectProfile(length, width)` with the FRONT-LEFT corner at the origin (`toPartPlan`), so the
 *     blank's centre — where the model puts the pocket — lands at (length/2, width/2), which in
 *     the badge's own numbers is (height/2, width/2). The job document has no outline field, so
 *     the stock is the blank's bounding rectangle: the four corner radii are not represented
 *     (they cost about 5.6 mm² of phantom material on the default blank).
 *   - `magnetPocket.depth` is measured from the badge's BACK face, and `zCeiling` is measured from
 *     the blank's BOTTOM face — the same face, because the blank is machined **pocket-down,
 *     engraved face up to the cutter** (/Fabrication.md §7.2). So `zCeiling` is `pocket.depth`
 *     verbatim, and the membrane comes out as `thickness − depth` — 1.51 mm on the default
 *     3.81 mm blank with its 2.3 mm pocket, the number §7.2 names.
 *   - The pocket is CENTRED on the outline and `BadgeMagnetPocket` has no offset, so the flip that
 *     machining requires cannot move it: a mirror about either in-plane axis maps the centre to
 *     itself. Nothing here depends on which way the operator turns the blank over. The quarter
 *     turn above does move its EXTENTS though — `pocket.length` runs along the badge's X, so on
 *     the blank it is the Y extent of the rect.
 *   - `splitHeight` and the badge's own `print` (#166) travel into `EngraveJob.stock.colour` when
 *     the badge states one (#285/#492), as `{ kind: 'printed', capMm: thickness − splitHeight, … }`.
 *     That is the switch that puts the colour boundary into the depth model; a badge without a
 *     print leaves the job's limit analytic and its `.nc` unchanged.
 *
 * This module is PURE and returns a patch, not a job: the caller decides what to do with it, and
 * `engraveJobStore` owns the write (and the `sources` stamping, #254).
 */

import type { BadgeParams } from '@/types/badge';
import type { EngraveJob, EngraveKeepOut } from '@/types/engraveJob';

/**
 * The id the badge's pocket is declared under. FIXED, not `newEngraveKeepOutId()`: the badge
 * describes one blank, so applying it twice must land on the same void rather than a second copy
 * of it — and the id is how "the void the badge put there" is told apart from one the user typed
 * (`ko-…`), so removing a stale pocket can never remove the user's.
 */
export const BADGE_POCKET_KEEP_OUT_ID = 'badge-magnet-pocket';

/** What the badge contributes, as plain data for the store to write. */
export interface BadgeBlank {
  /** The badge's blank, in `EngraveJob.stock`'s own shape. Always PLA (decision 13, §7.2). */
  stock: EngraveJob['stock'];
  /** The blank's magnet pocket, or null when the badge model declares none. */
  pocket: EngraveKeepOut | null;
  /** One sentence per thing the badge set, for the panel to state back to the user. */
  notes: string[];
}

/** `76.2` rather than `76.2…` — the notes are read, not parsed, so trailing zeros go. */
function mm(v: number): string {
  return `${Number(v.toFixed(3))}`;
}

/**
 * The blank's colour facts, in `EngraveJob.stock`'s shape, or `undefined` when the badge states
 * none (#285/#492).
 *
 * This is the switch the whole colour-boundary path hangs off. `EngraveJob.stock.colour` is what
 * makes the app slice the compiled solid on the printer's layer grid instead of trusting a
 * nominal design height — so it is written ONLY when the badge actually declares its print
 * (`BadgeParams.print`, #166). A badge that does not leaves the job's depth limit analytic and
 * its `.nc` byte-identical to before.
 *
 * The cap travels with it: the job is a standalone document and must not have to look back at
 * the project's badge to know where its colour boundary is. `capMm` is measured from the engraved
 * (top) face, and the badge's `splitHeight` is from the bottom, so they are complements about
 * `thickness` (#492).
 *
 * The key is always present, `undefined` when the badge states no print (#285 review). It is the
 * difference between "this blank states no colour facts" and "this patch says nothing about them":
 * `setStock` clears on the first and leaves alone on the second, so "Use the badge blank" on a badge
 * that has lost its print can take a stale layer grid away.
 */
function stockColourFor(badge: BadgeParams): EngraveJob['stock']['colour'] {
  if (!badge.print) return undefined;
  return {
    kind: 'printed',
    capMm: badge.thickness - badge.splitHeight,
    layerHeight: badge.print.layerHeight,
    firstLayerHeight: badge.print.firstLayerHeight,
  };
}

/**
 * Read `badge` as the job's blank: its stock, and the void its model already has.
 *
 * Deliberately narrow — it does not touch labels, tool, vise, feeds or `minFloor`. The badge
 * settles what the BLANK is; where the text goes is the user's business, and a label that no
 * longer fits the smaller blank is reported by `validateJob` as it always is, not silently moved.
 *
 * The stock is the badge's blank TURNED a quarter turn (#383), the `ccw` one `fromDesign.ts`
 * applies: the bench holds a badge with its 38.1 mm side across the jaws, so that side is X and
 * the 76.2 mm side runs along the feed, in Y. This is not a mirror — a badge has no front/back
 * asymmetry the turn could break — so the only thing it changes is which field each span lands in;
 * the notes say so, because a person reading "38.1 × 76.2" against the badge's own 76.2 × 38.1 is
 * owed the reason.
 */
export function badgeBlankFor(badge: BadgeParams): BadgeBlank {
  const pocket = badge.magnetPocket;
  const colour = stockColourFor(badge);
  const notes = [
    `The badge's blank, ${mm(badge.height)} × ${mm(badge.width)} × ${mm(badge.thickness)} mm PLA, ` +
      `is now the stock (its bounding rectangle — the corner radii are not modelled here), turned ` +
      `a quarter turn to sit in the vise: the ${mm(badge.width)} mm side now runs along Y.`,
  ];

  if (colour) {
    notes.push(
      `The blank's print came with it: a ${mm(badge.splitHeight)} mm colour split, ` +
        `a ${mm(colour.capMm)} mm top colour` +
        (colour.layerHeight === undefined ? '' : `, at ${mm(colour.layerHeight)} mm layers`) +
        ', so the colour boundary is measured on the printer’s own layer grid rather than at the ' +
        'nominal height.',
    );
  }

  // #496 — no dome comes with the badge. A bow belongs to the piece as clamped, not to the part
  // number it was printed as, so the job states one only after its own surface has been measured.

  if (!pocket) {
    notes.push('This badge has no magnet pocket, so no void was declared.');
    return {
      stock: {
        length: badge.height,
        width: badge.width,
        thickness: badge.thickness,
        material: 'pla',
        colour,
      },
      pocket: null,
      notes,
    };
  }

  const membrane = badge.thickness - pocket.depth;
  notes.push(
    `Magnet pocket ${mm(pocket.width)} × ${mm(pocket.length)} mm, its ceiling ${mm(pocket.depth)} mm up ` +
      `from the blank's BOTTOM face: ${mm(membrane)} mm of material is left over it.`,
  );

  return {
    stock: {
      length: badge.height,
      width: badge.width,
      thickness: badge.thickness,
      material: 'pla',
      colour,
    },
    pocket: {
      id: BADGE_POCKET_KEEP_OUT_ID,
      name: 'Magnet pocket',
      kind: 'rect',
      position: { x: badge.height / 2, y: badge.width / 2 },
      rotation: 0,
      enabled: true,
      zCeiling: pocket.depth,
      width: pocket.width,
      height: pocket.length,
      cornerRadius: 0,
    },
    notes,
  };
}
