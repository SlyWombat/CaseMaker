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
 * move order, feed and spindle state: it will draw a cut made with the spindle off exactly
 * as it draws a correct one. A state machine sees it for free. So "cutting with the spindle
 * off" and "cutting at an unknown Z" are diagnostics here, not geometry checks.
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
import type { GcodeEvent, MoveEvent, ParseResult, Pos } from '../gcode/types';
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
  /** Event indices of the cutting moves, in program order. */
  steps: number[];
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

export interface Timeline {
  events: GcodeEvent[];
  segments: Segment[];
  pauses: PausePoint[];
  checkpoints: Checkpoint[];
  diagnostics: TimelineDiagnostic[];
  /** The state AFTER event `i`; `i = -1` is the state before the program starts. */
  stateAt(i: number): MachineState;
  summary: { steps: number; segments: number; pauses: number; checkpoints: number; cuttingMoves: number };
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
 * Tessellated arc points are already absolute and fully resolved by the parser, so they are
 * taken as written.
 */
export function resolveMove(s: MachineState, ev: MoveEvent): { from: Pos; to: Pos } {
  if (ev.fromArc) return { from: [ev.from[0], ev.from[1], ev.from[2]], to: [ev.to[0], ev.to[1], ev.to[2]] };
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
      // A real change (or one that cannot be ruled out): the spindle is stopped, the new tool
      // is active, and the head comes back to the saved X,Y at the machine's clearance Z. So
      // X and Y survive and Z is unknown, in BOTH frames.
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
    case 'home':
    case 'probe':
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

export function buildTimeline(parse: ParseResult, setup: Setup): Timeline {
  const events = parse.events;
  const diagnostics: TimelineDiagnostic[] = [];
  const segments: Segment[] = [];
  const pauses: PausePoint[] = [];
  const buckets = new Map<string, Checkpoint>();
  const order: Checkpoint[] = [];
  const snapshots: MachineState[] = [];
  let cuttingMoves = 0;

  const diag = (severity: TimelineDiagnostic['severity'], code: string, step: number, line: number, message: string): void => {
    diagnostics.push({ severity, code, line, step, message });
  };

  let state = initialState(setup);
  snapshots.push(state); // snapshot[0] is the state before step 0

  let toolpath: number | null = null;
  let seg: Segment = { index: 0, start: 0, end: 0, toolpath: null, tool: state.tool, pause: null };
  segments.push(seg);
  let segHasMove = false;
  const warnedWcs = new Set<number>();

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

  for (let i = 0; i < events.length; i++) {
    const ev = events[i] as GcodeEvent;

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
    } else if (ev.kind === 'wcs-select' && ev.wcs !== 0 && !warnedWcs.has(ev.wcs)) {
      warnedWcs.add(ev.wcs);
      diag('warning', 'wcs-unmodelled', i, ev.line, `G${54 + ev.wcs} selects a work offset this emulator was not given; positions are unknown until G54 returns`);
    }

    // The reducer needs the state BEFORE the event; checks that depend on it run first.
    if (ev.kind === 'move') {
      const m: MoveEvent = ev;
      if (m.mode === 'cut' && !state.laser) {
        cuttingMoves++;
        if (state.spindle === 'off') {
          // A WARNING, not an error. The state machine cannot know whether the move is in air
          // or in stock, and a feed move with the spindle off is sometimes deliberate: the
          // vendor's own `fatigue-test-air.nc` opens with `G1 Z-50` / `G1 Z-61` under the
          // label "(Height Test)" before it ever issues `M3`. It becomes an ERROR only when
          // the move enters stock, which needs the geometry (`/Simulation.md` §7.1).
          diag('warning', 'cut-spindle-off', i, m.line, 'a feed move with the spindle off. If it enters stock a volumetric simulation would draw it exactly like a correct cut; it is an error only then, which needs the geometry');
        }
        // Cutting happens in work coordinates; a machine-frame cut converts first. Resolved
        // against the RUNNER's state, not the parser's (see `resolveMove`).
        const r = resolveMove(state, m);
        const toW = m.frame === 'work' ? r.to : machinePosToWork(withOrigin(setup, state), r.to);
        const fromW = m.frame === 'work' ? r.from : machinePosToWork(withOrigin(setup, state), r.from);
        const z = lowestKnownZ(toW[2], fromW[2]);
        if (toW[2] === null || z === null) {
          diag('error', 'cut-unknown-z', i, m.line, 'a cutting move to a Z the program never established: the emulator will not invent one');
        } else {
          const zKey = Math.round(z * 1000);
          const key = `${seg.index}:${zKey}`;
          let cp = buckets.get(key);
          if (!cp) {
            cp = { segment: seg.index, zKey, z, steps: [], nonConstantZ: false };
            buckets.set(key, cp);
            order.push(cp);
          }
          cp.steps.push(i);
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
  }
  seg.end = events.length;

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
    },
  };
}
