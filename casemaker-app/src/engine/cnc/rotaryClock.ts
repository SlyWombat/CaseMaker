/**
 * How the Z1's firmware times a move that turns the A axis (`/Rotary.md` §1.2, read from
 * MakeraInc/MakeraZ1Firmware Robot.cpp and configZ1.default). Machine facts, not chosen values.
 */

/** The firmware adds this to the circumference when it converts a feed to an A rate, mm. */
export const FIRMWARE_ROTARY_PERIMETER_EXTRA_MM = 30;
/** The shipped A-axis ceiling, degrees per minute (`delta_max_rate`). Used when a machine states none. */
export const FIRMWARE_A_MAX_DEG_PER_MIN = 3600;

export interface RotaryClock {
  /** The A axis's ceiling, degrees per minute. */
  aMaxDegPerMin: number;
  /** Added to 2π·r to form the firmware's perimeter, mm. */
  perimeterExtraMm: number;
}

export const DEFAULT_ROTARY_CLOCK: RotaryClock = {
  aMaxDegPerMin: FIRMWARE_A_MAX_DEG_PER_MIN,
  perimeterExtraMm: FIRMWARE_ROTARY_PERIMETER_EXTRA_MM,
};

export interface RotaryRate {
  /** What the feed asks of A, degrees per second, before the ceiling. */
  askedDegPerSec: number;
  /** The A axis's ceiling, degrees per second. */
  capDegPerSec: number;
  /** The rate A really turns at: the smaller of the two. */
  allowedDegPerSec: number;
  /** True when the ceiling is the limit. */
  capped: boolean;
}

/** The rate A turns at for feed `feedMmPerMin` when the cut is `radiusMm` from the rotary axis. */
export function rotaryRate(
  feedMmPerMin: number,
  radiusMm: number,
  clock: RotaryClock = DEFAULT_ROTARY_CLOCK,
): RotaryRate {
  const r = Math.abs(radiusMm);
  const perimeter = r > 1 ? 2 * Math.PI * r + clock.perimeterExtraMm : 2 * Math.PI + clock.perimeterExtraMm;
  const askedDegPerSec = (feedMmPerMin / 60 / perimeter) * 360;
  const capDegPerSec = clock.aMaxDegPerMin / 60;
  const allowedDegPerSec = Math.min(askedDegPerSec, capDegPerSec);
  return {
    askedDegPerSec,
    capDegPerSec,
    allowedDegPerSec,
    capped: askedDegPerSec > capDegPerSec + 1e-9,
  };
}

/**
 * Seconds for one FEED move on the rotary: `dxMm` along the rod, `dzMm` toward or away from the
 * axis, `dADeg` of turn, ending `radiusMm` from the axis. 0 when the feed is not above 0.
 */
export function rotaryFeedSeconds(
  dxMm: number,
  dzMm: number,
  dADeg: number,
  feedMmPerMin: number,
  radiusMm: number,
  clock: RotaryClock = DEFAULT_ROTARY_CLOCK,
): number {
  if (!(feedMmPerMin > 0)) return 0;
  const linearSeconds = Math.hypot(dxMm, dzMm) / (feedMmPerMin / 60);
  const turn = Math.abs(dADeg);
  // A move that does not turn A is the plain linear move, whatever its radius.
  if (turn <= 1e-9) return linearSeconds;
  const rate = rotaryRate(feedMmPerMin, radiusMm, clock).allowedDegPerSec;
  const turnSeconds = rate > 0 ? turn / rate : 0;
  // The firmware slows a combined move so neither the A part nor the linear part outruns the
  // commanded feed; the slower of the two sets the time.
  return Math.max(linearSeconds, turnSeconds);
}

/** Seconds for one RAPID that turns A by `dADeg`: A runs at its ceiling. */
export function rotaryRapidTurnSeconds(dADeg: number, clock: RotaryClock = DEFAULT_ROTARY_CLOCK): number {
  return Math.abs(dADeg) / (clock.aMaxDegPerMin / 60);
}
