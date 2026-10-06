import type { BadgeParams } from '@/types';
import { difference, extrude, translate, type BuildNode } from './buildPlan';
import { pTranslate, rectProfile, roundedRect, type Profile } from './profile';

/**
 * Issue #167 — the two-colour name-badge blank, ported off
 * `samples/badge-blank/make_badge.py` onto the Profile IR.
 *
 * The Python script built its outline as a hand-rolled triangle fan per corner
 * (75 lines); here the whole part is the IR's `roundedRect` plus two
 * `extrude`s. Frame is the oracle's, and is documented on `BadgeParams`:
 *
 *   - outline CENTRED on the XY origin;
 *   - z = 0 is the BACK face, the one carrying the magnet pocket;
 *   - the colour split is the plane z = splitHeight; the top colour runs from
 *     there to z = thickness and is the face that gets engraved.
 *
 * TWO nodes, one per colour, printed separately and bonded at the split plane.
 * They are the same outline, so their mating faces are congruent — the part
 * only works if both compile from this one function.
 */

export const BADGE_BOTTOM_NODE_ID = 'badge-bottom';
export const BADGE_TOP_NODE_ID = 'badge-top';

/** Overshoot so the pocket cutter punches cleanly through the back face
 *  instead of leaving a coplanar skin for the boolean to argue with. */
const POCKET_OVER = 1;

/**
 * The outline, centred on the origin (the oracle's convention, and the reason
 * the `pTranslate` below exists — `roundedRect` is bbox-min-at-origin, so
 * without it the part lands in the first quadrant and the oracle bbox check in
 * `tests/unit/badge.spec.ts` fails).
 */
export function badgeOutline(b: BadgeParams): Profile {
  return pTranslate([-b.width / 2, -b.height / 2], roundedRect(b.width, b.height, b.cornerRadius));
}

/**
 * Is this badge buildable at all? The oracle makes the same two assertions
 * (`make_badge.py:33-34`) and crashes; here the caller falls through to the
 * normal shell so the viewport is never empty, and `badgeParamsProblem`
 * says why. Returns `null` for the unbuildable case, mirroring the stand's
 * `buildStandNodes` contract.
 */
export function buildBadgeNodes(b: BadgeParams): BuildNode[] | null {
  if (!(b.thickness > 0) || !(b.splitHeight > 0) || b.splitHeight >= b.thickness) return null;
  if (!(b.width > 0) || !(b.height > 0)) return null;

  const outline = badgeOutline(b);

  const bottom = extrude(outline, b.splitHeight);
  const pocket = b.magnetPocket;
  const bottomOp = pocket
    ? difference([
        bottom,
        translate(
          [0, 0, -POCKET_OVER],
          extrude(rectProfile(pocket.length, pocket.width, true), pocket.depth + POCKET_OVER),
        ),
      ])
    : bottom;

  return [
    { id: BADGE_BOTTOM_NODE_ID, op: bottomOp },
    {
      id: BADGE_TOP_NODE_ID,
      op: translate([0, 0, b.splitHeight], extrude(outline, b.thickness - b.splitHeight)),
    },
  ];
}
