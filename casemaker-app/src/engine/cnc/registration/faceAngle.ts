/**
 * #1059 — THE FACE-ANGLE STEP: level a SQUARE stock in the 4th axis before any indexed cut.
 *
 * `$H` leaves A's zero unmeasured (Rotary.md §9's homing row), and a square bar clamped by eye is
 * not corner- or flat-up. The vendor's own procedure (Makera wiki, captured 2026-11-07) is two
 * probe touches on the top face at ±d either side of the axis: the tilt is
 * `θ = atan((Z+ − Z−) / 2d)`, A turns by −θ, the touches repeat, and the levelled position becomes
 * the A work zero (`G10 L20 P0 A0`). This module is the PLAN (where the touches go, what must be
 * clear) and the SOLVER; `execute.ts` `runFaceAngle` is the motion.
 *
 * THE THREE SAFETY RULES (Manager, 2026-11-08):
 *  1. NEVER turn A with the probe near the stock. A square's corner sweeps past the face's height
 *     as it turns, so the head lifts to the ENVELOPE plus clearance before every A word — not to
 *     the face plus the park. {@link FaceAnglePlan.turnClearanceZ} is that height, and the
 *     executor refuses to send an A word from below it.
 *  2. BOUND θ. A reading past the limit is a wrong touch or a wrong mounting, never a turn; the
 *     limit is the shop's `registration.faceAngleMaxDeg` (seeded 10°).
 *  3. THE BALL CLEARS BOTH KEEP-OUTS. The touch X keeps the jaw band's margin plus
 *     {@link FACE_ANGLE_BALL_CLEARANCE_MM} from the JAWS and the same from the TAILSTOCK band
 *     (#1061), so neither end of the free span is ever approached with the probe.
 *
 * All placement here is MACHINE coordinates: the step runs before any work offset for the job
 * exists, exactly as the axis tap does.
 */

import { sectionEnvelopeRadius, ROTARY_JAW_KEEP_OUT_MM, type RotarySection } from '@/engine/cnc/rotary/wrap';
import { topTouchEdgeMarginsMm } from './cutBlank';

/** The touches' offset either side of the axis, mm — the maintainer's 15 mm on a 44.5 mm face. */
export const FACE_ANGLE_D_MM = 15;
/** How much clear of a keep-out the probe BALL keeps, mm (the safety rule's own number). */
export const FACE_ANGLE_BALL_CLEARANCE_MM = 3;
/** Smallest useful lever arm, mm: below this the angle's own resolution is noise. */
export const FACE_ANGLE_MIN_D_MM = 2;
/** The level band on |Z+ − Z−|, mm — the maintainer's 0.02 mm (≈ 0.04° over 2d). */
export const FACE_ANGLE_LEVEL_BAND_MM = 0.02;
/** How many corrections the step may make before it stops and says so. */
export const FACE_ANGLE_MAX_CORRECTIONS = 2;

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const num = (n: number): string => String(Number(n.toFixed(3)));

/** The axis datum's machine coordinates: the line's Y, the axis's Z. */
export interface FaceAngleAxis {
  axisY: number;
  axisZ: number;
}

export interface FaceAngleInputs {
  /** The module's measured axis, or null when it has not been measured for this record. */
  axis: FaceAngleAxis | null;
  /** The stock's section about the axis; a ROUND rod has no face to level. */
  section: RotarySection | null;
  /** The jaw face's machine X — the keep-out's boundary, from the module's record. */
  jawFaceX: number;
  /**
   * The stock's cuttable length, mm FROM THE JAW FACE — the map's free span's end, so the
   * tailstock's band (when the tailstock is in) is already subtracted from it.
   */
  freeEndMm: number;
  /** The probe's effective contact radius, mm (the ball's rim offset). */
  probeRadiusMm: number;
  /** The CAM's clearance above the stock, mm — the indexed CAM's `SAFE_Z`. */
  clearanceAboveStockMm: number;
  /** The machine's own clearance Z (the profile's tool-change height), or null for a stated machine. */
  machineClearanceZ: number | null;
  /** How far above the face's expected top the probe parks, mm (a registration setting). */
  parkAboveSurfaceMm: number;
  /** How far below the face's expected top a touch may travel, mm (a registration setting). */
  bandAllowanceMm: number;
  /** The machine's soft endstop minima, or null when the controller has not been read. */
  softLimits: { xMin: number; yMin: number; zMin: number } | null;
  /** The largest |θ| the step may correct, degrees — the shop's `registration.faceAngleMaxDeg`. */
  maxDeg: number;
  /**
   * #1211 field 2 — the shop's `registration.probeFootprintShrinkMm`, mm: the floor the top-touch
   * margin never goes below. Absent: the probe's own radius is the margin.
   */
  footprintShrinkMm?: number;
  /** #1211 — the unit's stated lateral uncertainty of the tip, mm (#1200's field). */
  tipLateralUncertaintyMm?: number;
  /** #1211 field 7 — the shop's `rotary.jawKeepOutMm`; absent → the registry's fallback. */
  jawKeepOutMm?: number;
}

