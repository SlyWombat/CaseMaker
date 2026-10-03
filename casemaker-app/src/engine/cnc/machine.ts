/**
 * The machine profile (#184, decision 25): one object for every machine-dependent number.
 *
 * Built now, with one supported machine, because two things need it immediately:
 *
 *  1. Feeds and speeds must be clamped against SOMETHING. Makera's own tool table has no
 *     machine column and 32 of its rows specify a spindle speed above the Z1's 13 000 RPM
 *     ceiling (`/Makera-Parity.md` §5.1). Without a profile there is nowhere to clamp from.
 *  2. The emulator animates the tool-change macro (#182, Q14), and every position in that
 *     macro is machine config — clearance, safe height, the tool-length sensor — not
 *     anything the program file contains.
 *
 * Scope is the Z1 ONLY. Carvera and Carvera Air are rows in Makera's own database, so the
 * SHAPE is known, but they are not supported machines and must not be added here (#183).
 *
 * PROVENANCE. Every number carries where it came from. Three sources, in order of trust:
 *   - `t_MachineType` in Makera's library database: the Z1's own row.
 *   - `src/configZ1.default` in MakeraZ1Firmware: the shipped default config. A READING of
 *     the repo, not of the machine; the device's own config could differ, and that file
 *     carries Carvera-era boilerplate (its `worksize_x` says 300 on a 200 mm machine).
 *   - Hard-coded constants in `ATCHandler.cpp` for the Z1 model.
 * Nothing here has been verified on hardware.
 */

import type { Mm, Vec2 } from '@/types/units';

export interface AxisRange {
  min: Mm;
  max: Mm;
}

export interface MachineProfile {
  id: string;
  name: string;
  process: 'mill';
  /**
   * The work envelope in MACHINE coordinates. The Z1 homes to MAX on every axis and loads
   * 0 there, so machine coordinates run negative: X and Y in [-200, 0], Z in [-100, 0]. The
   * sizes are the machine's own database row; the sign convention is from the firmware
   * config (`home_to_max`, `alpha_max 0`) and is consistent with the vendor's own sample
   * `goto-pack-pos.nc` (`G53 X-295 Y-205` on a 320 x 240 Carvera).
   */
  envelope: { x: AxisRange; y: AxisRange; z: AxisRange };
  /**
   * The largest F the controller should be asked for on a CUTTING move, mm/min. Deliberately
   * no rapid ceiling: a rapid carries no F, the controller uses its own seek rate, and a
   * guessed field would be worse than none (`/Makera-Parity.md` §11.2).
   */
  maxCutFeed: number;
  maxRpm: number;
  /** `isATC=0`: a manual tool change, which is what makes `M490.1`/`M490.2` the tool-change path. */
  hasATC: false;
  toolSlots: 0;
  capabilities: {
    /** Optional 4th-axis module. Owned; not simulated in V1. */
    rotary: boolean;
    /** No laser module on this machine. A FLAG, so the absence is a fact rather than silence. */
    laser: boolean;
    /** `M7`/`M9` air. The internal vacuum (`M801`/`M802`) is Carvera-only. */
    air: boolean;
    vacuum: boolean;
  };
  dialect: {
    /** The controller takes `G2`/`G3`; other CAM emits them. */
    acceptsArcs: boolean;
    /** It does NOT take canned cycles; the vendor's own post translates drill cycles. */
    cannedCycles: boolean;
    grblMode: boolean;
    axisPrecision: number;
    feedPrecision: number;
  };
  /** Machine coordinates of the two anchor positions, the bed's native XY datum. */
  anchor1: Vec2;
  anchor2: Vec2;
  /**
   * What the manual tool-change macro does, in machine coordinates. Read from
   * `fill_change_scripts` / `fill_cali_scripts` and the completion path in `ATCHandler.cpp`
   * (`/Z1-Firmware-Dialect.md` §2); the numbers from the shipped config.
   */
  toolChange: {
    /** Z the head lifts to before moving to the change position, and returns to afterwards. */
    clearanceZ: Mm;
    /** XY the head parks at while the operator swaps the tool. */
    changePosition: Vec2;
    /** Z used while moving to and from the tool-length sensor with a tool clamped. */
    safeZ: Mm;
    /** XY of the tool-length sensor: `anchor1 + 181` on each axis, hard-coded for the Z1. */
    sensor: Vec2;
    /**
     * Z the probe move is commanded TOWARD. It stops early, at the tool tip's contact, and
     * never reaches this. The shipped config's -108 is BELOW the Z1's 100 mm of Z travel —
     * it fits a Carvera Air's 130 mm, and the same file says `worksize_x 300` on a 200 mm
     * machine, so this is Carvera-era boilerplate the firmware uses as "all the way down".
     * Recorded as the firmware would send it; not a position the head can reach.
     */
    sensorZ: Mm;
    probeFastFeed: number;
    probeSlowFeed: number;
    probeRetract: Mm;
  };
}

