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

import { machinePosToWork, workPosToMachine } from '../frames';
import type { GcodeEvent, MoveEvent, ParseResult, Pos, ProbeEvent, ToolChangeEvent } from '../gcode/types';
import { insideEnvelope, type MachineProfile } from '../machine';
import type { Setup } from '../setup';
import type { Vec3 } from '@/types/units';

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
  /** The work origin in machine coordinates. Starts at `setup.wcs.origin`; `G10 L2 P0` moves it. */
  wcsOrigin: Vec3;
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
    work: [null, null, null],
    machine: [null, null, null],
    a: null,
  };
}

/** A setup whose work origin is the state's CURRENT one, so frame conversion tracks `G10`. */
function withOrigin(setup: Setup, s: MachineState): Setup {
  return { ...setup, wcs: { ...setup.wcs, origin: s.wcsOrigin } };
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
export function applyEvent(s: MachineState, ev: GcodeEvent, setup: Setup): MachineState {
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
          machine: s.wcs === 0 ? workPosToMachine(withOrigin(setup, s), to) : unknownPos(),
        };
      }
      return {
        ...s,
        machine: to,
        work: s.wcs === 0 ? machinePosToWork(withOrigin(setup, s), to) : unknownPos(),
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
      // `G10 L2 P0` writes the G54 offset INTO THE CONTROLLER, in machine coordinates. A file
      // that sets it overrides the stubbed one for the axes it names.
      if (ev.p !== 0 && ev.p !== null) return s;
      const o: Vec3 = [
        ev.values[0] ?? s.wcsOrigin[0],
        ev.values[1] ?? s.wcsOrigin[1],
        ev.values[2] ?? s.wcsOrigin[2],
      ];
      const next: MachineState = { ...s, wcsOrigin: o };
      // The machine position did not change; the work position it corresponds to did.
      next.work = s.wcs === 0 ? machinePosToWork(withOrigin(setup, next), s.machine) : unknownPos();
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
 * The firmware's manual tool-change macro, as synthetic machine-frame steps (#182, Q14).
 * Read from `fill_change_scripts`, `fill_cali_scripts` and the completion path of
 * `ATCHandler.cpp` (`/Z1-Firmware-Dialect.md` §2); the positions are the profile's.
 *
 *   lift to clearance Z -> park at the change position -> [M490.1: operator swaps the tool]
 *   -> safe Z -> to the tool-length sensor -> probe down fast, retract, probe slow
 *   -> save the offset -> safe Z -> clearance Z -> back to the saved X,Y
 *
 * The probe stops at the tool tip's contact, a height the program cannot know, so Z is
 * unknown between the probe and the next rapid. After the macro the head is at the saved
 * X,Y and `clearanceZ`: all three axes KNOWN, which is strictly more than the un-expanded
 * change (Z unknown) can say.
 */
export function toolChangeMacro(ev: ToolChangeEvent, before: MachineState, m: MachineProfile): GcodeEvent[] {
  const tc = m.toolChange;
  const base = { line: ev.line, synthetic: 'tool-change-macro' as const };
  const mv = (from: Pos, to: Pos, commanded: [boolean, boolean, boolean]): MoveEvent => ({
    kind: 'move',
    ...base,
    mode: 'rapid',
    frame: 'machine',
    from,
    to,
    a: before.a ?? null,
    feed: null,
    power: null,
    fromArc: false,
    commanded,
    values: [commanded[0] ? to[0] : null, commanded[1] ? to[1] : null, commanded[2] ? to[2] : null],
    relative: false,
  });
  const probe = (target: Pos): ProbeEvent => ({ kind: 'probe', ...base, subcode: 6, target });
  const saved = before.machine;
  const atClear: Pos = [saved[0], saved[1], tc.clearanceZ];
  const parked: Pos = [tc.changePosition[0], tc.changePosition[1], tc.clearanceZ];
  const safeOverPark: Pos = [parked[0], parked[1], tc.safeZ];
  const sensorAtSafe: Pos = [tc.sensor[0], tc.sensor[1], tc.safeZ];
  const sensorUnknownZ: Pos = [tc.sensor[0], tc.sensor[1], null];
  return [
    mv(saved, atClear, [false, false, true]),
    mv(atClear, parked, [true, true, false]),
    { ...ev, expanded: true },
    mv(parked, safeOverPark, [false, false, true]),
    mv(safeOverPark, sensorAtSafe, [true, true, false]),
    probe([null, null, tc.sensorZ]),
    probe([null, null, tc.sensorZ]),
    { kind: 'tlo-calibrate', ...base },
    mv(sensorUnknownZ, sensorAtSafe, [false, false, true]),
    mv(sensorAtSafe, [tc.sensor[0], tc.sensor[1], tc.clearanceZ], [false, false, true]),
    mv([tc.sensor[0], tc.sensor[1], tc.clearanceZ], atClear, [true, true, false]),
  ];
}

export function buildTimeline(parse: ParseResult, setup: Setup, machine?: MachineProfile): Timeline {
  const events: GcodeEvent[] = [];
  const diagnostics: TimelineDiagnostic[] = [];
  const segments: Segment[] = [];
  const pauses: PausePoint[] = [];
  const buckets = new Map<string, Checkpoint>();
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
      const cur = withOrigin(setup, state);
      const mapped = state.wcs === 0;
      const toW = m.frame === 'work' ? r.to : mapped ? machinePosToWork(cur, r.to) : unknownPos();
      const fromW = m.frame === 'work' ? r.from : mapped ? machinePosToWork(cur, r.from) : unknownPos();
      const toM = m.frame === 'machine' ? r.to : mapped ? workPosToMachine(cur, r.to) : unknownPos();
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
          const key = `${seg.index}:${zKey}`;
          let cp = buckets.get(key);
          if (!cp) {
            cp = { segment: seg.index, zKey, z, steps: [], xy: [], nonConstantZ: false };
            buckets.set(key, cp);
            order.push(cp);
          }
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
          }
          // Non-constant only when BOTH ends are known and differ. A move whose start Z is
          // unknown (a plunge from the tool-change clearance height) is not a ramp: it is a
          // vertical column from its known end up, which is exactly what the lowest-Z rule
          // removes, so calling it non-constant would flag a plain plunge as an over-removal.
          if (fromW[2] !== null && toW[2] !== fromW[2]) cp.nonConstantZ = true;
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
    if (src.kind === 'tool-change' && machine && !machine.hasATC && isRealToolChange(state, src.tool) !== false) {
      for (const step of toolChangeMacro(src, state, machine)) process(step);
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
