import type { BlankParams } from '@/types';
import { extrude, type BuildNode } from './buildPlan';
import { pTranslate, rectProfile, roundedRect, type Profile } from './profile';

/**
 * Issue #280 — the bare blank: "just cut something".
 *
 * One part, no cavity, no lid, no board. The whole project is a single plate
 * the Engrave panel drives, which is the entry point #274 found missing.
 *
 * Frame follows `BadgeParams` (see types/blank.ts): the outline is CENTRED on
 * the XY origin and z = 0 is the back face, extruded up to `thickness`. The
 * centring is not cosmetic — `engine/cnc/engrave/fromBlank.ts` maps a centred
 * outline onto the job's stock rectangle, so a corner-at-origin blank would
 * place every engraving in the wrong half of the stock.
 */

/** The single top-level node — the whole part is the blank. */
export const BLANK_NODE_ID = 'blank';

/**
 * The outline, centred on the XY origin. `roundedRect` is bbox-min at the
 * origin, so the `pTranslate` is what moves the part to centre — the same two
 * lines `badgeOutline` uses. A zero or clamped-away radius falls back to a
 * plain rectangle, which `roundedRect` already does internally.
 */
export function blankOutline(b: BlankParams): Profile {
  const outline =
    b.cornerRadius > 0
      ? roundedRect(b.width, b.height, b.cornerRadius)
      : rectProfile(b.width, b.height);
  return pTranslate([-b.width / 2, -b.height / 2], outline);
}

/**
 * The one `blank` node, or null when the plate would have no extent.
 *
 * `null` is the compiler's fall-through signal: like the badge and the stand,
 * an unbuildable parameter set yields the normal shell rather than an empty
 * viewport. `blankParamsProblem` (types/blank.ts) is what the panel shows the
 * user instead of a blank screen.
 */
export function buildBlankNodes(b: BlankParams): BuildNode[] | null {
  if (!(b.width > 0) || !(b.height > 0) || !(b.thickness > 0)) return null;
  return [{ id: BLANK_NODE_ID, op: extrude(blankOutline(b), b.thickness) }];
}
