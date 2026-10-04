/**
 * The program runner: the pure half of the emulator (#182, `/Simulation.md` §1.1, §8.0).
 *
 * It consumes the parser's event stream and the `Setup`, and produces everything the
 * emulator needs EXCEPT geometry: the machine state after every step, the points where the
 * machine would stop for a human, the segment boundaries, and the checkpoints playback
 * scrubs between. No Manifold, no worker, no machine. It is testable on its own, and it
 * runs on any `.nc` — the vendor's included — which is the point of simulating the file.
 *
 * WHAT IT CATCHES THAT A VOLUMETRIC ORACLE CANNOT. A union of swept volumes is blind to
 * move order and to state: it cannot tell a cut at an unknown position from a known one. So
 * "cutting at a position the program never established" is a diagnostic here — a WARNING,
 * because the machine knows where it is and only the emulator does not: the picture has a
 * gap, the program is not wrong. `summary.unsweptMoves` counts the gaps. Spindle-off is deliberately NOT: a feed
 * move with the spindle off is fine in air, and only the geometry knows whether the tool is
 * near the material, the fixture or the bed, so that check lives with the sweep.
 *
 * CHECKPOINTS ARE KEYED BY (SEGMENT, Z), not by Z alone. `/Simulation.md` §4.3 once
 * bucketed by quantised Z across the whole program, which merges two labels cut at the same
 * depth either side of a tool change and destroys their order — and the pause at `M6` then
 * has nothing to show. Cost is segments x levels, which is fine for a badge.
 *
 * It deliberately does NOT know the machine: no envelope, no rapid-through-stock, no holder
 * clearance. Those are the verifier's, and need #184's machine profile.
 */

import type { GcodeEvent, HomeEvent, MoveEvent, ParseResult, Pos, ProbeEvent, TloCalibrateEvent, ToolChangeEvent } from '../gcode/types';
import { insideEnvelope, type MachineProfile } from '../machine';
import type { Setup } from '../setup';

export type ToolState = number | 'unknown';

export interface MachineState {
  /** The active tool. `-1` is an empty spindle; `'unknown'` means the setup did not say. */
  tool: ToolState;
  spindle: 'cw' | 'ccw' | 'off';
  rpm: number | null;
  air: boolean;
  /** `M321` laser mode: a laser job, which a mill emulation should refuse (verifier's call). */
  laser: boolean;
  /** Selected work coordinate system, 0 = G54. Only G54 is modelled. */
  wcs: number;
  /**
   * The G54 origin in machine coordinates. Starts at `setup.wcs.origin`; `G10 L2 P0|P1`
   * moves it, and `L20` from an unknown position leaves an axis unknown.
   */
  wcsOrigin: Pos;
  /**
   * The G92 offset (Robot.cpp `g92_offset`): work = machine − wcsOrigin + g92. Starts at 0;
   * `G92 X..` shifts it, `G92` / `.1` / `.2` reset it. An axis shifted from an unknown
   * position is unknown, and so is every position that depends on it.
   */
  g92: Pos;
  work: Pos;
  machine: Pos;
  /** Rotary axis, tracked only. */
  a: number | null;
}

export type PauseKind = 'tool-change' | 'M490.1' | 'M600';

export interface PausePoint {
  /** Index of the event the machine stops at. */
  step: number;
  kind: PauseKind;
  line: number;
  fromTool: ToolState;
  toTool: number | null;
}

export interface Segment {
  index: number;
  /** First event index of the segment, inclusive. */
  start: number;
  /** One past the last event index. */
  end: number;
  /** The `;@MKR|TOOLPATH_START` number in force, or null. */
  toolpath: number | null;
  /** The tool active when the segment's first MOVE happens. */
  tool: ToolState;
  /** The pause that opened this segment, if one did. */
  pause: PausePoint | null;
}

