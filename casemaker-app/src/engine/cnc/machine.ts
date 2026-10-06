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

import { z } from 'zod';
import type { Mm, Vec2 } from '@/types/units';

export interface AxisRange {
  min: Mm;
  max: Mm;
}

/**
 * Every machine we model is one of these (#184, and #228's lesson).
 *
 * The multi-vendor study (#228) found that an abstraction modelling only "3-axis mill with a
 * spindle" does not survive contact with the field — a lathe, a camera-located router and a
 * laser-first machine are all in scope for "CNC software". So the shared contract is ONLY the
 * identity and this discriminator. Everything process-specific hangs off the process's own
 * subtype: a mill's spindle ceiling, tool change and holder live on `MillProfile`; a
 * printer's build volume and nozzle live on `PrinterProfile`. A future laser or lathe is a new
 * subtype, not a field added to every machine. Within a process, capabilities are FLAGS (what
 * hardware is fitted) and dialect is DATA (what the controller accepts), never structure.
 */
export type MachineProcess = 'fdm' | 'mill';

/** The identity and process discriminator every machine shares. */
export interface MachineIdentity {
  id: string;
  name: string;
  process: MachineProcess;
}

/**
 * The collet nut above the cutter (#191 item 4, #204): the widest thing above the tool, and
 * what reaches a low-profile vise first. `null` on the profile means NOT MEASURED.
 *
 * A null holder is not an error: #182 decided an unknown holder is reported as "cannot be
 * proven", never a refusal, or every tool would be refused (Makera's catalogue leaves lengths
 * empty for every engraver). The fixture check degrades the same way.
 */
export interface HolderProfile {
  /** The collet nut's diameter, mm. */
  nutDiameter: Mm;
  /** The collet nut's height, mm. */
  nutLength: Mm;
  /** Where the measurement came from (an owner's caliper, Maker's docs, ...). */
  source: string;
}

/**
 * The controller's soft endstops — **MEASURED on the machine** (#192 question 5, #208 B2,
 * 2026-10-06).
 *
 * The shipped config (`configZ1.default:429-432`) read `false / −206.0 / −206.0 / −102.0`. The
 * machine disagrees on **two of the four**: `config-get` returned `enable true` and
 * `x_min −207.00`, with `y_min −206.0` and `z_min −102.0` as documented. So the endstops are
 * **ENABLED** — the config has been changed on this machine, or drifted from the shipped default
 * — and nothing may assume the controller will let a move run past them.
 *
 * This is RECORDED, not enforced: `insideEnvelope` keeps using `envelope`, the conservative
 * −200/−200/−100. That is now the cautious side of a limit the machine really does hold, rather
 * than the only limit there is: the band `(−207, −200]` is reachable by hand but lies outside the
 * declared work area, so refusing there is a choice rather than an invention.
 */
export interface SoftEndstop {
  enabled: boolean;
  xMin: Mm;
  yMin: Mm;
  zMin: Mm;
  /** Where the numbers came from. */
  source: string;
}

/**
 * The optional 4th-axis module's profile (#237, `/Rotary.md` §3.5), sourced in the
 * {@link SoftEndstop} pattern: `undefined` means no module fitted.
 *
 * Every figure here is a READING of Makera's shipped config (`src/configZ1.default`) and
 * database (`t_MachineType` — the ⌀80 × 150 envelope), never of the device, so `source` says
 * so. R-1 measures the module at the bench and replaces them with `source: 'measured'` values
 * (`/Rotary.md` §9).
 *
 * DELIBERATELY NO ANGULAR TRAVEL LIMITS. A is unwound — the vendor's own files run to
 * −153 720° and reset with `G92.4 A0 S0` — so none exist; a limit here would be an invented
 * constraint (`/Rotary.md` §6.3). `capabilities.rotary` stays as "a module exists"; this block
 * says what it is.
 */
