/**
 * The V-bit's cone, as one piece of maths in one place (#405).
 *
 * A V-bit is an engraving or chamfer cutter: a flat of `tipDiameter` at the point, then two flanks
 * rising at `halfAngle` from the tool AXIS. So the FLOOR the cutter leaves at a column is not flat
 * — it rises away from the tool's centre line — and the groove's width at a depth is not the tip.
 * This module is the ONE statement of that geometry; the column engine's height profile, the feeds
 * lookup's diameter, the stroke-merge check, the jaw reach and the findings all ask it, so no two
 * of them can disagree about how wide a V trace cuts.
 *
 * THE CONVENTION, which the repo already uses (`/Makera-Parity.md` §3.1, #185): `halfAngle` is
 * measured from the tool axis, and the floor width at depth `d` below the tip plane is
 *
 *     w(d) = tipDiameter + 2·d·tan(halfAngle)
 *
 * The hand-written bench file `docs/bench/185-v-groove.nc` carries the same arithmetic and the
 * bench cut on 2026-10-15 confirmed it in the blank (the 0.836 mm check at d = 1.0). `w` is the
 * groove's TOP OPENING: a 0.3 mm tip leaves a 0.3 mm floor at every depth, so a caliper on the
 * floor reads the tip however deep the groove goes (#185 review).
 *
 * The flank's height above the tip plane at radial distance `ρ` from the axis is the inverse:
 *
 *     profile(ρ) = max(0, (ρ − tipRadius) / tan(halfAngle))
 *
 * which is what `columnEngine`'s `FLAT` parameterisation writes as each column's floor.
 */

import type { Tool } from './tool';

/** The cone a V-bit presents, resolved from a `Tool`. */
export interface VCone {
  /** Radius of the flat at the point, mm. 0 for a sharp point. */
  tipRadius: number;
  /** Half angle, measured from the tool AXIS, in degrees — the repo's convention. */
  halfAngleDeg: number;
  /** `tan(halfAngle)`: the flank's rise per mm of radial distance from the tip's edge. */
  tanHalf: number;
  /**
   * #741 — the radius where the flank meets the cutter's CYLINDRICAL BODY, mm: the stated
   * `diameter / 2`. For an engraver and a chamfer `diameter` is the shank the cone flares to, so
   * this is the end of the cone — above it the bit cuts a vertical wall, not a V.
   *
   * Absent when the record states no diameter WIDER THAN THE TIP: a shank the width of its own
   * tip is not a body the cone flares to, so the record states no cone end, and the model keeps
   * the pre-#741 reading (an open flank bounded only by the stock) rather than guessing one.
   */
  outerRadius?: number;
}

const DEG = Math.PI / 180;

/**
 * A number the file actually stated, or `null`. **`0` means "unset"** in this vocabulary, not a
 * measurement: our own post writes `angle=${numberOrZero(...)}` / `halfAngle=${numberOrZero(...)}`
 * (`post/z1.ts`), so a bit whose only angle is the INCLUDED one round-trips with `halfAngle=0`.
 * Reading that as a stated 0° from the axis would refuse exactly the file we wrote ourselves.
 */
function statedAngle(v: number | null): number | null {
  return v !== null && v > 0 ? v : null;
}

/** A shape this module has geometry for: an engraver or a chamfer. Nothing else is a cone. */
export function isVShape(tool: Tool): boolean {
  return tool.shape === 'engraving' || tool.shape === 'chamfer';
}

/**
 * The cone of a `Tool`, or `null` when it is not one, or does not state what a cone needs.
 *
 * The tip comes from `tipDiameter` ONLY — never from `cuttingDiameter`'s `diameter` fallback. For
 * an engraver and a chamfer Makera writes the SHANK into `diameter` (3.175 mm), so a tool whose tip
 * field is missing would otherwise look like a 3.175 mm-wide V and be simulated as one. A missing
 * tip is a missing cutter, not a shank-wide groove.
 *
 * #669 — THE ONE EXCEPTION: a CHAMFER's unstated tip is a POINT. A chamfer mill comes to a point by
 * definition, and Makera leaves the tip empty on every chamfer row (`C1-BIT-CHAMFER-90` names the
 * angle and nothing else). #654 already read it that way for geometry and display
 * ({@link vConeGeometry}); the chamfer OPERATION is the bit's own use, and the simulator has to see
 * the cone it really is — a point tip there is the tool's definition, not an assumption. An
 * ENGRAVER's missing tip stays refused, for the shank-wide-groove reason above.
 *
 * The angle is `halfAngle` when the file states it, and half of `angle` when it states only the
 * INCLUDED angle — the two are the same bit, and a file that writes one and not the other must not
 * be refused for it. A 0 in either field is UNSET, not an angle (see {@link statedAngle}), and a
 * half angle that is still missing, or at/past 90°, is not a cone: a 0° tool cannot cut and a 90°
 * half angle is a flat disc of unbounded radius.
 */
