/**
 * #607 — THE 4TH-AXIS MODULE'S REFERENCE TAP POINT, on the module's record.
 *
 * A tap needs somewhere to go before it measures anything: the chuck's mid-length on the axis
 * line, MACHINE XY. The module's record carries the axis datum (`rotaryAxis`): the axis line's Y
 * in `at`, or the shipped/preset value until it has been measured. That Y is the estimate the
 * chord pair straddles; the diameter and the axis Z are what the tap MEASURES (`registration/
 * rotaryTap.ts`), never what it assumes.
 */

/** What the module's record must say for a tap: the axis line's Y and the nominal body radius. */
export interface RotaryTapRecord {
  /** The axis line's Y, machine Y — the datum's `at[1]`, or the shipped preset. */
  axisY: number;
  /** The chuck body's nominal radius, mm — the chord pair's search straddles it, the solve measures it. */
  nominalRadiusMm: number;
}

/**
 * The tap point, MACHINE XY: X on the chuck's mid-length, Y on the axis estimate. `atX` comes from
 * the module's record (the chuck face's X, measured or preset); a record without one refuses.
 */
export function rotaryTapPoint(record: RotaryTapRecord, atX: number): { x: number; y: number } {
  return { x: atX, y: record.axisY };
}

/**
 * The chord pair's start, mm either side of the tap point: the nominal radius plus a margin, so the
 * ball starts in air beside the body and travels INWARD to meet it.
 */
export function rotarySearchMm(record: RotaryTapRecord, marginMm = 10): number {
  return Math.max(1, record.nominalRadiusMm + marginMm);
}