export interface RotaryProfile {
  /** The axis name. The module's is `A` (the stock's rotation about X). */
  axis: 'A';
  /** The machine axis the module is parented to (`Makera_Z1.fcm`). */
  parent: 'y';
  /** The stock envelope the module accepts, mm (`t_MachineType`). */
  envelope: { diameter: Mm; length: Mm };
  /** Steps per degree of A. Shipped 88.888889 = 32 000 steps per turn. */
  stepsPerDegree: number;
  /** Max A rate, °/min. Shipped 3600 = 60 °/s = 10 rpm. */
  maxRate: number;
  /** A acceleration, °/s². Shipped 360. */
  acceleration: number;
  /** Direction the shipped config homes A (`delta_homing_direction`). */
  homing: 'home_to_min';
  /** The firmware's rotary unwind, the code the vendor's own files end with. */
  unwind: 'G92.4 A S';
  /** Where every figure above came from. A shipped default is not a measurement. */
  source: string;
}

export interface MillProfile extends MachineIdentity {
  /** A mill. The only process with a spindle and a tool change (#183: Z1-only). */
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
  /** Sourced. Disabled, and past the vendor figure — see {@link SoftEndstop}. Not read by `insideEnvelope`. */
  softEndstop: SoftEndstop;
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
    /**
     * Z the head lifts to before moving to the change position, traverses to the sensor at
     * (`fill_cali_scripts(.., clear_z = true)` on the manual-change path), and returns to.
     *
     * **Measured**: `coordinate.clearance_z` is `-3.0` on the machine (#208 B6), not the `-1.0`
     * this profile carried from a reading of the shipped config. The old value was also B4's
     * homed rest Z, which would have meant `G28` did not move Z at all; it moves 2 mm.
     */
    clearanceZ: Mm;
    /** XY of the "clearance position" `G28` and the completion of a change go to (`clearance_x/y`). */
    clearanceXY: Vec2;
    /** XY the head parks at while the operator swaps the tool. */
    changePosition: Vec2;
    /** Z the head lifts to right after the length probe, before the final lift to clearance. */
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
  /**
   * The collet nut — the widest thing above the cutter (#204). `null` = not measured yet (#208),
   * which makes the sweep say clearance "cannot be proven" rather than guess. Do not invent a
   * number here: a guessed nut either hides a real crash or refuses a good tool.
   */
  holder: HolderProfile | null;
  /**
   * The 4th-axis module, when one is fitted (#237). `undefined` means none. Sourced data, not a
   * measurement — see {@link RotaryProfile}.
   */
  rotary?: RotaryProfile;
}

/**
 * A consumer FDM printer (#184, work item 4): the other half of the `MillProfile`
 * abstraction, behind the same `process` discriminant so printers and mills are the same kind
 * of thing. This is what used to be `PRINTER_PRESETS` in `rackFit.ts`, plus the nozzle width
 * that used to be `ASSUMED_NOZZLE` in `fasteners.ts` — the last machine numbers outside the
 * profile.
 *
 * A printer's work volume is POSITIVE extents (`0..x`), unlike the mill's negative machine
 * frame, so it is a separate field rather than the mill's `envelope`.
 */
export interface PrinterProfile extends MachineIdentity {
  process: 'fdm';
  /** Build volume, mm, as positive extents. */
  buildVolume: { x: number; y: number; z: number };
  /** Installed nozzle width, mm — the line width the slicer lays down. */
  nozzle: number;
}

/**
 * The bed's native XY datum, machine coordinates.
 *
 * **These are the firmware's SHIPPED DEFAULTS, and this machine is calibrated away from them.**
 * `configZ1.default:405-406` carries exactly these numbers; `config-get sd coordinate.anchor1_x`
 * and `.anchor1_y` read **(−190.89, −193.83)** out of the machine's own `/sd/config.txt` (#208 B6,
 * 2026-10-06) — 1.51 mm and 0.47 mm away (#279).
 *
 * An earlier version of this note argued for keeping them on the grounds that `changePosition` lands
 * on the config's `clearance_x` (−11.6; it computes −11.62) only with these numbers, and that the
 * machine's anchor moves it to −10.09. **That argument was wrong, and why it was wrong is worth
 * keeping.** `clearance` and `anchor1` are the two *opposite corners of the work area*, not links in
 * a derived chain: `ATCHandler::fill_Autoclean_scripts` sweeps X back and forth between `clearance_x`
 * and `anchor1_x`, and Y between `clearance_y` and `anchor1_y`. Two independent config keys that
 * happen to sit 0.02 mm apart under the shipped defaults are a coincidence, and a coincidence cannot
 * confirm a constant.
 *
 * What is actually true: `/sd/config.txt` is a *calibration* of the shipped defaults, and it has
 * moved several keys together — this anchor, `toolrack_offset_y` (179.74 → 181),
 * `rotation_offset_{x,y}` (12.0/85.5 → −7.5/69.0), `clearance_z` (−1.0 → −3.0) — while
 * `anchor2_offset` (88.5, 45.0) and `toolrack_offset_x` (48.8) are untouched. So nothing here says
 * the profile's anchor is *wrong*; what it says is that this profile describes a stock Z1 and this
 * machine is not one. Whether the profile should carry the machine's read instead of the vendor's
 * default is **#279's** open question, and it is not a cosmetic one: `sensor` and `changePosition`
 * derive from this constant, and the emulator drives a predicted tool-length probe to them.
 */