export function vCone(tool: Tool): VCone | null {
  if (!isVShape(tool)) return null;
  const tip = tool.tipDiameter === null && tool.shape === 'chamfer' ? 0 : tool.tipDiameter;
  if (tip === null || !(tip >= 0)) return null;
  const included = statedAngle(tool.angle);
  const half = statedAngle(tool.halfAngle) ?? (included === null ? null : included / 2);
  if (half === null || !(half > 0) || !(half < 90)) return null;
  // #741 — the BODY the flank runs into. An engraver's and a chamfer's `diameter` is the shank,
  // so it is the cone's outer end and not a cutting width (`cuttingDiameter` falls back to it
  // only for a shape with no tip). A stated 0 is "unset" in this vocabulary, like an angle — and
  // so is a diameter NOT WIDER THAN THE TIP: a shank the width of its own tip states no cone at
  // all, which is a record this module cannot read as a body rather than a body with zero height.
  // Records like that exist in the tests' shorthand and in hand-entered cutters; reading them as
  // a 0 mm cone would make every V-cut with them impossible rather than geometrically wrong.
  const body = tool.diameter !== null && tool.diameter > tip ? tool.diameter / 2 : null;
  return {
    tipRadius: tip / 2,
    halfAngleDeg: half,
    tanHalf: Math.tan(half * DEG),
    ...(body === null ? {} : { outerRadius: body }),
  };
}

/**
 * #741 — the height of the cone: where the flank reaches the cutter's body, mm, or `null` when
 * the record states no diameter. `(diameter/2 − tipRadius)/tanHalf`, derived from the cutter's
 * own geometry — never a table or a catalogue's flute claim.
 */
export function coneHeight(cone: VCone): number | null {
  if (cone.outerRadius === undefined) return null;
  const h = (cone.outerRadius - cone.tipRadius) / cone.tanHalf;
  return h > 0 ? h : 0;
}

/** The groove's width at `depth` below the tip plane, mm — the TOP OPENING, not the floor. */
export function grooveWidthAt(cone: VCone, depth: number): number {
  return cone.tipRadius * 2 + 2 * depth * cone.tanHalf;
}

/**
 * The inverse: the depth at which the groove's top opening is `width` wide, mm. `null` for a
 * narrower width than the tip itself, which no depth reaches — the tip's own flat is the floor of
 * what this cutter can do.
 */
export function depthForWidth(cone: VCone, width: number): number | null {
  const d = (width - cone.tipRadius * 2) / (2 * cone.tanHalf);
  return d >= 0 ? d : null;
}

/**
 * The flank's height ABOVE the tip plane at radial distance `ρ` from the tool axis, mm: 0 inside
 * the tip's flat, rising at `1/tan` outside it. Unbounded — the caller bounds it by the stock.
 */
export function flankHeightAboveTip(cone: VCone, rho: number): number {
  const h = (rho - cone.tipRadius) / cone.tanHalf;
  return h > 0 ? h : 0;
}

/**
 * The cone a V-bit presents for GEOMETRY and DISPLAY, as opposed to the simulator's {@link vCone}.
 *
 * They differ on one point: a chamfer's tip. `vCone` refuses a missing tip because for an ENGRAVER a
 * missing tip would read as the shank-wide groove (3.175 mm) the bit does not have. A chamfer's
 * missing tip is the opposite — it is a POINT: Makera leaves the tip empty on every chamfer row and
 * box (`C1-BIT-CHAMFER-90` names the angle and nothing else), and a chamfer mill comes to a point by
 * definition. So a chamfer with no tip gets a 0 here, which makes its cone height — the flute length
 * — derivable from the diameter and angle it DOES state.
 *
 * The simulator still asks {@link vCone}, and is still told "no" for a chamfer with no tip: a point
 * tip is assumed, not proven, and a V trace planned against an assumption is exactly what the rule
 * exists to prevent.
 */
export function vConeGeometry(tool: Tool): VCone | null {
  if (!isVShape(tool)) return null;
  if (tool.tipDiameter !== null) return vCone(tool);
  if (tool.shape !== 'chamfer') return null;
  return vCone({ ...tool, tipDiameter: 0 });
}

/**
 * The flute length of a V-bit, derived from geometry the record DOES state: the cutting diameter
 * (the shank `diameter` the cone flares to) and the angle. `(diameter − tip) / (2 · tan(halfAngle))`
 * is the height at which the cone reaches the shank, which is where the flutes end.
 *
 * `null` when the tool is not a cone, or does not state a diameter and an angle (or a tip, for an
 * engraver — see {@link vConeGeometry}).
 */
export function vFluteLength(tool: Tool): number | null {
  const cone = vConeGeometry(tool);
  if (cone === null) return null;
  // #741 — one derivation: the cone's own body radius (`VCone.outerRadius`) is the height's input,
  // so `vDepthLimit`, the chamfer reach and the panel cannot read two different cones.
  const height = coneHeight(cone);
  return height !== null && height > 0 ? height : null;
}

