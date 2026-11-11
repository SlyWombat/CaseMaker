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
 * Scope was the Z1 ONLY until #773. Carvera and Carvera Air are rows in Makera's own database,
 * and #773 brings them in as far as the evidence goes: the Carvera Air is a full profile (its
 * shipped controller settings are Makera's own open-source Controller's), while the Carvera is a
 * {@link MillModel} — the vendor's row with NO frame, because no Carvera controller configuration
 * has ever been read. What #183 guarded against (a second machine's numbers silently borrowed from
 * the Z1) is what the `frameState` discriminator now makes impossible to compile past.
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
import { MACHINE_FRAME_UNREAD, MACHINE_RUN_ELSEWHERE } from './machineWords';
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

/**
 * #845 — WHICH POST WRITES THIS MACHINE'S FILES. `'z1'` is the Makera/Smoothie dialect this app
 * has always written; `'grbl'` is a machine run from its owner's own sender. OPTIONAL and absent
 * reads `'z1'`, so every stored record and literal written before the field existed is unchanged.
 */
export type MachinePost = 'z1' | 'grbl';

/**
 * #845 — THE WORK-ORIGIN CONVENTION a stated machine's programs are written against.
 *
 *   - `'top-front-left'` — the Z1's convention and the app's `PostContext.origin` literal: G54 at
 *     the stock's front-left corner, Z0 on its top face.
 *   - `'top-centre'` — the centre-zero convention most GRBL senders offer: G54 at the stock's XY
 *     CENTRE, Z0 on its top face.
 *
 * Absent reads `'top-front-left'`, so every profile written before the field existed is unchanged.
 * A FRAMED profile (the Z1, the Carvera Air) never carries it: its convention is the controller's,
 * read with its frame. Only a stated machine — one Case Maker writes files for and never drives —
 * states one.
 */
export type WorkOrigin = 'top-front-left' | 'top-centre';

