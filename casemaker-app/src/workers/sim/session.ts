/**
 * The simulation session (#182 step 8b, `/Simulation.md` §8.0): load a program, show the stock
 * at any checkpoint, dispose. Headless — it knows nothing about workers or the UI, so it runs
 * (and is tested) in plain Node; `sim.worker.ts` is a thin Comlink shell over it.
 *
 *   load(gcode, setup, tool, machineId)  -> diagnostics, summary, stats, plain checkpoint /
 *                                          pause / segment lists, and the stock, result,
 *                                          removal and gouge MESHES
 *   frameAt(k, gen)                      -> { stock, removalSoFar, sacrificial } meshes, or null
 *                                          if stale
 *   stateAt(step), toolPath(from, to)    -> on demand; per-step state is never shipped whole
 *   simPath()                            -> the whole path with kinds and times (#197)
 *   dispose()
 *
 * OWNERSHIP, exactly. One session holds at most one loaded program. `load` disposes any
 * existing one first. A REFUSED load leaves a session only when the RUNNER succeeded and the
 * SWEEP refused: the timeline is kept (PATH-ONLY), `stateAt` and `toolPath` work, `frameAt`
 * returns null, and such a session owns NO wasm handle at all. A refusal before the timeline
 * exists (an unknown machine) leaves nothing. A loaded session owns the `SweepResult`
 * (`stock`, `result`, `removal`, every non-null `perCheckpoint[i]`, every gouge) AND the
 * `Playback` — `createPlayback` does not own the sweep result. `dispose` runs
 * `playback.dispose()` and THEN deletes the sweep handles, in that order: the playback holds
 * unions built over the sweep's solids. Handles from `stockAt` / `removalAt` are playback-owned
 * and evictable, so they are meshed inside the same call and never stored. Everything that
 * leaves this module is plain data or ArrayBuffers; no wasm handle crosses it.
 *
 * Never shipped: `events[]` and per-step machine state (fatigue-test.nc is 782 256 cutting
 * moves).
 */

import { postKey } from '@/engine/cnc/post';
import { applyEvent, buildTimeline, parseGcode, resolveMachine, MACHINES, MILL_MODELS, machineFrameProblemById, type FixtureEnvelope, type MachineCalibration, type MachineState, type Mill, type PausePoint, type Segment, type Setup, type Timeline } from '@/engine/cnc';
import { moveSeconds, rapidRate, type RapidEstimate } from '@/engine/cnc/cam/ir';

import type { Mm } from '@/types/units';
import { cuttingRadiusForSweep, type Tool } from '@/engine/cnc/tool';
import { isVShape } from '@/engine/cnc/vProfile';
import {
  columnOracleBand,
  computeOracle,
  computeRotaryOracle,
  gridSliceAt,
  oracleBand,
  ORACLE_SLICE_LIFT_MM,
  removalSliceAt,
  type OracleBbox,
  type OracleLevel,
  type OraclePredicted,
  type OracleReport,
  type OracleSliceAt,
} from '@/engine/cnc/engrave/oracle';
import { computeCopperTopology, type PcbCopperTopologyInput } from '@/engine/cnc/engrave/pcbTopology';
import { checkDesignReach, checkGoalCutInto, goalCutIntoUnchecked, type DesignCheckItem, type GoalCutIntoOptions } from '@/engine/cnc/engrave/designCheck';
import type { WholeSurfaceReach } from '@/engine/cnc/engrave/goalWholeSurface';
import type { GoalHeightfield } from '@/engine/cnc/cam/surface3d';
import type { ResultTop } from '@/engine/cnc/engrave/goalCoverage';
import { surfaceLift, type SurfaceFrame } from '@/engine/cnc/engrave/surfacePlane';
import { exactSweptField } from './sweptPoint';
import type { ManifoldToplevel } from '../geometry/evaluateOp';
import type { CarriedField } from '../geometry/carriedField';

type CrossSectionInstance = InstanceType<ManifoldToplevel['CrossSection']>;
import { manifoldOfTriangles, meshOutputOf, type NodeMeshOutput } from '../geometry/meshOutput';
import { createPlayback, type Playback } from '../geometry/playback';
import { boxSolid, isDenseForExactSweep, sweepTimeline, unliftTimeline, type SweepDiagnostic, type SweepOpts, type SweepResult, type SweepStats } from '../geometry/sweep';
import { columnSweep, type ColumnSweepOk, type DrillPointDefault } from '../geometry/columnEngine';
import { checkpointStoreOf } from '@/engine/cnc/emulator/checkpointStore';
import { eventStoreOf } from '@/engine/cnc/gcode/eventStore';
import type { ParseResult } from '@/engine/cnc/gcode/types';
import type { FlatField } from '../geometry/carriedField';
import { routeEngine } from './routeEngine';
import { unionRemoval } from './engraveRest';
import type { SimThreadSpec } from '@/engine/cnc/cam/threadMill';

export type DiagnosticSource = 'parser' | 'runner' | 'sweep';

/** One diagnostic from any stage, tagged with the stage that raised it. */
export interface SimDiagnostic {
  source: DiagnosticSource;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  line?: number;
  step?: number;
  checkpoint?: number;
  /**
   * #895 — the stall that stopped the run: the window, ms, that passed without a checkpoint. Set
   * on a `sweep-stalled` diagnostic only; the panel offers a report beside it.
   */
  stallMs?: number;
}

/** A checkpoint without its geometry-sized arrays (`xy`, `zs`, `steps`). */
export interface CheckpointInfo {
  segment: number;
  z: number;
  run: number;
  firstStep: number;
  lastStep: number;
  moveCount: number;
  nonConstantZ: boolean;
  /**
   * #241 — the rotary index this run was cut at, degrees (`null` for a flat program). Constant
   * through the run: an indexed job's playback is per FACE, so a consumer that draws the stock
   * in the orientation being cut (deferred to the viewport slice) reads it here rather than
   * re-deriving it from the program.
   */
  a: number | null;
}

export interface SimGougeMesh {
  step: number;
  line: number;
  mesh: NodeMeshOutput;
}

/**
 * One obstacle the tool must not hit (#204, `/Simulation.md` §1.1). Mesh coordinates are the
 * **un-inflated** box — where the user said the jaw is, not where the check grew it to. The
 * viewport draws them translucent grey with the source in the label.
 */
export interface SimFixtureMesh {
  id: string;
  label: string;
  mesh: NodeMeshOutput;
}

/**
 * #817 — the column engine's removed volume as one mesh: the blank minus what it left. The engine
 * has no removal solid of its own (its grid IS the material); this realm owns the wasm toplevel,
 * so the subtraction happens here. Null when either display mesh cannot be made into a solid —
 * the removal ghost is then absent, and the chain still carries the FIELD.
 */
function columnRemovalMesh(tl: ManifoldToplevel, col: { stock: NodeMeshOutput; result: NodeMeshOutput }): NodeMeshOutput | null {
  const stockSolid = manifoldOfTriangles(tl, col.stock.positions, col.stock.indices);
  const resultSolid = manifoldOfTriangles(tl, col.result.positions, col.result.indices);
  if (stockSolid === null || resultSolid === null) {
    stockSolid?.delete();
    resultSolid?.delete();
    return null;
  }
  const removal = stockSolid.subtract(resultSolid);
  stockSolid.delete();
  resultSolid.delete();
  if (removal.status() !== 'NoError') {
    removal.delete();
    return null;
  }
  const mesh = meshOutputOf(removal);
  removal.delete();
  return mesh;
}

export interface SimLoadOk {
  ok: true;
  diagnostics: SimDiagnostic[];
  summary: Timeline['summary'];
  stats: SweepStats;
  stockTopZ: number;
  radius: number;
  /**
   * How many cutting moves dipped past the rotary axis within one tool radius and were clamped to
   * it, with the deepest such Z (#239, decision R8) — `null` when none did. Carried here, OUTSIDE
   * `diagnostics`, so the panel can show it where a user reads the result: a clamped cut did not
   * come out the depth that was asked for.
   */
  axisClamped: { count: number; deepestZ: number } | null;
  /** Number of checkpoints: valid `simFrameAt` indices are -1 … count-1. */
  count: number;
  checkpoints: CheckpointInfo[];
  pauses: PausePoint[];
  segments: Segment[];
  meshes: { stock: NodeMeshOutput; result: NodeMeshOutput; removal: NodeMeshOutput | null; sacrificial: NodeMeshOutput | null; gouges: SimGougeMesh[]; fixture: SimFixtureMesh[] };
  /**
   * #817 — the column engine's remaining TOP per column (its final grid, in the program's own
   * frame), so the next program's column seed starts with this program's cuts gone. Null for the
   * exact engine, whose removal is the mesh above and whose later seeds read that.
   */
  removalField?: CarriedField | null;
  /**
   * Where the fixture's dimensions came from (#204), present only when the setup models one.
   * A default is NOT a measurement; the viewport shows this so the shown jaws are not read as
   * exact. Optional so a setup with no `fixture` does not grow the load info's shape.
   */
  fixtureSource?: FixtureEnvelope['source'];
  /** Every box was grown by this much before any check (#203, decision 28), mm. */
  fixtureUncertainty?: Mm;
  /**
   * #723 P2-2b — the FLAT grid's final TOP field when the column engine swept this program, as
   * plain data. The run store keeps it and hands it to the next setup as the carried floor; a
   * rotary or exact sweep returns none. Copied across the worker boundary (never transferred): the
   * session keeps the same grid live for playback.
   */
  flatField?: FlatField | null;
}

export interface SimLoadRefused {
  ok: false;
  diagnostics: SimDiagnostic[];
  /**
   * True when the runner succeeded and only the SWEEP refused: the cheap half is still here —
   * `summary`, `pauses` and `segments` are present, `stateAt` and `toolPath` work, and
   * `frameAt` returns null, so the viewport can draw the path with no material (#194). False
   * when there is no timeline to keep (an unknown machine).
   */
  pathOnly: boolean;
  /** Present only when `pathOnly`. */
  summary?: Timeline['summary'];
  pauses?: PausePoint[];
  segments?: Segment[];
}

export type SimLoadResult = SimLoadOk | SimLoadRefused;