export interface Checkpoint {
  segment: number;
  /** Quantised Z in micrometres (work frame). */
  zKey: number;
  /** The Z in mm that bucket stands for: the LOWEST Z of any move in it. */
  z: number;
  /**
   * Position in program order. A checkpoint is one CONTIGUOUS run of cuts at one (segment,
   * Z): when the program leaves a Z and comes back to it, that is a NEW checkpoint, so the
   * list is causal — everything in checkpoint k happened before anything in k+1. (The first
   * version keyed on (segment, Z) alone and a return to an earlier Z was folded into the old
   * checkpoint, so playback at a step in between showed cuts that had not happened yet.)
   */
  run: number;
  /**
   * Per move, the Z at each end in the work frame: [z0, z1, ...], one pair per entry of
   * `steps`. A start Z the program never established is stored as the end Z (a plunge). The
   * air-move gate sweeps a move whose ends differ as the exact hull of the tool at both
   * ends, instead of this checkpoint's lowest Z, which would credit a ramp with material it
   * has not reached yet.
   */
  zs: number[];
  /** Step indices of the cutting moves, in program order. */
  steps: number[];
  /**
   * The same moves resolved in the WORK frame, flat: [x0, y0, x1, y1, ...], one quad per
   * entry of `steps`. This is what the sweep consumes. A move whose START X,Y the program
   * never established is stored as a zero-length move at its end (a plunge: the disc only),
   * which is the conservative geometric reading; one whose END X,Y is unknown is dropped
   * with an error, because nothing can be invented for it.
   */
  xy: number[];
  /**
   * True if any move in the bucket changes Z. These use the conservative rule (the move's
   * lowest Z), which OVER-removes; the over-cut check must tolerate it (`/Simulation.md` §3.2).
   */
  nonConstantZ: boolean;
}

export interface TimelineDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  line: number;
  step: number;
  message: string;
}

/**
 * A move that cuts nothing but can still be wrong: a rapid, or a feed move with the spindle
 * off. Resolved in the WORK frame, only when both ends are fully known. The sweep checks
 * them against the stock and the bed (`/Simulation.md` §7.1): a rapid through stock, and —
 * the maintainer's rule — a spindle-off move that comes near the material, the fixture or
 * the bed. In air they are nothing, and are not reported.
 */
export interface AirMove {
  step: number;
  line: number;
  kind: 'rapid' | 'feed-spindle-off';
  from: [number, number, number];
  to: [number, number, number];
}

/** Diagnostics of one code beyond this many are folded into a single "…and N more". */
export const DIAGNOSTIC_CAP = 25;

export interface Timeline {
  events: GcodeEvent[];
  airMoves: AirMove[];
  segments: Segment[];
  pauses: PausePoint[];
  checkpoints: Checkpoint[];
  diagnostics: TimelineDiagnostic[];
  /** The state AFTER event `i`; `i = -1` is the state before the program starts. */
  stateAt(i: number): MachineState;
  summary: {
    steps: number;
    segments: number;
    pauses: number;
    checkpoints: number;
    cuttingMoves: number;
    /** Cutting moves the sweep cannot place because the program never established their position. */
    unsweptMoves: number;
    airMoves: number;
    /** An `M321` ran: a laser job. The sweep refuses it. */
    laser: boolean;
    /** An A word moved: rotary work. V1's sweep refuses it. */
    rotary: boolean;
  };
}

const SNAPSHOT_EVERY = 512;
const unknownPos = (): Pos => [null, null, null];

export function initialState(setup: Setup): MachineState {
  return {
    tool: setup.startingTool,
    spindle: 'off',
    rpm: null,
    air: false,
    laser: false,
    wcs: 0,
    wcsOrigin: [setup.wcs.origin[0], setup.wcs.origin[1], setup.wcs.origin[2]],
    g92: [0, 0, 0],
    work: [null, null, null],
    machine: [null, null, null],
    a: null,
  };
}

/**
 * Work → machine through the state's CURRENT offsets (the firmware's `wcs2mcs`, without the
 * tool offset, which the runner never sees applied). A work offset is a pure translation, so
 * each axis converts on its own and an unknown offset axis makes that axis unknown.
 */
function toMachinePos(s: MachineState, w: Pos): Pos {
  const out: Pos = [null, null, null];
  for (let i = 0; i < 3; i++) {
    const v = w[i] ?? null;
    const o = s.wcsOrigin[i] ?? null;
    const g = s.g92[i] ?? null;
    out[i] = v === null || o === null || g === null ? null : v + o - g;
  }
  return out;
}