/** The identity and process discriminator every machine shares. */
export interface MachineIdentity {
  id: string;
  name: string;
  process: MachineProcess;
  /**
   * #845 — the POST that writes this machine's `.nc`; absent reads `'z1'`. Named `post`, not
   * `dialect`: a profile's `dialect` is already the G-code FORMATTING table (arcs, precision),
   * which every post reads — this is which post reads it.
   */
  post?: MachinePost;
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
  /**
   * Steps per degree of A. Shipped 88.888889 = 32 000 steps per turn on the Z1. `null` where the
   * machine's controller configuration has never been read (#773) — the Carvera family's shipped
   * user settings file carries the A rate and acceleration but not this figure.
   */
  stepsPerDegree: number | null;
  /** Max A rate, °/min. Shipped 3600 = 60 °/s = 10 rpm. */
  maxRate: number;
  /** A acceleration, °/s². Shipped 360. */
  acceleration: number;
  /** Direction the shipped config homes A (`delta_homing_direction`); `null` when unread. */
  homing: 'home_to_min' | null;
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
 *
 * `null` is a machine whose controller configuration has never been read (#773): the Carvera Air's
 * shipped user settings file carries rates but not `*_steps_per_mm`, and nothing else we hold does.
 * A reader that needs the step says so rather than assuming the Z1's.
 */
export type AxisSteps =
  | {
      xyPerMm: number;
      zPerMm: number;
      source: string;
    }
  | null;

/** #828 — an ATC's rack as the frame states it: slot positions (tools 1..n), and the exchange Z. */
export interface ToolRack {
  /** Slot XY in MACHINE coordinates, index 0 = tool 1. */
  slots: readonly Vec2[];
  /** The Z the changer exchanges at (`coordinate.toolrack_z`). */
  z: Mm;
  /** Where those positions come from — never left silent, because none of them is a measurement. */
  source: string;
}

/**
 * #845 — THE CONTROLLER'S G-CODE FORMATTING: what a POST writes to. `dialect` on a framed profile
 * is the controller's own table; a stated GRBL machine carries {@link GRBL_FORMATTING}, the one
 * constants GRBL 1.1 itself defines. Both are machine data, so the posts read one field through
 * {@link dialectOf} rather than each deciding what precision to write.
 */
export interface MachineDialect {
  /** The controller takes `G2`/`G3`; other CAM emits them. */
  acceptsArcs: boolean;
  /** It does NOT take canned cycles; the vendor's own post translates drill cycles. */
  cannedCycles: boolean;
  grblMode: boolean;
  axisPrecision: number;
  feedPrecision: number;
}

export interface MillProfile extends MachineIdentity {
  /** A mill. The only process with a spindle and a tool change. */
  process: 'mill';
  /**
   * The controller frame this profile carries has been established (#773): the vendor's shipped
   * defaults, or a machine's own read of them (never mixed). A model whose frame keys we have never
   * seen is a {@link MillModel}, not a MillProfile, and nothing that needs a position may use it.
   */
  frameState: 'read';
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
   * #927 — THE SPINDLE'S RAMP, seconds from rest to the profile's working speed, when this model
   * states a measured one; `null`/absent means NOT MEASURED and the estimate prices no spin-up.
   *
   * The number's home is here, on the profile; the ESTIMATE reads it through
   * {@link RapidEstimate.spinUpSeconds}, and every framed profile sets both from one constant so a
   * spec can hold them equal. `#935`'s D3 air session replaces the value with its own timing.
   */
  spinUpSeconds?: number | null;
  /** Where {@link spinUpSeconds} came from, in words; present exactly when that is. */
  spinUpSource?: string;
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
   * The model's tool-change derivation constants, mm (#448) — promoted from bare module constants
   * so a profile carries them as data. They are MODEL constants, not a calibration's: a machine's
   * own read of the frame must not move the sensor or the change position it was never a
   * measurement of. One pair per axis since #773: the Air's sensor is 280 on X and 196 on Y.
   */
  sensorOffsetFromAnchor1: Vec2;
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
  /**
   * Whether the machine has the automatic tool changer fitted, and how many slots it holds
   * (`t_MachineType.isATC` / `ATC_Number`). The Z1 is `false`/`0` — a manual tool change, which is
   * what makes `M490.1`/`M490.2` its path — while the Carvera's changer holds six (#773).
   */
  hasATC: boolean;
  toolSlots: number;
  /**
   * #828 — THE RACK ITSELF, when the machine has an automatic changer: where each slot stands in
   * MACHINE coordinates, and the Z every exchange happens at. Absent on a manual machine.
   *
   * The POSITIONS are a statement, not a command: our post writes `Tn M6` and the controller
   * drives its own rack, so nothing here is ever commanded by this app. They are carried so the
   * machine profile can STATE the changer the way it states the travel — and so a reader can see
   * that a Carvera's slots are the firmware's default arrangement rather than a measurement. A
   * machine that has configured its own slots (`load_custom_tool_slots`) reports those on its own
   * console and its config; this app does not hold them, and `source` says so.
   */
  toolRack?: ToolRack;
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
     * cleaning and `M331.1` blowing (the spindle's Auto Blow, switched by the RUN since #1060 when
     * `run.blowWithVacuum` is on — `blow` below) — plus `M951` time-lapse, none of which this app
     * writes into a file or reads back (#283, #289; `/Z1-Firmware-Dialect.md` §11.3). The Carvera's
     * internal vacuum, `M801`/`M802`, is a different machine's and is not this.
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

    /**
     * #1060 — the `M331.1`/`M332.1` sub-codes: "turning auto blowing mode on/off", Makera's Auto
     * Blow (the Z1 quick start's spindle air blowing; Studio's own MDI log sends `M331.1`). A
     * separable mode in the vacuum's family, switched by the RUN when the shop's
     * `run.blowWithVacuum` (or the job) asks for it — never written in a file, exactly like the
     * antistatic above. The bench's first line (`M331.1` → `ok`, air at the spindle) is owed.
     */
    blow: boolean;
  };
  dialect: MachineDialect;
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
   * #1133 — THE HEAD'S ENVELOPE: the widest body around the spindle that can come down within the
   * probe-touch height above the tool tip, as a RADIUS. It is what a registration's seat tap must
   * clear — the collet nut alone is not the head (the bench refused a point 7.5 mm in front of the
   * stock because the HEAD, not the tip, would hit the taller wood).
   *
   * A PRODUCT CONSTANT for a shipped machine (every Z1 is the same unit), never a shop knob;
   * `source` says where the number came from. Absent when the machine states none, and then a
   * caller chooses the point it can prove or says the envelope is unknown — it never invents one.
   */
  headEnvelope?: { radiusMm: Mm; source: string };
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
   * How far past `anchor1`, on each axis, the machine's tool-length sensor sits, mm
   * (`ATCHandler.cpp:266`, hard-coded per model: 181 on both axes for the Z1, 280 and 196 for the
   * Carvera Air). One pair per axis, because the models do not share a single number (#773).
   */
  sensorOffsetFromAnchor1: Vec2;
  /**
   * The +X the manual change macro adds on top of `toolrack_offset_x`, mm (`ATCHandler.cpp:134`).
   * A fixed reach from the tool rack's own corner, not a clearance figure.
   */
  changePositionExtraX: number;
}

/** The Z1's {@link FrameDerivationOffsets}: the two `ATCHandler.cpp` model constants. */
export const Z1_DERIVATION_OFFSETS: FrameDerivationOffsets = {
  sensorOffsetFromAnchor1: [181, 181],
  changePositionExtraX: 132,
};

/**
 * The Carvera Air's {@link FrameDerivationOffsets} (#773), from the same `ATCHandler.cpp` and its
 * own model branch: the manual tool change parks the head at `anchor1 + (280, 196)` to probe the
 * tool (`ATCHandler.cpp`, the `CARVERA_AIR == MachineModel` arm), and the change position adds the
 * same `132` on X every model does (`ATCHandler.cpp:134`).
 */
export const CA1_DERIVATION_OFFSETS: FrameDerivationOffsets = {
  sensorOffsetFromAnchor1: [280, 196],
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
    sensor: [ax + offsets.sensorOffsetFromAnchor1[0], ay + offsets.sensorOffsetFromAnchor1[1]],
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
 * The materials every Makera mill's profile carries (#347, #773): Makera's own `t_MaterialList`,
 * in this app's words, one entry per vendor row this app can name EXACTLY. The library table has
 * no machine column — the vendor list is the firm's materials, not a per-model one — so the same
 * list rides on the Z1 and both Carveras. See the Z1's `materials` field for what is left out and
 * why.
 */
const MAKERA_MATERIALS: StockMaterial[] = [
  'softwood', 'hardwood', 'abs', 'acrylic',
  'petg', 'pet', 'asa', 'hips', 'pa', 'pa-cf', 'pa-gf', 'pc', 'pp', 'tpu', 'pva',
  'aluminium-6061', 'aluminium-7075', 'brass', 'copper',
  // #743 P-1 — Makera's `PCB` row, now that this app has the material for it.
  'pcb',
  // #1066 — Makera's `Epoxy Tooling` rows; the M1 stock on hand is this board.
  'epoxy-tooling',
];

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
/**
 * #927 — the Z1 spindle's ramp, seconds, and where it came from. The profile carries it twice on
 * purpose: `spinUpSeconds` is the profile's home for the number, `rapidEstimate.spinUpSeconds` is
 * where the cycle estimate reads it; one constant keeps the two from drifting.
 */
const Z1_SPIN_UP_SECONDS = 12;
const Z1_SPIN_UP_SOURCE =
  'the 2026-10-15 185-v-groove cut trace: S:36.8 at 17:18:08.262 to S:12011.7 at 17:18:20.296, ~12 s from rest to 12000 rpm (docs/bench/traces/2026-10-15-185-cut.log); a speed-field read, not the D3 timed run';

export const Z1: MillProfile = {
  id: 'Z1',
  name: 'Makera Z1',
  process: 'mill',
  frameState: 'read',
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
  materials: MAKERA_MATERIALS,
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
    // #927 — the same number as the profile's own field below, set from one constant.
    spinUpSeconds: Z1_SPIN_UP_SECONDS,
    spinUpSource: Z1_SPIN_UP_SOURCE,
    aMaxDegPerMin: 3600,
  },
  // #927 — the spindle's ramp at this machine's working speed, read from the 2026-10-15 cut trace:
  // `S:36.8` at 17:18:08.262 and `S:12011.7` at 17:18:20.296, with the intermediate samples between
  // (5568.6, 9834.0, 11162.4, 11748.3, 11927.8) — about 12 s from rest to 12 000 rpm. A READ OF THE
  // SPEED FIELD, not the D3 timed air run; #935's D3 session replaces it with its own timing.
  spinUpSeconds: Z1_SPIN_UP_SECONDS,
  spinUpSource: Z1_SPIN_UP_SOURCE,
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
    // #1173A — the source is shown to the operator, so it says where the numbers came from in
    // their words; the command that read them is provenance for a bench note, not for this page.
    source: 'read from the machine, 2026-10-06',
  },
  // `air: false` — `M7`/`M9` are answered `ok` and blow nothing on this machine; `vacuum: true` —
  // the post writes bare `M331`/`M332` and the machine obeys them (#283, bench 2026-10-12).
  // `antistatic: true` — the device is mounted and answers `M331.4`/`M332.4` (#564, bench 2026-10).
  capabilities: { rotary: true, laser: false, air: false, vacuum: true, antistatic: true, blow: true },
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
  // #1133 — THE HEAD, measured from Makera's own public model: `Machine_Design_Files/
  // Makera-Z1_Simplified_4Axis.step` (github.com/MakeraInc/CarveraProfiles; sha256
  // b7df28bcc66a1923457211e610579848ea25b1b950fcdcb19d969747888dfd12; vendor file, never
  // committed). ONE HEIGHT FILTER: only a body that can come DOWN within the stock's height plus
  // clearance above the tip can ever hit the stock, and the Z carriage/housing sits far above that
  // band. Of the head-sized solids the one inside the band measures 52 × 57 × 67 mm, so the
  // envelope is its widest half-extent: radius 28.5 mm. (The 92 mm bodies are the carriage and are
  // excluded by that filter — the #1133 review's correction.) It lands the seat point about where
  // the maintainer probed by hand (0f, machine (−175, −35)), and #943's bench agenda carries the
  // caliper line that replaces it with a measured nose.
  headEnvelope: {
    radiusMm: 28.5,
    source:
      'Makera’s public Z1 model (Machine_Design_Files/Makera-Z1_Simplified_4Axis.step, sha256 b7df28bc…), height-filtered to the bodies that can descend within the stock’s height plus clearance above the tip: the one in that band measures 52 × 57 × 67 mm, taken as a 57 mm diameter (radius 28.5 mm); the assembly transforms were not resolved, so it is a model reading, not a calipered nose — #943 owes the caliper',
  },
  // The 4th-axis figures (#237, /Rotary.md §3.5), each with its own provenance (#238). After the
  // 2026-10-27 evidence pass (/Rotary.md §9) every source names Makera's own artifact: the shipped
  // config (`configZ1.default`), Studio's `ControllerConfig.txt`, the library database's
  // `t_MachineType` row, and the decompiled Studio's G92.4 strings. `maxRate` and `acceleration`
  // were also READ from the machine's own config on 2026-10-07 (`delta_max_rate` = 3600,
  // `delta_acceleration` = 360, docs/bench/2026-10-07-config-sweep.json; runbook B9) and match
  // configZ1.default digit for digit — a config read, still not a measurement. R-1 replaces each
  // string with `measured (#238, <date>)` as its §9 row lands.
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
      envelope:
        'Makera’s own figure (t_MachineType row “Makera Z1”: range_A_Diameter 80, range_A_Length 150 — the library database, read 2026-10-26) — not measured',
      stepsPerDegree:
        'Makera’s shipped value (configZ1.default delta_steps_per_mm 88.888889 = 32 000 steps per turn; absent from the machine’s /sd/config.txt, sweep 2026-10-07) — unverified on the device',
      maxRate:
        'Makera’s shipped value (configZ1.default delta_max_rate 3600 °/min = 60 °/s = 10 rpm; Studio’s ControllerConfig.txt and the machine’s config read 2026-10-07 agree) — a config read, not a measurement',
      acceleration:
        'Makera’s shipped value (configZ1.default delta_acceleration 360 °/s²; Studio’s ControllerConfig.txt and the machine’s config read 2026-10-07 agree) — a config read, not a measurement',
      homing:
        'Makera’s shipped value (configZ1.default delta_homing_direction home_to_min, delta_min_endstop 1.4^, delta_limit_enable true; absent from the machine’s /sd/config.txt) — unverified on the device',
      unwind:
        'Makera’s shipped value (configZ1.default / Robot.cpp: G92.4 A S drops whole turns, R resets to the value modulo 360; Studio sends G92.4 A0 S0 and calls it “A-axis shrunk”, and the vendor rotary files end on it) — unverified on the device',
    },
  },
};

