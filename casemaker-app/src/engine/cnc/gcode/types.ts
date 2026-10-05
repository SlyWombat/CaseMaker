/**
 * The event stream a G-code program is lowered to (#174, #182).
 *
 * This is deliberately an ORDERED EVENT STREAM, not a `Move[]`. A program is not just
 * motion: it changes tool, stops for an operator, switches the spindle and coolant, and
 * announces toolpath boundaries. The emulator, the verifier and the post-processor's
 * round-trip all consume this one shape, so the parser is written once and nothing
 * downstream re-reads G-code. Operations and segments are VIEWS over the stream (a
 * boundary is a tool change, a pause, or a toolpath marker), not a second IR.
 *
 * Three rules shape every type here:
 *
 *  - UNKNOWN IS A STATE. A position axis the file has not established is `null`, never
 *    `0`. A real Z1 program opens with `T1 M6` and then rapids to `G0 X.. Y..` with no
 *    Z, and the tool-change macro leaves the head at a safe height the file cannot see.
 *    Inventing a Z there would invent a rapid, and the simulator would believe it.
 *  - FRAMES ARE TAGGED, NOT RESOLVED. A move carries the frame it was written in. The
 *    parser never applies a WCS offset, a placement or a tool offset: those are machine
 *    state the FILE DOES NOT CONTAIN (the WCS lives in the controller's EEPROM), and
 *    they are supplied downstream by `Setup`.
 *  - MILLIMETRES. Inch programs (`G20`) are converted at ingest, so nothing downstream
 *    carries a unit flag.
 *
 * Everything is plain JSON-serialisable data so it can cross the worker boundary.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  /** Stable machine-readable identifier; tests and the verifier key on this. */
  code: string;
  /** 1-based source line. */
  line: number;
  message: string;
}

export type Frame = 'work' | 'machine';

/** X, Y, Z in millimetres; `null` means "the program has not established this axis". */
export type Pos = [number | null, number | null, number | null];

export interface BaseEvent {
  /** 1-based source line. Every segment of a tessellated arc keeps its arc's line. */
  line: number;
  /**
   * Set by the RUNNER, never the parser, on steps it inserted that are not in the program:
   * the head movement of the firmware's manual tool-change macro (#182, Q14), of an `M491`
   * calibration, or of `G28` (which on this firmware is "go to the clearance position").
   * They carry the line of the command that caused them. The parser's own events never
   * have this field.
   */
  synthetic?: 'tool-change-macro' | 'tlo-calibrate' | 'g28-clearance';
}

export interface MoveEvent extends BaseEvent {
  kind: 'move';
  mode: 'rapid' | 'cut';
  frame: Frame;
  from: Pos;
  to: Pos;
  /** Rotary axis value after the move, `null` if never set. Tracked, not interpreted. */
  a: number | null;
  /** Modal feed in mm/min for cutting moves; `null` for rapids or if never set. */
  feed: number | null;
  /** `S` written on a motion line: laser power in laser mode. `null` otherwise. */
  power: number | null;
  /** True for every segment of a tessellated G2/G3. */
  fromArc: boolean;
  /**
   * Which axes the program COMMANDED on this line. A `null` in `to` is ambiguous without
   * this: it can be an axis the line did not mention, or an axis it did mention whose base
   * the PARSER does not know (a relative move after an unknown). A consumer holding more
   * state than the parser (the runner knows the starting tool, so it knows Z survived a
   * no-op `M6`) must be able to tell them apart, or it overwrites what it knows with the
   * parser's null. Without this, `T1M6` (a real change to the parser, a no-op to the
   * emulator) followed by `G1 X4` lost the known Z and raised a false `cut-unknown-z`.
   */
  commanded: [boolean, boolean, boolean];
  /** The commanded values as written, in mm, or `null` where the axis was not commanded. */
  values: Pos;
  /**
   * True when `values` are DELTAS (`G91`, work frame). A machine-frame move (`G53`) is never
   * relative, and tessellated arc segments carry resolved absolute values.
   */
  relative: boolean;
}

export interface ToolChangeEvent extends BaseEvent {
  kind: 'tool-change';
  tool: number;
  /**
   * The firmware does NOTHING if the requested tool is already active: no change and no
   * length calibration. A program cannot know the machine's starting tool, so every
   * change carries this and the emulator decides.
   */
  noOpIfActive: boolean;
  /** Set when the tool is known to be the active one already: nothing will happen. */
  noOp: boolean;
  /**
   * The spindle was on when the change began. The firmware does NOT halt: it turns the
   * spindle off first, and halts only if it is STILL running afterwards. Programs rely on
   * this: Makera's concatenated samples run `M30` then `T1M6` with no `M5` between. The
   * parser emits the `spindle off` event itself; this flag records that it did.
   */
  stoppedSpindle: boolean;
  /**
   * Set by the RUNNER when it has expanded this change into the macro's synthetic moves:
   * the surrounding steps then own the head position, so the reducer must not forget Z.
   */
  expanded?: boolean;
}

export interface PauseEvent extends BaseEvent {
  kind: 'pause';
  // Only codes with evidence in the firmware or the corpus. `M0`/`M1` are deliberately
  // absent: nothing read so far shows the Z1 implements them, so they are unknown codes.
  reason: 'M490.1' | 'M490.2' | 'M600';
}

export interface SpindleEvent extends BaseEvent {
  kind: 'spindle';
  state: 'cw' | 'ccw' | 'off';
  rpm: number | null;
}

