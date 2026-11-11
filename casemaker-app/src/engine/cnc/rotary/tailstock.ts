/**
 * #241 slice 4 (#729 item 1) — THE TAILSTOCK AS AN OBSTACLE, in the setup's own frame.
 *
 * An indexed rotary job is swept on the exact engine, in the stock frame, with X running from the
 * jaw face (0) along the stock to the stick-out. When the job says the tailstock is in, the body
 * behind the live centre stands past the stock's free end and the cutter must not reach it — a
 * collision is a safety case, so the model is deliberately CONSERVATIVE: a cylinder about the A
 * axis from `stickout + centre` to `stickout + centre + length`, with a radius no smaller than the
 * four-jaw chuck's own jaws or the stock, and never below the provisional housing figure.
 *
 * THE FIGURES ARE PROVISIONAL. None of them has been calipered; they are scaled from Makera's
 * clamped-module figure (wiki `z1-4th-axis-4.png`). They live here, one named block, so the bench
 * session that measures them (#238's calipers list: "tailstock body — length, radius,
 * centre-to-body") replaces them and nothing else changes. A refusal that names them is honest; a
 * missed collision is not.
 */

import { readDefault } from '@/platform/defaultsClient';
import type { RotaryLimits } from './limits';
import type { Mm } from '@/types/units';

/** PROVISIONAL: the live centre's length, from the stock's free end to the body's front face, mm. */
// #1222 — the registry's labelled fallback (recommended value).
export const ROTARY_TAILSTOCK_CENTRE_MM: Mm = readDefault(null, 'rotary.tailstockCentreMm').value;
/** PROVISIONAL: the tailstock body's length along X, mm. */
// #1222 — the registry's labelled fallback.
export const ROTARY_TAILSTOCK_BODY_MM: Mm = readDefault(null, 'rotary.tailstockBodyMm').value;
/**
 * PROVISIONAL, and deliberately LARGER than the figure reads: the housing's radius about the
 * axis, mm. The body and the live centre both sit inside it, so a false refusal that names this
 * number is preferred to a missed collision.
 */
// #1222 — the registry's labelled fallback.
export const ROTARY_TAILSTOCK_HOUSING_RADIUS_MM: Mm = readDefault(null, 'rotary.tailstockHousingRadiusMm').value;

/** The obstacle's cylinder: X span and radius about the A axis, in the program's work frame. */
export interface TailstockSpan {
  x0: Mm;
  x1: Mm;
  radius: Mm;
}

/**
 * The tailstock's obstacle for a holding. Its radius is the LARGEST of the provisional housing,
 * half the chuck's jaw diameter and the stock's radius — never smaller than any of them.
 */
export function tailstockSpan(
  stickout: Mm,
  jawDiameter: Mm,
  stockRadius: Mm,
  limits?: Pick<RotaryLimits, 'tailstockCentreMm' | 'tailstockBodyMm' | 'tailstockHousingRadiusMm'>,
): TailstockSpan {
  const centre = limits?.tailstockCentreMm ?? ROTARY_TAILSTOCK_CENTRE_MM;
  const body = limits?.tailstockBodyMm ?? ROTARY_TAILSTOCK_BODY_MM;
  const housing = limits?.tailstockHousingRadiusMm ?? ROTARY_TAILSTOCK_HOUSING_RADIUS_MM;
  return {
    x0: stickout + centre,
    x1: stickout + centre + body,
    radius: Math.max(housing, jawDiameter / 2, stockRadius),
  };
}

/**
 * Whether a straight move of a cutter of `cutterRadius` — a sphere swept along the segment, in the
 * work frame, (x, y, z) with the A axis on y = z = 0 — enters the obstacle (the cylinder grown by
 * the cutter radius). Exact for a sphere against a cylinder: the segment is clipped to the grown
 * X span, and the radial distance's quadratic is minimised over that part.
 */
export function segmentEntersTailstock(
  from: readonly [Mm, Mm, Mm],
  to: readonly [Mm, Mm, Mm],
  cutterRadius: Mm,
  span: TailstockSpan,
): boolean {
  const r = span.radius + cutterRadius;
  const x0 = span.x0 - cutterRadius;
  const x1 = span.x1 + cutterRadius;
  const dx = to[0] - from[0];
  // The t interval where the tip's x is within the grown span.
  let t0 = 0;
  let t1 = 1;
  if (Math.abs(dx) < 1e-12) {
    if (from[0] < x0 || from[0] > x1) return false;
  } else {
    const ta = (x0 - from[0]) / dx;
    const tb = (x1 - from[0]) / dx;
    t0 = Math.max(0, Math.min(ta, tb));
    t1 = Math.min(1, Math.max(ta, tb));
    if (t0 > t1) return false;
  }
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const denom = dy * dy + dz * dz;
  const tStar = denom < 1e-18 ? t0 : -(from[1] * dy + from[2] * dz) / denom;
  const t = Math.max(t0, Math.min(t1, tStar));
  const y = from[1] + t * dy;
  const z = from[2] + t * dz;
  return y * y + z * z < r * r - 1e-6;
}