/**
 * The Carvera Air's shipped coordinate frame (#773), from Makera's own Carvera Controller
 * (`github.com/MakeraInc/CarveraController`, `src/config.txt`, commit
 * `3914c912452f83fbd5b5d90c730cb78795198438`). That file is the Carvera Air model's shipped
 * user-settings document — its own `wifi.machine_name CARVERA_AIR_Lab_2` names the model, and its
 * `worksize_x/y` (300 × 200) agree with the library database's CA1 row digit for digit, which is
 * the consistency check the anchors do not have. The firmware's `ATCHandler.cpp` carries the same
 * model's toolrack defaults (`-108` / `126` / `196`, lines 1579–1583), and its rotation offsets
 * (41.5 / 82.5 / 23 here, 30 / 82.5 / 23 as the firmware default) are the controller file's
 * newer values.
 *
 * NOT THIS Z1's EXPORT: Studio's `ControllerConfig.txt` on this machine carries the Z1's own
 * numbers (anchor1 −190.89 / −193.83, clearance_z −3.0, rotation −7.5 / 69 / 17) — the values this
 * file already records as THIS machine's reads — so it was not used for a Carvera. A stock Air's
 * own `/sd/config.txt` may have been calibrated away from these shipped defaults; that read is
 * #279's override, and it is not held here.
 */
export const CA1_FRAME: CoordinateFrame = {
  anchor1: [-287.51, -202.11], // CarveraController src/config.txt @ 3914c912
  anchor2Offset: [88.5, 45.0], // the same file; identical on the Z1, the frame shape is the family's
  toolrackOffset: [126.0, 196.0], // the same file; the firmware's CA1 defaults agree (ATCHandler.cpp:1579-1583)
  clearanceXY: [-5.0, -21.0], // the same file
  clearanceZ: -3.0, // the same file
  toolrackZ: -108, // the same file; the firmware's CA1 default agrees
};

/** The shipped Air frame's derived positions — `deriveCoordinateFrame` is the only thing that makes them. */
const CA1_DATUMS = deriveCoordinateFrame(CA1_FRAME, CA1_DERIVATION_OFFSETS);

/**
 * The Makera Carvera Air (#773): the second FRAMED mill.
 *
 * `t_MachineType` (read 2026-10-29, the CA1 row): 300 × 200 × 130, rotary ⌀92 × 200, no ATC,
 * 3000 mm/min, 13 000 RPM. The shipped frame and motion settings are the Carvera Controller's
 * `src/config.txt` at 3914c912: the rates and acceleration, the probe feeds, safe Z and the soft
 * endstops.
 *
 * WHAT IS NULL, RATHER THAN COPIED FROM THE Z1: the axes' steps-per-mm and the rotary's
 * steps-per-degree and homing direction. The user-settings file states none of them, and nothing
 * else we hold does; a controller read against a real Air is what fills them.
 *
 * WHAT IS FALSE, AND IS NOT SILENCE: this app's accessory words are the Z1's (`M331`/`M332` and
 * their sub-codes). The Carvera's vacuum is `M801`/`M802` — a different machine's controls, which
 * this app does not drive — so `vacuum`, `air` and `antistatic` are false here because the post
 * must not speak them at a Carvera, not because the machine lacks them. `rotary` is true: the
 * library row states the module's envelope. `laser` is false: no source states one is fitted.
 *
 * The dialect is the shared Makera firmware's (MakeraZ1Firmware @ 8ae81f3 carries the
 * `CARVERA_AIR` branches beside the Z1's), read off that firmware's parser and its own G-code
 * vocabulary — a family figure, NOT verified on a Carvera Air.
 */
export const CARVERA_AIR: MillProfile = {
  id: 'CA1',
  name: 'Makera Carvera Air',
  process: 'mill',
  frameState: 'read',
  materials: MAKERA_MATERIALS,
  envelope: { x: { min: -300, max: 0 }, y: { min: -200, max: 0 }, z: { min: -130, max: 0 } },
  maxCutFeed: 3000,
  // CarveraController src/config.txt @ 3914c912: alpha/beta_max_rate 3000, gamma_max_rate 2000,
  // acceleration 150. Shipped settings, not a stopwatch — the estimate's own label says so.
  rapidEstimate: {
    xyMmPerMin: 3000,
    zMmPerMin: 2000,
    accelMmPerS2: 150,
    source: 'CarveraController src/config.txt @ 3914c912 — shipped settings, not measured',
  },
  axisSteps: null,
  maxRpm: 13000,
  sensorOffsetFromAnchor1: CA1_DERIVATION_OFFSETS.sensorOffsetFromAnchor1,
  changePositionExtraX: CA1_DERIVATION_OFFSETS.changePositionExtraX,
  sources: {
    maxCutFeed:
      'makera_library.db t_MachineType, Carvera Air (CA1) row, read 2026-10-29 (vendor figure, not measured)',
    maxRpm:
      'makera_library.db t_MachineType, Carvera Air (CA1) row, read 2026-10-29 (vendor figure, not measured)',
    sensorOffsetFromAnchor1:
      'MakeraZ1Firmware ATCHandler.cpp, the CARVERA_AIR manual-change arm (anchor1 + 280 on X, + 196 on Y), commit 8ae81f3 — the firmware’s own model constant',
    changePositionExtraX:
      'MakeraZ1Firmware ATCHandler.cpp:134 (+132 on X for every model), commit 8ae81f3',
  },
  // t_MachineType CA1: isATC 0, ATC_Number 0.
  hasATC: false,
  toolSlots: 0,
  // CarveraController src/config.txt @ 3914c912: soft_endstop.enable true, x_min -302, y_min
  // -212, z_min -121 — the same 2/12/9 mm past the envelope the Z1's machine reads hold.
  softEndstop: {
    enabled: true,
    xMin: -302.0,
    yMin: -212.0,
    zMin: -121.0,
    source: 'CarveraController src/config.txt @ 3914c912 — shipped settings, not measured',
  },
  capabilities: { rotary: true, laser: false, air: false, vacuum: false, antistatic: false, blow: false },
  dialect: { acceptsArcs: true, cannedCycles: false, grblMode: true, axisPrecision: 3, feedPrecision: 2 },
  anchor1: CA1_FRAME.anchor1,
  anchor2: CA1_DATUMS.anchor2,
  toolChange: {
    clearanceZ: CA1_FRAME.clearanceZ,
    clearanceXY: CA1_FRAME.clearanceXY,
    changePosition: CA1_DATUMS.changePosition,
    safeZ: -20.0, // atc.safe_z_mm
    sensor: CA1_DATUMS.sensor,
    sensorZ: CA1_FRAME.toolrackZ,
    probeFastFeed: 500, // atc.probe.fast_rate_mm_m
    probeSlowFeed: 100, // atc.probe.slow_rate_mm_m
    probeRetract: 2, // atc.probe.retract_mm (the Z1's is 1)
    sources: {
      safeZ: 'CarveraController src/config.txt @ 3914c912 (atc.safe_z_mm -20.0) — shipped settings',
      probeFastFeed: 'CarveraController src/config.txt @ 3914c912 (atc.probe.fast_rate_mm_m 500)',
      probeSlowFeed: 'CarveraController src/config.txt @ 3914c912 (atc.probe.slow_rate_mm_m 100)',
      probeRetract: 'CarveraController src/config.txt @ 3914c912 (atc.probe.retract_mm 2)',
    },
  },
  holder: null,
  // The rotary module's envelope is the library row's; the A rate and acceleration are the
  // controller file's shipped settings; the steps and homing are unread (see the profile note).
  rotary: {
    axis: 'A',
    parent: 'y',
    envelope: { diameter: 92, length: 200 },
    stepsPerDegree: null,
    maxRate: 2400,
    acceleration: 360,
    homing: null,
    unwind: 'G92.4 A S',
    sources: {
      envelope:
        'Makera’s own figure (t_MachineType CA1 row: range_A_Diameter 92, range_A_Length 200 — the library database, read 2026-10-29) — not measured',
      stepsPerDegree:
        'not read from a Carvera Air: its shipped user-settings file states no steps per degree, and no other source we hold does',
      maxRate: 'CarveraController src/config.txt @ 3914c912 (delta_max_rate 2400) — shipped settings',
      acceleration: 'CarveraController src/config.txt @ 3914c912 (delta_acceleration 360) — shipped settings',
      homing: 'not read from a Carvera Air: its shipped user-settings file states no homing direction',
      unwind:
        'the shared Makera firmware (MakeraZ1Firmware Robot.cpp:667, G92.4) @ 8ae81f3 — not verified on a Carvera Air',
    },
  },
};

