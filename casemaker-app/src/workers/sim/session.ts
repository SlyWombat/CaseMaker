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

import { applyEvent, buildTimeline, parseGcode, resolveMachine, MACHINES, type FixtureEnvelope, type MachineCalibration, type MachineState, type PausePoint, type Segment, type Setup, type Timeline } from '@/engine/cnc';
import { moveSeconds, rapidRate, type RapidEstimate } from '@/engine/cnc/cam/ir';

import type { Mm } from '@/types/units';
import { cuttingRadiusForSweep, type Tool } from '@/engine/cnc/tool';
import { isVShape } from '@/engine/cnc/vProfile';
import {
  columnOracleBand,
  computeOracle,
  gridSliceAt,
  oracleBand,
  removalSliceAt,
  type OraclePredicted,
  type OracleReport,
} from '@/engine/cnc/engrave/oracle';
import type { SurfaceFrame } from '@/engine/cnc/engrave/surfacePlane';
import type { ManifoldToplevel } from '../geometry/evaluateOp';
import { meshOutputOf, type NodeMeshOutput } from '../geometry/meshOutput';
import { createPlayback, type Playback } from '../geometry/playback';
import { boxSolid, isDenseForExactSweep, sweepTimeline, unliftTimeline, type SweepDiagnostic, type SweepResult, type SweepStats } from '../geometry/sweep';
import { columnSweep, type ColumnSweepOk, type DrillPointDefault } from '../geometry/columnEngine';
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
   * Where the fixture's dimensions came from (#204), present only when the setup models one.
   * A default is NOT a measurement; the viewport shows this so the shown jaws are not read as
   * exact. Optional so a setup with no `fixture` does not grow the load info's shape.
   */
  fixtureSource?: FixtureEnvelope['source'];
  /** Every box was grown by this much before any check (#203, decision 28), mm. */
  fixtureUncertainty?: Mm;
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
}

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
 * refusal is never reached from here — the timeline's `rotary` flag routes the load.
 */
interface LiveColumn {
  kind: 'column';
  column: ColumnSweepOk;
  timeline: Timeline;
  setup: Setup;
}
type Live = LiveSwept | LivePath | LiveColumn;