/** Machine → work (`mcs2wcs`): work = machine − wcsOrigin + g92. */
function toWorkPos(s: MachineState, m: Pos): Pos {
  const out: Pos = [null, null, null];
  for (let i = 0; i < 3; i++) {
    const v = m[i] ?? null;
    const o = s.wcsOrigin[i] ?? null;
    const g = s.g92[i] ?? null;
    out[i] = v === null || o === null || g === null ? null : v - o + g;
  }
  return out;
}

/** Is this a `tool-change` that really changes the tool? Null when it cannot be known. */
export function isRealToolChange(s: MachineState, tool: number): boolean | null {
  if (s.tool === 'unknown') return null;
  return s.tool !== tool;
}

/**
 * Resolve a move against THIS state, not the parser's.
 *
 * The parser knows less than the runner: it cannot know the starting tool, so it treats
 * `T1M6` as a real change and forgets Z, while the runner (told the tool is already T1)
 * correctly keeps it. If the runner simply adopted the event's `to`, the next move's null Z
 * would overwrite what it knows. So: AXES THE PROGRAM COMMANDED come from the event
 * (`values`, plus the runner's own base when the move is relative), and EVERY OTHER AXIS
 * stays whatever the runner already holds. This also keeps a `G53` move from erasing the
 * work X and Y, which the machine-frame event knows nothing about.
 *
 */
export function resolveMove(s: MachineState, ev: MoveEvent): { from: Pos; to: Pos } {
  // Arc segments are ordinary absolute moves now: their `commanded` flags say which axes the
  // program set (the linear axis of an XY arc often was not), so they go through the same
  // path and the runner keeps its own Z. (An early return here once drew a chord after every
  // no-op M6, because the parser's Z was unknown there and the runner's was not.)
  const cur = ev.frame === 'work' ? s.work : s.machine;
  const from: Pos = [cur[0], cur[1], cur[2]];
  const to: Pos = [cur[0], cur[1], cur[2]];
  for (let i = 0; i < 3; i++) {
    if (!ev.commanded[i]) continue;
    const v = ev.values[i] ?? null;
    if (v === null) {
      to[i] = null;
    } else if (ev.relative) {
      const base = cur[i] ?? null;
      to[i] = base === null ? null : base + v;
    } else {
      to[i] = v;
    }
  }
  return { from, to };
}