/**
 * The whole tool path, with the kind and time of every move (#197, `/Simulation.md` §8). The
 * viewport needs to know which segments cut and #198 needs time; `toolPath` returns bare
 * positions and neither. One entry per MoveEvent whose position is FULLY known — a non-move
 * step and a move that leaves an axis unknown produce no vertex.
 */
export interface SimPath {
  /** Tool-tip position after each step whose position is fully known: [x, y, z, …], work frame. */
  xyz: Float32Array;
  /** The program step each vertex belongs to; strictly increasing. */
  step: Uint32Array;
  /**
   * 0 = rapid, 1 = cutting feed (spindle on), 2 = feed with the spindle off. Vertex i's kind
   * describes the move that ENDS at vertex i.
   */
  kind: Uint8Array;
  /** Cumulative seconds at each vertex (see `simPath`). */
  t: Float32Array;
  /**
   * The 1-based source line each vertex's move came from (#198), so the transport can show
   * "line L" without a per-step round-trip. Optional: a hand-built path in a spec need not
   * carry it, and `simPath` always produces it.
   */
  line?: Uint32Array;
  /**
   * #716 slice 2 — the A axis at each vertex, degrees, UNWOUND (the machine's own A, so a
   * multi-turn pass reads 1 234.5; the transport renders it as `A 154.5° · 3 turns`).
   * Present only when the program commands A at all — a flat program has no array, like `line` —
   * and NaN at a vertex before the first A word, where the machine's angle is unknown.
   */
  a?: Float64Array;
  /**
   * Whether `t` is a FULL clock — feeds AND rapids, timed through the trapezoid on the machine's
   * rapid model (#281) — or feeds only. A session loaded with an explicit machine times rapids;
   * one loaded with NO machine (`machineId === null`) has no rapid model to time them with, so it
   * draws them in 0 s rather than inventing a rate, and says so. Absent means timed: a hand-built
   * path in a spec carries only what it cares about, and the real ones always set it (#367).
   */
  rapidsTimed?: boolean;
}

export interface SimFrame {
  k: number;
  stock: NodeMeshOutput;
  /** Everything cut up to and including checkpoint k; null when nothing has been. */
  removalSoFar: NodeMeshOutput | null;
  /**
   * The sacrificial material as cut up to and including checkpoint k (#213); null when the job
   * has none. Same two-body split as `load`: `sacrificial` uncut at k = -1, the board/strips
   * minus the cumulative removal thereafter.
   */
  sacrificial: NodeMeshOutput | null;
  /**
   * #716 slice 2 — which frame `stock` is in: the wrapped rod (default) or the unrolled map
   * (Unroll). Absent means stock, so a hand-built frame in a spec keeps its old shape.
   */
  design?: SimDesign;
}

/**
 * #716 slice 2 — how a rotary simulation's material is drawn: the rod in the chuck (`stock`,
 * default) or the same columns unrolled onto the map (`map`, Unroll).
 */
export type SimDesign = 'stock' | 'map';

/** A swept session: the geometry AND the path. */
interface LiveSwept {
  kind: 'swept';
  sweep: SweepResult;
  playback: Playback;
  timeline: Timeline;
  setup: Setup;
}
/** A refused sweep keeps the runner's work: the path is drawable, the material is not (#194). */
interface LivePath {
  kind: 'path';
  timeline: Timeline;
  setup: Setup;
}
/**
 * A ROTARY job, swept by the column engine (#239, `/Rotary.md` §4.1). It owns no wasm handle:
 * every mesh it hands out is plain buffers built from the grid, so there is nothing for
 * `dispose` to delete and no playback anchor chain to warm. The exact sweeper's `rotary-job`
 * refusal is never reached from here — the timeline's `summary.rotaryClass` routes the load
 * ('wrapped' to this engine; an INDEXED job with a flat tool to the exact sweep, #241).
 */
interface LiveColumn {
  kind: 'column';
  column: ColumnSweepOk;
  timeline: Timeline;
  setup: Setup;
  /**
   * #240 slice 2 — the cutter the run was swept with. The rotary oracle derives its FACET
   * allowance from it (`√(Z_t² + r_t²) − Z_t`), the same term the R-2 column model implies, so
   * the tolerance is the run's own number rather than a hand-set millimetre.
   */
  tool: Tool;
}
type Live = LiveSwept | LivePath | LiveColumn;

/** What `load` will accept on top of its arguments (#194). */
export interface SimLoadOpts {
  /**
   * #895 — how long the sweep may go without completing a checkpoint, ms. The worker's own guard
   * (the client's watchdog is the hard stop for a single call that never yields).
   */
  stallMs?: number;
  onProgress?: (done: number, total: number) => void;
  /**
   * The machine's own coordinate frame, if one has been read from it (#279). Resolved against
   * the profile named by `machineId` — the timeline animates a predicted tool-length probe
   * toward `sensor`, and on a calibrated machine that is not the vendor's position.
   *
   * A calibration belonging to a DIFFERENT machine is ignored by `resolveMachine`, so a stale
   * saved record can never aim this machine's probe at another one's numbers.
   */
  calibration?: MachineCalibration | null;
  /**
   * The material PREVIOUS programs left, as the removal meshes their own sweeps produced (#410,
   * the rest pass; #744, every program of a multi-program run). This program is then swept
   * starting from that part rather than from the blank — see `SweepOpts.priorRemoval`, which is
   * where the subtraction happens. A single mesh is one earlier program; a LIST is the cumulative
   * material of several, which this load unions before the exact sweep. An EMPTY list means no
   * seed (not a rest pass).
   *
   * The EXACT sweeper takes it; a V-bit or a WRAPPED rotary job (the column engine) is REFUSED
   * with `prior-removal-column`, and an INDEXED rotary job by the exact sweep itself with
   * `prior-removal-rotary` (#241) — its prior material would have to be read in the stock frame
   * the faces are turned back into — rather than swept without it, because a rest pass simulated
   * against the wrong stock is a picture of a cut that will not happen.
   */
  priorRemoval?: NodeMeshOutput | readonly NodeMeshOutput[];
  /**
   * #723 P2-2b — the other side's remaining stock as a FIELD (the column engine's carried floor),
   * with the maps into this program's work frame. A column-swept program (a ball/bull finish, a
   * V/drill/thread, a wrapped rotary) starts from it instead of being refused
   * `prior-removal-column`; an exact-swept program uses `priorRemoval`'s meshes and ignores this.
   */
  carried?: CarriedField | null;
  /**
   * #817 — the earlier COLUMN programs' remaining tops, in this program's own work frame. A column
   * program seeds its grid from these; a legacy caller with only `priorRemoval` keeps the old
   * refusal. The EXACT sweeper ignores them and subtracts the meshes above instead. When both a
   * carried field and these are present, these win (they are the run's own chain).
   */
  priorFields?: readonly CarriedField[];
  /**
   * #817 — which of `priorRemoval`'s meshes an EXACT-engine program produced. A column program can
   * start from the fields but not from an exact sweep's mesh, so a walk that has an exact
   * predecessor in its history is still refused for a column program; absent, a caller with only
   * meshes (a rest pass) is refused exactly as before.
   */
  priorExactRemoval?: readonly NodeMeshOutput[] | null;
  /**
   * The shop's `drill.pointAngleDeg` as the app read it from the location, for a drill whose record
   * states no point angle (#382). Absent: the registry's labelled fallback (source `fallback`).
   */
  drillPointDefault?: DrillPointDefault | null;
  /**
   * The shop's `sim.columnFlatPitchYMm` as the app read it (#438): the column engine's FLAT grid Y
   * pitch, mm. Absent: `COLUMN_FLAT_PITCH_Y_FALLBACK_MM`. A rotary job ignores it.
   */
  flatPitchYMm?: number | null;
  /**
   * The shop's `sim.columnPitchXMm` as the app read it (#451): the column grid's X pitch, mm.
   * Absent: `COLUMN_PITCH_X_FALLBACK_MM`. An explicit `resolution` overrides it.
   */
  columnPitchXMm?: number | null;
  /**
   * The shop's `sim.rotaryPitchDeg` as the app read it (#451): the ROTARY column grid's θ pitch,
   * degrees. Absent: `COLUMN_ROTARY_PITCH_FALLBACK_DEG`. A flat job ignores it.
   */
  rotaryPitchDeg?: number | null;
  /**
   * The shop's `sim.spindleOffProximityMm` as the app read it (#451): how close a spindle-off move
   * may come to material or the bed, mm. Absent: `SPINDLE_OFF_PROXIMITY_FALLBACK_MM`.
   */
  spindleOffProximityMm?: number | null;
  /**
   * The threads the program mills (#445 §4), as the CAM planned them. Passed straight through to
   * the column engine, which checks each against the cutting diameter and reports the annular
   * band instead of the generic envelope warning. A rotary job is refused by name.
   */
  threads?: readonly SimThreadSpec[] | null;
  /**
   * How far below the blank a job's through cuts reach, mm (#218) — the job's breakthrough, read
   * by the caller because the session holds no job. The EXACT sweeper needs nothing: the G-code
   * already cuts into the board and `setup.sacrificial` is the second body it removes from. The
   * COLUMN engine clamps every floor to the blank's bottom, so without this a through drill or a
   * V-bit through pocket would stop at the bottom face; with it, the flat grid reaches
   * `base − breakthroughMm` and reports the board removal as `removedFromSacrificial`. Absent: 0.
   */
  breakthroughMm?: number | null;
  /**
   * #623/#628 — the fitted surface the program was POSTED against (`SurfaceFrame`), or null/absent
   * for a flat post. BOTH engines now read it the same way (#628): the timeline is UN-LIFTED —
   * every feed's Z read back with the lift subtracted at its own XY, the exact inverse of
   * `applySurfaceLift` (#625) — so the surface-frame program IS the flat program the CAM predicted,
   * swept on the un-seated stock and judged in the work frame, which for that program is the same
   * frame. `OracleReport.frame` still says `'surface'` when the file was posted against a plane.
   *
   * The column engine cannot sweep the LIFTED program: it gives every feed move ONE tip Z
   * (`min(z0, z1)`), and a lifted move's Z ramps along the segment — on the 2026-10-25 badge job
   * 4,070 of 13,015 moves ramped, by up to 0.079 mm over a 7.35 mm glyph segment, and sweeping each
   * at its deep end read the text floors past the next level (75.5 mm² of over-cut, #628). The
   * un-lifted program has a constant Z per move again, so the same rule is exact for it.
   *
   * A load WITHOUT this option is byte-for-byte the pre-#623 behaviour: stock at the work Z0,
   * verdict in the work frame.
   */
  surface?: SurfaceFrame | null;
  /**
   * The Z ramp, mm, past which the COLUMN engine reports a swept move as `ramp-over-removed` (#629)
   * — a PLAIN V-BIT only since #758; every other cutter follows Z along the move and no longer
   * over-removes.
   * Passed straight through to the column engine, which has no job and so cannot derive it: the
   * caller sends half the job's smallest level step (the smallest gap between its distinct item
   * depths). Absent: the column engine's ramp check is off — a pre-#629 caller sees no new
   * diagnostics.
   */
  rampThresholdMm?: number | null;
}