const ANCHOR1: Vec2 = [-192.4, -194.3];

/**
 * The Makera Z1.
 *
 * `t_MachineType`: 200 x 200 x 100, 1200 mm/min, 13 000 RPM, isATC = 0, rotary ⌀80 x 150.
 *
 * `coordinate.*`, **read on the machine** (`config-get sd`, 2026-10-06): `clearance_x` = `-11.6`
 * and `clearance_z` = `-3.0` — both exactly where bench item C1 watched `G28` stop, so the group
 * name and the values are hardware-confirmed. `atc.*` holds neither (it answers *"not in config"*),
 * so the earlier note crediting it was wrong. Everything the anchors, safe Z and sensor need is
 * under `coordinate.*`, and as of 2026-10-06 it has all been read — see the table below.
 *
 * `ATCHandler.cpp`: the Z1's sensor position is `anchor1 + 181` on each axis (line 266), and its
 * change position is `anchor1 + toolrack_offset + (132, 0)` (line 134) — the shipped defaults put
 * that at (-11.62, -14.56), which is *not* a consistency check on the anchor; see `ANCHOR1`.
 *
 * | Key | Shipped default | Read off the machine |
 * |---|---|---|
 * | `coordinate.anchor1_x` / `_y` | -192.4 / -194.3 | **-190.89 / -193.83** |
 * | `coordinate.anchor2_offset_x` / `_y` | 88.5 / 45.0 | 88.5 / 45.0 |
 * | `coordinate.toolrack_offset_x` / `_y` | 48.78 / 179.74 | **48.8 / 181** |
 * | `coordinate.toolrack_z` | (not in the default file) | -108 |
 * | `coordinate.clearance_x` / `_y` / `_z` | -11.6 / -14.6 / -1.0 | -11.6 / -14.6 / **-3.0** |
 * | `coordinate.rotation_offset_x` / `_y` / `_z` | 12.0 / 85.5 / — | **-7.5 / 69.0 / 17.0** |
 * | `coordinate.worksize_x` / `_y` | (not in the default file) | 200.0 / 200.0 |
 *
 * `toolrack_z` = **-108** is where `sensorZ` below comes from — the constant the profile had
 * credited to an unread key. `worksize` = 200 x 200 independently restates the vendor's own figure,
 * and `anchor2_offset` matching to the digit says the anchor *frame* is intact on this machine; only
 * its origin has been calibrated.
 *
 * The bolded values are the calibration. Whether this profile should carry them or the vendor's
 * defaults is **#279**.
 */