/**
 * A mill MODEL whose controller frame has never been read (#773): the vendor's own database row,
 * and nothing that needs a position.
 *
 * Deliberately not a {@link MillProfile}. Every position the app drives to — the tool-change park,
 * the length probe, `G28`'s clearance, the soft endstops — comes from a controller configuration,
 * and inventing one is how a head is driven into a fixture. A location may hold this model (a shop
 * can own a Carvera), the picker may name it, and anything that needs a frame answers
 * {@link MACHINE_FRAME_UNREAD} instead.
 */
export interface MillModel extends MachineIdentity {
  process: 'mill';
  /**
   * #1133 — the head envelope a seat tap must clear, when the model states one. A stated (GRBL)
   * machine usually does not: absent is "unknown", and the caller says so rather than inventing.
   */
  headEnvelope?: { radiusMm: Mm; source: string };
  /**
   * #845 — `'unread'`: a vendor model whose controller frame has not been read yet (connect it
   * once). `'stated'`: a GRBL machine whose values the OWNER stated and which this app never
   * connects to — export only — so there is no frame to read and none is invented.
   */
  frameState: 'unread' | 'stated';
  /**
   * #845 — the work-origin convention the machine's programs are written against; absent reads
   * `'top-front-left'` (see {@link WorkOrigin}). Stated machines only: a framed profile's
   * convention is its controller's.
   */
  workOrigin?: WorkOrigin;
  materials: StockMaterial[];
  envelope: { x: AxisRange; y: AxisRange; z: AxisRange };
  maxCutFeed: number;
  maxRpm: number;
  /**
   * #845 — THE RAPID MODEL, for the cycle ESTIMATE only (it is never written as an `F`). A framed
   * profile reads it from its controller configuration; a stated machine carries the owner's own
   * numbers, and the estimate's `source` says exactly that. Required, so a post reads one field
   * and no caller has to decide what an absent estimate means.
   */
  rapidEstimate: RapidEstimate;
  hasATC: boolean;
  toolSlots: number;
  /** The rotary module's stock envelope, from the same row; absent when the row names none. */
  rotaryEnvelope?: { diameter: number; length: number };
  sources: {
    envelope: string;
    maxCutFeed: string;
    maxRpm: string;
    atc: string;
    /** Present exactly when the model states a rotary — a machine without one has no source. */
    rotaryEnvelope?: string;
  };
}

/** A mill: a framed {@link MillProfile}, or a {@link MillModel} with no frame yet. */
export type Mill = MillProfile | MillModel;

// #845 — the two sentences live in their own module (no imports) so the run gate can print one
// without loading this one; every importer of this module still gets them from here.
export { MACHINE_FRAME_UNREAD, MACHINE_RUN_ELSEWHERE } from './machineWords';

/** The refusal for a model with no frame, or null when the model carries one. */
export function machineFrameProblem(model: Mill): string | null {
  if (model.frameState === 'stated') return MACHINE_RUN_ELSEWHERE;
  return model.frameState === 'unread' ? MACHINE_FRAME_UNREAD : null;
}

/** A mill model by id — framed or not — or undefined for an id this build does not know. */
export function millModelById(id: string | null | undefined): Mill | undefined {
  return id == null ? undefined : MILL_MODELS[id];
}

/**
 * #845 — the work-origin convention a stated machine's programs are written against; absent reads
 * `'top-front-left'`. One reader, so the post, the header sentence and the run sheet cannot default
 * differently.
 */
export function workOriginOf(model: MillModel): WorkOrigin {
  return model.workOrigin ?? 'top-front-left';
}

/**
 * #845 — THE FORMATTING A POST WRITES TO. A framed profile carries its controller's own table
 * (`dialect`); a stated model's controller is GRBL 1.1, whose formatting the post's own constants
 * state, because there is no controller configuration to read one from and no record field to
 * carry one. Named here so both posts and the frame-height rule read one function.
 */
export function dialectOf(machine: Mill): MachineDialect {
  return 'dialect' in machine ? machine.dialect : GRBL_FORMATTING;
}

/**
 * #845 — GRBL 1.1's formatting: three axis decimals and two feed decimals, the same grid the Z1's
 * post writes. Stated HERE because a stated machine has no controller configuration to read a table
 * from: this is Case Maker's choice for the files it writes, not a vendor figure, and it is what the
 * GRBL post's golden file pins. `acceptsArcs`/`cannedCycles` are GRBL 1.1's own capabilities; this
 * app's CAM emits neither today.
 */
export const GRBL_FORMATTING: MachineDialect = {
  acceptsArcs: true,
  cannedCycles: true,
  grblMode: true,
  axisPrecision: 3,
  feedPrecision: 2,
};

/**
 * #845 — the collet nut a sweep or a verifier may model. A stated machine's holder has never been
 * measured — nothing here drives it — and `null` is the profile's own word for "not measured", so
 * every reader degrades to "cannot be proven" exactly as it does on an unmeasured Z1.
 */
export function holderOf(machine: Mill): HolderProfile | null {
  return machine.frameState === 'read' ? machine.holder : null;
}

/**
 * #1133 — THE HEAD ENVELOPE a registration's seat tap must clear, or null when the machine states
 * none. Read from the profile only: it is a product constant of the machine, not a measurement of
 * this shop's setup (the holder is the part that is calipered per unit).
 */
export function headEnvelopeOf(machine: Mill): { radiusMm: number; source: string } | null {
  return machine.headEnvelope ?? null;
}

/**
 * #877 — WHAT A MACHINE CAN DO ABOUT A FOURTH AXIS, for every caller that used to write
 * `rotaryOf(...)?.envelope ?? <the Z1's numbers>`. That fallback confused "no machine described"
 * with "a machine that has none": a STATED machine states three axes and its owner is never
 * offered a chuck, so the Z1's envelope must not be applied to its rod stock.
 */
export type RotaryCapability =
  | { kind: 'framed'; envelope: { diameter: number; length: number } }
  | { kind: 'none' }
  | { kind: 'unknown' };

export function rotaryCapability(machine: Mill | MillModel): RotaryCapability {
  if (machine.frameState === 'read') {
    return machine.rotary === undefined ? { kind: 'unknown' } : { kind: 'framed', envelope: machine.rotary.envelope };
  }
  return { kind: machine.frameState === 'stated' ? 'none' : 'unknown' };
}

