/**
 * cam/model/settings.ts — THE SHARED ENGINE PARAMETERS (#959, 2026-11-05 ruling).
 *
 * One place for the numbers the CAM's stages read as PARAMETERS rather than constants-in-code.
 * Each is a named value a caller (or a spec) may override; none is a job-document field yet.
 */

/**
 * THE SLOPE WHERE THE FLAT SURFACE-FOLLOWING PASS TAKES OVER (#959; shared with D's #960
 * flat/ball choice). A surface cell at or under this slope is cut by the flat's surface-following
 * pass (`skin`, and the flat's own finish choice); a steeper cell is left to the ball.
 *
 * DEFAULT PENDING: the maintainer's ruling is between 1.9° and 7.1°, decided by D's picture
 * against Makera's T1 (the manager's reply on #960). `value` is the PROVISIONAL 7.1 until that
 * ruling lands — every caller reads it through this object, and the specs pass both candidates to
 * prove it is read as a parameter, not baked in.
 */
export const FLAT_SURFACE_MAX_SLOPE_DEG = {
  value: 1.93,
  status: 'provisional' as const,
  note: 'same provisional as D’s #960 branch (1.93) until the manager rules on D’s corrected picture; the candidates were 1.9–7.1',
} as const;

/** The provisional value, as a plain number for callers that state no override. */
export function flatSurfaceMaxSlopeDeg(): number {
  return FLAT_SURFACE_MAX_SLOPE_DEG.value;
}

/**
 * THE SKIN PASS'S PER-PASS DEPTH CAP, as a MULTIPLE of the cutter row's own step-down (#959).
 * DECIDED (#943's ruling, 2026-11-05): the maintainer took the per-pass cap itself — "no pass
 * deeper than the row's step-down" — and the one-pass-up-to-1.25x option is NOT taken. 1.0: the
 * ⌀6 row's 1.0 mm step-down gives two passes on the tray's 1.2 mm skin and one on the
 * organizer's 0.8.
 */
export const SKIN_STEPDOWN_FACTOR = {
  value: 1.0,
  status: 'decided' as const,
  note: 'the #943 ruling (2026-11-05): every pass capped at the row’s own step-down; the 1.25x one-pass option was not taken',
} as const;

export function skinStepdownFactor(): number {
  return SKIN_STEPDOWN_FACTOR.value;
}