export const Z1: MillProfile = {
  id: 'Z1',
  name: 'Makera Z1',
  process: 'mill',
  envelope: { x: { min: -200, max: 0 }, y: { min: -200, max: 0 }, z: { min: -100, max: 0 } },
  maxCutFeed: 1200,
  maxRpm: 13000,
  hasATC: false,
  toolSlots: 0,
  // MEASURED (#208 B2, 2026-10-06): ENABLED, at −207/−206/−102 — 7/6/2 mm past the vendor's own
  // 200/200/100, and enforced. `envelope` stays the conservative figure.
  softEndstop: {
    enabled: true,
    xMin: -207.0,
    yMin: -206.0,
    zMin: -102.0,
    source: 'config-get sd, read on the machine (#208 B2, 2026-10-06)',
  },
  capabilities: { rotary: true, laser: false, air: true, vacuum: false },
  dialect: { acceptsArcs: true, cannedCycles: false, grblMode: true, axisPrecision: 3, feedPrecision: 2 },
  anchor1: ANCHOR1,
  anchor2: [ANCHOR1[0] + 88.5, ANCHOR1[1] + 45.0],
  // Every value here now has a read behind it (#208 B6, 2026-10-06). `clearanceXY`/`clearanceZ` come
  // from `coordinate.clearance_*`; `sensorZ` from `coordinate.toolrack_z` (-108, exact); the four
  // probe/height numbers from the `atc.*` group, which does exist and does agree — `atc.safe_z_mm`
  // -20.0, `atc.probe.fast_rate_mm_m` 500, `atc.probe.slow_rate_mm_m` 100 and `atc.probe.retract_mm`
  // 1, all matching this block digit for digit. `changePosition` and `sensor` are computed from
  // `ANCHOR1` per the firmware, so they inherit whatever #279 decides.
  toolChange: {
    clearanceZ: -3.0,
    clearanceXY: [-11.6, -14.6],
    changePosition: [ANCHOR1[0] + 48.78 + 132, ANCHOR1[1] + 179.74],
    safeZ: -20.0,
    sensor: [ANCHOR1[0] + 181, ANCHOR1[1] + 181],
    sensorZ: -108,
    probeFastFeed: 500,
    probeSlowFeed: 100,
    probeRetract: 1,
  },
  // PROVISIONAL (#208): the collet nut has never been measured. `null` is the honest value —
  // it makes the fixture check warn "cannot be proven" instead of testing a made-up cylinder.
  holder: null,
  // The shipped 4th-axis figures (#237, /Rotary.md §3.5). A reading of configZ1.default, not
  // the device; the ⌀80 x 150 envelope is from t_MachineType. R-1 replaces all of it.
  rotary: {
    axis: 'A',
    parent: 'y',
    envelope: { diameter: 80, length: 150 },
    stepsPerDegree: 88.888889,
    maxRate: 3600,
    acceleration: 360,
    homing: 'home_to_min',
    unwind: 'G92.4 A S',
    source: 'configZ1.default (shipped default, unverified)',
  },
};

/** The only supported MILL machine. A second one is configuration here, not a refactor elsewhere. */
export const MACHINES: Readonly<Record<string, MillProfile>> = { Z1 };

/**
 * The nozzle width assumed when the printer is not named. Nearly every consumer FDM machine
 * ships with a 0.4 mm nozzle, and the profile carries no per-job printer for the case and rack
 * compilers to read yet, so `preThreadPrintable` falls back to this. Moved here from
 * `fasteners.ts` (it is a machine number, and #184's acceptance greps for it outside the
 * profile). A real line-width setting, when one lands, replaces this in one place.
 */
export const ASSUMED_NOZZLE = 0.4;

/**
 * The consumer printers the rack fit-checker offers. Bed volumes, byte-identical ids and names
 * to the old `PRINTER_PRESETS`, so a stored `rack.printer.preset` keeps resolving; `nozzle` is
 * the addition this fold buys. Not supported machines to execute against — only fit volumes.
 */
export const PRINTER_PROFILES: readonly PrinterProfile[] = [
  { id: 'a1-mini', name: 'Bambu A1 mini (180³)', process: 'fdm', buildVolume: { x: 180, y: 180, z: 180 }, nozzle: ASSUMED_NOZZLE },
  { id: 'prusa-mini', name: 'Prusa MINI+ (180³)', process: 'fdm', buildVolume: { x: 180, y: 180, z: 180 }, nozzle: ASSUMED_NOZZLE },
  { id: 'ender-3', name: 'Ender-3 class (220×220×250)', process: 'fdm', buildVolume: { x: 220, y: 220, z: 250 }, nozzle: ASSUMED_NOZZLE },
  { id: 'prusa-mk4', name: 'Prusa MK4/MK3 (250×210×220)', process: 'fdm', buildVolume: { x: 250, y: 210, z: 220 }, nozzle: ASSUMED_NOZZLE },
  { id: 'bambu-256', name: 'Bambu X1/P1/A1 (256³)', process: 'fdm', buildVolume: { x: 256, y: 256, z: 256 }, nozzle: ASSUMED_NOZZLE },
  { id: 'prusa-xl', name: 'Prusa XL (360³)', process: 'fdm', buildVolume: { x: 360, y: 360, z: 360 }, nozzle: ASSUMED_NOZZLE },
];