/** The pure reducer. Never mutates its input. */
export function applyEvent(s: MachineState, ev: GcodeEvent, _setup: Setup): MachineState {
  switch (ev.kind) {
    case 'move': {
      // Resolved against THIS state, not the parser's: see `resolveMove`.
      const { to } = resolveMove(s, ev);
      if (ev.frame === 'work') {
        return {
          ...s,
          a: ev.a,
          work: to,
          // Only G54 is modelled: another WCS has an offset this emulator was not given.
          machine: s.wcs === 0 ? toMachinePos(s, to) : unknownPos(),
        };
      }
      return {
        ...s,
        machine: to,
        work: s.wcs === 0 ? toWorkPos(s, to) : unknownPos(),
      };
    }
    case 'tool-change': {
      const real = isRealToolChange(s, ev.tool);
      // A no-op leaves everything alone: no change, no calibration, the head does not move.
      if (real === false) return s;
      // A real change (or one that cannot be ruled out): the spindle is stopped and the new
      // tool is active. Where the head ends up depends on whether the runner expanded the
      // macro: if it did, the surrounding synthetic moves own the position and nothing is
      // forgotten here; if not, the head comes back to the saved X,Y at a clearance Z this
      // reducer was not given, so X and Y survive and Z is unknown, in BOTH frames.
      if (ev.expanded) return { ...s, tool: ev.tool, spindle: 'off' };
      return {
        ...s,
        tool: ev.tool,
        spindle: 'off',
        work: [s.work[0], s.work[1], null],
        machine: [s.machine[0], s.machine[1], null],
      };
    }
    case 'spindle':
      return { ...s, spindle: ev.state, rpm: ev.rpm };
    case 'air':
      return { ...s, air: ev.on };
    case 'laser-mode':
      return { ...s, laser: ev.on };
    case 'wcs-select':
      // A different WCS means a different offset: the work position can no longer be mapped.
      return ev.wcs === s.wcs ? s : { ...s, wcs: ev.wcs, work: unknownPos() };
    case 'wcs-set': {
      // `G10 L2 Pn` writes offset n INTO THE CONTROLLER. Robot.cpp: `P0` means the current
      // offset, otherwise `--n`, so P1 is G54 and P2 is G55. Only G54 is modelled; a write to
      // any other offset is ignored, not guessed (the first version applied P0 only and
      // treated P1 as "another offset" — backwards).
      const n = ev.p === 0 ? s.wcs : ev.p - 1;
      if (n !== 0) return s;
      const o: Pos = [s.wcsOrigin[0], s.wcsOrigin[1], s.wcsOrigin[2]];
      for (let i = 0; i < 3; i++) {
        const v = ev.values[i] ?? null;
        if (v === null) continue;
        if (ev.l === 2) {
          o[i] = v; // the offset IS this machine coordinate
        } else {
          // L20: the current position must READ as v, so origin = machine + g92 − v; from an
          // unknown machine position the new origin is unknown.
          const m = s.machine[i] ?? null;
          const g = s.g92[i] ?? null;
          o[i] = m === null || g === null ? null : m + g - v;
        }
      }
      const next: MachineState = { ...s, wcsOrigin: o };
      // The machine position did not change; the work position it corresponds to did.
      next.work = s.wcs === 0 ? toWorkPos(next, s.machine) : unknownPos();
      return next;
    }
    case 'offset-set': {
      // G92 (Robot.cpp case 92). `.5` is a laser offset and changes no position.
      if (ev.subcode === 5) return s;
      if (ev.subcode === 4) {
        // Manual homing: the MACHINE position itself is redefined. Nothing the setup said
        // about where the part is relative to machine zero holds any more.
        return { ...s, work: unknownPos(), machine: unknownPos() };
      }
      let g92: Pos;
      if (ev.reset) {
        g92 = [0, 0, 0];
      } else if (ev.subcode === 3) {
        g92 = [ev.values[0] ?? 0, ev.values[1] ?? 0, ev.values[2] ?? 0];
      } else {
        // Shift so the current position reads as the given values: g92 += v − work, i.e.
        // g92 = v − machine + origin. From an unknown machine position the axis is unknown.
        g92 = [s.g92[0], s.g92[1], s.g92[2]];
        for (let i = 0; i < 3; i++) {
          const v = ev.values[i] ?? null;
          if (v === null) continue;
          const m = s.machine[i] ?? null;
          const o = s.wcsOrigin[i] ?? null;
          g92[i] = m === null || o === null ? null : v - m + o;
        }
      }
      const next: MachineState = { ...s, g92 };
      // The machine position did not change. The work position did — and for a shifted axis
      // it is exactly the value written, known even when the machine position is not.
      next.work = s.wcs === 0 ? toWorkPos(next, s.machine) : unknownPos();
      if (!ev.reset && ev.subcode === 0 && s.wcs === 0) {
        for (let i = 0; i < 3; i++) if (ev.values[i] !== null) next.work[i] = ev.values[i] ?? null;
      }
      return next;
    }
    case 'probe': {
      // A probe moves only the axes it names, and stops early, at contact: those axes are
      // unknown afterwards and the others are exactly where they were. (A Z probe at the
      // tool-length sensor leaves X,Y at the sensor.)
      const work: Pos = [s.work[0], s.work[1], s.work[2]];
      const machine: Pos = [s.machine[0], s.machine[1], s.machine[2]];
      for (let i = 0; i < 3; i++) {
        if (ev.target[i] !== null) {
          work[i] = null;
          machine[i] = null;
        }
      }
      return { ...s, work, machine };
    }
    case 'home':
    case 'tlo-calibrate':
      // With a profile the runner inserted the head movement these perform and the moves
      // own the position; without one, where the head ends up is not known.
      if (ev.expanded) return s;
      return { ...s, work: unknownPos(), machine: unknownPos() };
    case 'program-end':
      // M2/M30 reset the work offset to G54.
      return s.wcs === 0 ? s : { ...s, wcs: 0, work: unknownPos() };
    default:
      return s;
  }
}

