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
import type { StockMaterial } from '@/types/engraveJob';
import type { RapidEstimate } from './cam/ir';
import { STOCK_MATERIALS } from './materials';

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
 * Every field of {@link RotaryProfile} whose provenance R-1 can replace on its own (#238).
 *
 * `axis` and `parent` are deliberately absent: they are the module's frame in Makera's own model
 * (`Makera_Z1.fcm`) — structure, not a figure any bench step re-measures.
 */
export type RotarySourcedField =
  | 'envelope'
  | 'stepsPerDegree'
  | 'maxRate'
  | 'acceleration'
  | 'homing'
  | 'unwind';

/**
 * The optional 4th-axis module's profile (#237, `/Rotary.md` §3.5): `undefined` means no module
 * fitted.
 *
 * PROVENANCE, PER FIELD (#238). A single `source` string for the whole block could not hold the
 * truth: `maxRate` and `acceleration` were READ off this machine's own config on 2026-10-07, while
 * `stepsPerDegree` and `homing` are still the shipped file and the envelope is from Makera's
 * database. So each figure carries its own string, and R-1 replaces them ONE AT A TIME at the bench
 * with `measured (#238, <date>)` as each row of `/Rotary.md` §9 is answered — the same shape as
 * `feeds.ts`'s per-field `sources`. This is the {@link SoftEndstop} pattern with one string per
 * sourced field instead of one per block, because here the fields do not share a source.
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
  /**
   * Where each figure above came from, keyed by the field it describes. A shipped default is not a
   * measurement, and the fields do not share a source — see the block's note.
   */
  sources: Record<RotarySourcedField, string>;
}

/**
 * One step of the controller's axes, as steps per millimetre (#221). Part of the MACHINE RECORD:
 * a cutter's narrowest useful groove is judged against `1 / xyPerMm`, never against a setting.
 */
export interface AxisSteps {
  xyPerMm: number;
  zPerMm: number;
  source: string;
}