export interface AirEvent extends BaseEvent {
  kind: 'air';
  on: boolean;
}

export interface DwellEvent extends BaseEvent {
  kind: 'dwell';
  /** Raw `P` and `S` words, unconverted: whether `P` is seconds or ms is firmware config. */
  p: number | null;
  s: number | null;
}

export interface HomeEvent extends BaseEvent {
  kind: 'home';
  /** Set by the runner when it inserted the clearance moves `G28` performs (needs a profile). */
  expanded?: boolean;
}

export interface ProbeEvent extends BaseEvent {
  kind: 'probe';
  /** The `G38.x` subcode. */
  subcode: number;
  target: Pos;
}

export interface TloCalibrateEvent extends BaseEvent {
  kind: 'tlo-calibrate';
  /** Set by the runner when it inserted the head movement of the `M491` calibration macro. */
  expanded?: boolean;
}

export interface WcsSelectEvent extends BaseEvent {
  kind: 'wcs-select';
  /** 0 = G54 … 5 = G59, 6–8 = G59.1–G59.3. */
  wcs: number;
}

export interface WcsSetEvent extends BaseEvent {
  kind: 'wcs-set';
  /**
   * `G10 L2 Pn` writes work offset n into the controller as MACHINE coordinates; `L20` sets
   * it so the current position READS as the given values. `P0` is the current offset,
   * `P1` is G54 (the firmware does `--n`). The parser carries the words; the runner applies
   * them. A G10 without P never reaches here: the firmware ignores it.
   */
  l: 2 | 20;
  p: number;
  values: Pos;
}

export interface OffsetSetEvent extends BaseEvent {
  kind: 'offset-set';
  /** `G92` family, the subcode as written (`G92.4` is 4). */
  subcode: number;
  /**
   * `G92 X.. Y.. Z..` shifts the G92 offset so the current position reads as these values.
   * `G92` with no axes, `G92.1` and `G92.2` RESET the offset (`reset`); `G92.3` sets it to
   * the raw values; `G92.4` with axis words is a manual homing that redefines the MACHINE
   * position itself. The other `G92.4` form — `G92.4 A<v> S<n>`/`R<n>` — is NOT this event;
   * it lowers to {@link RotaryUnwindEvent} (#237, `/Rotary.md` §1.2).
   */
  values: Pos;
  reset: boolean;
}

/**
 * The firmware's rotary unwind (#237, `/Rotary.md` §1.2): `G92.4 A<v> S<n>` (or `R<n>`).
 *
 * The firmware shrinks the A position by whole turns — the value modulo 360 is kept, the turns
 * are dropped (`S`), or A is reset to the value modulo 360 (`R`). X, Y and Z are NOT touched.
 * Distinct from a manual home: the old parser read EVERY `G92.4` as a manual home and forgot
 * XYZ, which is the wrong semantics for the rotary form — harmless at end-of-program (where the
 * vendor's files use it, `G92.4A0S0`), a position-losing trap mid-program.
 */
export interface RotaryUnwindEvent extends BaseEvent {
  kind: 'rotary-unwind';
  /** `S` drops whole turns (`'shrink'`); `R` resets (`'reset'`). Both keep A mod 360. */
  mode: 'shrink' | 'reset';
  /** The `A` value as written, degrees. */
  a: number;
  /** The `S` or `R` word's value. */
  value: number;
}

export interface LaserModeEvent extends BaseEvent {
  kind: 'laser-mode';
  on: boolean;
}

export interface MarkerEvent extends BaseEvent {
  kind: 'toolpath-start';
  /** From `;@MKR|TOOLPATH_START|toolpath_number=`; `null` when not parseable. */
  number: number | null;
}

export interface ProgramEndEvent extends BaseEvent {
  kind: 'program-end';
}

export type GcodeEvent =
  | MoveEvent
  | ToolChangeEvent
  | PauseEvent
  | SpindleEvent
  | AirEvent
  | DwellEvent
  | HomeEvent
  | ProbeEvent
  | TloCalibrateEvent
  | WcsSelectEvent
  | WcsSetEvent
  | OffsetSetEvent
  | RotaryUnwindEvent
  | LaserModeEvent
  | MarkerEvent
  | ProgramEndEvent;

/**
 * One `;@MKR|` record. The header is UNTRUSTED input: its fields are carried as written
 * and none of them is interpreted here. In particular the `ORIGIN` semantics are still a
 * hypothesis (`/Makera-Parity.md` §6.1) and must not be baked into the parser.
 */
export interface MkrRecord {
  tag: string;
  fields: Record<string, string>;
  line: number;
}

export interface MkrHeader {
  records: MkrRecord[];
}

export interface ParseSummary {
  lines: number;
  codeLines: number;
  moves: number;
  rapids: number;
  cuts: number;
  toolChanges: number;
  /** An `M321` appeared: this is a laser job and a mill simulation must refuse it. */
  laser: boolean;
  usesArcs: boolean;
  /** An `A` word appeared. Tracked, not interpreted; V1 does not simulate rotary. */
  usesRotary: boolean;
  /** Any `G20` appeared (converted to mm at ingest). */
  usesInches: boolean;
}

export interface ParseResult {
  events: GcodeEvent[];
  diagnostics: Diagnostic[];
  header: MkrHeader | null;
  summary: ParseSummary;
}

export function hasErrors(r: ParseResult): boolean {
  return r.diagnostics.some((d) => d.severity === 'error');
}
