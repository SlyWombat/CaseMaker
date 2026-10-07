import type { Mm } from './units';

/**
 * Issue #280 — the bare-blank archetype: "just cut something".
 *
 * No enclosure, no board, no cavity, no lid. The project IS a single plate,
 * and the Engrave panel is what drives it — which is the path #274 found
 * missing when the welcome screen offered only board-first cards.
 *
 * Frame and orientation follow `BadgeParams` exactly, because this is the
 * badge blank's sibling and shares its convention:
 *
 *   - the outline is CENTRED on the XY origin, so the bounding box is
 *     `[-W/2, W/2] × [-H/2, H/2] × [0, thickness]`;
 *   - `z = 0` is the BACK face (the one on the bed in the print layout) and
 *     the part is extruded up to `thickness`.
 *
 * That centring is load-bearing rather than cosmetic: the engrave hand-off
 * (`engine/cnc/engrave/fromBadge.ts`) maps a centred outline onto a stock
 * rectangle, so a blank that compiled corner-at-origin would silently place
 * every engraving in the wrong half of the stock.
 *
 * Naming follows `BadgeParams` (`width` = X, `height` = Y) rather than
 * `EngraveJob.stock` (`length` = X, `width` = Y) so the two blank *shapes*
 * read alike; the job's own naming is unchanged and the two are bridged by
 * `fromBlank.ts`, not by a shared vocabulary.
 */
export interface BlankParams {
  enabled: boolean;
  /** Outline extent along X, mm. */
  width: Mm;
  /** Outline extent along Y, mm. */
  height: Mm;
  /** Thickness, back face to cut face, mm. */
  thickness: Mm;
  /** Outline corner radius, mm. 0 = a plain rectangle. */
  cornerRadius: Mm;
}

/**
 * The starter blank: 100 × 60 × 12 mm, R3. A common hobby blank — wide enough
 * for a name or a set of labels, thin enough to sit proud of the vise jaws on
 * the Z1's 200 mm X without crowding them.
 */
export function defaultBlankParams(overrides: Partial<BlankParams> = {}): BlankParams {
  return {
    enabled: true,
    width: 100,
    height: 60,
    thickness: 12,
    cornerRadius: 3,
    ...overrides,
  };
}

/**
 * Why these parameters will not make a blank, or `null` when they will.
 *
 * Mirrors `badgeParamsProblem`: the panel states the reason rather than the
 * compiler throwing out of a render (#280's "no dialog can caliper a blank"
 * cousin — a hand-edited project should say what is wrong, not go blank).
 */
export function blankParamsProblem(b: BlankParams): string | null {
  if (!(b.width > 0)) return 'the blank width must be positive';
  if (!(b.height > 0)) return 'the blank height must be positive';
  if (!(b.thickness > 0)) return 'the blank thickness must be positive';
  if (b.cornerRadius < 0) return 'the blank corner radius cannot be negative';
  if (b.cornerRadius >= Math.min(b.width, b.height) / 2) {
    return `the corner radius (${b.cornerRadius} mm) is too big for a ${b.width} × ${b.height} mm blank — it must be under half the shorter side`;
  }
  return null;
}
