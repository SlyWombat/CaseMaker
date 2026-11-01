/**
 * #607 — THE 4TH-AXIS (ROTARY) REFERENCE TAP: the chuck body's circle in the YZ plane, found with
 * the 3D probe, so the `rotaryAxis` datum is MEASURED (axis Z, the axis line's Y, and the radius)
 * rather than shipped.
 *
 * THE GEOMETRY (the maintainer's ruling, 2026-10-31). Two chords a few mm apart near the centre
 * are ill-conditioned (dw/dZ → 0 as Z → the centre), so the solve uses ONE chord and the crown:
 *
 *   1. A ±Y chord pair at a trial Z1 below the crown: the ball centres' midpoint is the axis line's
 *      Y, and the face width there is `w1 = span − 2R_probe` (a boss: the wall lies one effective
 *      probe radius inside each ball centre).
 *   2. The crown touched from above at that Y: Ztop. #626's worry — the crown plus an UNMEASURED
 *      radius — is gone: with d = Ztop − Z1 > 0, the circle through the chord and the crown is
 *      `R = (w1²/4 + d²) / (2d)` and `Zc = Ztop − R`, closed form, well conditioned with d between
 *      roughly 0.3R and 0.7R (Z1 is picked from the record's nominal R to put d near the middle of
 *      that band).
 *   3. A SECOND chord at another Z is a CHECK, never part of the solve: its face width against the
 *      fitted circle is reported as a residual, and a residual over {@link ROTARY_CHORD_TOLERANCE_MM}
 *      is said in one line (the datum is still the fitted circle — the check is information).
 *
 * THE PROBE'S RADIUS cancels out of the CENTRE and the RADIUS: the chord's width uses the FACE,
 * `span − 2R_probe`, and the crown's Z is a direct reading. What does NOT cancel is any error in the
 * recorded R_probe itself, which moves every ball centre by that error — the same rule as every
 * other sideways touch (#525/#827).
 */

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The chord check's tolerance, mm: a second chord further than this from the fitted circle is said. */
export const ROTARY_CHORD_TOLERANCE_MM = 0.05;

/** Where the trial chord's depth wants to land, as a fraction of the nominal radius. */
export const ROTARY_DEPTH_FRACTION = { min: 0.3, target: 0.5, max: 0.7 } as const;

/** What the profile knows before the tap: the shipped (or last measured) axis and radius, mm. */
export interface RotaryNominal {
  /** The axis height, machine Z (the preset or last measurement). */
  axisZ: number;
  /** The chuck body's nominal radius, mm. */
  radiusMm: number;
}

/** The trial chord's height, from the nominal and the bed clearance. */
export interface RotaryTrialPlan {
  ok: true;
  /** The chord pair's touch height, machine Z. */
  z1: number;
  /** The CHORD pair's height on the other side, machine Z — the CHECK only. */
  z2: number;
  /** The estimate of the crown the trial assumes, machine Z — d = crown − z1. */
  crownEstimateZ: number;
  /** How deep the trial sits below the estimated crown, mm (0.3R–0.7R is the sound band). */
  depthMm: number;
}

/** Why a trial chord cannot be placed, in a sentence the operator can act on (a SAFETY refusal). */
export interface RotaryTrialRefusal {
  ok: false;
  reason: string;
}

/**
 * The chord pair's height: `crownEstimate − target·R`, but never below the bed clearance (the probe
 * body beside the chuck must clear the bed and the headstock). Refused, by name, only when no trial
 * height above the clearance still lies inside the sound band.
 */