/**
 * Does this tool's job go to the COLUMN engine on a prism? A V-bit or chamfer (#405), a drill and a
 * thread mill (#382), a ball or a bull nose (#532): the exact sweeper's contract is one flat cutting
 * radius, and none of these has one it can honestly use — a ball/bull is a height profile over its
 * radius, which the FLAT dexel holds (`columnCutterFor`, `ColumnCutter.cornerRadius`). One that
 * states too little to sweep (a box-code chamfer with no tip, a thread mill with no cutting diameter,
 * a bull nose with no corner radius) still routes here, so the column engine's refusal — which names
 * what is missing — is the one the user reads.
 */
export function sweepsOnColumn(tool: Tool): boolean {
  return isVShape(tool) || tool.shape === 'drill' || tool.shape === 'thread' || tool.shape === 'ball' || tool.shape === 'bull';
}

/**
 * Does a DENSE flat-end-mill job route to the COLUMN (dexel) engine instead of being refused
 * `dense-3d-refused` by the exact sweep (#531, slice B)? The exact 2.5D sweeper caps itself at
 * `MAX_CHECKPOINTS` causal runs and refuses anything denser by name, leaving a 3D/relief file
 * path-only (#194) — but the FLAT dexel can draw exactly that, and already runs today for
 * V/drill/thread. So a job that (a) is denser than the exact sweep takes on
 * (`isDenseForExactSweep`) and (b) uses a genuine flat end mill — `cuttingRadiusForSweep(tool).ok`,
 * which is false for a ball or a bull nose — is sent to the dexel rather than refused. A ball/bull
 * does not need this gate: it already routes to the dexel through `sweepsOnColumn` (#532), dense or
 * not, so keeping it out here leaves B's dense-flat routing flat-only, as #531 relies on.
 *
 * A REST PASS is NOT routed here: the column engine cannot start from a previous program's
 * material (it would answer `prior-removal-column`), so a dense flat program handed a seed still
 * goes to the exact sweep and is refused `dense-3d-refused`. The multi-program walk (`programSweep`,
 * #746) then retries that program FROM THE BLANK — a real check of its own cuts, with an info note
 * saying so — rather than ending the run. This guard stays because the seeded FIRST attempt must
 * remain the exact sweep, not be routed away from its seed; the dexel engine and its geometry are
 * untouched.
 */
export function denseFlatRoutesToColumn(timeline: Timeline, tool: Tool, opts?: SimLoadOpts): boolean {
  return isDenseForExactSweep(timeline) && !opts?.priorRemoval && cuttingRadiusForSweep(tool).ok;
}

/**
 * #948 — what an oracle call needs to judge a goal: the goal's heightfield and the live sweep's
 * top, or the reason the top could not be sampled (a rotary or exact-engine sweep).
 */
export type GoalCheckInput =
  | {
      heightfield: GoalHeightfield;
      /** The conservative read — cut-into is judged on it (#948's max-of-four column read). */
      sweptTop: ResultTop;
      /** #948 — the page's own point read of the same sweep, for the leftover bands. */
      sweptTopExact?: ResultTop;
      /**
       * #948 review §4.1 — the whole-surface field, formed from every proposed setup's sweep
       * (`unionWholeSurface`). The pass line judges it when present; the single top setup's
       * producer hands its one-setup union, whose fraction is its top-surface number.
       */
      wholeSurface?: WholeSurfaceReach | null;
      opts?: GoalCutIntoOptions;
    }
  | { unchecked: string; opts?: GoalCutIntoOptions };

export interface SimSession {
  load(gcodeText: string, setup: Setup, tool: Tool, machineId: string | null, opts?: SimLoadOpts): SimLoadResult;
  /**
   * Build the playback anchor chain now (#224), off the scrub path. Called by the worker once
   * the client has the load result, so the first real seek does not pay for it. No-op on a
   * path-only or empty session.
   */
  warmup(): void;
  /** `null` when `gen` is older than one already seen, or when nothing is loaded. */
  frameAt(k: number, gen: number, design?: SimDesign): SimFrame | null;
  stateAt(step: number): MachineState | null;
  /** Work-frame [x, y, z, …] of the tool after each step in [from, to] whose position is fully known. */
  toolPath(fromStep: number, toStep: number): Float32Array;
  /** The whole path with kinds and times (#197). Empty arrays when nothing is loaded. */
  simPath(): SimPath;
  /**
   * The volumetric oracle (#206, `/Simulation.md` §7): compare the CURRENT sweep's cumulative
   * removal against the CAM's `predicted` regions, level by level. The session owns the removal
   * solid, so this is the only place the comparison can be made without shipping wasm handles.
   *
   * Throws when nothing SWEPT is loaded — a path-only refusal owns no removal at all. A COLUMN
   * live is judged off its grid (#408): a FLAT one against the work frame's (X, Y), which is what
   * lets a V-bit trace reach this at all (its prediction is a groove rather than one region per
   * item), and a ROTARY one against the MAP's (X, arc) column by column (`computeRotaryOracle`,
   * #240 slice 2, `/Rotary.md` §4.5) — never the flat area comparison, because the R-2 column
   * model's flat tip is a wedge whose floor only meets the nominal value under each pass. The
   * caller only reaches this after a load that reported `ok`.
   *
   * #623 — judged in the frame the LOAD was given: a `surface` load reads the sweep with the fitted
   * lift subtracted at each XY and stamps `frame: 'surface'` on the report, so a program posted
   * against a tilted blank is compared with the flat prediction that blank's design is.
   */
  // #924 — the public type never grew the `designItems`/`goal` params `554b0f67`'s own
  // implementation (just below) already takes; nothing called them with more than two arguments
  // until this activation, so the mismatch went uncaught. Widened here to match.
  oracle(
    predicted: readonly OraclePredicted[],
    pcb?: PcbCopperTopologyInput | null,
    designItems?: readonly DesignCheckItem[],
    goal?: GoalCheckInput,
  ): OracleReport;
  /**
   * #948 — THE LIVE SWEEP'S TOP, as a work-frame sampler the goal check reads: the highest column
   * touching the queried point on the FLAT grid (the same grid `SimLoadOk.flatField` exposes),
   * null outside it, and NULL when the live sweep has no flat top at all — an exact-engine sweep,
   * or a rotary column whose grid is the map frame. A caller then states the goal check as
   * UNCHECKED with a reason (`goalCutIntoUnchecked`); it never reports a silent pass.
   */
  sweptTop(): ResultTop | null;
  /**
   * #948 — THE PAGE'S OWN READ of the live sweep, as a field on the GOAL's grid: the cutter
   * stamped along the program's cutting moves, exactly as `goal_check.py` computes it (the
   * leftover bands and the pass line are judged on this; cut-into stays on {@link sweptTop},
   * which is conservative). Null for a sweep the goal check does not run on (a rotary or
   * exact-engine sweep), and when the session holds no tool to name the cutter.
   */
  sweptFieldExact(goal: { nx: number; ny: number; x0: number; y0: number; pitch: number }): Float32Array | null;
  /**
   * #857 — the region the CURRENT sweep has cut at or below `zSlice` (work frame), with the band
   * the oracle would judge it in: the same slice the volumetric comparison reads, handed to a
   * caller that measures something of its own on it (a raised glyph's counters). The caller owns
   * and deletes `region`; `region` is null when nothing is cut at that level. Null when the live
   * sweep is not a flat one (a rotary run's frame is not the work frame's XY).
   */
  levelCut(zSlice: number): { region: CrossSectionInstance | null; bandMm: number } | null;
  dispose(): void;
  readonly loaded: boolean;
}

/**
 * Test seams for `createSimSession`. The teardown order below is by construction, not by type,
 * so a spec needs a way to observe it rather than trust the comment: `onDispose` fires as each
 * owned thing is released, `'playback'` first and `'sweep'` second.
 */
export interface SimSessionHooks {
  onDispose?(what: 'playback' | 'sweep'): void;
}

/** A growable Float64 list (#899): `push` like an array, `done` is the filled part. */
class GrowF64 {
  private buf: Float64Array;
  private n = 0;
  constructor(width: number) {
    this.buf = new Float64Array(1024 * width);
  }
  push(...v: number[]): void {
    if (this.n + v.length > this.buf.length) {
      const next = new Float64Array(Math.max(this.buf.length * 2, this.n + v.length));
      next.set(this.buf.subarray(0, this.n));
      this.buf = next;
    }
    for (let i = 0; i < v.length; i++) this.buf[this.n++] = v[i] as number;
  }
  done(): Float64Array {
    return this.buf.subarray(0, this.n);
  }
}

/**
 * What the client is told about each checkpoint. #899 — read from the packed checkpoints without
 * making each one's move arrays; a checkpoint with no moves reports `undefined` steps, exactly as
 * reading `steps[0]` of its empty array did.
 */
