/**
 * #599 — the mount's reference point for the registration tap (the vise, first).
 *
 * The fixed-jaw top is the one point on the MOUNT the executor can verify against the stored
 * jaw-top datum. The tap sits MID-BAR along the jaw's length — it never depends on the blank's
 * size — and is inset from the fixed-jaw FACE by half the bar's width, so it lands on the bar,
 * clear of the stock. The frame (the jaw's machine XY) comes from the bed placement or, failing
 * that, a usable registration (`platform/bedProfiles.ts`'s `viseFrameFromRegistration`); this
 * module only turns a frame and the vise's constants into the point.
 */

/** The fixed jaw's machine XY: its inner face (the stock's left edge) and where the bar starts. */
export interface ViseTapFrame {
  fixedJawFaceX: number;
  jawStartY: number;
}

/** The vise constants the tap's geometry reads: the bar's width and length, mm. */
export interface ViseTapConstants {
  jawBarWidth: number;
  jawLength: number;
}

/** The fixed-jaw-top tap point, machine XY: mid-bar, inset from the face by half the bar width. */
export function viseTapPoint(frame: ViseTapFrame, vise: ViseTapConstants): { x: number; y: number } {
  return {
    x: frame.fixedJawFaceX - vise.jawBarWidth / 2,
    y: frame.jawStartY + vise.jawLength / 2,
  };
}