export interface FaceAnglePlan {
  ok: true;
  /** The touches' offset either side of the axis, mm. */
  d: number;
  /** The touches' machine X (both at the same X). */
  x: number;
  /** The touches' machine Y, on either side of the axis. */
  yPlus: number;
  yMinus: number;
  /** The face's expected top, machine Z (the axis plus the section's half-height). */
  faceTopZ: number;
  /** The lowest a touch may travel to, machine Z. */
  bandFloorZ: number;
  /** Where the probe parks before each touch, machine Z. */
  parkZ: number;
  /** The travel height between touches, machine Z (the machine's own clearance). */
  seekZ: number;
  /** THE Z EVERY A WORD MUST BE SENT FROM: the envelope plus the CAM's clearance, machine Z. */
  turnClearanceZ: number;
  /** The section's circumscribed radius — the swing the turn must clear, mm. */
  envelopeRadiusMm: number;
  maxDeg: number;
  /** The distances the plan kept, in the operator's words, for the run sheet and the receipt. */
  notes: string[];
  // ── #1211 field 2 — THE ROTARY JOB'S DESCENT REGION, carried for the guard ──────────────────
  /** The jaws' face, machine X. */
  jawFaceX: number;
  /** The stock's free span past the jaw face, mm. */
  freeEndMm: number;
  /** The probe's effective contact radius, mm. */
  probeRadiusMm: number;
  /** The top-touch margin either end of the span and either side of the axis, mm. */
  regionMarginMm: number;
  /** #1211 field 7 — the chuck keep-out this plan was built with, mm (the guard reads the same). */
  jawKeepOutMm: number;
}

export interface FaceAngleRefusal {
  ok: false;
  reason: string;
}

/**
 * Where the two touches go and what must be clear, or a refusal in a sentence the operator can
 * act on. Every number is MACHINE: the step runs before the job's work offset exists.
 */