function checkpointInfos(timeline: Timeline): CheckpointInfo[] {
  const packed = checkpointStoreOf(timeline.checkpoints);
  if (packed === null) {
    return timeline.checkpoints.map((cp): CheckpointInfo => ({
      segment: cp.segment,
      z: cp.z,
      run: cp.run,
      firstStep: cp.steps[0] as number,
      lastStep: cp.steps[cp.steps.length - 1] as number,
      moveCount: cp.steps.length,
      nonConstantZ: cp.nonConstantZ,
      a: cp.a,
    }));
  }
  const out = new Array<CheckpointInfo>(packed.length);
  for (let k = 0; k < packed.length; k++) {
    const start = packed.moveStart(k);
    const n = packed.moveEnd(k) - start;
    out[k] = {
      segment: packed.segmentOf(k),
      z: packed.zOf(k),
      run: k,
      firstStep: (n > 0 ? packed.stepOf(start) : undefined) as number,
      lastStep: (n > 0 ? packed.stepOf(start + n - 1) : undefined) as number,
      moveCount: n,
      nonConstantZ: packed.nonConstantZOf(k),
      a: packed.aOf(k),
    };
  }
  return out;
}

/** Delete every handle a `SweepResult` owns, each exactly once. */
export function disposeSweep(sweep: SweepResult): void {
  sweep.stock.delete();
  sweep.sacrificial?.delete();
  sweep.result.delete();
  sweep.removal?.delete();
  for (const s of sweep.perCheckpoint) s?.delete();
  for (const g of sweep.gouges) g.solid.delete();
}

const refuse = (code: string, message: string): SimLoadRefused => ({ ok: false, pathOnly: false, diagnostics: [{ source: 'sweep', severity: 'error', code, message }] });

const tagSweep = (d: SweepDiagnostic): SimDiagnostic => ({
  source: 'sweep',
  severity: d.severity,
  code: d.code,
  message: d.message,
  ...(d.checkpoint !== undefined ? { checkpoint: d.checkpoint } : {}),
  ...(d.line !== undefined ? { line: d.line } : {}),
  ...(d.step !== undefined ? { step: d.step } : {}),
});

/**
 * The worst checkpoint's 2D contour count, as a triangle count — the number the sweep's own
 * simplify budget is derived from (`sweepTimeline`), and so the number the oracle's band must use
 * to agree with it. One definition, because the oracle now reads it on two engines' paths.
 */
const worstContours = (timeline: Timeline): number => timeline.checkpoints.reduce((a, cp) => Math.max(a, cp.steps.length * 3), 0);

/** A Manifold handle inside this session, derived from the toplevel it was given. */
type ManifoldHandle = InstanceType<ManifoldToplevel['Manifold']>;

/**
 * #708 — the volumetric oracle for an INDEXED rotary live (a `swept` one; `#241` gave its runs one
 * stock-frame solid each). Per face:
 *
 *   - the face's solids are turned back into the FACE frame by `+a` about X — the inverse of the
 *     `-a` the sweep applied — so the tool's cut sits at the top of the stock again, Y ≡ 0 and
 *     Z the radius above the axis (R6);
 *   - the frame's top face is the stock's RADIUS (`sweep.stockTopZ`), so a prediction's depth is
 *     measured below that face by `computeOracle`'s `zTop`;
 *   - the predictions are grouped by {@link OraclePredicted.a} (an untagged one belongs to A 0,
 *     the single face a one-index program cuts), and the flat comparison runs on each group.
 *
 * A face named by a prediction but never cut has no solid: its levels come back as pure under-cut,
 * which is what "the program never turned to that face" should say. The merged report keeps the
 * flat one's shape, and `a` on every level and on the worst cut lets the sentence name the face.
 */
/**
 * #729 — a rotary index as a FACE key: in [0, 360), at the post's 3-decimal precision, so 0 and
 * 360, −90 and 270, and 51.42857° against the posted A51.429 all name the same face.
 */
export function faceKey(a: number | null | undefined): number {
  const r = Math.round(((((a ?? 0) % 360) + 360) % 360) * 1000) / 1000;
  return r >= 360 || r === 0 ? 0 : r;
}

/** #729 — an unplanned face's removal is judged this far below the stock's top, mm. */
const UNPLANNED_FACE_DEPTH_MM = 0.05;
/** #729 — removal smaller than this on an unplanned face is noise, mm². */
const UNPLANNED_FACE_FLOOR_MM2 = 0.01;

function indexedFaceOracle(tl: ManifoldToplevel, l: { timeline: Timeline; sweep: SweepResult }, predicted: readonly OraclePredicted[]): OracleReport {
  // #729 — no prediction at all is not a pass: every face an indexed program cuts must be one the
  // plan named. (The flat path returns an empty report instead; an indexed one refuses.)
  if (predicted.length === 0) {
    throw new Error('oracle: an indexed rotary program with no predicted face cannot be judged');
  }
  const zTop = l.sweep.stockTopZ;
  const band = oracleBand(worstContours(l.timeline));
  // #749 — ONE COLUMN PER FOOTPRINT, THE DEEPEST. An indexed face cut in several depth passes
  // leaves the sweep with identical columns nested in Z, exactly as a through cut does; unioning
  // every one here would rebuild the combinatorial pile the sweep and playback now avoid. Nested
  // prisms with one XY contour union to the deepest alone, so the face's union is unchanged.
  // `perCheckpointKey` is the sweep's label for that contour (and includes A); a solid it could
  // not label is kept, never dropped.
  const keys = l.sweep.perCheckpointKey;
  const zAt = (i: number): number => l.timeline.checkpoints[i]?.z ?? Number.POSITIVE_INFINITY;
  const picked = new Map<number, { unkeyed: number[]; deepest: Map<number, number> }>();
  l.timeline.checkpoints.forEach((cp, i) => {
    if (!l.sweep.perCheckpoint[i]) return;
    const a = faceKey(cp.a);
    let entry = picked.get(a);
    if (entry === undefined) {
      entry = { unkeyed: [], deepest: new Map() };
      picked.set(a, entry);
    }
    const key = keys[i] ?? null;
    if (key === null) {
      entry.unkeyed.push(i);
      return;
    }
    const prev = entry.deepest.get(key);
    if (prev === undefined || zAt(i) < zAt(prev)) entry.deepest.set(key, i);
  });
  const solidsByFace = new Map<number, ManifoldHandle[]>();
  for (const [a, entry] of picked) {
    const indices = entry.unkeyed.concat([...entry.deepest.values()]).sort((x, y) => x - y);
    solidsByFace.set(
      a,
      indices.map((i) => l.sweep.perCheckpoint[i] as ManifoldHandle),
    );
  }
  const angles = [...new Set([...solidsByFace.keys(), ...predicted.map((p) => faceKey(p.a))])].sort((x, y) => x - y);
  const levels: OracleLevel[] = [];
  let ok = true;
  let areaFloor: number | undefined;
  let worstUnder = 0;
  let worstOver = 0;
  let worstUnderAt: { z: number; bbox: OracleBbox; a?: number } | null = null;
  let worstOverAt: { z: number; bbox: OracleBbox; a?: number } | null = null;
  for (const a of angles) {
    const solids = solidsByFace.get(a) ?? [];
    const turned = solids.map((s) => s.rotate([a, 0, 0]));
    const faceSolid: ManifoldHandle | null = turned.length === 0 ? null : turned.length === 1 ? (turned[0] as ManifoldHandle) : tl.Manifold.union(turned);
    try {
      const facePredicted = predicted.filter((p) => faceKey(p.a) === a);
      // #729 — a face the program CUT that no prediction names. `computeOracle` has no level to
      // ask it at, so it would come back empty and pass; judge it at a shallow level below the
      // face instead, and any removal there is cut the plan never asked for.
      if (facePredicted.length === 0 && faceSolid !== null) {
        const z = zTop - UNPLANNED_FACE_DEPTH_MM;
        const slice = removalSliceAt(faceSolid)(z + ORACLE_SLICE_LIFT_MM);
        if (slice !== null) {
          try {
            const area = slice.area();
            if (area > UNPLANNED_FACE_FLOOR_MM2) {
              const b = slice.bounds();
              const bbox = { min: [b.min[0], b.min[1]] as [number, number], max: [b.max[0], b.max[1]] as [number, number] };
              ok = false;
              levels.push({ z, predictedArea: 0, simulatedArea: area, underCut: 0, overCut: area, a, underBbox: null, overBbox: bbox });
              if (area > worstOver) {
                worstOver = area;
                worstOverAt = { z, bbox, a };
              }
            }
          } finally {
            slice.delete();
          }
        }
        continue;
      }
      const report = computeOracle(
        tl,
        faceSolid === null ? () => null : removalSliceAt(faceSolid),
        facePredicted,
        band,
        undefined,
        zTop,
      );
      ok = ok && report.ok;
      if (report.areaFloor !== undefined) areaFloor = areaFloor === undefined ? report.areaFloor : Math.max(areaFloor, report.areaFloor);
      for (const level of report.levels) levels.push({ ...level, a });
      if (report.worst.underCut > worstUnder) {
        worstUnder = report.worst.underCut;
        worstUnderAt = report.worst.underAt ? { ...report.worst.underAt, a } : null;
      }
      if (report.worst.overCut > worstOver) {
        worstOver = report.worst.overCut;
        worstOverAt = report.worst.overAt ? { ...report.worst.overAt, a } : null;
      }
    } finally {
      // The turned handles are OURS; the sweep's solids stay alive underneath them until every
      // slice has been forced above (the lazy-transform trap, /Simulation.md's Manifold note).
      if (faceSolid !== null && turned.length > 1) faceSolid.delete();
      for (const t of turned) t.delete();
    }
  }
  return {
    ok,
    band,
    levels,
    worst: { underCut: worstUnder, overCut: worstOver, underAt: worstUnderAt, overAt: worstOverAt },
    ...(areaFloor === undefined ? {} : { areaFloor }),
    frame: 'work',
  };
}