export function planRotaryTrial(
  nominal: RotaryNominal,
  bedClearanceZ: number,
  opts: { depthFraction?: number } = {},
): RotaryTrialPlan | RotaryTrialRefusal {
  if (!(nominal.radiusMm > 0)) {
    return { ok: false, reason: 'the rotary has no nominal chuck radius to place the trial chord — record the module’s radius first' };
  }
  const fraction = opts.depthFraction ?? ROTARY_DEPTH_FRACTION.target;
  const crownEstimateZ = r3(nominal.axisZ + nominal.radiusMm);
  const wanted = r3(crownEstimateZ - fraction * nominal.radiusMm);
  // Machine Z runs negative DOWNWARD: below the crown is a LOWER Z. The sound band is between
  // 0.3R (the shallow end) and 0.7R (the deep end) below the crown, and the bed clearance can only
  // RAISE the trial toward the shallow end.
  const shallowest = r3(crownEstimateZ - ROTARY_DEPTH_FRACTION.min * nominal.radiusMm);
  const deepest = r3(crownEstimateZ - ROTARY_DEPTH_FRACTION.max * nominal.radiusMm);
  if (wanted >= bedClearanceZ && wanted >= deepest && wanted <= shallowest) {
    return { ok: true, z1: wanted, z2: r3(wanted + (crownEstimateZ - wanted) / 3), crownEstimateZ, depthMm: r3(crownEstimateZ - wanted) };
  }
  // The bed is in the way where the sound band wants the chord: try the shallowest sound height.
  if (shallowest >= bedClearanceZ) {
    return {
      ok: true,
      z1: shallowest,
      z2: r3(shallowest + (crownEstimateZ - shallowest) / 3),
      crownEstimateZ,
      depthMm: r3(crownEstimateZ - shallowest),
    };
  }
  return {
    ok: false,
    reason:
      `the bed stands at machine Z ${r3(bedClearanceZ)} and the chuck’s sound trial band (${deepest} to ${shallowest}) is under it — ` +
      `the probe body beside the chuck cannot clear the bed and the headstock; raise the module or measure the axis with Studio`,
  };
}

/** One ball-centre pair's outcome, as the executor measures it. */
export interface ChordReading {
  /** The two ball centres' midpoint, machine Y — the axis line's Y. */
  y: number;
  /**
   * The FACES' width at that height, mm — the ball-centre span less twice the probe's effective
   * radius (the app's sideways-boss convention, the same rule #827's centre find uses).
   */
  widthMm: number;
  /** The Z the pair ran at, machine Z. */
  zMachine: number;
}

/** The fitted chuck circle: the datum the tap writes. */
export interface RotaryCircle {
  /** The axis line's height, machine Z. */
  axisZ: number;
  /** The axis line's Y (the chord's midpoint). */
  axisY: number;
  /** The chuck body's radius, mm — measured, not the probe's. */
  radiusMm: number;
  /** Ztop − Z1, mm: the solve's d. */
  depthMm: number;
}

/**
 * The circle through one chord at Z1 and the crown at (axisY, Ztop): closed form, the maintainer's
 * formula — `R = (w²/4 + d²)/(2d)`, `Zc = Ztop − R`. Refuses a crown at or below the chord.
 */
export function solveRotaryCircle(
  chord: ChordReading,
  crownMachineZ: number,
): { ok: true; circle: RotaryCircle } | { ok: false; reason: string } {
  const d = r3(crownMachineZ - chord.zMachine);
  if (!(d > 0)) {
    return {
      ok: false,
      reason: `the crown read machine Z ${r3(crownMachineZ)}, at or below the chord's ${r3(chord.zMachine)} — the crown must stand above the chord to solve the circle`,
    };
  }
  if (!(chord.widthMm > 0)) {
    return { ok: false, reason: `the chord measured ${r3(chord.widthMm)} mm wide — the side touches found nothing of the chuck body` };
  }
  const radiusMm = r3((chord.widthMm * chord.widthMm) / 4 / d / 2 + d / 2);
  return { ok: true, circle: { axisZ: r3(crownMachineZ - radiusMm), axisY: r3(chord.y), radiusMm, depthMm: d } };
}

/**
 * The check chord's residual against the fitted circle, mm: how far the measured face width at its
 * own Z is from `2·sqrt(R² − (Z − Zc)²)`. Over {@link ROTARY_CHORD_TOLERANCE_MM} the caller says so
 * in one line; the datum stays the fitted circle.
 */
export function chordResidualMm(check: ChordReading, circle: RotaryCircle): number {
  const dz = check.zMachine - circle.axisZ;
  const inside = circle.radiusMm * circle.radiusMm - dz * dz;
  const predicted = inside > 0 ? 2 * Math.sqrt(inside) : 0;
  return r3(Math.abs(check.widthMm - predicted));
}