/**
 * #741 — THE DEPTH LIMIT OF A V-BIT, as one statement: the height at which its cone reaches its
 * cylindrical body (the "cone height"), the flute length the record states, and the smaller of the
 * two, which is the deepest V the cutter can cut.
 *
 * A V-cut deeper than the cone's height is no longer a V: the cylindrical body cuts vertical walls
 * below it. A cut deeper than a STATED flute length has no cutting edge at all. The cone height is
 * derived from the tool's own geometry ({@link coneHeight}); the stated flute is the record's
 * claim, used only when it is SHORTER than the cone (a longer claim adds nothing — the body still
 * ends the cone). `null` when the record states neither, in which case no depth can be refused
 * honestly.
 *
 * ONE owner, read by the V-carve findings, the CAM's own guard and the panel, so no two of them
 * can name a different number. Never read a catalogue or a table here.
 */
export interface VDepthLimit {
  /** Where the flank meets the cutter's body, mm; `null` with no stated diameter. */
  coneHeightMm: number | null;
  /** The flute length the record states, positive mm, or `null`. */
  statedFluteMm: number | null;
  /** The deepest V the cutter can cut, mm — `min(coneHeightMm, statedFluteMm)`. */
  limitMm: number;
  /** Which of the two set `limitMm`. */
  boundBy: 'cone' | 'flute';
}

export function vDepthLimit(tool: Tool): VDepthLimit | null {
  const cone = vConeGeometry(tool);
  const coneHeightMm = cone === null ? null : coneHeight(cone);
  const stated = tool.fluteLength !== null && Number.isFinite(tool.fluteLength) && tool.fluteLength > 0
    ? tool.fluteLength
    : null;
  const bounds: { mm: number; by: 'cone' | 'flute' }[] = [];
  if (coneHeightMm !== null) bounds.push({ mm: coneHeightMm, by: 'cone' });
  if (stated !== null) bounds.push({ mm: stated, by: 'flute' });
  if (bounds.length === 0) return null;
  // The smaller bound binds; on a tie the CONE is named — it is the geometry this module holds,
  // and a record backfilled from it (`registerCutter`) is the same number restated.
  let binding = bounds[0]!;
  for (const b of bounds) if (b.mm < binding.mm - 1e-12) binding = b;
  return { coneHeightMm, statedFluteMm: stated, limitMm: binding.mm, boundBy: binding.by };
}

/**
 * #741 — WHY a V-carve or inlay is deeper than its cutter can cut, in words the panel shows
 * verbatim. ONE sentence builder, so the finding, the CAM's guard and the panel cannot paraphrase
 * the same fact differently: the item, its depth, the cutter, the binding height, and the way out,
 * every number with its unit.
 */
export function vDepthRefusal(itemName: string, depthMm: number, tool: Tool, limit: VDepthLimit): string {
  const mm = (v: number): string => String(Math.round(v * 1000) / 1000);
  const cone = vConeGeometry(tool);
  const included = cone === null ? null : cone.halfAngleDeg * 2;
  const angle = included === null ? '' : `${mm(included)}° `;
  const body = cone?.outerRadius === undefined ? null : `⌀${mm(cone.outerRadius * 2)} mm`;
  const reason =
    limit.boundBy === 'flute'
      ? `it has a ${mm(limit.limitMm)} mm flute` +
        (limit.coneHeightMm === null || body === null
          ? ''
          : ` (its ${angle}cone would reach ${mm(limit.coneHeightMm)} mm at the ${body} body)`) +
        ', so deeper than that there is no cutting edge'
      : `its ${angle}cone reaches the ${body ?? 'cutter’s'} body at ${mm(limit.limitMm)} mm, and ` +
        'deeper than that the body cuts a vertical wall instead of a V' +
        (limit.statedFluteMm === null ? '' : ` (the record states a ${mm(limit.statedFluteMm)} mm flute)`);
  return (
    `${itemName} is ${mm(depthMm)} mm deep, but the cutter "${tool.name}" can only V-carve ` +
    `${mm(limit.limitMm)} mm deep: ${reason}. Cut no deeper than ${mm(limit.limitMm)} mm, or use a ` +
    `cutter that reaches ${mm(depthMm)} mm.`
  );
}

/**
 * The groove width a TRACE cuts at `depth`, for a `Tool` — the number every width question wants.
 * `null` when the tool is not a cone (a flat end mill's width is its diameter, `cuttingDiameter`).
 */
export function grooveWidthForTool(tool: Tool, depth: number): number | null {
  const cone = vCone(tool);
  return cone === null ? null : grooveWidthAt(cone, depth);
}

/**
 * The radius a V TRACE's cutter sweeps in XY at `depth`: the groove's half opening. This is the
 * honest footprint of a V trace — the material the move actually removes — and is what a job-level
 * "how wide is this cut" reader (the jaw reach, the stroke-merge check, the trace's predicted
 * region) gets instead of the tip radius, which would understate a 1 mm-deep groove threefold.
 */
export function grooveRadiusAt(cone: VCone, depth: number): number {
  return grooveWidthAt(cone, depth) / 2;
}