/**
 * #845 — the rotary module a machine carries, if any. A stated machine states three axes
 * (`RotaryProfile` is a framed profile's), so it answers none: `undefined` is the same word a Z1
 * without the module uses, and every rotary reader already handles it.
 */
export function rotaryOf(machine: Mill): RotaryProfile | undefined {
  return machine.frameState === 'read' ? machine.rotary : undefined;
}

/**
 * #845 — the clearance Z a framed machine's tool-change macro lifts to, or null for a stated machine:
 * it has no controller macro and this app never drives it. A caller that needs a number uses it only
 * where it also refuses the stated case by name (`MACHINE_RUN_ELSEWHERE`).
 */
export function clearanceZOf(machine: Mill): number | null {
  return machine.frameState === 'read' ? machine.toolChange.clearanceZ : null;
}

/** #845 — the soft-endstop model, or null when the machine carries no read controller frame. */
export function softEndstopOf(machine: Mill): SoftEndstop | null {
  return machine.frameState === 'read' ? machine.softEndstop : null;
}

/** The frame refusal for an id: null for a framed or UNKNOWN id, the sentence for an unread one. */
export function machineFrameProblemById(id: string | null | undefined): string | null {
  const model = millModelById(id);
  return model === undefined ? null : machineFrameProblem(model);
}

/**
 * #828 — THE CARVERA'S SHIPPED FRAME, from the Carvera Community Firmware: the open-source fork
 * that targets the ORIGINAL Carvera (C1), not the Air. Its `src/config.default` carries
 * `wifi.machine_name CARVERA_01001` (the Air's file is `config2.default` with
 * `CARVERA_AIR_01001`), and the anchor, toolrack, clearance and worksize values below; the keys
 * the file leaves commented are the firmware's own compiled defaults, which `ATCHandler.cpp` and
 * `Robot.cpp` state.
 *
 * Commit: `2c97111cb0bbd6d3edfac2c138963c0255248865`
 * (github.com/Carvera-Community/Carvera_Community_Firmware).
 *
 * NONE OF IT IS A READ OF A MACHINE. A Carvera whose own `/sd/config.txt` was calibrated away
 * from these shipped defaults reports its own values, and the #279 connection read is what would
 * replace them — the same standing the Air's shipped frame has. And it is NOT the Z1's Studio
 * export nor the Air's Controller config: #773 records which file belongs to which machine.
 */
export const C1_FRAME: CoordinateFrame = {
  anchor1: [-360.158, -234.568], // src/config.default @ 2c97111 — coordinate.anchor1_x/_y, active lines
  anchor2Offset: [90.0, 45.0], // y active in the same file; x is its documented default (coordinate.anchor2_offset_x)
  toolrackOffset: [356.0, 0.0], // the file's documented defaults; ATCHandler.cpp's CARVERA defaults agree
  clearanceXY: [-75.0, -3.0], // ATCHandler.cpp's CARVERA arm (@ 2c97111); config.default documents the same
  clearanceZ: -3.0, // the same arm
  toolrackZ: -112.5, // config.default's ACTIVE coordinate.toolrack_z (ATCHandler's compiled default is -105)
};

/**
 * The Carvera's derivation constants (#828), from the same firmware commit:
 *
 *  - the tool-length sensor: `ATCHandler.cpp`'s CARVERA probe fallback is
 *    `(anchor1_x + toolrack_offset_x, anchor1_y + toolrack_offset_y + 180)` — (356, 180) from
 *    anchor1 — used when the machine configures no `probe_mcs_*`;
 *  - the +132 on X: the family's change-arm constant (`ATCHandler.cpp`), the same number the Z1
 *    and the Air derive. A Carvera with an ATC never runs a manual park — the controller's `M6`
 *    drives its own rack — so the change position this derives is the family formula, carried
 *    because the profile's shape is shared, not a position this app commands.
 *
 * The config.default comment beside `probe_mcs_*` states the unset probe as Y −42.568, Z −157.0,
 * which DISAGREES with this commit's code (Y −54.568, Z −152.5 at the same file's toolrack_z).
 * The code is what the firmware runs, so the code's formula is recorded here and the
 * disagreement is stated rather than smoothed over.
 */
export const C1_DERIVATION_OFFSETS: FrameDerivationOffsets = {
  sensorOffsetFromAnchor1: [356, 180],
  changePositionExtraX: 132,
};

/** The Carvera's shipped frame and its derived datums (#828). */
const C1_DATUMS = deriveCoordinateFrame(C1_FRAME, C1_DERIVATION_OFFSETS);

/**
 * The changer's default rack (#828): six slots (`t_MachineType`'s `ATC_Number`), the firmware's
 * own default arrangement — tool i at `anchor1 + toolrack_offset`, 30 mm apart along Y, tool 1 at
 * the far end. A machine that configured custom slots (`load_custom_tool_slots`) reports those
 * instead; this app never commands a slot, so the numbers are carried to be STATED.
 */
const C1_RACK_SLOTS: readonly Vec2[] = [1, 2, 3, 4, 5, 6].map(
  (tool): Vec2 => [
    // Rounded to the firmware's own three decimals: -234.568 + 150 is -84.56800000000001 in
    // binary, and a position printed to a screen should read as the number the firmware states.
    Number((C1_FRAME.anchor1[0] + C1_FRAME.toolrackOffset[0]).toFixed(3)),
    Number((C1_FRAME.anchor1[1] + C1_FRAME.toolrackOffset[1] + (6 - tool) * 30).toFixed(3)),
  ],
);

/**
 * The Makera Carvera (#773, framed in #828): the vendor's row for the travel and the changer's
 * size, and the Carvera Community Firmware's shipped configuration for the frame the controller
 * works in.
 *
 * `t_MachineType` (read 2026-10-29, the Carvera/C1 row): 320 × 240 × 140, rotary ⌀92 × 240, ATC
 * with 6 tools, 3000 mm/min, 15 000 RPM. The worksize the firmware file states (340 × 240) is
 * WIDER on X than the vendor row; the row is what this app bounds a job's stock with, and the
 * firmware figure is noted here rather than preferred, because the row is the machine's stated
 * range and the work area is not.
 *
 * WHAT IS NULL, RATHER THAN COPIED FROM THE Z1: the axes' steps-per-mm (the firmware's
 * `config.default` carries the generic Smoothieboard 200, not this machine's steps, and nothing
 * else we hold states them) and the rotary's steps-per-degree and homing direction. A controller
 * read against a real Carvera is what fills them.
 *
 * WHAT IS FALSE, AND IS NOT SILENCE: this app's accessory words are the Z1's (`M331`/`M332` and
 * their sub-codes). The Carvera's vacuum is `M801`/`M802` — a different machine's controls, which
 * this app does not drive — so `vacuum`, `air` and `antistatic` are false here because the post
 * must not speak them at a Carvera, not because the machine lacks them. `rotary` is true: the
 * library row states the module's envelope. `laser` is false: no source states one is fitted.
 *
 * The dialect is the shared Makera firmware's — the same family the Air's comment records — read
 * off that firmware's parser and its own G-code vocabulary.
 */