function lowestKnownZ(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * The firmware's macros, as synthetic machine-frame steps (#182, Q14). Read from
 * `fill_change_scripts`, `fill_cali_scripts` and the completion path of `on_main_loop` in
 * `ATCHandler.cpp` (`/Z1-Firmware-Dialect.md` §2); the positions are the profile's.
 *
 * Manual tool change (`M6`, `isATC = 0`; change and calibration both with `clear_z = true`):
 *
 *   lift to clearance Z -> park at the change position -> [M490.1: operator swaps the tool]
 *   -> to the tool-length sensor AT CLEARANCE Z -> probe down fast -> retract `probeRetract`
 *   -> probe slow -> save the offset -> safe Z -> clearance Z -> back to the saved X,Y
 *
 * (The first version traversed to the sensor at safe Z; the source says clearance Z, and the
 * review caught it.) The probe stops at the tool tip's contact, a height the program cannot
 * know, so Z is unknown from the probe until the lift to safe Z. After the macro the head is
 * at the saved X,Y and `clearanceZ`: all three axes KNOWN, which is strictly more than the
 * un-expanded change (Z unknown) can say.
 *
 * `M491` is the calibration half alone, from the current position, with the same return.
 * `G28` is "go to the clearance position": lift to clearance Z, then X,Y to `clearanceXY`.
 */
type SyntheticKind = NonNullable<GcodeEvent['synthetic']>;

function syntheticMove(base: { line: number; synthetic: SyntheticKind }, a: number | null) {
  return (from: Pos, to: Pos, commanded: [boolean, boolean, boolean], relative = false): MoveEvent => ({
    kind: 'move',
    ...base,
    mode: 'rapid',
    frame: 'machine',
    from,
    to,
    a,
    feed: null,
    power: null,
    fromArc: false,
    commanded,
    values: [commanded[0] ? to[0] : null, commanded[1] ? to[1] : null, commanded[2] ? to[2] : null],
    relative,
  });
}

/** `fill_cali_scripts(.., clear_z = true)` plus the completion path: from `at`, back to `saved` X,Y. */
function calibrationSteps(base: { line: number; synthetic: SyntheticKind }, a: number | null, at: Pos, saved: Pos, m: MachineProfile): GcodeEvent[] {
  const tc = m.toolChange;
  const mv = syntheticMove(base, a);
  const probe = (target: Pos): ProbeEvent => ({ kind: 'probe', ...base, subcode: 6, target });
  const atClear: Pos = [at[0], at[1], tc.clearanceZ];
  const sensorAtClear: Pos = [tc.sensor[0], tc.sensor[1], tc.clearanceZ];
  const sensorUnknownZ: Pos = [tc.sensor[0], tc.sensor[1], null];
  const sensorAtSafe: Pos = [tc.sensor[0], tc.sensor[1], tc.safeZ];
  const retract: Pos = [null, null, tc.probeRetract];
  const steps: GcodeEvent[] = [];
  if (at[2] !== tc.clearanceZ) steps.push(mv(at, atClear, [false, false, true]));
  steps.push(
    mv(atClear, sensorAtClear, [true, true, false]),
    probe([null, null, tc.sensorZ]),
    // `G91 G0 Z<retract>`: a relative lift from the contact height, which is unknown.
    { ...mv(sensorUnknownZ, sensorUnknownZ, [false, false, true], true), values: retract },
    probe([null, null, tc.sensorZ]),
    { kind: 'tlo-calibrate', ...base, expanded: true },
    mv(sensorUnknownZ, sensorAtSafe, [false, false, true]),
    mv(sensorAtSafe, sensorAtClear, [false, false, true]),
    mv(sensorAtClear, [saved[0], saved[1], tc.clearanceZ], [true, true, false]),
  );
  return steps;
}

export function toolChangeMacro(ev: ToolChangeEvent, before: MachineState, m: MachineProfile): GcodeEvent[] {
  const tc = m.toolChange;
  const base = { line: ev.line, synthetic: 'tool-change-macro' as const };
  const mv = syntheticMove(base, before.a ?? null);
  const saved = before.machine;
  const atClear: Pos = [saved[0], saved[1], tc.clearanceZ];
  const parked: Pos = [tc.changePosition[0], tc.changePosition[1], tc.clearanceZ];
  return [
    mv(saved, atClear, [false, false, true]),
    mv(atClear, parked, [true, true, false]),
    { ...ev, expanded: true },
    ...calibrationSteps(base, before.a ?? null, parked, saved, m),
  ];
}

/** `M491`: re-measure the tool length from wherever the head is, then return. */
export function tloCalibrateMacro(ev: TloCalibrateEvent, before: MachineState, m: MachineProfile): GcodeEvent[] {
  const base = { line: ev.line, synthetic: 'tlo-calibrate' as const };
  return [{ ...ev, expanded: true }, ...calibrationSteps(base, before.a ?? null, before.machine, before.machine, m)];
}

/** `G28` on this firmware: lift to clearance Z, then X,Y to the clearance position. */
export function g28Clearance(ev: HomeEvent, before: MachineState, m: MachineProfile): GcodeEvent[] {
  const tc = m.toolChange;
  const base = { line: ev.line, synthetic: 'g28-clearance' as const };
  const mv = syntheticMove(base, before.a ?? null);
  const cur = before.machine;
  const atClear: Pos = [cur[0], cur[1], tc.clearanceZ];
  return [
    { ...ev, expanded: true },
    mv(cur, atClear, [false, false, true]),
    mv(atClear, [tc.clearanceXY[0], tc.clearanceXY[1], tc.clearanceZ], [true, true, false]),
  ];
}

export function buildTimeline(parse: ParseResult, setup: Setup, machine?: MachineProfile): Timeline {
  const events: GcodeEvent[] = [];
  const diagnostics: TimelineDiagnostic[] = [];
  const segments: Segment[] = [];
  const pauses: PausePoint[] = [];
  let current: Checkpoint | null = null;
  const order: Checkpoint[] = [];
  const snapshots: MachineState[] = [];
  let cuttingMoves = 0;
  let unswept = 0;

  const counts = new Map<string, number>();
  const diag = (severity: TimelineDiagnostic['severity'], code: string, step: number, line: number, message: string): void => {
    const n = (counts.get(code) ?? 0) + 1;
    counts.set(code, n);
    if (n <= DIAGNOSTIC_CAP) diagnostics.push({ severity, code, line, step, message });
  };
  const airMoves: AirMove[] = [];
  let sawLaser = false;
  let sawRotary = false;

  let state = initialState(setup);
  snapshots.push(state); // snapshot[0] is the state before step 0

  let toolpath: number | null = null;
  let seg: Segment = { index: 0, start: 0, end: 0, toolpath: null, tool: state.tool, pause: null };
  segments.push(seg);
  let segHasMove = false;
  const warnedWcs = new Set<number>();
  let warnedFromXY = false;

  /** Open a new segment at `step`, unless the current one has done no work yet. */
  const boundary = (step: number, pause: PausePoint | null): void => {
    if (!segHasMove) {
      // Nothing happened in this segment yet: boundary events stack up inside one segment
      // rather than leaving a run of empty ones.
      if (pause && !seg.pause) seg.pause = pause;
      return;
    }
    seg.end = step;
    seg = { index: segments.length, start: step, end: step, toolpath, tool: state.tool, pause };
    segments.push(seg);
    segHasMove = false;
  };

  const process = (ev: GcodeEvent): void => {
    const i = events.length;
    events.push(ev);

    if (ev.kind === 'toolpath-start') {
      toolpath = ev.number;
      boundary(i, null);
      seg.toolpath = toolpath;
    } else if (ev.kind === 'tool-change') {
      const real = isRealToolChange(state, ev.tool);
      if (real === false) {
        diag('info', 'tool-change-noop', i, ev.line, `M6 to T${ev.tool}, which is already active: the firmware does nothing (no change, no length calibration)`);
      } else {
        if (real === null) {
          diag('info', 'tool-change-ambiguous', i, ev.line, `the starting tool was not stated, so whether T${ev.tool} is a real change cannot be known; treated as one`);
        }
        const p: PausePoint = { step: i, kind: 'tool-change', line: ev.line, fromTool: state.tool, toTool: ev.tool };
        pauses.push(p);
        boundary(i, p);
      }
    } else if (ev.kind === 'pause' && ev.reason !== 'M490.2') {
      const p: PausePoint = { step: i, kind: ev.reason, line: ev.line, fromTool: state.tool, toTool: null };
      pauses.push(p);
      boundary(i, p);
    } else if (ev.kind === 'offset-set' && ev.subcode === 4) {
      diag('warning', 'g92-4-manual-home', i, ev.line, "G92.4 redefines the machine position: the setup's placement no longer holds, positions are unknown from here");
    } else if (ev.kind === 'wcs-set' && (ev.p === 0 ? state.wcs : ev.p - 1) !== 0) {
      diag('warning', 'wcs-set-unmodelled', i, ev.line, `G10 L${ev.l} P${ev.p} writes an offset other than G54, which this emulator does not model; ignored`);
    } else if (ev.kind === 'laser-mode' && ev.on) {
      sawLaser = true;
    } else if (ev.kind === 'wcs-select' && ev.wcs !== 0 && !warnedWcs.has(ev.wcs)) {
      warnedWcs.add(ev.wcs);
      diag('warning', 'wcs-unmodelled', i, ev.line, `G${54 + ev.wcs} selects a work offset this emulator was not given; positions are unknown until G54 returns`);
    }

    // The reducer needs the state BEFORE the event; checks that depend on it run first.
    if (ev.kind === 'move') {
      const m: MoveEvent = ev;
      if (m.a !== null) sawRotary = true;
      // Resolved against the RUNNER's state, not the parser's (see `resolveMove`), then put
      // in both frames: cutting and proximity happen in WORK coordinates, the envelope check
      // in MACHINE coordinates. Only G54 is modelled; under another WCS the mapping is unknown.
      const r = resolveMove(state, m);
      const mapped = state.wcs === 0;
      const toW = m.frame === 'work' ? r.to : mapped ? toWorkPos(state, r.to) : unknownPos();
      const fromW = m.frame === 'work' ? r.from : mapped ? toWorkPos(state, r.from) : unknownPos();
      const toM = m.frame === 'machine' ? r.to : mapped ? toMachinePos(state, r.to) : unknownPos();
      if (machine && !insideEnvelope(machine, toM)) {
        diag('error', 'outside-envelope', i, m.line, `a move to machine (${toM.map((v) => (v === null ? '?' : v.toFixed(3))).join(', ')}) leaves the ${machine.name}'s envelope`);
      }
      const known = (p: Pos): p is [number, number, number] => p[0] !== null && p[1] !== null && p[2] !== null;
      const isCut = m.mode === 'cut' && !state.laser && state.spindle !== 'off';
      if (!isCut && !state.laser) {
        // A rapid, or a feed move with the spindle off. Neither cuts; both can still be wrong,
        // and only the geometry can say (the maintainer's rule: a spindle-off move is a fault
        // only near the material, the fixture or the bed). Collected for the sweep.
        if (known(fromW) && known(toW)) {
          airMoves.push({ step: i, line: m.line, kind: m.mode === 'rapid' ? 'rapid' : 'feed-spindle-off', from: [fromW[0], fromW[1], fromW[2]], to: [toW[0], toW[1], toW[2]] });
        }
      }
      if (isCut) {
        cuttingMoves++;
        const z = lowestKnownZ(toW[2], fromW[2]);
        if (toW[2] === null || z === null) {
          // A WARNING, not an error: the machine knows where it is, the emulator was not told.
          // The vendor's own rotary samples open with `G01 Z30` before any X,Y is set. The
          // picture has a gap here; the move is counted so the UI can say how many.
          unswept++;
          diag('warning', 'cut-unknown-z', i, m.line, 'a cutting move at a Z the program never established: not swept, the emulator will not invent one (the picture has a gap here)');
        } else {
          const zKey = Math.round(z * 1000);
          // Reuse the bucket only while the program is STILL at this (segment, Z): a return
          // to it later is a new, later checkpoint (see `Checkpoint.run`).
          let cp = current && current.segment === seg.index && current.zKey === zKey ? current : null;
          if (!cp) {
            cp = { segment: seg.index, zKey, z, run: order.length, steps: [], xy: [], zs: [], nonConstantZ: false };
            order.push(cp);
          }
          current = cp;
          if (toW[0] === null || toW[1] === null) {
            unswept++;
            diag('warning', 'cut-unknown-xy', i, m.line, 'a cutting move to an X or Y the program never established: not swept, nothing can be invented for it (the picture has a gap here)');
          } else {
            const fromKnown = fromW[0] !== null && fromW[1] !== null;
            if (!fromKnown && !warnedFromXY) {
              warnedFromXY = true;
              diag('info', 'cut-from-unknown-xy', i, m.line, 'a cutting move from an X,Y the program never established is swept as a plunge at its end point only');
            }
            cp.steps.push(i);
            cp.xy.push(fromKnown ? (fromW[0] as number) : toW[0], fromKnown ? (fromW[1] as number) : toW[1], toW[0], toW[1]);
            cp.zs.push(fromKnown && fromW[2] !== null ? fromW[2] : toW[2], toW[2]);
            // A RAMP changes Z while travelling in X,Y; the lowest-Z rule over-removes along
            // it, and the picture says so. A vertical plunge (no X,Y travel) is not a ramp: the
            // column from its lowest end up is exactly what the tool removes, so it is not
            // flagged (the first version flagged every plunge inside a bucket). A move whose
            // start Z is unknown cannot be called a ramp either.
            if (fromKnown && fromW[2] !== null && toW[2] !== fromW[2] && (fromW[0] !== toW[0] || fromW[1] !== toW[1])) cp.nonConstantZ = true;
          }
          if (z < cp.z) cp.z = z;
        }
      }
      if (!segHasMove) seg.tool = state.tool;
      segHasMove = true;
    }

    state = applyEvent(state, ev, setup);
    if ((i + 1) % SNAPSHOT_EVERY === 0) snapshots.push(state);
  };

  for (const src of parse.events) {
    if (!machine) {
      process(src);
    } else if (src.kind === 'tool-change' && !machine.hasATC && isRealToolChange(state, src.tool) !== false) {
      for (const step of toolChangeMacro(src, state, machine)) process(step);
    } else if (src.kind === 'tlo-calibrate') {
      for (const step of tloCalibrateMacro(src, state, machine)) process(step);
    } else if (src.kind === 'home') {
      for (const step of g28Clearance(src, state, machine)) process(step);
    } else {
      process(src);
    }
  }
  seg.end = events.length;
  for (const [code, n] of counts) {
    if (n > DIAGNOSTIC_CAP) {
      diagnostics.push({ severity: 'info', code: `${code}-more`, line: 0, step: events.length, message: `…and ${n - DIAGNOSTIC_CAP} more '${code}' (${n} in all)` });
    }
  }

  const stateAt = (i: number): MachineState => {
    if (i < 0) return snapshots[0] as MachineState;
    const idx = Math.min(i, events.length - 1);
    const snapIdx = Math.floor((idx + 1) / SNAPSHOT_EVERY);
    let s = snapshots[snapIdx] as MachineState;
    for (let k = snapIdx * SNAPSHOT_EVERY; k <= idx; k++) s = applyEvent(s, events[k] as GcodeEvent, setup);
    return s;
  };

  return {
    events,
    airMoves,
    segments,
    pauses,
    checkpoints: order,
    diagnostics,
    stateAt,
    summary: {
      steps: events.length,
      segments: segments.length,
      pauses: pauses.length,
      checkpoints: order.length,
      cuttingMoves,
      unsweptMoves: unswept,
      airMoves: airMoves.length,
      laser: sawLaser,
      rotary: sawRotary,
    },
  };
}
