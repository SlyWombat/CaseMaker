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
 *   - `width`/`height`/`thickness` are the blank's X, Y and Z. The badge's outline is CENTRED on
 *     its own XY origin (`badgeOutline`), and the job's stock is `rectProfile(length, width)` with
 *     the FRONT-LEFT corner at the origin (`toPartPlan`), so the blank's centre — where the model
 *     puts the pocket — lands at (length/2, width/2). The job document has no outline field, so
 *     the stock is the blank's bounding rectangle: the four corner radii are not represented
 *     (they cost about 5.6 mm² of phantom material on the default blank).
 *   - `magnetPocket.depth` is measured from the badge's BACK face, and `zCeiling` is measured from
 *     the blank's BOTTOM face — the same face, because the blank is machined **pocket-down,
 *     engraved face up to the cutter** (/Fabrication.md §7.2). So `zCeiling` is `pocket.depth`
 *     verbatim, and the membrane comes out as `thickness − depth` — 1.51 mm on the default
 *     3.81 mm blank with its 2.3 mm pocket, the number §7.2 names.
 *   - The pocket is CENTRED on the outline and `BadgeMagnetPocket` has no offset, so the flip that
 *     machining requires cannot move it: a mirror about either in-plane axis maps the centre to
 *     itself. Nothing here depends on which way the operator turns the blank over.
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
 * Read `badge` as the job's blank: its stock, and the void its model already has.
 *
 * Deliberately narrow — it does not touch labels, tool, vise, feeds or `minFloor`. The badge
 * settles what the BLANK is; where the text goes is the user's business, and a label that no
 * longer fits the smaller blank is reported by `validateJob` as it always is, not silently moved.
 */
export function badgeBlankFor(badge: BadgeParams): BadgeBlank {
  const pocket = badge.magnetPocket;
  const notes = [
    `The badge's blank, ${mm(badge.width)} × ${mm(badge.height)} × ${mm(badge.thickness)} mm PLA, ` +
      `is now the stock (its bounding rectangle — the corner radii are not modelled here).`,
  ];

  if (!pocket) {
    notes.push('This badge has no magnet pocket, so no void was declared.');
    return {
      stock: { length: badge.width, width: badge.height, thickness: badge.thickness, material: 'pla' },
      pocket: null,
      notes,
    };
  }

  const membrane = badge.thickness - pocket.depth;
  notes.push(
    `Magnet pocket ${mm(pocket.length)} × ${mm(pocket.width)} mm, its ceiling ${mm(pocket.depth)} mm up ` +
      `from the blank's BOTTOM face: ${mm(membrane)} mm of material is left over it.`,
  );

  return {
    stock: { length: badge.width, width: badge.height, thickness: badge.thickness, material: 'pla' },
    pocket: {
      id: BADGE_POCKET_KEEP_OUT_ID,
      name: 'Magnet pocket',
      kind: 'rect',
      position: { x: badge.width / 2, y: badge.height / 2 },
      rotation: 0,
      enabled: true,
      zCeiling: pocket.depth,
      width: pocket.length,
      height: pocket.width,
      cornerRadius: 0,
    },
    notes,
  };
}