export const CARVERA: MillProfile = {
  id: 'C1',
  name: 'Makera Carvera',
  process: 'mill',
  frameState: 'read',
  materials: MAKERA_MATERIALS,
  envelope: { x: { min: -320, max: 0 }, y: { min: -240, max: 0 }, z: { min: -140, max: 0 } },
  maxCutFeed: 3000,
  rapidEstimate: {
    xyMmPerMin: 3000,
    zMmPerMin: 2000,
    accelMmPerS2: 150,
    // src/config.default @ 2c97111: alpha/beta_max_rate 3000, gamma_max_rate 2000, acceleration
    // 150 — the documented defaults (the Air ships the same rates). Shipped settings, not measured.
    source:
      'Carvera Community Firmware src/config.default @ 2c97111 (alpha/beta_max_rate 3000, gamma_max_rate 2000, acceleration 150 — the keys’ defaults) — shipped settings, not measured',
  },
  axisSteps: null,
  maxRpm: 15000,
  sensorOffsetFromAnchor1: C1_DERIVATION_OFFSETS.sensorOffsetFromAnchor1,
  changePositionExtraX: C1_DERIVATION_OFFSETS.changePositionExtraX,
  sources: {
    maxCutFeed:
      'makera_library.db t_MachineType, Carvera (C1) row (maxFeedRate 3000), read 2026-10-29 (vendor figure, not measured)',
    maxRpm:
      'makera_library.db t_MachineType, Carvera (C1) row (maxRPM 15000), read 2026-10-29 (vendor figure, not measured)',
    sensorOffsetFromAnchor1:
      'Carvera Community Firmware src/modules/tools/atc/ATCHandler.cpp @ 2c97111 — the CARVERA probe fallback (anchor1 + toolrack offsets, +180 on Y) when no probe_mcs_* is configured',
    changePositionExtraX:
      'Carvera Community Firmware src/modules/tools/atc/ATCHandler.cpp @ 2c97111 — the +132 on X every model’s change arm uses (an ATC Carvera changes at its rack, not here)',
  },
  // t_MachineType C1: isATC 1, ATC_Number 6.
  hasATC: true,
  toolSlots: 6,
  toolRack: {
    slots: C1_RACK_SLOTS,
    z: C1_FRAME.toolrackZ,
    source:
      'Carvera Community Firmware src/modules/tools/atc/ATCHandler.cpp @ 2c97111 — the default slot list built when a machine configures no custom slots (tool i at anchor1 + the toolrack offsets, 30 mm apart along Y); a machine with its own slot list reports those, and this app does not hold them',
  },
  softEndstop: {
    enabled: true,
    xMin: -371.0,
    yMin: -250.0,
    zMin: -135.0,
    // src/modules/robot/Robot.cpp @ 2c97111: soft_endstop.enable true, x_min -371.0, y_min -250.0,
    // z_min -135.0 — the firmware's compiled defaults; config.default documents the same values.
    source:
      'Carvera Community Firmware src/modules/robot/Robot.cpp @ 2c97111 (the soft_endstop defaults) — shipped settings, not measured',
  },
  capabilities: { rotary: true, laser: false, air: false, vacuum: false, antistatic: false, blow: false },
  dialect: { acceptsArcs: true, cannedCycles: false, grblMode: true, axisPrecision: 3, feedPrecision: 2 },
  anchor1: C1_FRAME.anchor1,
  anchor2: C1_DATUMS.anchor2,
  toolChange: {
    clearanceZ: C1_FRAME.clearanceZ,
    clearanceXY: C1_FRAME.clearanceXY,
    changePosition: C1_DATUMS.changePosition,
    // atc.safe_z_mm, an ACTIVE key in the same config.default; the Air's file ships the same value.
    safeZ: -20.0,
    sensor: C1_DATUMS.sensor,
    // The firmware's CARVERA probe fallback: `toolrack_z − 40` at the same commit, so -152.5 at this
    // file's toolrack_z. It is BELOW the 140 mm travel the row states, exactly as the Air's -108 is
    // below its 130 — recorded as the firmware would send it, not as a reachable position.
    sensorZ: C1_FRAME.toolrackZ - 40,
    probeFastFeed: 500, // atc.probe.fast_rate_mm_m, active
    probeSlowFeed: 100, // atc.probe.slow_rate_mm_m, active
    probeRetract: 2, // atc.probe.retract_mm — the documented default (the Z1's is 1)
    sources: {
      safeZ: 'Carvera Community Firmware src/config.default @ 2c97111 (atc.safe_z_mm -20.0) — shipped settings',
      probeFastFeed: 'Carvera Community Firmware src/config.default @ 2c97111 (atc.probe.fast_rate_mm_m 500)',
      probeSlowFeed: 'Carvera Community Firmware src/config.default @ 2c97111 (atc.probe.slow_rate_mm_m 100)',
      probeRetract: 'Carvera Community Firmware src/config.default @ 2c97111 (atc.probe.retract_mm default 2)',
    },
  },
  holder: null,
  rotary: {
    axis: 'A',
    parent: 'y',
    envelope: { diameter: 92, length: 240 },
    stepsPerDegree: null,
    // delta_max_rate 1800 and delta_acceleration 360, both ACTIVE keys in the same file.
    maxRate: 1800,
    acceleration: 360,
    homing: null,
    unwind: 'G92.4 A S',
    sources: {
      envelope:
        'Makera’s own figure (t_MachineType C1 row: range_A_Diameter 92, range_A_Length 240 — the library database, read 2026-10-29) — not measured',
      stepsPerDegree:
        'not stated anywhere we hold: the Carvera Community Firmware config.default carries no rotary steps per degree for the C1',
      maxRate: 'Carvera Community Firmware src/config.default @ 2c97111 (delta_max_rate 1800) — shipped settings',
      acceleration:
        'Carvera Community Firmware src/config.default @ 2c97111 (delta_acceleration 360) — shipped settings',
      homing:
        'not stated: config.default leaves delta_homing_direction commented at this commit, so the A axis’s homing direction is unread',
      unwind:
        'the shared Makera firmware (MakeraZ1Firmware Robot.cpp:667, G92.4) @ 8ae81f3 — the same family',
    },
  },
};

/**
 * #845 SLICE B — THE GRBL MACHINES THE APP SHIPS PRESETS FOR.
 *
 * A stated machine, not a vendor row: the owner tells the app the work area and the spindle, and
 * Case Maker writes its `.nc` for the owner's own sender and never drives the machine
 * (`frameState: 'stated'`, `post: 'grbl'`). Every value's `sources` entry says where it came from —
 * the vendor's published spec with its URL, or "stated by you — the vendor publishes no value" for
 * the handful no vendor states. Nothing here is measured on the maintainer's bench, and nothing is
 * invented and labelled as published.
 *
 * THE ENVELOPE IS THE WORK AREA, from the machine's front-left corner: `0 … W` on each axis. The
 * Z1's negative machine frame is a controller convention it has and these machines do not; a
 * stated machine's numbers are relative to the work origin the profile names in `workOrigin`.
 *
 * THE VALUES ARE STARTING POINTS. Any of them may be edited on the machine record; after an edit
 * the value is the owner's, which is why the Manage row reads "values stated by you".
 */

/** A cited value: the vendor's number, with the page it came from. */
const cited = (what: string, url: string): string => `${what} (${url})`;

/** What no vendor publishes: the owner's own starting value, said as such. */
const statedByYou = (what: string): string => `stated by you — ${what}`;

const GRBL_MATERIALS: StockMaterial[] = ['softwood', 'hardwood', 'mdf', 'plastic', 'acrylic', 'aluminium-6061'];

/** The 0…extent envelope a work-area figure makes. */
const workArea = (x: number, y: number, z: number): MillModel['envelope'] => ({
  x: { min: 0, max: x },
  y: { min: 0, max: y },
  z: { min: 0, max: z },
});

/** The tools every GRBL preset is run with: a manual change, so no slots. */
const MANUAL_CHANGE: Pick<MillModel, 'hasATC' | 'toolSlots'> = { hasATC: false, toolSlots: 0 };

export const SHAPEOKO_4: MillModel = {
  id: 'grbl:shapeoko-4',
  name: 'Shapeoko 4 XXL',
  process: 'mill',
  post: 'grbl',
  frameState: 'stated',
  workOrigin: 'top-front-left',
  materials: GRBL_MATERIALS,
  // 33 × 33 × 4 in — the XXL, the size most shops buy (Standard and XL are in the same page).
  envelope: workArea(838.2, 838.2, 101.6),
  maxCutFeed: 3000,
  // Carbide Compact Router: 12 000–30 000 RPM (the DeWalt's dial tops at 27 000).
  maxRpm: 30000,
  // #845 — no rapid rate is published for this machine: the owner's own starting values.
  rapidEstimate: {
    xyMmPerMin: 5000,
    zMmPerMin: 1000,
    accelMmPerS2: 250,
    source: 'stated by you — the vendor publishes no rapid rate; 5000 mm/min XY, 1000 mm/min Z, 250 mm/s²',
  },
  ...MANUAL_CHANGE,
  sources: {
    envelope: cited(
      'Carbide 3D Shapeoko 4 XXL, 33 × 33 × 4 in (838.2 × 838.2 × 101.6 mm)',
      'https://easel.inventables.com/partners/machines/carbide3d-shapeoko-4/',
    ),
    maxCutFeed: statedByYou('Carbide 3D publishes no maximum feed; 3000 mm/min is a starting value'),
    maxRpm: cited(
      'Carbide Compact Router 12 000–30 000 RPM',
      'https://easel.inventables.com/partners/machines/carbide3d-shapeoko-4/',
    ),
    atc: cited('no tool changer — a manual change', 'https://easel.inventables.com/partners/machines/carbide3d-shapeoko-4/'),
  },
};