/**
 * A machine of either process. The union is what makes the discriminant useful: a caller that
 * only needs the identity can take a `Machine`, and a caller that needs a spindle ceiling takes
 * a `MillProfile` and is told at compile time it is a mill.
 */
export type Machine = MillProfile | PrinterProfile;

/** Every machine we know, of any process (#184). */
export const ALL_MACHINES: readonly Machine[] = [Z1, ...PRINTER_PROFILES];

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
export function clampToMachine(feed: number | null, rpm: number | null, machine: MillProfile): ClampResult {
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
export function insideEnvelope(machine: MillProfile, p: [number | null, number | null, number | null]): boolean {
  const e = machine.envelope;
  const ok = (v: number | null, r: AxisRange): boolean => v === null || (v >= r.min && v <= r.max);
  return ok(p[0], e.x) && ok(p[1], e.y) && ok(p[2], e.z);
}

// ---------------------------------------------------------------------------
// Schemas (#184, work item 1)
// ---------------------------------------------------------------------------
//
// The profiles are code constants today, so nothing parses them yet; the schema exists because
// `src/store/projectSchema.ts` strips unknown keys, so the moment a profile is loaded from
// outside the code (a project, an import, a second machine) an unvalidated shape would silently
// lose fields. Same pattern as `toolLibrary.ts`: validate rather than trust.
//
// `hasATC: z.literal(false)` and `toolSlots: z.literal(0)` are deliberate, not laziness: the
// type itself promises a manual-change mill (#183, Z1-only), so a profile with an ATC is not a
// profile this schema accepts. A machine that has one adds a subtype, not a looser literal.

const finite = z.number().finite();
const vec2 = z.tuple([finite, finite]);

const softEndstopSchema = z.object({
  enabled: z.boolean(),
  xMin: finite,
  yMin: finite,
  zMin: finite,
  source: z.string().min(1),
});

const holderSchema = z.object({
  nutDiameter: finite.positive(),
  nutLength: finite.positive(),
  source: z.string().min(1),
});

/** The optional 4th-axis module (#237). A shipped default is carried as sourced data. */
const rotarySchema = z.object({
  axis: z.literal('A'),
  parent: z.literal('y'),
  envelope: z.object({ diameter: finite.positive(), length: finite.positive() }),
  stepsPerDegree: finite.positive(),
  maxRate: finite.positive(),
  acceleration: finite.positive(),
  homing: z.literal('home_to_min'),
  unwind: z.literal('G92.4 A S'),
  source: z.string().min(1),
});

export const millProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  process: z.literal('mill'),
  envelope: z.object({
    x: z.object({ min: finite, max: finite }),
    y: z.object({ min: finite, max: finite }),
    z: z.object({ min: finite, max: finite }),
  }),
  maxCutFeed: finite.positive(),
  maxRpm: finite.positive(),
  hasATC: z.literal(false),
  toolSlots: z.literal(0),
  softEndstop: softEndstopSchema,
  capabilities: z.object({ rotary: z.boolean(), laser: z.boolean(), air: z.boolean(), vacuum: z.boolean() }),
  dialect: z.object({
    acceptsArcs: z.boolean(),
    cannedCycles: z.boolean(),
    grblMode: z.boolean(),
    axisPrecision: z.number().int().positive(),
    feedPrecision: z.number().int().positive(),
  }),
  anchor1: vec2,
  anchor2: vec2,
  toolChange: z.object({
    clearanceZ: finite,
    clearanceXY: vec2,
    changePosition: vec2,
    safeZ: finite,
    sensor: vec2,
    sensorZ: finite,
    probeFastFeed: finite.positive(),
    probeSlowFeed: finite.positive(),
    probeRetract: finite,
  }),
  holder: holderSchema.nullable(),
  rotary: rotarySchema.optional(),
});

export const printerProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  process: z.literal('fdm'),
  buildVolume: z.object({ x: finite.positive(), y: finite.positive(), z: finite.positive() }),
  nozzle: finite.positive(),
});

/** Any machine, discriminated on `process`. */
export const machineSchema = z.discriminatedUnion('process', [millProfileSchema, printerProfileSchema]);
