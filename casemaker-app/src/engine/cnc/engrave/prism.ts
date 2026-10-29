/**
 * #674 — A RAISED PRISM: a V-bit carves a ring AROUND a closed shape so the shape stands at its
 * own depth, its sides sloping at the cone's angle.
 *
 * THE GEOMETRY, in one place so the plan, the row, the findings and the sheet cannot disagree:
 *
 *     height  H      the shape's own `depth`            (the operator's number)
 *     base    B      the flat base's width             (marker; default 1 mm — labelled)
 *     margin  M      where the cut meets the top face   M = B + 2·H·tanHalf   (derived)
 *     plane   rPlane the tip's offset from the mouth    rPlane = tipRadius + H·tanHalf
 *
 * The region the plan cuts is the RING between the shape's outline and its outward offset by M.
 * The V-carve machinery is told that ring's boundary is the MOUTH at the top face (#673's inlay
 * convention): the existing plane V-carve then erodes the floor to
 *
 *     B = M − 2·H·tanHalf
 *
 * so the base is `B` wide, the inner wall rises from the base to the standing shape's edge and the
 * outer wall rises from the base to the untouched top face at M. The tip travels the mouth inset
 * by `rPlane`, a ring `B − 2·tipRadius` wide — which is why the base must beat the tip twice and
 * the cutter must have a tip at all: the base's FLATNESS is the tip pad's overlap at the V-carve's
 * own pitch (`≤ tipRadius`), and a point tip would leave the base as a field of ridges.
 *
 * WHAT IT IS NOT. Not #665's medial-axis ladder (that runs INSIDE the design, each point to its
 * own depth); a prism leaves the design untouched and cuts the ring at ONE depth. Not a pocket
 * either: nothing here is a flat region — the slopes ARE the cone's flank, and the only flat is
 * the base the tip pad clears.
 */

import { pDifference, pOffset, type Profile } from '@/engine/compiler/profile';
import { coneHeight, type VCone } from '@/engine/cnc/vProfile';
import type { PrismMark } from '@/types/engraveJob';
import type { Mm } from '@/types/units';

/** The flat base a prism runs with when the operator states none, mm — labelled, not measured. */
export const DEFAULT_PRISM_BASE_MM = 1;

/** Where the base's width came from, in the words the row prints. */
export type PrismBaseSource = 'typed' | 'the CAM’s default';

/**
 * Why a prism cannot be cut, as data the finding words. The values ARE the finding codes
 * (`prism-needs-cone`, `prism-height`, `prism-tip`, `prism-base`), so the row, the finding and
 * this check cannot drift apart.
 *
 * #741 review — `prism-height`: a prism's sides ARE the cone's flank, so a prism taller than
 * the cone's own height would have its top cut by the bit's cylindrical body, not the flank —
 * the same defect as an over-deep V-carve. The bound is the cone the cutter states, derived
 * here from the same {@link VCone} every other reader uses.
 */
export type PrismRefusal = 'prism-needs-cone' | 'prism-height' | 'prism-tip' | 'prism-base';

export interface PrismNumbers {
  /** The standing height: the shape's own depth, mm. */
  heightMm: Mm;
  /**
   * Where the flank meets the cutter's body, mm (#741 review) — the tallest side this cone can
   * cut. `null` when the record states no body (the degenerate-record rule), so no height bound.
   */
  coneHeightMm: Mm | null;
  /** The flat base's width around the shape, mm. */
  baseMm: Mm;
  baseSource: PrismBaseSource;
  /** Where the cut meets the untouched top face, mm out from the shape's outline (derived). */
  marginMm: Mm;
  /** The tip's offset inside the mouth, mm: `tipRadius + height · tanHalf`. */
  planeRadiusMm: Mm;
  /** The ring the TIP travels, mm wide: `base − 2 · tipRadius`. */
  tipPathWidthMm: Mm;
  /** Half the cutting depth of the cone's flank at this height, mm: `height · tanHalf`. */
  slopeWidthMm: Mm;
}

export type PrismCheck =
  | { ok: true; numbers: PrismNumbers }
  | { ok: false; code: PrismRefusal; numbers: PrismNumbers };

/**
 * Resolve a prism's numbers from the cone, the shape's depth and the marker. Never throws: a
 * refusal comes back with the numbers it did compute, so the finding can name them.
 */
export function prismNumbers(cone: VCone | null, heightMm: Mm, mark: PrismMark | undefined): PrismCheck {
  const typed = mark?.baseMm;
  const typedOk = typed !== undefined && Number.isFinite(typed) && typed > 0;
  const baseMm = typedOk ? (typed as number) : DEFAULT_PRISM_BASE_MM;
  const tanHalf = cone === null ? 0 : cone.tanHalf;
  const tipRadius = cone === null ? 0 : cone.tipRadius;
  const slopeWidthMm = heightMm * tanHalf;
  const coneHeightMm = cone === null ? null : coneHeight(cone);
  const numbers: PrismNumbers = {
    heightMm,
    coneHeightMm,
    baseMm,
    baseSource: typedOk ? 'typed' : 'the CAM’s default',
    marginMm: baseMm + 2 * slopeWidthMm,
    planeRadiusMm: tipRadius + slopeWidthMm,
    tipPathWidthMm: baseMm - 2 * tipRadius,
    slopeWidthMm,
  };
  if (cone === null) return { ok: false, code: 'prism-needs-cone', numbers };
  // #741 review — the side is the cone's flank only up to the cone's own height; above it the
  // cutter's cylindrical body would cut the wall (or rub it, if it has no edge there).
  if (coneHeightMm !== null && heightMm > coneHeightMm + 1e-9) {
    return { ok: false, code: 'prism-height', numbers };
  }
  if (!(cone.tipRadius > 0)) return { ok: false, code: 'prism-tip', numbers };
  if (!(numbers.tipPathWidthMm > 0)) return { ok: false, code: 'prism-base', numbers };
  return { ok: true, numbers };
}

/**
 * #741 review — WHY a prism is taller than its cutter's cone, in words the finding, the CAM's
 * guard and the row can share. One sentence builder: the prism, its height, the cutter and the
 * cone height, every number with its unit, and the way out. Only called for `prism-height`,
 * where {@link PrismNumbers.coneHeightMm} is stated.
 */
export function prismHeightRefusal(itemName: string, numbers: PrismNumbers, toolName: string | null): string {
  const mm = (v: number): string => String(Math.round(v * 1000) / 1000);
  const cone = numbers.coneHeightMm ?? 0;
  return (
    `${itemName} stands ${mm(numbers.heightMm)} mm high, but the cutter ` +
    `"${toolName ?? 'the cutter'}"'s cone is only ${mm(cone)} mm tall, so a side higher than ` +
    `that is no longer the cone's flank. Cut it no higher than ${mm(cone)} mm, or use a cutter ` +
    `whose cone is at least ${mm(numbers.heightMm)} mm tall.`
  );
}

/**
 * The profile the plan cuts: the ring between the shape's outline and its outward offset by the
 * margin. Pure profile algebra — the plan has no wasm, so the offset and the difference are NODES
 * evaluated later, by the same `itemProfile` every region goes through.
 */
export function prismRingProfile(shape: Profile, marginMm: Mm): Profile {
  return pDifference([pOffset(shape, marginMm, 'round'), shape]);
}