export interface MillProfile extends MachineIdentity {
  /** A mill. The only process with a spindle and a tool change (#183: Z1-only). */
  process: 'mill';
  /**
   * The materials this profile says the machine is set up to cut (#347), in the order the setup
   * flow lists the ones only this list can offer.
   *
   * It is the MACHINE's own claim, and the app treats it as one: the flow offers the union of this
   * list and the starting table's own materials (`materialOptionsFor`), because a material with a
   * starting row is cut by this app's numbers whether or not a profile names it. What a profile
   * cannot supply is the numbers — a material here with no starting row is answerable only from the
   * user's own synced catalogue, and `feedsFor` refuses it until that row exists (#347, Route A).
   *
   * For the Z1 the list is Makera's OWN `t_MaterialList`, in this app's words, one entry per vendor
   * row this app can name EXACTLY. See the literal for what is left out and why.
   */
  materials: StockMaterial[];
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
  /**
   * The machine's rapid model, for the CYCLE ESTIMATE only (#281): the rate a rapid is timed at and
   * the acceleration every timed move is run through.
   *
   * The pairing with {@link maxCutFeed} above is the point. That field is the one limit on the
   * program and it bounds CUTTING moves; this one bounds nothing — it is a labelled assumption a
   * figure is computed from, and the post never writes it as an `F` (/Makera-Parity.md §11.2). A
   * reader looking for "how fast may this machine go" wants `maxCutFeed`; this is "what do we
   * assume it goes, to print a number".
   */
  rapidEstimate: RapidEstimate;
  /**
   * The axes' step resolution, from the controller's own steps-per-mm (#221). This is the
   * MACHINE's number, not a shop tunable: one X/Y microstep is `1 / xyPerMm` mm, and a V-carve
   * whose colour-plane groove is narrower than a few of them cannot be resolved into the two
   * walls the design asks for (`vCarveGrooveRefusal`).
   *
   * The Z1's 1600/3200 are the firmware's SHIPPED config (`configZ1.default`). They are not a
   * reading of this machine: `alpha_steps_per_mm` and `beta_steps_per_mm` answer *not in config*
   * on `/sd/config.txt`, and the compiled-in `firm` source is silent over the bridge (#208 B6/B7,
   * `Z1-Bridge-Protocol.md`). The source string says exactly that, so a later read can replace it.
   */
  axisSteps: AxisSteps;
  maxRpm: number;
  /**
   * The Z1's tool-change derivation constants, mm (#448) — promoted from bare module constants so
   * a profile carries them as data. They are MODEL constants, not a calibration's: a machine's own
   * read of the frame must not move the sensor or the change position it was never a measurement of.
   */
  sensorOffsetFromAnchor1: number;
  changePositionExtraX: number;
  /**
   * Provenance for the model's limits and the two derivation constants above (#448). One string per
   * sourced field — the {@link RotaryProfile} pattern — because a vendor figure and a compiled
   * `ATCHandler.cpp` constant do not share a source.
   */
  sources: {
    maxCutFeed: string;
    maxRpm: string;
    sensorOffsetFromAnchor1: string;
    changePositionExtraX: string;
  };
  /** `isATC=0`: a manual tool change, which is what makes `M490.1`/`M490.2` the tool-change path. */
  hasATC: false;
  toolSlots: 0;
  /**
   * #530 — the machine's own camera, when it serves one: the ESP32 module on the Z1 pushes JPEGs
   * over its own WebSocket. Absent on a machine with no camera, and then the camera panel is not
   * offered at all (never a pane that can only say "unavailable"). The path and the start word are
   * the module's, observed at the bench (`tools/z1/camera.mjs`); the port is NOT the command port.
   */
  camera?: { port: number; path: string; source: string };
  /**
   * The controller's software endstops, as read off the machine (`config-get sd`, #208 B2): the
   * Z1's literal is `enabled: true` since #279, bounding cuts short of the declared travel.
   * Carried for the profile's own account of the machine; `insideEnvelope` does NOT consult it,
   * and {@link envelope} is the field that describes where the head may go.
   */
  softEndstop: SoftEndstop;
  capabilities: {
    /** Optional 4th-axis module. Owned; not simulated in V1. */
    rotary: boolean;
    /** No laser module on this machine. A FLAG, so the absence is a fact rather than silence. */
    laser: boolean;
    /**
     * `M7`/`M9` air: **`false` on a Z1, and that is an observation, not a silence.** The
     * controller answers both `ok` and blows nothing (bench, 2026-10-12; no `M7`/`M9` appeared in
     * the 2026-10-07 traffic read either), so air via `M7` is a no-op here. It is not "the machine
     * has no air": the blowing mode is `M331.1`, part of the family below, which this app does not
     * drive.
     */
    air: boolean;
    /**
     * The bare `M331`/`M332` "extend out" mode — the vacuum, and what every real cut runs with
     * (maintainer's call at the bench, 2026-10-12, #283). `true`: our post writes those two words
     * and the machine obeys them — `M331` answered *turning extend out mode on* / `ok`, `M332`
     * *…off* / `ok`, sent from our own console around both first-chips runs
     * (`docs/bench/traces/2026-10-12-cut-rowA.log`). What was inference by elimination on
     * 2026-10-07 is a reading of our own traffic now.
     *
     * The rest of the machine's accessory surface is the same family's sub-codes — `M331.2` bed
     * cleaning, `M331.1` blowing — plus `M951` time-lapse, none of which this app emits or reads
     * (#283, #289; `/Z1-Firmware-Dialect.md` §11.3). The Carvera's internal vacuum, `M801`/`M802`,
     * is a different machine's and is not this.
     */
    vacuum: boolean;
    /**
     * The `M331.4`/`M332.4` sub-codes — "turning static electricity removal mode on/off", the
     * antistatic (static-removal) device (#564, `/Z1-Firmware-Dialect.md` §11.3). A SEPARABLE mode
     * in the same accessory family, independent of the bare vacuum above: the codes are confirmed
     * live at the bench. `true`: the machine has the device and answers the two sub-codes; the run
     * switches it on for plastic jobs and off at the run's end (the codes themselves live in
     * `machineVacuum.ts` beside `VACUUM_ON`/`VACUUM_OFF`).
     */
    antistatic: boolean;
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
    /** XY of the tool-length sensor: `anchor1 + sensorOffsetFromAnchor1` on each axis. See {@link FrameDerivationOffsets}. */
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
    /**
     * Provenance for the four probe/height numbers above (#448), read from the `atc.*` group
     * (`config-get sd`, 2026-10-06). One string per field, like {@link RotaryProfile.sources}.
     */
    sources: {
      safeZ: string;
      probeFastFeed: string;
      probeSlowFeed: string;
      probeRetract: string;
    };
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
 * The controller's `coordinate.*` group, in the controller's own vocabulary, mm (#279).
 *
 * This is DATA, not decoration. Every position the tool-change macro drives to is derived from
 * these six keys by {@link deriveCoordinateFrame}, so a machine whose configuration has been
 * calibrated away from the shipped default is a different VALUE of this object rather than a
 * second copy of the formula. That is what makes {@link Z1_FRAME} replaceable: `calibration.ts`
 * holds a machine's own read of exactly this object, and nothing downstream has to know which
 * one it was handed.
 *
 * The field names are the firmware's own key names, so a read can be checked against them one
 * for one — and a key that is missing from one of them is a key we have not read, not a key the
 * machine does not have.
 */
export interface CoordinateFrame {
  /** `coordinate.anchor1_x` / `_y`. The bed's native XY datum, and the origin of the rest. */
  anchor1: Vec2;
  /** `coordinate.anchor2_offset_x` / `_y`. The second anchor, RELATIVE to `anchor1`. */
  anchor2Offset: Vec2;
  /** `coordinate.toolrack_offset_x` / `_y`. The manual tool-change park offset from `anchor1`. */
  toolrackOffset: Vec2;
  /** `coordinate.clearance_x` / `_y`. Where `G28` and the end of a change put X and Y. */
  clearanceXY: Vec2;
  /** `coordinate.clearance_z`. The Z the head lifts to before any clearance traverse. */
  clearanceZ: Mm;
  /**
   * `coordinate.toolrack_z`. The Z the tool-length probe is commanded TOWARD — it stops early,
   * at the tool tip's contact, so this is a direction and a bound rather than a position.
   */
  toolrackZ: Mm;
}

/**
 * The two `ATCHandler.cpp` constants the tool-change derivation adds to a frame, mm (#448).
 * They are MODEL constants for the Z1, not measurements: `deriveCoordinateFrame` uses them for
 * BOTH the shipped and the calibrated frame, so a machine's own read must not move them. Their
 * provenance travels on the machine record's `sources`.
 */
export interface FrameDerivationOffsets {
  /**
   * How far past `anchor1`, on each axis, the Z1's tool-length sensor sits, mm
   * (`ATCHandler.cpp:266`, hard-coded for this model — the same number on X and Y, which is why
   * it is one number and not a `Vec2`).
   */
  sensorOffsetFromAnchor1: number;
  /**
   * The +X the manual change macro adds on top of `toolrack_offset_x`, mm (`ATCHandler.cpp:134`).
   * A fixed reach from the tool rack's own corner, not a clearance figure.
   */
  changePositionExtraX: number;
}

/** The Z1's {@link FrameDerivationOffsets}: the two `ATCHandler.cpp` model constants. */
export const Z1_DERIVATION_OFFSETS: FrameDerivationOffsets = {
  sensorOffsetFromAnchor1: 181,
  changePositionExtraX: 132,
};

/** The positions the tool-change macro is driven to, every one derived from a frame. */
export interface DerivedDatums {
  /** The second anchor, `anchor1 + anchor2Offset`. */
  anchor2: Vec2;
  /** The tool-length sensor, `anchor1 + sensorOffsetFromAnchor1` on each axis. */
  sensor: Vec2;
  /** Where the head parks for a manual change, `anchor1 + toolrackOffset + (changePositionExtraX, 0)`. */
  changePosition: Vec2;
}

/**
 * Derive the positions the head is actually driven to from the frame the controller holds.
 *
 * **ONE formula, two callers**: the shipped `Z1` below, and a machine's own read
 * (`calibration.ts`). While this was inline arithmetic inside the `Z1` literal, an override had
 * nowhere to put itself except a duplicated expression — and a duplicated derivation is how two
 * numbers that must agree stop agreeing.
 *
 * These three are the DERIVED positions. `clearanceXY`, `clearanceZ` and `sensorZ` are config
 * keys in their own right and are read from the frame directly; in particular
 * `clearance` and `anchor1` are the two *opposite corners of the work area*, not links in a
 * chain (`ATCHandler::fill_Autoclean_scripts` sweeps between them), so a change position that
 * lands on `clearance_x` is a coincidence of the shipped defaults rather than a check.
 */
export function deriveCoordinateFrame(frame: CoordinateFrame, offsets: FrameDerivationOffsets): DerivedDatums {
  const [ax, ay] = frame.anchor1;
  const [c2x, c2y] = frame.anchor2Offset;
  const [tx, ty] = frame.toolrackOffset;
  return {
    anchor2: [ax + c2x, ay + c2y],
    sensor: [ax + offsets.sensorOffsetFromAnchor1, ay + offsets.sensorOffsetFromAnchor1],
    changePosition: [ax + tx + offsets.changePositionExtraX, ay + ty],
  };
}

/**
 * The coordinate frame the shipped `Z1` profile carries, one value per `coordinate.*` key.
 *
 * **The anchors are the firmware's SHIPPED DEFAULTS, and this machine is calibrated away from
 * them.** `configZ1.default:405-406` carries exactly these numbers; `config-get sd
 * coordinate.anchor1_x` and `.anchor1_y` read **(−190.89, −193.83)** out of the machine's own
 * `/sd/config.txt` (#208 B6, 2026-10-06) — 1.51 mm and 0.47 mm away (#279).
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
 * machine is not one.
 *
 * **#279 decided how that is handled: default + override.** This constant is the DEFAULT half —
 * the profile a stock Z1 gets, which is what every user without a calibration should be running —
 * and `calibration.ts` is the override half, holding a machine's own read of this same object. The
 * anchors stay the vendor's on purpose: pasting one machine's calibration into the shipped profile
 * would aim every other Z1's probe 1.5 mm off, which is option 2 and was rejected.
 *
 * **This frame is not purely the vendor's file, and saying so is part of the fix.** Four of the six
 * keys are `configZ1.default`'s; the two Z values are this repo's own machine reads, because the
 * vendor file cannot supply them honestly:
 *
 *  - `clearanceZ` is **−3.0**, read on the machine (#208 B6), where `configZ1.default` says −1.0 —
 *    and −1.0 is also B4's post-homing rest Z, which would have meant `G28` moved no Z at all. C1
 *    watched it move 2 mm, to −3.000.
 *  - `toolrackZ` is **−108**, read on the machine (#208 B7). The vendor file has no such key; −108
 *    is Carvera-Air boilerplate the firmware uses as "all the way down", past this machine's own Z
 *    travel.
 *
 * So the profile as shipped was *already* part vendor and part measurement, and was silent about
 * which. That is the confusion this constant ends: every value below is traceable, and a machine
 * that disagrees supplies a whole frame rather than three borrowed numbers.
 */
export const Z1_FRAME: CoordinateFrame = {
  anchor1: [-192.4, -194.3], // configZ1.default:405-406
  anchor2Offset: [88.5, 45.0], // configZ1.default; identical on the machine (#208 B7)
  toolrackOffset: [48.78, 179.74], // configZ1.default; the machine reads 48.8 / 181 (#208 B7)
  clearanceXY: [-11.6, -14.6], // configZ1.default; identical on the machine, and C1 watched G28 stop here
  clearanceZ: -3.0, // READ on the machine (#208 B6); configZ1.default says -1.0
  toolrackZ: -108, // READ on the machine (#208 B7); absent from configZ1.default
};

/** The shipped frame's derived positions. `deriveCoordinateFrame` is the only thing that makes them. */
const Z1_DATUMS = deriveCoordinateFrame(Z1_FRAME, Z1_DERIVATION_OFFSETS);

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
 * that at (-11.62, -14.56), which is *not* a consistency check on the anchor; see {@link Z1_FRAME}.
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
 * The bolded values are this machine's calibration. **#279 decided what to do with them: the
 * shipped profile keeps the vendor's defaults (see {@link Z1_FRAME}) and a read like this one is
 * held separately, as a saved record with provenance, in `calibration.ts`.** Nothing below is
 * typed twice: every position in `toolChange` that the firmware derives, is derived here.
 */
export const Z1: MillProfile = {
  id: 'Z1',
  name: 'Makera Z1',
  process: 'mill',
  // Makera's own `t_MaterialList`, in this app's words (#347): the wood the Z1 ships cutting, the
  // two plastics and the four metals this app can NAME EXACTLY. The other vendor rows — `Bakelite`,
  // `Carbon Fiber`, `Epoxy Tooling`, `Synthetic Stone`, `Delrin`, `Polycarbonate`, `PCB` — are left
  // out because `CATALOGUE_MATERIALS` has no exact mapping for them: offering a word this app
  // cannot match to a row would offer a job nothing can answer. (The four plastics and woods the
  // STARTING TABLE covers — softwood, hardwood, MDF, PLA — are in this list where the vendor names
  // them and are unioned in by the flow where it does not.) The PRINTED-BLANK classes are the
  // exception (#456): they are PrusaSlicer's filament words, the catalogue has no row of its own
  // for any of them, and the #455 mapping answers each from the ABS and acrylic rows — so the
  // material select must be able to show a job imported as one.
  materials: [
    'softwood', 'hardwood', 'abs', 'acrylic',
    'petg', 'pet', 'asa', 'hips', 'pa', 'pa-cf', 'pa-gf', 'pc', 'pp', 'tpu', 'pva',
    'aluminium-6061', 'aluminium-7075', 'brass', 'copper',
  ],
  envelope: { x: { min: -200, max: 0 }, y: { min: -200, max: 0 }, z: { min: -100, max: 0 } },
  maxCutFeed: 1200,
  // The cycle estimate's rapid model (#281), from the controller's own config (`config-get sd`,
  // 2026-10-07): X/Y `alpha_max_rate` 1200, Z `gamma_max_rate` 600, `acceleration` 150 mm/s². One
  // stopwatch sample (2026-10-08) agreed to within its own spread; `#208 D3`'s timed air run closes
  // it. NOT a limit — nothing here clamps, and no `F` is ever written from it (§11.2).
  rapidEstimate: {
    xyMmPerMin: 1200,
    zMmPerMin: 600,
    accelMmPerS2: 150,
    source: 'config read 2026-10-07 + stopwatch 2026-10-08',
  },
  // The firmware's SHIPPED defaults (`configZ1.default`, /Makera-Parity.md §11.3), not a device
  // read: both keys answer *not in config*, and the compiled-in `firm` source is silent over the
  // bridge (#208 B7). One X/Y step is 1/1600 mm = 0.625 µm.
  axisSteps: {
    xyPerMm: 1600,
    zPerMm: 3200,
    source: 'configZ1.default, shipped firmware default — keys absent from /sd/config.txt and unreadable over the bridge',
  },
  maxRpm: 13000,
  // #448 — the two ATCHandler.cpp derivation constants, promoted from bare module constants so
  // their provenance travels on the record (see `sources`). They are MODEL constants: a
  // calibration must not move them (deriveCoordinateFrame reads the base record's copies).
  sensorOffsetFromAnchor1: Z1_DERIVATION_OFFSETS.sensorOffsetFromAnchor1,
  changePositionExtraX: Z1_DERIVATION_OFFSETS.changePositionExtraX,
  // #448 — provenance for the limits and the derivation constants above. One string per field
  // (the RotaryProfile pattern): a vendor figure and a compiled C++ constant do not share a source.
  sources: {
    maxCutFeed: 't_MachineType, Makera library database (the Z1 row) — a vendor figure, not measured',
    maxRpm: 't_MachineType, Makera library database (the Z1 row) — a vendor figure, not measured',
    sensorOffsetFromAnchor1: 'ATCHandler.cpp:266, hard-coded for the Z1 model — the same number on X and Y',
    changePositionExtraX: 'ATCHandler.cpp:134, hard-coded for the Z1 model',
  },
  hasATC: false,
  toolSlots: 0,
  // #530 — the camera module observed on 2026-10-08 (#286, `tools/z1/camera.mjs`): a WebSocket on
  // port 82 sends baseline JPEGs after the text `start_stream`, and its first frames after a
  // (re)connect replay the previous client's last frame — which is why the stream skips three.
  camera: {
    port: 82,
    path: '/ws_video',
    source: 'observed on the Z1, 2026-10-08 (#286): ws://<host>:82/ws_video, `start_stream`, binary JPEG frames',
  },
  // MEASURED (#208 B2, 2026-10-06): ENABLED, at −207/−206/−102 — 7/6/2 mm past the vendor's own
  // 200/200/100, and enforced. `envelope` stays the conservative figure.
  softEndstop: {
    enabled: true,
    xMin: -207.0,
    yMin: -206.0,
    zMin: -102.0,
    source: 'config-get sd, read on the machine, 2026-10-06',
  },
  // `air: false` — `M7`/`M9` are answered `ok` and blow nothing on this machine; `vacuum: true` —
  // the post writes bare `M331`/`M332` and the machine obeys them (#283, bench 2026-10-12).
  // `antistatic: true` — the device is mounted and answers `M331.4`/`M332.4` (#564, bench 2026-10).
  capabilities: { rotary: true, laser: false, air: false, vacuum: true, antistatic: true },
  dialect: { acceptsArcs: true, cannedCycles: false, grblMode: true, axisPrecision: 3, feedPrecision: 2 },
  // The frame and its derivations, not the numbers themselves: `Z1_DATUMS` is
  // `deriveCoordinateFrame(Z1_FRAME)` and is the only thing that computes a position (#279).
  anchor1: Z1_FRAME.anchor1,
  anchor2: Z1_DATUMS.anchor2,
  // The four probe/height numbers come from the `atc.*` group, which does exist and does agree —
  // `atc.safe_z_mm` -20.0, `atc.probe.fast_rate_mm_m` 500, `atc.probe.slow_rate_mm_m` 100 and
  // `atc.probe.retract_mm` 1, all matching this block digit for digit (#208 B6, 2026-10-06).
  toolChange: {
    clearanceZ: Z1_FRAME.clearanceZ,
    clearanceXY: Z1_FRAME.clearanceXY,
    changePosition: Z1_DATUMS.changePosition,
    safeZ: -20.0,
    sensor: Z1_DATUMS.sensor,
    sensorZ: Z1_FRAME.toolrackZ,
    probeFastFeed: 500,
    probeSlowFeed: 100,
    probeRetract: 1,
    // #448 — the four probe/height numbers are read from the machine's `atc.*` group
    // (`config-get sd`, 2026-10-06), not the shipped config. Provenance per field.
    sources: {
      safeZ: 'config-get sd on the machine, 2026-10-06 (atc.safe_z_mm -20.0)',
      probeFastFeed: 'config-get sd on the machine, 2026-10-06 (atc.probe.fast_rate_mm_m 500)',
      probeSlowFeed: 'config-get sd on the machine, 2026-10-06 (atc.probe.slow_rate_mm_m 100)',
      probeRetract: 'config-get sd on the machine, 2026-10-06 (atc.probe.retract_mm 1)',
    },
  },
  // Unmeasured, and no longer needed by the sweep (#314, 2026-10-08): the collet grips the shank,
  // never the flutes, so the nut face is at least `shoulderLength` above the tip at any seating
  // and the depth gate at `shoulderLength` keeps it out of the stock. `null` stays the honest
  // value; it matters only for an obstacle that rises above the stock top.
  holder: null,
  // The 4th-axis figures (#237, /Rotary.md §3.5), each with its own provenance (#238). `maxRate`
  // and `acceleration` were READ from the machine's own config on 2026-10-07 (`delta_max_rate` =
  // 3600, `delta_acceleration` = 360, docs/bench/2026-10-07-config-sweep.json; runbook B9) and match
  // configZ1.default digit for digit — a config read, still not a measurement. `stepsPerDegree`,
  // `homing` and the unwind are the shipped file (`delta_steps_per_mm` and `delta_homing_direction`
  // never answered on the machine: absent from /sd/config.txt). The ⌀80 x 150 envelope is Makera's
  // own database row. R-1 replaces each string with `measured (#238, <date>)` as its §9 row lands.
  rotary: {
    axis: 'A',
    parent: 'y',
    envelope: { diameter: 80, length: 150 },
    stepsPerDegree: 88.888889,
    maxRate: 3600,
    acceleration: 360,
    homing: 'home_to_min',
    unwind: 'G92.4 A S',
    sources: {
      envelope: 't_MachineType, Makera library database (the Z1 row) — a vendor figure, not measured',
      stepsPerDegree: 'configZ1.default, shipped default (key absent from /sd/config.txt) — unverified',
      maxRate: 'config-get sd on the machine, 2026-10-07 — a config read, not a measurement',
      acceleration: 'config-get sd on the machine, 2026-10-07 — a config read, not a measurement',
      homing: 'configZ1.default, shipped default (key absent from /sd/config.txt) — unverified',
      unwind: 'configZ1.default / Robot.cpp, corroborated by the vendor rotary files (they end on G92.4A0S0) — unverified on the device',
    },
  },
};

/** The only supported MILL machine. A second one is configuration here, not a refactor elsewhere. */
export const MACHINES: Readonly<Record<string, MillProfile>> = { Z1 };

/**
 * The smallest X/Y move the controller can make, mm: one step of the axes (#221). Read from the
 * MACHINE RECORD's `axisSteps`, so a second machine (or a real read of this one) changes the V
 * groove bound by changing one field, and no shop setting can move it.
 */
export function minimumXyStepMm(machine: MillProfile): number {
  return 1 / machine.axisSteps.xyPerMm;
}

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
 *
 * THE LABELLED FALLBACK for the shop's `clamp.refuseFraction` (#448). The shop default lives in
 * `location.json` and is read through `readDefault`; this is the number used with no house
 * service, and the value `clampToMachine` falls back to when a caller passes none.
 */
export const CLAMP_REFUSE_FRACTION_FALLBACK = 0.5;

/**
 * The single choke point every feed and spindle value passes through before it reaches a
 * toolpath. Clamps a modest overage and says so; refuses a gross one; passes `null` through
 * untouched (an unset value is the caller's problem, not a limit violation).
 *
 * `refuseFraction` is the shop's `clamp.refuseFraction` — the band above the ceiling where a
 * value is refused rather than clamped. It is threaded in so {@link feedsFor} and
 * {@link catalogueRefusal} (and any other caller) all use the one number; the default is the
 * labelled fallback above.
 */
export function clampToMachine(
  feed: number | null,
  rpm: number | null,
  machine: MillProfile,
  refuseFraction: number = CLAMP_REFUSE_FRACTION_FALLBACK,
): ClampResult {
  const diagnostics: ClampDiagnostic[] = [];
  const one = (value: number | null, limit: number, what: 'feed' | 'rpm', unit: string): number | null => {
    if (value === null) return null;
    if (!(value <= limit)) {
      if (!Number.isFinite(value) || value > limit * (1 + refuseFraction)) {
        diagnostics.push({
          severity: 'error',
          code: what === 'feed' ? 'feed-refused' : 'rpm-refused',
          message: `${what} ${value} ${unit} is more than ${Math.round(refuseFraction * 100)} % above the ${machine.name}'s ${limit} ${unit} ceiling: refused, not clamped (wrong tool, wrong material, or corruption)`,
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

/**
 * The optional 4th-axis module (#237). A shipped default is carried as sourced data, one string per
 * sourced field (#238) — so a profile that states a rate but not where it came from does not parse.
 */
const rotarySchema = z.object({
  axis: z.literal('A'),
  parent: z.literal('y'),
  envelope: z.object({ diameter: finite.positive(), length: finite.positive() }),
  stepsPerDegree: finite.positive(),
  maxRate: finite.positive(),
  acceleration: finite.positive(),
  homing: z.literal('home_to_min'),
  unwind: z.literal('G92.4 A S'),
  sources: z.object({
    envelope: z.string().min(1),
    stepsPerDegree: z.string().min(1),
    maxRate: z.string().min(1),
    acceleration: z.string().min(1),
    homing: z.string().min(1),
    unwind: z.string().min(1),
  }),
});

export const millProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  process: z.literal('mill'),
  // #347 — the profile's own material claim, parsed against the ONE vocabulary
  // (`engine/cnc/materials.ts`), so a profile's parse output is a `MillProfile` rather than a shape
  // with a `string[]` where the materials go. A word this build does not know fails the parse and is
  // reported at the profile, which is the honest place for a machine that claims a material the app
  // cannot cut — `materialOptionsFor`'s guard is for the opposite case, a field the JOB carries.
  materials: z.array(z.enum(STOCK_MATERIALS)),
  envelope: z.object({
    x: z.object({ min: finite, max: finite }),
    y: z.object({ min: finite, max: finite }),
    z: z.object({ min: finite, max: finite }),
  }),
  maxCutFeed: finite.positive(),
  // #281 — the estimate's rapid model. Positive like the other motion numbers: a zero rate would
  // make a rapid instantaneous rather than estimated, which is a claim about the machine this field
  // is not allowed to make. `source` is required for the same reason every other `source` is.
  rapidEstimate: z.object({
    xyMmPerMin: finite.positive(),
    zMmPerMin: finite.positive(),
    accelMmPerS2: finite.positive(),
    source: z.string().min(1),
  }),
  // #221 — the axes' own step resolution. Positive like every other motion number; a zero would
  // claim infinitely fine steps, which is a claim about hardware this field cannot make.
  axisSteps: z.object({
    xyPerMm: finite.positive(),
    zPerMm: finite.positive(),
    source: z.string().min(1),
  }),
  maxRpm: finite.positive(),
  sensorOffsetFromAnchor1: finite,
  changePositionExtraX: finite,
  // #448 — a profile that states a limit or a derivation constant without its provenance does
  // not parse, for the same reason a rotary field without a source does not.
  sources: z.object({
    maxCutFeed: z.string().min(1),
    maxRpm: z.string().min(1),
    sensorOffsetFromAnchor1: z.string().min(1),
    changePositionExtraX: z.string().min(1),
  }),
  hasATC: z.literal(false),
  toolSlots: z.literal(0),
  softEndstop: softEndstopSchema,
  capabilities: z.object({ rotary: z.boolean(), laser: z.boolean(), air: z.boolean(), vacuum: z.boolean(), antistatic: z.boolean() }),
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
    sources: z.object({
      safeZ: z.string().min(1),
      probeFastFeed: z.string().min(1),
      probeSlowFeed: z.string().min(1),
      probeRetract: z.string().min(1),
    }),
  }),
  holder: holderSchema.nullable(),
  rotary: rotarySchema.optional(),
  // #530 — the machine's own camera, when it serves one: an OPTIONAL sourced endpoint, the rotary
  // block's shape. A port is positive (port 0 is no endpoint), the path is absolute, and `source`
  // is required for the same reason every other provenance string on a profile is.
  camera: z
    .object({
      port: z.number().int().positive(),
      path: z.string().regex(/^\//, 'a camera path starts with /'),
      source: z.string().min(1),
    })
    .optional(),
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