/** What `load` will accept on top of its arguments (#194). */
export interface SimLoadOpts {
  /** Wall clock for the sweep itself; the client's timer is the hard stop. */
  budgetMs?: number;
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
   * The material a PREVIOUS program left, as the removal mesh its own sweep produced (#410, the
   * rest pass). This program is then swept starting from that part rather than from the blank —
   * see `SweepOpts.priorRemoval`, which is where the subtraction happens. The EXACT sweeper
   * takes it; a rotary job or a V-bit (the column engine) is REFUSED with `prior-removal-column`
   * rather than swept without it, because a rest pass simulated against the wrong stock is a
   * picture of a cut that will not happen.
   */
  priorRemoval?: NodeMeshOutput;
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
 * A REST PASS is NOT re-routed: the column engine cannot start from a previous program's material
 * (it would answer `prior-removal-column`), so a dense flat rest pass keeps its existing exact-sweep
 * `dense-3d-refused` refusal rather than trading it for a different one. This is routing only: the
 * dexel engine and its geometry are untouched.
 */
export function denseFlatRoutesToColumn(timeline: Timeline, tool: Tool, opts?: SimLoadOpts): boolean {
  return isDenseForExactSweep(timeline) && !opts?.priorRemoval && cuttingRadiusForSweep(tool).ok;
}

export interface SimSession {
  load(gcodeText: string, setup: Setup, tool: Tool, machineId: string | null, opts?: SimLoadOpts): SimLoadResult;
  /**
   * Build the playback anchor chain now (#224), off the scrub path. Called by the worker once
   * the client has the load result, so the first real seek does not pay for it. No-op on a
   * path-only or empty session.
   */
  warmup(): void;
  /** `null` when `gen` is older than one already seen, or when nothing is loaded. */
  frameAt(k: number, gen: number): SimFrame | null;
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
   * Throws when nothing SWEPT is loaded — a path-only refusal owns no removal at all — and for a
   * ROTARY column live, whose grid's second axis is the stock angle rather than the work frame's Y,
   * so no 2D region can be read off it. A FLAT column live is judged off its grid (#408), which is
   * what lets a V-bit trace reach this at all: the cone's removal has no solid to slice either, and
   * its prediction is a groove rather than one region per item. The caller only reaches this after
   * a load that reported `ok`.
   *
   * #623 — judged in the frame the LOAD was given: a `surface` load reads the sweep with the fitted
   * lift subtracted at each XY and stamps `frame: 'surface'` on the report, so a program posted
   * against a tilted blank is compared with the flat prediction that blank's design is.
   */
  oracle(predicted: readonly OraclePredicted[]): OracleReport;
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

const tagSweep = (d: SweepDiagnostic): SimDiagnostic => ({ source: 'sweep', severity: d.severity, code: d.code, message: d.message, ...(d.checkpoint !== undefined ? { checkpoint: d.checkpoint } : {}) });

/**
 * The worst checkpoint's 2D contour count, as a triangle count — the number the sweep's own
 * simplify budget is derived from (`sweepTimeline`), and so the number the oracle's band must use
 * to agree with it. One definition, because the oracle now reads it on two engines' paths.
 */
const worstContours = (timeline: Timeline): number => timeline.checkpoints.reduce((a, cp) => Math.max(a, cp.steps.length * 3), 0);

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
   * #623 — the fitted surface the LOADED program was posted against, or null for a flat post. It is
   * the frame the sweep was seated in and the frame `oracle` must judge in; set by `load`, cleared
   * by `dispose`, and never read by anything that does not own both halves.
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
    let machine;
    if (machineId !== null) {
      const base = MACHINES[machineId];
      if (!base) return refuse('machine-unknown', `unknown machine "${machineId}"; known: ${Object.keys(MACHINES).join(', ')}`);
      // The saved read of THIS machine's frame, if there is one (#279). The lookup above is by
      // the CALLER's id, so an unknown id still refuses by name rather than falling back to a
      // profile with the machine's calibration quietly laid over it.
      machine = resolveMachine(base, opts?.calibration);
      rapid = machine.rapidEstimate;
    }
    const parse = parseGcode(gcodeText);
    // The LIFTED timeline (the file as posted) and, when the package speaks the surface frame, its
    // surface-frame image: the same program with the lift taken back out, re-bucketed — the flat
    // program a flat post would have produced. The SWEEP takes the image; the viewport draws the
    // file (the timelines share their events).
    const timeline = buildTimeline(parse, setupArg, machine);
    const surfaceTimeline = surface === null ? timeline : unliftTimeline(timeline, surface);
    const diagnostics: SimDiagnostic[] = [
      ...parse.diagnostics.map((d): SimDiagnostic => ({ source: 'parser', severity: d.severity, code: d.code, message: d.message, line: d.line })),
      ...timeline.diagnostics.map((d): SimDiagnostic => ({ source: 'runner', severity: d.severity, code: d.code, message: d.message, line: d.line, step: d.step })),
    ];
    // A rotary job is swept by the COLUMN engine (#239, `/Rotary.md` §4.1), never the exact
    // 2.5D sweeper: the exact one refuses it by name and its `MAX_CHECKPOINTS` gate would refuse
    // the vendor files as dense 3D anyway. Routing here also means the dense-3D classifier never
    // applies to a rotary job, whose checkpoint count is expected to exceed it.
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
    if (timeline.summary.rotary || sweepsOnColumn(tool) || denseFlatRoutesToColumn(surfaceTimeline, tool, opts)) {
      // A rest pass is measured against the material a previous program left, and only the exact
      // sweeper can start from it. Silently sweeping the blank instead would draw a cut nobody is
      // going to make, so the pair is refused by name (#410).
      if (opts?.priorRemoval) {
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
      const col = columnSweep(surfaceTimeline, tool, setupArg, opts);
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
      live = { kind: 'column', column: col, timeline: surfaceTimeline, setup: setupArg };
      return {
        ok: true,
        diagnostics,
        summary: surfaceTimeline.summary,
        stats: col.stats,
        stockTopZ: col.stockTopZ,
        radius: col.radius,
        axisClamped: col.axisClamped,
        count: col.count,
        checkpoints: surfaceTimeline.checkpoints.map((cp): CheckpointInfo => ({
          segment: cp.segment,
          z: cp.z,
          run: cp.run,
          firstStep: cp.steps[0] as number,
          lastStep: cp.steps[cp.steps.length - 1] as number,
          moveCount: cp.steps.length,
          nonConstantZ: cp.nonConstantZ,
        })),
        pauses: surfaceTimeline.pauses,
        segments: surfaceTimeline.segments,
        // No removal ghost and no gouge solids from the column engine yet: the grid IS the
        // material, so `frameAt` regenerates the stock surface instead (§4.4). A gouge is still
        // reported as a diagnostic; only its drawn solid is pending.
        meshes: { stock: col.stock, result: col.result, removal: null, sacrificial: null, gouges: [], fixture },
        ...(setupArg.fixture ? { fixtureSource: setupArg.fixture.source, fixtureUncertainty: setupArg.fixture.uncertainty } : {}),
      };
    }
    // The EXACT 2.5D sweep: the surface-frame (un-lifted) program on the un-seated stock — the flat
    // program the job really is, so the removal and the oracle's band are the flat post's own.
    const out = sweepTimeline(tl, surfaceTimeline, tool, setupArg, machine ? { ...opts, machine } : opts);
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
        checkpoints: surfaceTimeline.checkpoints.map((cp): CheckpointInfo => ({
          segment: cp.segment,
          z: cp.z,
          run: cp.run,
          firstStep: cp.steps[0] as number,
          lastStep: cp.steps[cp.steps.length - 1] as number,
          moveCount: cp.steps.length,
          nonConstantZ: cp.nonConstantZ,
        })),
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

  const frameAt = (k: number, gen: number): SimFrame | null => {
    if (gen < latestGen) return null;
    latestGen = gen;
    const l = live;
    if (!l || l.kind === 'path') return null;
    if (!Number.isFinite(k)) throw new RangeError(`checkpoint index must be a finite number, got ${k}`);
    if (l.kind === 'column') {
      // The column engine regenerates the surface straight from the grid — no booleans, no
      // removal ghost (#239, `/Rotary.md` §4.4). Both are null by construction.
      const kc = Math.max(-1, Math.min(l.column.count - 1, Math.trunc(k)));
      return { k: kc, stock: l.column.meshAt(kc), removalSoFar: null, sacrificial: null };
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
    return { k: kk, stock, removalSoFar: removal ? meshOutputOf(removal) : null, sacrificial };
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
   * A ROTARY column is still refused, and for a reason no band can answer: its second grid axis is
   * the stock ANGLE, so its cells are not a picture of the work frame's XY. A 2D region cannot be
   * read off it at all — the comparison would be between a grid over (X, θ) and polygons over
   * (X, Y). The refusal names the axis rather than claiming nothing can be done, which was the old
   * message's overreach: a FLAT column sweep can be compared, and now is.
   */
  const oracle = (predicted: readonly OraclePredicted[]): OracleReport => {
    // #623 — the frame the loaded program speaks. A flat post is judged exactly as it always was;
    // a surface post is read with its lift taken back out at each XY, which is the only way a
    // correct tilt-following file can match the flat prediction (and the flat post's mismatch).
    const surface = surfaceFrame;
    const l = live;
    if (l && l.kind === 'column') {
      const grid = l.column.grid;
      if (grid.kind !== 'flat') {
        throw new Error(
          'oracle: this is a ROTARY column sweep, whose grid runs over (X, θ): a 2D region in the work frame cannot be read off it, so the CAM\'s predicted regions cannot be compared with the material it left',
        );
      }
      const report = computeOracle(tl, gridSliceAt(tl, grid), predicted, columnOracleBand(worstContours(l.timeline), grid), grid);
      return { ...report, frame: surface === null ? 'work' : 'surface' };
    }
    if (!l || l.kind !== 'swept') throw new Error('oracle: no swept program is loaded');
    const removal = l.sweep.removal;
    if (!removal) throw new Error('oracle: the loaded program removed no material');
    // #625 — the exact engine swept the SURFACE-FRAME image of the program (the load un-lifted every
    // FEED by the lift at its XY), so the removal is already the flat program's own, in the work
    // frame: compare it directly. `frame` still says `'surface'` when the program was posted against
    // a fitted plane, because that is the frame the numbers speak — which, for the flat program the
    // un-lift recovers, coincides with the work frame. No shear: the removal is never tilted.
    return { ...computeOracle(tl, removalSliceAt(removal), predicted, oracleBand(worstContours(l.timeline))), frame: surface === null ? 'work' : 'surface' };
  };

  const stateAt = (step: number): MachineState | null => (live ? live.timeline.stateAt(Math.trunc(step)) : null);

  const toolPath = (fromStep: number, toStep: number): Float32Array => {
    const l = live;
    if (!l || l.timeline.events.length === 0) return new Float32Array(0);
    const last = l.timeline.events.length - 1;
    const from = Math.max(0, Math.min(last, Math.trunc(fromStep)));
    const to = Math.max(from, Math.min(last, Math.trunc(toStep)));
    const pts: number[] = [];
    let s = l.timeline.stateAt(from);
    for (let i = from; i <= to; i++) {
      if (i > from) s = applyEvent(s, l.timeline.events[i] as Parameters<typeof applyEvent>[1], l.setup);
      const [x, y, z] = s.work;
      if (x !== null && y !== null && z !== null) pts.push(x, y, z);
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
    const xyz: number[] = [];
    const step: number[] = [];
    const kind: number[] = [];
    const t: number[] = [];
    const line: number[] = [];
    let cum = 0;
    let s = l.timeline.stateAt(-1); // the state before step 0
    for (let i = 0; i < events.length; i++) {
      const ev = events[i] as Parameters<typeof applyEvent>[1];
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
      xyz.push(x, y, z);
      step.push(i);
      t.push(cum);
      kind.push(ev.mode === 'rapid' ? 0 : s.spindle === 'off' ? 2 : 1);
      line.push(ev.line);
    }
    return {
      xyz: Float32Array.from(xyz),
      step: Uint32Array.from(step),
      kind: Uint8Array.from(kind),
      t: Float32Array.from(t),
      line: Uint32Array.from(line),
      rapidsTimed: rapid !== null,
    };
  };

  return { load, warmup, frameAt, stateAt, toolPath, simPath, oracle, dispose, get loaded() { return live !== null; } };
}