const ANCHOR1: Vec2 = [-192.4, -194.3];

/**
 * The Makera Z1.
 *
 * `t_MachineType`: 200 x 200 x 100, 1200 mm/min, 13 000 RPM, isATC = 0, rotary ⌀80 x 150.
 * `configZ1.default` (`coordinate.*`, `atc.*`): anchors, clearance, safe Z, sensor.
 * `ATCHandler.cpp`: the Z1's sensor position is `anchor1 + 181`, and its change position is
 * `anchor1 + toolrack_offset + (132, 0)` — which with the shipped offsets (48.78, 179.74)
 * lands on (-11.62, -14.56), the config's own `clearance_x/y` (-11.6, -14.6) to within the
 * rounding of the config. That agreement is the one internal consistency check available
 * without the machine.
 */
export const Z1: MachineProfile = {
  id: 'Z1',
  name: 'Makera Z1',
  process: 'mill',
  envelope: { x: { min: -200, max: 0 }, y: { min: -200, max: 0 }, z: { min: -100, max: 0 } },
  maxCutFeed: 1200,
  maxRpm: 13000,
  hasATC: false,
  toolSlots: 0,
  capabilities: { rotary: true, laser: false, air: true, vacuum: false },
  dialect: { acceptsArcs: true, cannedCycles: false, grblMode: true, axisPrecision: 3, feedPrecision: 2 },
  anchor1: ANCHOR1,
  anchor2: [ANCHOR1[0] + 88.5, ANCHOR1[1] + 45.0],
  toolChange: {
    clearanceZ: -1.0,
    changePosition: [ANCHOR1[0] + 48.78 + 132, ANCHOR1[1] + 179.74],
    safeZ: -20.0,
    sensor: [ANCHOR1[0] + 181, ANCHOR1[1] + 181],
    sensorZ: -108,
    probeFastFeed: 500,
    probeSlowFeed: 100,
    probeRetract: 1,
  },
};

/** The only supported machine. A second one is configuration here, not a refactor elsewhere. */
export const MACHINES: Readonly<Record<string, MachineProfile>> = { Z1 };

export interface ClampDiagnostic {
  severity: 'error' | 'warning';
  code: 'feed-clamped' | 'rpm-clamped' | 'feed-refused' | 'rpm-refused';
  message: string;
}

export interface ClampResult {
  feed: number | null;
  rpm: number | null;
  diagnostics: ClampDiagnostic[];
}

/**
 * Over this fraction above the ceiling the value is REFUSED rather than clamped: a small
 * overage is a table written for a faster machine (Makera's 15 000 RPM rows on a 13 000 RPM
 * spindle are +15 %); a large one means the wrong tool, the wrong material, or garbage.
 */
export const CLAMP_REFUSE_FRACTION = 0.5;

/**
 * The single choke point every feed and spindle value passes through before it reaches a
 * toolpath. Clamps a modest overage and says so; refuses a gross one; passes `null` through
 * untouched (an unset value is the caller's problem, not a limit violation).
 */
export function clampToMachine(feed: number | null, rpm: number | null, machine: MachineProfile): ClampResult {
  const diagnostics: ClampDiagnostic[] = [];
  const one = (value: number | null, limit: number, what: 'feed' | 'rpm', unit: string): number | null => {
    if (value === null) return null;
    if (!(value <= limit)) {
      if (!Number.isFinite(value) || value > limit * (1 + CLAMP_REFUSE_FRACTION)) {
        diagnostics.push({
          severity: 'error',
          code: what === 'feed' ? 'feed-refused' : 'rpm-refused',
          message: `${what} ${value} ${unit} is more than ${Math.round(CLAMP_REFUSE_FRACTION * 100)} % above the ${machine.name}'s ${limit} ${unit} ceiling: refused, not clamped (wrong tool, wrong material, or corruption)`,
        });
        return null;
      }
      diagnostics.push({
        severity: 'warning',
        code: what === 'feed' ? 'feed-clamped' : 'rpm-clamped',
        message: `${what} ${value} ${unit} exceeds the ${machine.name}'s ${limit} ${unit} ceiling; clamped`,
      });
      return limit;
    }
    return value;
  };
  return {
    feed: one(feed, machine.maxCutFeed, 'feed', 'mm/min'),
    rpm: one(rpm, machine.maxRpm, 'rpm', 'RPM'),
    diagnostics,
  };
}

/** Is a MACHINE-coordinate point inside the envelope? Unknown axes are not checked. */
export function insideEnvelope(machine: MachineProfile, p: [number | null, number | null, number | null]): boolean {
  const e = machine.envelope;
  const ok = (v: number | null, r: AxisRange): boolean => v === null || (v >= r.min && v <= r.max);
  return ok(p[0], e.x) && ok(p[1], e.y) && ok(p[2], e.z);
}