export function createSimSession(tl: ManifoldToplevel, hooks?: SimSessionHooks): SimSession {
  let live: Live | null = null;
  let latestGen = Number.NEGATIVE_INFINITY;
  /**
   * The rapid model the LOADED program was swept for (#281), or `null` when it was loaded with no
   * machine. Set by `load`, cleared by `dispose`, and read by `simPath` — it is the session's own
   * account of the run it holds, so the drawn clock does not have to re-derive which machine this is.
   */
  let rapid: RapidEstimate | null = null;
  /**
   * #623/#628 — the fitted surface the LOADED program was posted against, or null for a flat post.
   * It is the frame the program was UN-LIFTED into for the sweep and the frame `oracle` judges in;
   * set by `load`, cleared by `dispose`, and never read by anything that does not own both halves.
   */
  let surfaceFrame: SurfaceFrame | null = null;

  const dispose = (): void => {
    const l = live;
    live = null;
    rapid = null;
    surfaceFrame = null;
    if (!l) return;
    if (l.kind === 'path' || l.kind === 'column') return; // owns no wasm handle at all
    // Playback first: its anchors and cached unions are built over the sweep's solids.
    l.playback.dispose();
    hooks?.onDispose?.('playback');
    disposeSweep(l.sweep);
    hooks?.onDispose?.('sweep');
  };

  /**
   * #948 — THE RUN'S ONE GOAL FIELD, ACROSS ITS PROGRAMS.
   *
   * `goal_check.py` stamps EVERY program of a run onto ONE field (`np.minimum` per cell), and a
   * goal run's last program judged alone answers a different question: a rest pass with a ⌀0.5
   * ball touches only the corners the finish left, so its own stamp reads most of the surface at
   * the stock's top. Each program's stamp is folded in (elementwise minimum) as the run's oracle
   * asks for it, so the LAST program's report carries the run's combined field. A load that
   * carries material from an earlier program is a later program of the same run and keeps the
   * field; a load with no seed at all begins a new run (see `load`).
   */
  let exactRun: { key: string; field: Float32Array } | null = null;

  const load = (gcodeText: string, setupArg: Setup, tool: Tool, machineId: string | null, opts?: SimLoadOpts): SimLoadResult => {
    dispose();
    // #623/#625/#628 — a program posted against the blank's fitted surface is judged in its SURFACE
    // frame, and BOTH engines read that frame the same way: by UN-LIFTING the program (the exact
    // inverse of `applySurfaceLift`, #625) so it sweeps the flat program the job really is, on the
    // flat stock. The verdict is then identical to the flat post's by construction.
    //
    // The COLUMN engine took a different route until #628 — a seated stock plus a per-cell lift in
    // the grid read — and that route cannot be exact: the engine gives every feed move ONE tip Z
    // (`min(z0, z1)`), while a lifted move's Z ramps along its segment. On the 2026-10-25 badge job
    // 4,070 of 13,015 cut moves ramped, by up to 0.079 mm over a 7.35 mm glyph segment (the plane's
    // slope × the segment), so each was swept at its deep end and the text floors read past the next
    // level: 75.5 mm² of over-cut. Un-lifted, the program's Z is constant per move again and the
    // rule is exact. A flat load (no surface) is untouched either way.
    const surface = opts?.surface ?? null;
    surfaceFrame = surface;
    // #744 — the seed may be a LIST (one entry per earlier program). Normalize once, here, so the
    // routing below asks "is there a seed at all" as one boolean and never as a truthy array: an
    // EMPTY list must not read as a rest pass, which would take a dense flat job off the column
    // route and then sweep it from the blank with no seed at all.
    const priorList: NodeMeshOutput[] =
      opts?.priorRemoval === undefined
        ? []
        : Array.isArray(opts.priorRemoval)
          ? [...(opts.priorRemoval as readonly NodeMeshOutput[])]
          : [opts.priorRemoval as NodeMeshOutput];
    const hasPrior = priorList.length > 0;
    const routingOpts: SimLoadOpts | undefined =
      opts === undefined ? undefined : { ...opts, priorRemoval: hasPrior ? priorList : undefined };
    // #948 — A LOAD FROM THE BLANK BEGINS A NEW RUN. The page's checker stamps every program of a
    // run onto one goal field; the session folds each program's stamp in as the run's oracle asks
    // for it (`sweptFieldExact`). A load that carries material from an earlier program is a later
    // program of the same run and keeps the field; a load with no seed at all starts clean, so a
    // new run (or the Simulate panel's own load) cannot inherit the last run's cuts.
    if (!hasPrior && opts?.carried == null && (opts?.priorFields?.length ?? 0) === 0 && (opts?.priorExactRemoval?.length ?? 0) === 0) {
      exactRun = null;
    }
    let machine: Mill | undefined;
    if (machineId !== null) {
      const base = MACHINES[machineId];
      if (base !== undefined) {
        // The saved read of THIS machine's frame, if there is one (#279). The lookup above is by
        // the CALLER's id, so an unknown id still refuses by name rather than falling back to a
        // profile with the machine's calibration quietly laid over it.
        machine = resolveMachine(base, opts?.calibration);
      } else {
        const model = MILL_MODELS[machineId];
        if (model === undefined) {
          return refuse('machine-unknown', `unknown machine "${machineId}"; known: ${Object.keys(MILL_MODELS).join(', ')}`);
        }
        // #773 — a model the app KNOWS but whose controller frame has never been read is not an
        // unknown machine: it is the Carvera sentence, so the two facts cannot be confused.
        if (model.frameState !== 'stated') {
          return refuse('machine-frame-unread', machineFrameProblemById(machineId) ?? 'this machine carries no frame');
        }
        // #845 — A STATED MACHINE IS SIMULATED, NOT DRIVEN. Its stated values are its model, with
        // no controller configuration to resolve and no calibration to lay over it; the simulation
        // and the oracle are predictions of the file, which is exactly what an export-only machine
        // still needs (the acceptance runs them). What it never gets is a probe, a park or a
        // machine-frame move — none of which its post writes.
        machine = model;
      }
      rapid = machine.rapidEstimate;
    }
    // The LIFTED timeline (the file as posted) and, when the package speaks the surface frame, its
    // surface-frame image: the same program with the lift taken back out, re-bucketed — the flat
    // program a flat post would have produced. The SWEEP takes the image; the viewport draws the
    // file (the timelines share their events).
    //
    // #899 — the parse is read inside its own scope so nothing holds it past the timeline: its
    // packed events are a second copy of the program, and the sweep should not run beside them.
    const { timeline, parserDiagnostics } = ((): { timeline: Timeline; parserDiagnostics: ParseResult['diagnostics'] } => {
      // #845 — READ THE FILE AS ITS MACHINE'S POST WROTE IT: a GRBL file's `M0` pause and `M8`
      // coolant are its own dialect, and the Z1 firmware model refuses them as unknown codes.
      const parse = parseGcode(gcodeText, { dialect: machine === undefined ? 'z1' : postKey(machine) });
      return { timeline: buildTimeline(parse, setupArg, machine), parserDiagnostics: parse.diagnostics };
    })();
    const surfaceTimeline = surface === null ? timeline : unliftTimeline(timeline, surface);
    const diagnostics: SimDiagnostic[] = [
      ...parserDiagnostics.map((d): SimDiagnostic => ({ source: 'parser', severity: d.severity, code: d.code, message: d.message, line: d.line })),
      ...timeline.diagnostics.map((d): SimDiagnostic => ({ source: 'runner', severity: d.severity, code: d.code, message: d.message, line: d.line, step: d.step })),
    ];
    // A WRAPPED rotary job — one whose cutting moves change A — is swept by the COLUMN engine
    // (#239, `/Rotary.md` §4.1): the tool follows a helix the exact 2.5D sweeper cannot
    // represent, and the vendor files' checkpoint count is expected to exceed the exact one's
    // gate. Routing here also means the dense-3D classifier never applies to a wrapped rotary
    // job, whose checkpoint count is expected to exceed it.
    //
    // An INDEXED rotary job (#241, R-4) goes the other way, to the EXACT sweeper: A is held
    // across every run and changes only between them (the timeline's `rotaryClass`), so each
    // run is an ordinary 2.5D cut on a stock rotated by its own `a`, which `sweepTimeline`
    // rotates the removal back out of (§4.6). A rotary V-bit or drill still routes here through
    // `sweepsOnColumn` and is refused by that engine by name; an indexed job with a FLAT tool
    // and no V/drill is the one rotary shape the exact path takes.
    //
    // A V-BIT traces the same way and for the same kind of reason (#405, the hook #221 reserved):
    // the exact sweeper's contract is one flat cutting radius (`cuttingRadiusForSweep`), and a
    // cone's cutting width is a function of depth, so it refuses a V by name. The column engine
    // models the cone directly, so a V tool routes here whether or not the job is rotary — and a
    // rotary V job is refused inside `columnSweep` rather than swept as a flat disc. This is the
    // ONE place the decision is made: a job whose tool is a cone never reaches `sweepTimeline`.
    // A DRILL (its point is a cone) and a THREAD MILL (swept as its envelope) route the same way
    // (#382) — `sweepsOnColumn`.
    //
    // A DENSE FLAT job routes here too (#531, slice B): the exact sweeper would refuse it
    // `dense-3d-refused` for crossing `MAX_CHECKPOINTS`, leaving a 3D/relief file path-only, but
    // the FLAT dexel draws it — `denseFlatRoutesToColumn` gates this on a genuine flat end mill and
    // on its not being a rest pass, so a ball/bull (#532) and a rest pass keep their old refusals.
    // #928 — the decision above is `routeEngine`'s frozen table (`routeEngine.ts`), read off the
    // same four axes: tool shape, rotary class, exact-sweep density and the rest-pass seed kind.
    const rotaryClass = timeline.summary.rotaryClass;
    const toEngine = routeEngine({
      toolShape: tool.shape,
      rotaryClass,
      isDenseForExactSweep: isDenseForExactSweep(surfaceTimeline),
      flatCuttingRadiusOk: cuttingRadiusForSweep(tool).ok,
      hasPriorRemoval: Boolean(routingOpts?.priorRemoval),
    });
    if (toEngine === 'column') {
      // A rest pass is measured against the material a previous program left, and only the exact
      // sweeper can start from it. Silently sweeping the blank instead would draw a cut nobody is
      // going to make, so the pair is refused by name (#410). EITHER seed clears it: the carried
      // FIELD (#723 P2-2b) or the run's own field chain (#817).
      const hasExactPrior = opts?.priorExactRemoval == null ? hasPrior : opts.priorExactRemoval.length > 0;
      const hasFieldPrior = (opts?.priorFields?.length ?? 0) > 0;
      if (hasPrior && opts?.carried == null && (hasExactPrior || !hasFieldPrior)) {
        return refuse(
          'prior-removal-column',
          timeline.summary.rotary
            ? 'a rotary job cannot be a rest pass: the column engine has no way to start from the material a previous program left'
            : `tool "${tool.name}" is a ${tool.shape === 'drill' ? 'drill' : tool.shape === 'thread' ? 'thread mill' : 'cone (a V-bit)'}, which the column engine sweeps, and a rest pass is measured on a flat cutter's floor: the column engine cannot start from the material a previous program left`,
        );
      }
      // #628 — the column engine sweeps the UN-LIFTED (surface-frame) program on the flat stock,
      // exactly as the exact engine does since #625. See the load's comment for why the seat + grid
      // lift this replaces could not be exact.
      // #817 — the column engine seeds its grid from the earlier column programs' remaining tops;
      // without them the carried field (#723 P2-2b) is the seed, exactly as before.
      // #923 — the machine, so the column engine's fixture/holder check knows the collet nut's
      // dimensions, the same way `machine` already reaches `sweepTimeline` below.
      const columnOpts = hasFieldPrior
        ? { ...routingOpts, priorTops: opts?.priorFields ?? null, machine }
        : { ...routingOpts, carried: opts?.carried ?? null, machine };
      const col = columnSweep(surfaceTimeline, tool, setupArg, columnOpts);
      if (!col.ok) {
        // Same contract as a refused exact sweep (#194): keep the runner's work, draw the path,
        // show no material. A rotary refusal owns no wasm handle.
        live = { kind: 'path', timeline: surfaceTimeline, setup: setupArg };
        return {
          ok: false,
          pathOnly: true,
          diagnostics: [...diagnostics, ...col.diagnostics.map(tagSweep)],
          summary: surfaceTimeline.summary,
          pauses: surfaceTimeline.pauses,
          segments: surfaceTimeline.segments,
        };
      }
      const fixture: SimFixtureMesh[] = [];
      for (const box of setupArg.fixture?.boxes ?? []) {
        const solid = boxSolid(tl, box);
        fixture.push({ id: box.id, label: box.label, mesh: meshOutputOf(solid) });
        solid.delete();
      }
      diagnostics.push(...col.diagnostics.map(tagSweep));
      // #723 R-4 review — NO DIAGNOSTIC FOR THE ROTARY'S WORKHOLDING. The chuck, the jaws and the
      // tailstock are the map's keep-out bands, and a `fixture-unchecked` info on every wrapped job
      // was a warning that could not discriminate (it fired on every rotary cut). The result
      // states the fact once instead (`simCoverage`'s band sentence: the jaws and tailstock are
      // checked as bands, and neither is modelled as a solid); the verifier still judges them.
      live = { kind: 'column', column: col, timeline: surfaceTimeline, setup: setupArg, tool };
      return {
        ok: true,
        diagnostics,
        summary: surfaceTimeline.summary,
        stats: col.stats,
        stockTopZ: col.stockTopZ,
        radius: col.radius,
        axisClamped: col.axisClamped,
        count: col.count,
        checkpoints: checkpointInfos(surfaceTimeline),
        pauses: surfaceTimeline.pauses,
        segments: surfaceTimeline.segments,
        // #817 — the column engine's removal ghost is the stock minus what it left, built here
        // because this realm owns the wasm toplevel. The FIELD is what a later column program
        // seeds from; the mesh is what a later exact sweep subtracts. A gouge is still reported
        // as a diagnostic; only its drawn solid is pending. The flat field stays too: it is the
        // display's own grid (§4.4), unaffected by the ghost.
        meshes: { stock: col.stock, result: col.result, removal: col.field === null ? null : columnRemovalMesh(tl, col), sacrificial: null, gouges: [], fixture },
        removalField: col.field,
        ...(col.grid.kind === 'flat'
          ? {
              flatField: {
                u0: col.grid.u0,
                v0: col.grid.v0,
                du: col.grid.du,
                dv: col.grid.dv,
                nu: col.grid.nu,
                nv: col.grid.nv,
                top: col.grid.h,
                base: col.grid.base,
              } satisfies FlatField,
            }
          : {}),
        // #923 — this stamp now means what it says: `columnSweep` only builds and tests the
        // fixture boxes for a FLAT job (a rotary job's obstacle is the chuck/jaws half-space
        // bands, never `setup.fixture` — #723 R-4 review), so guarding on `!col.grid.kind ===
        // 'rotary'` keeps this from claiming a check that never ran on the one path that
        // doesn't honour `setup.fixture`.
        ...(setupArg.fixture && col.grid.kind !== 'rotary' ? { fixtureSource: setupArg.fixture.source, fixtureUncertainty: setupArg.fixture.uncertainty } : {}),
      };
    }
    // The EXACT 2.5D sweep: the surface-frame (un-lifted) program on the un-seated stock — the flat
    // program the job really is, so the removal and the oracle's band are the flat post's own.
    // #744 — the exact sweeper takes ONE seed mesh. Union the cumulative list here, in the realm
    // that owns the wasm toplevel, so the app and the command line share one seed semantic; a
    // single mesh is passed straight through (no copy) and an invalid one still reaches
    // `sweep.ts`'s own `prior-removal-invalid` refusal. If the union produced nothing, the first
    // mesh is passed for the same reason: refuse the seed by name rather than sweep the blank in
    // silence.
    // The exact sweeper takes ONE seed mesh (`SweepOpts.priorRemoval`). Drop the list form here and
    // add the one mesh back below, so the field never carries an array into `sweep.ts` — which
    // would be a different option shape, not a seed.
    let baseOpts: SweepOpts | undefined;
    if (routingOpts !== undefined) {
      const { priorRemoval: _prior, ...rest } = routingOpts;
      baseOpts = rest;
    }
    let sweepOpts: SweepOpts | undefined = baseOpts;
    if (hasPrior) {
      const seed = priorList.length === 1 ? priorList[0]! : unionRemoval(tl, priorList);
      sweepOpts = { ...baseOpts, priorRemoval: seed ?? priorList[0]! };
    }
    const out = sweepTimeline(tl, surfaceTimeline, tool, setupArg, machine ? { ...sweepOpts, machine } : sweepOpts);
    if (!out.ok) {
      // The runner's work is cheap and worth keeping on its own: a refused sweep still yields
      // the path, the pauses and the segments, so the viewport can draw the path with no
      // material. This session owns no wasm handle (#194).
      live = { kind: 'path', timeline: surfaceTimeline, setup: setupArg };
      return {
        ok: false,
        pathOnly: true,
        diagnostics: [...diagnostics, ...out.diagnostics.map(tagSweep)],
        summary: surfaceTimeline.summary,
        pauses: surfaceTimeline.pauses,
        segments: surfaceTimeline.segments,
      };
    }
    const sweep = out.value;
    let playback: Playback | null = null;
    try {
      playback = createPlayback(tl, surfaceTimeline, sweep);
      // The fixture, drawn where the user SAID the jaws are (#204): the un-inflated boxes, so
      // the picture is not the grown box the checks use. Built from the same `boxSolid` the
      // sweep checks against, so the shown solid and the tested one can never disagree.
      const fixture: SimFixtureMesh[] = [];
      for (const box of setupArg.fixture?.boxes ?? []) {
        const solid = boxSolid(tl, box);
        fixture.push({ id: box.id, label: box.label, mesh: meshOutputOf(solid) });
        solid.delete();
      }
      const meshes = {
        stock: meshOutputOf(sweep.stock),
        result: meshOutputOf(sweep.result),
        removal: sweep.removal ? meshOutputOf(sweep.removal) : null,
        sacrificial: sweep.sacrificial ? meshOutputOf(sweep.sacrificial) : null,
        gouges: sweep.gouges.map((g): SimGougeMesh => ({ step: g.step, line: g.line, mesh: meshOutputOf(g.solid) })),
        fixture,
      };
      diagnostics.push(...sweep.diagnostics.map(tagSweep));
      live = { kind: 'swept', sweep, playback, timeline: surfaceTimeline, setup: setupArg };
      return {
        ok: true,
        diagnostics,
        summary: surfaceTimeline.summary,
        stats: sweep.stats,
        stockTopZ: sweep.stockTopZ,
        radius: sweep.radius,
        axisClamped: null,
        count: playback.count,
        checkpoints: checkpointInfos(surfaceTimeline),
        pauses: surfaceTimeline.pauses,
        segments: surfaceTimeline.segments,
        meshes,
        ...(setupArg.fixture ? { fixtureSource: setupArg.fixture.source, fixtureUncertainty: setupArg.fixture.uncertainty } : {}),
      };
    } catch (e) {
      // Nothing may leak, and a failed load leaves no session. Same order as `dispose`.
      if (playback) {
        playback.dispose();
        hooks?.onDispose?.('playback');
      }
      disposeSweep(sweep);
      hooks?.onDispose?.('sweep');
      live = null;
      throw e;
    }
  };

  const warmup = (): void => {
    const l = live;
    if (l && l.kind === 'swept') l.playback.warmup();
  };

  const frameAt = (k: number, gen: number, design: SimDesign = 'stock'): SimFrame | null => {
    if (gen < latestGen) return null;
    latestGen = gen;
    const l = live;
    if (!l || l.kind === 'path') return null;
    if (!Number.isFinite(k)) throw new RangeError(`checkpoint index must be a finite number, got ${k}`);
    if (l.kind === 'column') {
      // The column engine regenerates the surface straight from the grid — no booleans, no
      // removal ghost (#239, `/Rotary.md` §4.4). Both are null by construction.
      const kc = Math.max(-1, Math.min(l.column.count - 1, Math.trunc(k)));
      // #716 slice 2 — Unroll re-meshes the SAME columns onto the map; a flat grid has no map.
      const unrolled = design === 'map' && l.timeline.summary.rotary && l.column.meshAtMap !== null;
      const stock = unrolled
        ? (l.column.meshAtMap as (kk: number) => NodeMeshOutput)(kc)
        : l.column.meshAt(kc);
      return { k: kc, design: unrolled ? 'map' : 'stock', stock, removalSoFar: null, sacrificial: null };
    }
    const kk = Math.max(-1, Math.min(l.playback.count - 1, Math.trunc(k)));
    // Both handles are the playback's and evictable: mesh them here, keep neither.
    const stock = meshOutputOf(l.playback.stockAt(kk));
    const removal = l.playback.removalAt(kk);
    // The sacrificial material as cut so far (#213 §4): the cumulative removal clipped to the
    // sacrificial body, subtracted from it. `sweep.sacrificial` is a materialised leaf (see its
    // doc), so subtracting from it on every seek is safe. The two derived handles are ours.
    let sacrificial: NodeMeshOutput | null = null;
    if (l.sweep.sacrificial) {
      if (removal) {
        const cut = removal.intersect(l.sweep.sacrificial);
        const left = l.sweep.sacrificial.subtract(cut);
        sacrificial = meshOutputOf(left);
        left.delete();
        cut.delete();
      } else {
        sacrificial = meshOutputOf(l.sweep.sacrificial);
      }
    }
    return { k: kk, design: 'stock', stock, removalSoFar: removal ? meshOutputOf(removal) : null, sacrificial };
  };

  /**
   * The volumetric oracle (#206). The band is derived from the checkpoints' worst contour count,
   * exactly as the sweep derives its own simplify budget (sweep.ts §562), so the two agree.
   *
   * A COLUMN live is judged off its grid (#408). It keeps its material as a sampled height field,
   * not a solid, so there is nothing to `slice` — the level's cut area is read off the cells cut to
   * at or below it, and the band gains the grid's own cell size, which is the resolution that
   * reading is good to. The job that routes here is a V-bit trace, whose cut only the cone profile
   * can model (#405) and whose prediction is a GROOVE rather than one 2D region per item — the two
   * halves of the same piece.
   *
   * A WRAPPED rotary column is judged by `computeRotaryOracle` (#240 slice 2, `/Rotary.md` §4.5):
   * a COLUMN prediction in the map's frame. The flat comparison cannot be used for it — the grid's
   * second axis is the stock ANGLE, so its cells are not a picture of the work frame's XY, and the
   * R-2 column model's flat tip is a wedge, so a level's area says nothing about the region. The
   * session's part is to name the run's own grid, radius and cutter; the model, the cell + facet
   * tolerance and the seam fold live in the oracle.
   *
   * An INDEXED rotary sweep (#708) is judged A FACE AT A TIME: its removal is in the stock frame,
   * one rotated solid per run, so each face's solids are turned back into that face's own frame
   * and the flat comparison runs there, at the face's own top (the stock's radius). The per-face
   * reports merge into the flat one's shape, tagged with the face so a refusal can name it.
   */
  /**
   * #743 P-5 — fold the copper's topology verdict into a flat report when the run is a board. The
   * SAME sliceAt the volumetric comparison used reads the copper at its underside, so the two
   * checks see one simulation; `ok` is the pair, and the tick that reads it states both.
   */
  const withCopper = (
    report: OracleReport,
    sliceAt: OracleSliceAt,
    band: number,
    pcb: PcbCopperTopologyInput | null,
  ): OracleReport => {
    if (pcb === null) return { ...report, frame: surfaceFrame === null ? 'work' : 'surface' };
    const copper = computeCopperTopology(tl, sliceAt, pcb, band);
    return { ...report, copper, ok: report.ok && copper.ok, frame: surfaceFrame === null ? 'work' : 'surface' };
  };

  /**
   * #924 — merges the independent design-side check and the goal cut-into check into a report
   * already computed from the CAM's own prediction, the same way {@link withCopper} merges the
   * copper topology check: `ok` folds in whichever of the two the caller supplied inputs for.
   * Both are OPTIONAL and additive — no caller passes `designItems`/`goal` yet (#924's own
   * wiring gap, see `designCheck.ts`'s header), so today this is a no-op on every real job; a
   * caller that starts supplying raw design geometry or a goal heightfield gets the check for
   * free, with no further change here.
   */
  /** #948 — the goal check merges on its own, so a rotary report (no flat slice) can carry it. */
  const withGoalCheck = (report: OracleReport, goal?: GoalCheckInput): OracleReport => {
    if (goal === undefined) return report;
    const goalCutInto =
      'unchecked' in goal
        ? goalCutIntoUnchecked(goal.unchecked, goal.opts?.passCoverage)
        : checkGoalCutInto(goal.heightfield, goal.sweptTop, {
            ...goal.opts,
            ...(goal.sweptTopExact === undefined ? {} : { leftoverTop: goal.sweptTopExact }),
            ...(goal.wholeSurface === undefined || goal.wholeSurface === null ? {} : { wholeSurface: goal.wholeSurface }),
          });
    return { ...report, goalCutInto, ok: report.ok && goalCutInto.ok };
  };

  const withDesignChecks = (
    report: OracleReport,
    sliceAt: OracleSliceAt,
    /**
     * #924 hotfix — THIS SWEEP'S OWN measured tolerance (`oracleBand`/`columnOracleBand`'s, the
     * same number `withCopper` above already reads), not a hand-set default. `checkDesignReach`
     * previously got `{}` and fell back to its OWN hardcoded `SWEEP_SIMPLIFY_EPS_MM + 2 *
     * ARC_CHORD_TOLERANCE_MM` — the `simplifyLevels === 1` case — regardless of how many contours
     * this particular sweep actually simplified. `oracleBand`'s formula scales that term by
     * `SWEEP_TOLERANCES.simplifyLevels(contours)`, which grows with contour count (#786's chunked
     * union tree, one simplify pass per chunk and per tree level): a job with few contours (a
     * one-word badge, a single laminate shape) keeps `levels === 1` and the hardcoded default
     * happened to match it by coincidence, masking this gap through #924's own activation proof.
     * A job with many contours (three real text labels, each letter stroke its own contour) needs
     * a wider band than the hardcoded default allows, and the design check read every one of those
     * extra, genuinely-tolerable simplify levels as "too far"/"unreached" — `tests/e2e/engrave.
     * spec.ts:180`'s regression. Passing the SAME band the CAM-prediction oracle already compares
     * against keeps the two checks answering the same "is this within the sweep's own
     * approximation" question; it is the sweep's measured numerical tolerance, never the CAM's
     * offset geometry, so #924's independence from the CAM's own prediction is unaffected.
     */
    band: number,
    designItems?: readonly DesignCheckItem[],
    goal?: GoalCheckInput,
  ): OracleReport => {
    let out = report;
    if (designItems !== undefined && designItems.length > 0) {
      const designCheck = checkDesignReach(tl, designItems, sliceAt, { band });
      out = { ...out, designCheck, ok: out.ok && designCheck.ok };
    }
    return withGoalCheck(out, goal);
  };

  const oracle = (
    predicted: readonly OraclePredicted[],
    pcb: PcbCopperTopologyInput | null = null,
    designItems?: readonly DesignCheckItem[],
    goal?: GoalCheckInput,
  ): OracleReport => {
    // #623 — the frame the loaded program speaks. A flat post is judged exactly as it always was;
    // a surface post is read with its lift taken back out at each XY, which is the only way a
    // correct tilt-following file can match the flat prediction (and the flat post's mismatch).
    const surface = surfaceFrame;
    const l = live;
    if (l && l.kind === 'column') {
      const grid = l.column.grid;
      if (grid.kind !== 'flat') {
        // #240 slice 2 — the column prediction. R is the grid's own untouched radius (the carve's
        // `column.radius`), so the frame the oracle speaks is the frame the sweep made; the
        // prediction is already in map millimetres, which is the frame it is compared in.
        const radius = l.column.radius;
        // #763 — the run's own resolved cutter profile (a flat, a ball or a V): the oracle's facet
        // term is that cutter's edge, not a flat disc's.
        const cutter = l.column.cutter;
        const report = computeRotaryOracle(tl, {
          grid,
          radius,
          toolRadius: cutter.outerRadius ?? cutter.radius,
          cutter,
          predicted,
        });
        return withGoalCheck({ ...report, frame: surface === null ? 'work' : 'surface' }, goal);
      }
      const band = columnOracleBand(worstContours(l.timeline), grid);
      const sliceAt = gridSliceAt(tl, grid);
      const report = computeOracle(tl, sliceAt, predicted, band, grid);
      return withDesignChecks(withCopper(report, sliceAt, band, pcb), sliceAt, band, designItems, goal);
    }
    if (!l || l.kind !== 'swept') throw new Error('oracle: no swept program is loaded');
    // #708 — AN INDEXED ROTARY SWEEP IS JUDGED A FACE AT A TIME. Its removal is in the STOCK frame
    // (each run's solid was turned back out of its index by #241), while a prediction names regions
    // on ONE face in that face's own frame. So each face's solids are turned BACK into its frame
    // (+a about X), the frame's top face is the stock's radius, and the flat comparison runs on
    // that; the per-face reports merge into the flat report's shape with every level and the worst
    // cut tagged with its face, so a refusal can name it.
    if (l.timeline.summary.rotary) {
      return withGoalCheck(indexedFaceOracle(tl, l, predicted), goal);
    }
    const removal = l.sweep.removal;
    if (!removal) throw new Error('oracle: the loaded program removed no material');
    // #625 — the exact engine swept the SURFACE-FRAME image of the program (the load un-lifted every
    // FEED by the lift at its XY), so the removal is already the flat program's own, in the work
    // frame: compare it directly. `frame` still says `'surface'` when the program was posted against
    // a fitted plane, because that is the frame the numbers speak — which, for the flat program the
    // un-lift recovers, coincides with the work frame. No shear: the removal is never tilted.
    const band = oracleBand(worstContours(l.timeline));
    const sliceAt = removalSliceAt(removal);
    return withDesignChecks(withCopper(computeOracle(tl, sliceAt, predicted, band), sliceAt, band, pcb), sliceAt, band, designItems, goal);
  };

  const levelCut = (zSlice: number): { region: CrossSectionInstance | null; bandMm: number } | null => {
    const l = live;
    if (l === null) return null;
    if (l.kind === 'column') {
      const grid = l.column.grid;
      if (grid.kind !== 'flat') return null;
      return { region: gridSliceAt(tl, grid)(zSlice), bandMm: columnOracleBand(worstContours(l.timeline), grid) };
    }
    if (l.kind !== 'swept' || l.timeline.summary.rotary) return null;
    const removal = l.sweep.removal;
    const bandMm = oracleBand(worstContours(l.timeline));
    if (!removal) return { region: null, bandMm };
    return { region: removalSliceAt(removal)(zSlice), bandMm };
  };

  /**
   * #948 — the live sweep's top as a work-frame sampler, from the flat column grid's remaining
   * top `h` (the same values `SimLoadOk.flatField` carries). The value is the HIGHEST of the four
   * columns whose centres bracket the queried point, so a goal cell is only read as cut when all
   * four are below the goal — and a gouge up to one column (0.1 mm) wide is not seen at all
   * (a stated limit, pinned by test; a two-column gouge reads as one line of cells). Null when
   * the bracketing square runs off the grid.
   *
   * Why not the nearest column or a bilinear average: the goal grid's pitch is the sim's (0.1 mm)
   * but its origin is generally offset by half a cell, so every goal cell lies exactly on the
   * boundary between two columns. A nearest-column read then flips on float noise (the corpus
   * relief test read a whole row one column off), and a bilinear average smears a vertical wall
   * across both sides, inventing cut-into wherever the CAM cut a wall just outside the part. The
   * highest touching column says only what the grid can prove: every column over this cell is
   * below the goal. A rotary grid's `h` is a radius, not a Z, so it answers null there; an
   * exact-engine sweep has no grid.
   */
  const sweptTop = (): ResultTop | null => {
    const l = live;
    if (l === null || l.kind !== 'column') return null;
    const g = l.column.grid;
    if (g.kind !== 'flat') return null;
    return (x, y) => {
      const fi = (x - g.u0) / g.du;
      const fj = (y - g.v0) / g.dv;
      const i0 = Math.floor(fi);
      const j0 = Math.floor(fj);
      if (i0 < 0 || j0 < 0 || i0 + 1 >= g.nu || j0 + 1 >= g.nv) return null;
      const at = (i: number, j: number): number => g.h[j * g.nu + i]!;
      return Math.max(at(i0, j0), at(i0 + 1, j0), at(i0, j0 + 1), at(i0 + 1, j0 + 1));
    };
  };

  /**
   * #948 — the page's own swept-top read, built once per load and cached: `goal_check.py` stamps
   * the cutter along the posted program at each goal cell's centre, and the app must answer the
   * same question the same way for leftover/coverage. The conservative `sweptTop` stays the
   * cut-into judge.
   */
  let exactFor: object | null = null;
  let exactKey = '';
  let exactValue: Float32Array | null = null;
  const sweptFieldExact = (goal: { nx: number; ny: number; x0: number; y0: number; pitch: number }): Float32Array | null => {
    const l = live;
    if (l === null || l.kind !== 'column' || l.column.grid.kind !== 'flat') return null;
    const key = `${goal.nx},${goal.ny},${goal.x0},${goal.y0},${goal.pitch}`;
    if (exactFor === l && exactKey === key) return exactValue;
    const stamp = exactSweptField(goal, l.timeline, l.tool);
    exactValue = stamp;
    if (stamp !== null) {
      // #948 — FOLD EACH PROGRAM'S STAMP INTO THE RUN'S ONE FIELD (the page's rule). A run's last
      // program alone (a ⌀0.5 rest pass) reads only its own moves; the fold makes the report carry
      // what every program of the run left, exactly as `goal_check.py` stamps them all onto one H.
      if (exactRun !== null && exactRun.key === key) {
        const acc = exactRun.field;
        for (let k = 0; k < acc.length; k++) {
          if (stamp[k]! < acc[k]!) acc[k] = stamp[k]!;
        }
        exactValue = acc;
      } else {
        exactRun = { key, field: stamp };
      }
    }
    exactFor = l;
    exactKey = key;
    return exactValue;
  };

  const stateAt = (step: number): MachineState | null => (live ? live.timeline.stateAt(Math.trunc(step)) : null);

  /**
   * The work-frame Z the viewport draws (#634): the loaded program's, with the fitted lift taken
   * back out. The material is the surface-frame image the sweep un-lifted (`surfaceTimeline`), so
   * the path the tool tip traces must be the same frame — otherwise the tip floats the tilt above
   * the floor it cut. A flat post (`surfaceFrame` null) passes every Z through unchanged.
   */
  const unliftZ = (x: number, y: number, z: number): number =>
    surfaceFrame === null ? z : z - surfaceLift(surfaceFrame.plane, surfaceFrame.z0, x, y);

  const toolPath = (fromStep: number, toStep: number): Float32Array => {
    const l = live;
    if (!l || l.timeline.events.length === 0) return new Float32Array(0);
    const last = l.timeline.events.length - 1;
    const from = Math.max(0, Math.min(last, Math.trunc(fromStep)));
    const to = Math.max(from, Math.min(last, Math.trunc(toStep)));
    const pts: number[] = [];
    let s = l.timeline.stateAt(from);
    const store = eventStoreOf(l.timeline.events);
    for (let i = from; i <= to; i++) {
      if (i > from) s = applyEvent(s, (store !== null ? store.at(i) : l.timeline.events[i]) as Parameters<typeof applyEvent>[1], l.setup);
      const [x, y, z] = s.work;
      if (x !== null && y !== null && z !== null) pts.push(x, y, unliftZ(x, y, z));
    }
    return Float32Array.from(pts);
  };

  /**
   * One pass over `timeline.events`, building the path the viewport draws (#197). A vertex is
   * emitted for each MoveEvent whose position is FULLY known after it; its kind is the move that
   * ended there, and its `t` is the running time.
   *
   * Times (#197, #281): every move over a fully-known span is timed through the trapezoid on the
   * machine's rapid model — a feed at its own `feed` (mm/min), a rapid at `rapidRate` — using
   * `moveSeconds`, the same trapezoid the cycle estimate is built from. PER MOVE here, where the
   * estimate charges one trapezoid per contiguous feed run: the drawn clock is what the axes do
   * arriving at each vertex, the estimate is what a run costs once the planner carries speed
   * through the junctions between those vertices, and on a pocket cut in short chords that makes
   * this clock the longer of the two — playback, not a prediction (the run sheet's estimate is).
   *
   * Only moves are timed: a loaded program's `dwell` moves no axis and carries no time this clock
   * can read, so it adds nothing to `t` and the drawn clock is short by its holds. A move whose
   * start or end is unknown, or a feed with no known feed value, takes 0 s — the first rapid of a
   * program starts from an unknown
   * position and so contributes nothing to the clock. With NO machine loaded there is no rapid
   * model, so rapids take 0 s and `rapidsTimed` is false: the clock is feeds only, and the
   * transport says so rather than reading as a total (#367).
   */
  const simPath = (): SimPath => {
    const empty = (): SimPath => ({
      xyz: new Float32Array(0),
      step: new Uint32Array(0),
      kind: new Uint8Array(0),
      t: new Float32Array(0),
      line: new Uint32Array(0),
      rapidsTimed: rapid !== null,
    });
    const l = live;
    if (!l || l.timeline.events.length === 0) return empty();
    const events = l.timeline.events;
    // #899 — read the packed events directly, and write the vertices into typed arrays: a 2M-line
    // program's path held as eight number arrays was another 130 MB before the copy.
    const store = eventStoreOf(events);
    const xyz = new GrowF64(3);
    const step = new GrowF64(1);
    const kind = new GrowF64(1);
    const t = new GrowF64(1);
    const line = new GrowF64(1);
    const a = new GrowF64(1);
    let anyA = false;
    let cum = 0;
    let s = l.timeline.stateAt(-1); // the state before step 0
    for (let i = 0; i < events.length; i++) {
      const ev = (store !== null ? store.at(i) : events[i]) as Parameters<typeof applyEvent>[1];
      const from = s.work;
      s = applyEvent(s, ev, l.setup);
      if (ev.kind !== 'move') continue;
      const [x, y, z] = s.work;
      if (x === null || y === null || z === null) continue; // position not fully known: no vertex
      let dt = 0;
      const [fx, fy, fz] = from;
      if (fx !== null && fy !== null && fz !== null) {
        const dist = Math.hypot(x - fx, y - fy, z - fz);
        if (rapid === null) {
          // No machine: rapids are untimed (0 s) and feeds fall back to the closed-form `d/f` — with
          // no acceleration to apply, dressing a feeds-only figure as a total would be worse than
          // saying so. Telling the truth about what this clock contains is the point (#367).
          if (ev.mode !== 'rapid' && ev.feed !== null) dt = (dist / ev.feed) * 60;
        } else if (ev.mode === 'rapid') {
          dt = moveSeconds(dist, rapidRate(rapid, x - fx, y - fy, z - fz), rapid.accelMmPerS2);
        } else if (ev.feed !== null) {
          dt = moveSeconds(dist, ev.feed, rapid.accelMmPerS2);
        }
        // else: a feed with no known feed value takes 0 s.
      }
      cum += dt;
      xyz.push(x, y, unliftZ(x, y, z));
      step.push(i);
      t.push(cum);
      kind.push(ev.mode === 'rapid' ? 0 : s.spindle === 'off' ? 2 : 1);
      line.push(ev.line);
      // #716 slice 2 — the machine's A at this vertex, NaN until the program states one.
      if (s.a !== null) anyA = true;
      a.push(s.a ?? Number.NaN);
    }
    return {
      xyz: Float32Array.from(xyz.done()),
      step: Uint32Array.from(step.done()),
      kind: Uint8Array.from(kind.done()),
      t: Float32Array.from(t.done()),
      line: Uint32Array.from(line.done()),
      ...(anyA ? { a: a.done().slice() } : {}),
      rapidsTimed: rapid !== null,
    };
  };

  return {
    load,
    warmup,
    frameAt,
    stateAt,
    toolPath,
    simPath,
    oracle,
    levelCut,
    sweptTop,
    sweptFieldExact,
    dispose,
    get loaded() {
      return live !== null;
    },
  };
}