export const SHAPEOKO_5: MillModel = {
  id: 'grbl:shapeoko-5-pro',
  name: 'Shapeoko 5 Pro (4 × 4)',
  process: 'mill',
  post: 'grbl',
  frameState: 'stated',
  workOrigin: 'top-front-left',
  materials: GRBL_MATERIALS,
  // 48.7 × 48.7 × 6.1 in — the 4 × 4 table (Z travel 5.51 in with the dust boot fitted).
  envelope: workArea(1237.0, 1237.0, 154.9),
  maxCutFeed: 3000,
  maxRpm: 27000,
  // #845 — no rapid rate is published for this machine: the owner's own starting values.
  rapidEstimate: {
    xyMmPerMin: 5000,
    zMmPerMin: 1000,
    accelMmPerS2: 250,
    source: 'stated by you — the vendor publishes no rapid rate; 5000 mm/min XY, 1000 mm/min Z, 250 mm/s²',
  },
  ...MANUAL_CHANGE,
  sources: {
    envelope: cited(
      'Carbide 3D Shapeoko 5 Pro, 4 × 4: 48.7 × 48.7 × 6.1 in (1237 × 1237 × 154.9 mm)',
      'https://easel.inventables.com/partners/machines/carbide3d-shapeoko-5-pro/',
    ),
    maxCutFeed: statedByYou('Carbide 3D publishes no maximum feed; 3000 mm/min is a starting value'),
    maxRpm: cited(
      'the DeWalt DW611 dial tops out at 27 000 RPM (no router is included)',
      'https://easel.inventables.com/partners/machines/carbide3d-shapeoko-5-pro/',
    ),
    atc: cited('no tool changer — a manual change', 'https://easel.inventables.com/partners/machines/carbide3d-shapeoko-5-pro/'),
  },
};

export const X_CARVE: MillModel = {
  id: 'grbl:x-carve-pro',
  name: 'X-Carve Pro (4 × 4)',
  process: 'mill',
  post: 'grbl',
  frameState: 'stated',
  workOrigin: 'top-front-left',
  materials: GRBL_MATERIALS,
  // 48 × 48 × 4 in — the 4 × 4 model (the 4 × 2 is the other size on the same page).
  envelope: workArea(1219.2, 1219.2, 101.6),
  maxCutFeed: 3000,
  // 2 HP VFD spindle: 8 000–24 000 RPM.
  maxRpm: 24000,
  // #845 — no rapid rate is published for this machine: the owner's own starting values.
  rapidEstimate: {
    xyMmPerMin: 5000,
    zMmPerMin: 1000,
    accelMmPerS2: 250,
    source: 'stated by you — the vendor publishes no rapid rate; 5000 mm/min XY, 1000 mm/min Z, 250 mm/s²',
  },
  ...MANUAL_CHANGE,
  sources: {
    envelope: cited(
      'Inventables X-Carve Pro 4 × 4: 48 × 48 × 4 in (1219.2 × 1219.2 × 101.6 mm)',
      'https://easel.inventables.com/partners/machines/inventables-x-carve-pro/',
    ),
    maxCutFeed: statedByYou('Inventables publishes no maximum feed; 3000 mm/min is a starting value'),
    maxRpm: cited(
      'X-Carve Pro 2 HP VFD spindle, 8 000–24 000 RPM',
      'https://easel.inventables.com/partners/machines/inventables-x-carve-pro/',
    ),
    atc: cited('no tool changer — a manual change', 'https://easel.inventables.com/partners/machines/inventables-x-carve-pro/'),
  },
};

export const GENMITSU_3018: MillModel = {
  id: 'grbl:3018-prover',
  name: '3018-PROVer V2',
  process: 'mill',
  post: 'grbl',
  frameState: 'stated',
  workOrigin: 'top-front-left',
  materials: GRBL_MATERIALS,
  // The published work area: 300 × 180 × 45 mm (the V2's effective Z travel is 40 mm).
  envelope: workArea(300, 180, 45),
  maxCutFeed: 500,
  // The 775 motor at 24 V: 10 000 RPM.
  maxRpm: 10000,
  // #845 — no rapid rate is published for this machine: the owner's own starting values.
  rapidEstimate: {
    xyMmPerMin: 2000,
    zMmPerMin: 500,
    accelMmPerS2: 100,
    source: 'stated by you — the vendor publishes no rapid rate; 2000 mm/min XY, 500 mm/min Z, 100 mm/s²',
  },
  ...MANUAL_CHANGE,
  sources: {
    envelope: cited(
      'Genmitsu 3018-PROVer V2 work area 300 × 180 × 45 mm (V2 Z travel 40 mm)',
      'https://www.sainsmart.com/products/genmitsu-3018-prover',
    ),
    maxCutFeed: statedByYou('SainSmart publishes no maximum feed; 500 mm/min is a starting value'),
    maxRpm: cited('775 spindle motor at 24 V: 10 000 RPM', 'https://www.sainsmart.com/products/genmitsu-3018-prover'),
    atc: cited('no tool changer — a manual change', 'https://www.sainsmart.com/products/genmitsu-3018-prover'),
  },
};

/** The four GRBL presets the Manage panel offers, in the order it lists them. */
export const GRBL_PRESETS: readonly MillModel[] = [SHAPEOKO_4, SHAPEOKO_5, X_CARVE, GENMITSU_3018];

/**
 * The mills whose controller frame is established: the only machines a job may be written for.
 * The Z1, the Carvera Air and — since #828 — the Carvera are FRAMED; a {@link MillModel} is not
 * in here, so no id lookup that returns a `MillProfile` can ever hand back a machine whose
 * positions are unknown.
 */
export const MACHINES: Readonly<Record<string, MillProfile>> = {
  [Z1.id]: Z1,
  [CARVERA_AIR.id]: CARVERA_AIR,
  [CARVERA.id]: CARVERA,
};

/**
 * Every mill model the app knows, framed or not: what the machine picker, the location's machine
 * records and the job schema read when they only need to say WHICH machine is meant.
 */
export const MILL_MODELS: Readonly<Record<string, Mill>> = {
  [Z1.id]: Z1,
  [CARVERA_AIR.id]: CARVERA_AIR,
  [CARVERA.id]: CARVERA,
  // #845 — the GRBL presets: stated machines the owner adds to the house location.
  ...Object.fromEntries(GRBL_PRESETS.map((model) => [model.id, model])),
};

/**
 * The smallest X/Y move the controller can make, mm: one step of the axes (#221). Read from the
 * MACHINE RECORD's `axisSteps`, so a second machine (or a real read of this one) changes the V
 * groove bound by changing one field, and no shop setting can move it.
 */