export function planFaceAngle(i: FaceAngleInputs): FaceAnglePlan | FaceAngleRefusal {
  if (i.axis === null) {
    return { ok: false, reason: 'the rotary axis has not been measured for this module — measure the axis first, then the face angle' };
  }
  if (i.section === null || i.section.kind !== 'rect') {
    return { ok: false, reason: 'the face angle is a step for SQUARE stock: a round rod has no face to level, so there is nothing to measure' };
  }
  if (i.machineClearanceZ === null) {
    return { ok: false, reason: 'this machine has no read controller frame — the face-angle step needs a clearance height to lift to' };
  }
  if (!(i.maxDeg > 0)) return { ok: false, reason: `the face-angle limit must be above 0° — the shop’s registration.faceAngleMaxDeg reads ${i.maxDeg}°` };

  const halfWidth = i.section.width / 2;
  const halfHeight = i.section.height / 2;
  // The lever arm: the maintainer's 15 mm, held inside the face (a margin off the edge and the
  // ball's own radius) so neither touch runs off the stock.
  const d = Math.min(FACE_ANGLE_D_MM, halfWidth - i.probeRadiusMm - 1);
  if (!(d >= FACE_ANGLE_MIN_D_MM)) {
    return {
      ok: false,
      reason: `the top face is ${num(i.section.width)} mm wide, which leaves ${num(Math.max(0, halfWidth - i.probeRadiusMm - 1))} mm either side of the axis for the two touches — at least ${FACE_ANGLE_MIN_D_MM} mm is needed. Level the stock by eye, or measure it another way`,
    };
  }

  // THE X, WITH THE BALL CLEAR OF BOTH KEEP-OUTS (safety rule 3). The jaw side adds the band's
  // own margin AND the rule's clearance; the tailstock side keeps the clearance from the free
  // span's end, which already excludes the tailstock's band when it is in.
  const keepOutMm = i.jawKeepOutMm ?? ROTARY_JAW_KEEP_OUT_MM;
  const jawSideX = i.jawFaceX + keepOutMm + FACE_ANGLE_BALL_CLEARANCE_MM + i.probeRadiusMm;
  const tailSideX = i.jawFaceX + i.freeEndMm - FACE_ANGLE_BALL_CLEARANCE_MM - i.probeRadiusMm;
  if (!(tailSideX - jawSideX >= 2)) {
    return {
      ok: false,
      reason: `the stock leaves ${num(Math.max(0, i.freeEndMm - ROTARY_JAW_KEEP_OUT_MM - 2 * FACE_ANGLE_BALL_CLEARANCE_MM - 2 * i.probeRadiusMm))} mm between the jaws’ keep-out and the ${i.freeEndMm} mm free end once the probe clears both by ${FACE_ANGLE_BALL_CLEARANCE_MM} mm — there is no room to touch the face at X. Use a longer stick-out, or take the tailstock out`,
    };
  }
  const x = r3((jawSideX + tailSideX) / 2);
  const yPlus = r3(i.axis.axisY + d);
  const yMinus = r3(i.axis.axisY - d);

  const faceTopZ = r3(i.axis.axisZ + halfHeight);
  const bandFloorZ = r3(faceTopZ - i.bandAllowanceMm);
  const parkZ = r3(faceTopZ + i.parkAboveSurfaceMm);
  const seekZ = r3(i.machineClearanceZ);
  // SAFETY RULE 1 — the turn clears the ENVELOPE (the corners), never the face.
  const envelopeRadiusMm = r3(sectionEnvelopeRadius(i.section));
  const turnClearanceZ = r3(Math.max(i.axis.axisZ + envelopeRadiusMm + i.clearanceAboveStockMm, i.machineClearanceZ));
  if (!(turnClearanceZ > faceTopZ)) {
    return {
      ok: false,
      reason: `the turn clearance (${num(turnClearanceZ)} mm) does not clear the face (${num(faceTopZ)} mm): the axis, the envelope or the machine’s clearance is wrong — check the axis datum before turning anything`,
    };
  }

  // THE SOFT LIMITS, on the moves as planned. The minima are the machine's own; the maxima are
  // the clearance height and the machine's travel, which the controller enforces itself.
  if (i.softLimits !== null) {
    const s = i.softLimits;
    if (x < s.xMin) return { ok: false, reason: `the touch X ${num(x)} is past the machine’s X soft limit ${num(s.xMin)} — move the stock or the module` };
    if (yMinus < s.yMin) return { ok: false, reason: `the −Y touch ${num(yMinus)} is past the machine’s Y soft limit ${num(s.yMin)} — the axis datum or the stock is not where it is expected` };
    if (bandFloorZ < s.zMin) return { ok: false, reason: `the touch may travel to ${num(bandFloorZ)}, past the machine’s Z soft limit ${num(s.zMin)} — check the axis datum and the face’s expected top` };
  }

  // #1211 field 2 — THE ROTARY JOB'S DESCENT REGION'S MARGIN: the same top-touch margin the flat
  // region uses (tip + lateral uncertainty, floored by the shop's shrink), one number for both
  // axes. The stock is held by the chuck, whose placement is the measured datum, so the hold term
  // is zero here.
  const margins = topTouchEdgeMarginsMm(
    { tipRadiusMm: i.probeRadiusMm, tipLateralUncertaintyMm: i.tipLateralUncertaintyMm ?? 0 },
    { floorMm: i.footprintShrinkMm ?? 0, hold: { xMm: 0, yMm: 0 } },
  );
  const regionMarginMm = r3(Math.max(margins.xMm, margins.yMm));
  return {
    ok: true,
    d,
    x,
    yPlus,
    yMinus,
    faceTopZ,
    bandFloorZ,
    parkZ,
    seekZ,
    turnClearanceZ,
    envelopeRadiusMm,
    maxDeg: i.maxDeg,
    jawFaceX: i.jawFaceX,
    freeEndMm: i.freeEndMm,
    probeRadiusMm: i.probeRadiusMm,
    regionMarginMm,
    jawKeepOutMm: keepOutMm,
    notes: [
      `the two touches run at machine X ${num(x)}, at ${num(d)} mm either side of the axis line (Y ${num(yPlus)} and ${num(yMinus)})`,
      `the probe ball keeps ${FACE_ANGLE_BALL_CLEARANCE_MM} mm clear of the jaws’ ${num(keepOutMm)} mm keep-out (X ≥ ${num(jawSideX)}) and of the free end (X ≤ ${num(tailSideX)})`,
      `the face is expected at machine Z ${num(faceTopZ)}; the touch is capped at ${num(bandFloorZ)} (${num(i.bandAllowanceMm)} mm below it) and parks at ${num(parkZ)}`,
      `every A word is sent from machine Z ${num(turnClearanceZ)} — the ⌀${num(2 * envelopeRadiusMm)} envelope plus the ${num(i.clearanceAboveStockMm)} mm clearance, so the corner cannot sweep into the probe`,
      `a reading past ${num(i.maxDeg)}° is refused, never turned: that is a wrong touch or a wrong mounting`,
    ],
  };
}

/** θ from the two touch heights, degrees: `atan((Z+ − Z−) / 2d)`. */
export function solveFaceAngle(zPlus: number, zMinus: number, d: number): number {
  return (Math.atan2(zPlus - zMinus, 2 * d) * 180) / Math.PI;
}

/**
 * The refusal a reading past the limit earns, or null when the turn may go ahead (safety rule 2):
 * a large reading is a wrong touch or a wrong mounting, and turning on it would make it worse.
 */
export function faceAngleLimitProblem(zPlus: number, zMinus: number, d: number, maxDeg: number): string | null {
  const theta = solveFaceAngle(zPlus, zMinus, d);
  if (Math.abs(theta) <= maxDeg) return null;
  return (
    `the two touches read ${num(zPlus - zMinus)} mm across ${num(2 * d)} mm — ${num(theta)}° of tilt, past the ${num(maxDeg)}° the face angle will correct. ` +
    'A reading this large is a wrong touch or a wrong mounting, not a turn: check the probe is on the stock and the axis datum is right, then run it again'
  );
}