export function minimumXyStepMm(machine: Mill): number | null {
  // #845 — a stated machine states no steps-per-mm (there is no controller configuration to read
  // one from), so a check that needs one answers null — "unknown", exactly as an unread profile does.
  if (machine.frameState !== 'read') return null;
  const steps = machine.axisSteps;
  return steps === null ? null : 1 / steps.xyPerMm;
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
 * a `Mill` and is told at compile time it is a mill — with a `MillProfile` still needed by
 * anything that reads a POSITION (#773).
 */
export type Machine = Mill | PrinterProfile;

/** Every machine we know, of any process (#184), framed or not. */
export const ALL_MACHINES: readonly Machine[] = [Z1, CARVERA_AIR, CARVERA, ...PRINTER_PROFILES];

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
 * #845 — the machine facts the clamp reads: its name and its two ceilings. A framed profile and a
 * stated model both satisfy it, so nothing that only clamps a number has to care which frame —
 * or whether there is one — the values came from.
 */
export type ClampMachine = Pick<MillProfile, 'name' | 'maxCutFeed' | 'maxRpm'>;

/** The machine facts an envelope test reads: a name and a work area. See {@link insideEnvelope}. */
export type SizedMachine = Pick<MillProfile, 'name' | 'envelope'>;

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
  machine: ClampMachine,
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
export function insideEnvelope(machine: SizedMachine, p: [number | null, number | null, number | null]): boolean {
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
// `hasATC`/`toolSlots` were literal `false`/`0` while the Z1 was the only mill (#183); #773 brings
// in the Carvera, whose changer holds six tools, so they are the numbers the profile states. The
// schema still refuses a HALF-statement: `hasATC` true with no slots, or slots on a manual machine.

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
  stepsPerDegree: finite.positive().nullable(),
  maxRate: finite.positive(),
  acceleration: finite.positive(),
  homing: z.literal('home_to_min').nullable(),
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
  // #845 — absent reads 'z1'; a framed Makera machine writes the Z1's dialect.
  post: z.enum(['z1', 'grbl']).optional(),
  frameState: z.literal('read'),
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
    // #927 — the spindle ramp, optional and positive when stated: a zero-second ramp is a claim the
    // field may not make (a machine that states none omits it, or writes null).
    spinUpSeconds: finite.positive().nullable().optional(),
    spinUpSource: z.string().min(1).optional(),
  }),
  // #927 — the same number on the profile itself; see the interface field. Optional: a profile that
  // has never timed its spindle states neither, and the estimate then prices no ramp.
  spinUpSeconds: finite.positive().nullable().optional(),
  spinUpSource: z.string().min(1).optional(),
  // #221 — the axes' own step resolution. Positive like every other motion number; a zero would
  // claim infinitely fine steps, which is a claim about hardware this field cannot make. `null`
  // where the controller's configuration has never been read (#773), which a reader must handle.
  axisSteps: z
    .object({
      xyPerMm: finite.positive(),
      zPerMm: finite.positive(),
      source: z.string().min(1),
    })
    .nullable(),
  maxRpm: finite.positive(),
  sensorOffsetFromAnchor1: vec2,
  changePositionExtraX: finite,
  // #448 — a profile that states a limit or a derivation constant without its provenance does
  // not parse, for the same reason a rotary field without a source does not.
  sources: z.object({
    maxCutFeed: z.string().min(1),
    maxRpm: z.string().min(1),
    sensorOffsetFromAnchor1: z.string().min(1),
    changePositionExtraX: z.string().min(1),
  }),
  hasATC: z.boolean(),
  toolSlots: z.number().int().nonnegative(),
  // #828 — an ATC's rack as the frame states it. Optional: a manual machine has none, and a
  // changer's positions may be unstated (the rack is the controller's) — but when the field IS
  // present its source is required, like every other provenance on this record.
  toolRack: z
    .object({
      slots: z.array(vec2),
      z: finite,
      source: z.string().min(1),
    })
    .optional(),
  softEndstop: softEndstopSchema,
  capabilities: z.object({ rotary: z.boolean(), laser: z.boolean(), air: z.boolean(), vacuum: z.boolean(), antistatic: z.boolean(), blow: z.boolean() }),
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
  // #1133 — the head envelope, when the model states one (the Z1 does; a stated machine may not).
  headEnvelope: z.object({ radiusMm: finite.positive(), source: z.string().min(1) }).optional(),
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
}).superRefine((profile, ctx) => {
  // #773 — the two fields are one fact. A changer with no slots names no tool it can hold, and a
  // manual machine that lists slots would be read as one it can change into.
  if (profile.hasATC && profile.toolSlots <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toolSlots'], message: 'a machine with a tool changer states its slot count' });
  }
  if (!profile.hasATC && profile.toolSlots !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toolSlots'], message: 'a manual tool change lists no slots' });
  }
});

/**
 * A mill model with no controller frame yet (#773): the vendor row, and none of the positions.
 * The `frameState` value is the whole point — a profile-shaped object cannot be mistaken for a
 * model that carries a frame, and vice versa.
 */
export const millModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  process: z.literal('mill'),
  // #845 — absent reads 'z1' (every record written before the field existed).
  post: z.enum(['z1', 'grbl']).optional(),
  frameState: z.enum(['unread', 'stated']),
  // #845 — absent reads 'top-front-left'; a stated machine may state the centre-zero convention.
  workOrigin: z.enum(['top-front-left', 'top-centre']).optional(),
  materials: z.array(z.enum(STOCK_MATERIALS)),
  envelope: z.object({
    x: z.object({ min: finite, max: finite }),
    y: z.object({ min: finite, max: finite }),
    z: z.object({ min: finite, max: finite }),
  }),
  maxCutFeed: finite.positive(),
  maxRpm: finite.positive(),
  // #845 — the estimate's rapid model: required on a stated model too, so a post reads one field.
  rapidEstimate: z.object({
    xyMmPerMin: finite.positive(),
    zMmPerMin: finite.positive(),
    accelMmPerS2: finite.positive(),
    source: z.string().min(1),
    // #927 — the spindle ramp, optional and positive when stated: a zero-second ramp is a claim the
    // field may not make (a machine that states none omits it, or writes null).
    spinUpSeconds: finite.positive().nullable().optional(),
    spinUpSource: z.string().min(1).optional(),
  }),
  // #927 — the same number on the profile itself; see the interface field. Optional: a profile that
  // has never timed its spindle states neither, and the estimate then prices no ramp.
  spinUpSeconds: finite.positive().nullable().optional(),
  spinUpSource: z.string().min(1).optional(),
  hasATC: z.boolean(),
  toolSlots: z.number().int().nonnegative(),
  rotaryEnvelope: z.object({ diameter: finite.positive(), length: finite.positive() }).optional(),
  sources: z.object({
    envelope: z.string().min(1),
    maxCutFeed: z.string().min(1),
    maxRpm: z.string().min(1),
    atc: z.string().min(1),
    // #845 — optional: a machine with no rotary module has no rotary fact to cite (the Carvera
    // states one; a Shapeoko does not).
    rotaryEnvelope: z.string().min(1).optional(),
  }),
}).superRefine((model, ctx) => {
  // The pair is one fact on a row too (#773): a 6-slot changer is a changer, and a manual machine
  // lists no slots.
  if (model.hasATC && model.toolSlots <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toolSlots'], message: 'a machine with a tool changer states its slot count' });
  }
  if (!model.hasATC && model.toolSlots !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toolSlots'], message: 'a manual tool change lists no slots' });
  }
  // #845 — A GRBL MACHINE CHANGES TOOLS BY HAND. Case Maker's GRBL post writes no tool changer
  // (no `M6`): a green field that claimed one would promise a change the program never makes, so
  // the record is refused here, with the sentence the operator reads — the cut side never sees
  // one to refuse, and no second sentence exists to disagree with this one.
  if (model.post === 'grbl' && model.hasATC) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['hasATC'],
      message: 'a GRBL machine changes tools by hand: Case Maker’s GRBL post writes no tool changer',
    });
  }
});

export const printerProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  process: z.literal('fdm'),
  buildVolume: z.object({ x: finite.positive(), y: finite.positive(), z: finite.positive() }),
  nozzle: finite.positive(),
});

/**
 * Any machine. A plain union rather than `discriminatedUnion('process')` since #773: two arms are
 * mills, and the discriminant that separates them is `frameState` — a framed profile parses first,
 * and its required positions are what a model without a frame fails.
 */
export const machineSchema = z.union([millProfileSchema, millModelSchema, printerProfileSchema]);
