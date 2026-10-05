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

import { applyEvent, buildTimeline, parseGcode, MACHINES, type FixtureEnvelope, type MachineState, type PausePoint, type Segment, type Setup, type Timeline } from '@/engine/cnc';
import { ASSUMED_RAPID_MM_MIN } from '@/engine/cnc/cam/ir';

import type { Mm } from '@/types/units';
import type { Tool } from '@/engine/cnc/tool';
import { computeOracle, oracleBand, type OraclePredicted, type OracleReport } from '@/engine/cnc/engrave/oracle';
import type { ManifoldToplevel } from '../geometry/evaluateOp';
import { meshOutputOf, type NodeMeshOutput } from '../geometry/meshOutput';
import { createPlayback, type Playback } from '../geometry/playback';
import { boxSolid, sweepTimeline, type SweepDiagnostic, type SweepResult, type SweepStats } from '../geometry/sweep';
import { columnSweep, type ColumnSweepOk } from '../geometry/columnEngine';

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
 * The seek rate a RAPID is DRAWN at, mm/min (#197), AND the rate the cycle estimate assumes
 * (#242). Both are now the ONE named constant `ASSUMED_RAPID_MM_MIN`, so the drawn timeline and
 * the run sheet's estimate cannot drift apart. It stays an ASSUMPTION, never a claim about the
 * controller's real seek rate (#208 D3 calibrates it).
 */
export const DISPLAY_RAPID_MM_MIN = ASSUMED_RAPID_MM_MIN;

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
   * Throws when no SWEPT program is loaded (a path-only refusal owns no removal) — the caller
   * only reaches this after a load that reported `ok`.
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

export function createSimSession(tl: ManifoldToplevel, hooks?: SimSessionHooks): SimSession {
  let live: Live | null = null;
  let latestGen = Number.NEGATIVE_INFINITY;

  const dispose = (): void => {
    const l = live;
    live = null;
    if (!l) return;
    if (l.kind === 'path' || l.kind === 'column') return; // owns no wasm handle at all
    // Playback first: its anchors and cached unions are built over the sweep's solids.
    l.playback.dispose();
    hooks?.onDispose?.('playback');
    disposeSweep(l.sweep);
    hooks?.onDispose?.('sweep');
  };

  const load = (gcodeText: string, setup: Setup, tool: Tool, machineId: string | null, opts?: SimLoadOpts): SimLoadResult => {
    dispose();
    let machine;
    if (machineId !== null) {
      machine = MACHINES[machineId];
      if (!machine) return refuse('machine-unknown', `unknown machine "${machineId}"; known: ${Object.keys(MACHINES).join(', ')}`);
    }
    const parse = parseGcode(gcodeText);
    const timeline = buildTimeline(parse, setup, machine);
    const diagnostics: SimDiagnostic[] = [
      ...parse.diagnostics.map((d): SimDiagnostic => ({ source: 'parser', severity: d.severity, code: d.code, message: d.message, line: d.line })),
      ...timeline.diagnostics.map((d): SimDiagnostic => ({ source: 'runner', severity: d.severity, code: d.code, message: d.message, line: d.line, step: d.step })),
    ];
    // A rotary job is swept by the COLUMN engine (#239, `/Rotary.md` §4.1), never the exact
    // 2.5D sweeper: the exact one refuses it by name and its `MAX_CHECKPOINTS` gate would refuse
    // the vendor files as dense 3D anyway. Routing here also means the dense-3D classifier never
    // applies to a rotary job, whose checkpoint count is expected to exceed it.
    if (timeline.summary.rotary) {
      const col = columnSweep(timeline, tool, setup, opts);
      if (!col.ok) {
        // Same contract as a refused exact sweep (#194): keep the runner's work, draw the path,
        // show no material. A rotary refusal owns no wasm handle.
        live = { kind: 'path', timeline, setup };
        return {
          ok: false,
          pathOnly: true,
          diagnostics: [...diagnostics, ...col.diagnostics.map(tagSweep)],
          summary: timeline.summary,
          pauses: timeline.pauses,
          segments: timeline.segments,
        };
      }
      const fixture: SimFixtureMesh[] = [];
      for (const box of setup.fixture?.boxes ?? []) {
        const solid = boxSolid(tl, box);
        fixture.push({ id: box.id, label: box.label, mesh: meshOutputOf(solid) });
        solid.delete();
      }
      diagnostics.push(...col.diagnostics.map(tagSweep));
      live = { kind: 'column', column: col, timeline, setup };
      return {
        ok: true,
        diagnostics,
        summary: timeline.summary,
        stats: col.stats,
        stockTopZ: col.stockTopZ,
        radius: col.radius,
        count: col.count,
        checkpoints: timeline.checkpoints.map((cp): CheckpointInfo => ({
          segment: cp.segment,
          z: cp.z,
          run: cp.run,
          firstStep: cp.steps[0] as number,
          lastStep: cp.steps[cp.steps.length - 1] as number,
          moveCount: cp.steps.length,
          nonConstantZ: cp.nonConstantZ,
        })),
        pauses: timeline.pauses,
        segments: timeline.segments,
        // No removal ghost and no gouge solids from the column engine yet: the grid IS the
        // material, so `frameAt` regenerates the stock surface instead (§4.4). A gouge is still
        // reported as a diagnostic; only its drawn solid is pending.
        meshes: { stock: col.stock, result: col.result, removal: null, sacrificial: null, gouges: [], fixture },
        ...(setup.fixture ? { fixtureSource: setup.fixture.source, fixtureUncertainty: setup.fixture.uncertainty } : {}),
      };
    }
    const out = sweepTimeline(tl, timeline, tool, setup, machine ? { ...opts, machine } : opts);
    if (!out.ok) {
      // The runner's work is cheap and worth keeping on its own: a refused sweep still yields
      // the path, the pauses and the segments, so the viewport can draw the path with no
      // material. This session owns no wasm handle (#194).
      live = { kind: 'path', timeline, setup };
      return {
        ok: false,
        pathOnly: true,
        diagnostics: [...diagnostics, ...out.diagnostics.map(tagSweep)],
        summary: timeline.summary,
        pauses: timeline.pauses,
        segments: timeline.segments,
      };
    }
    const sweep = out.value;
    let playback: Playback | null = null;
    try {
      playback = createPlayback(tl, timeline, sweep);
      // The fixture, drawn where the user SAID the jaws are (#204): the un-inflated boxes, so
      // the picture is not the grown box the checks use. Built from the same `boxSolid` the
      // sweep checks against, so the shown solid and the tested one can never disagree.
      const fixture: SimFixtureMesh[] = [];
      for (const box of setup.fixture?.boxes ?? []) {
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
      live = { kind: 'swept', sweep, playback, timeline, setup };
      return {
        ok: true,
        diagnostics,
        summary: timeline.summary,
        stats: sweep.stats,
        stockTopZ: sweep.stockTopZ,
        radius: sweep.radius,
        count: playback.count,
        checkpoints: timeline.checkpoints.map((cp): CheckpointInfo => ({
          segment: cp.segment,
          z: cp.z,
          run: cp.run,
          firstStep: cp.steps[0] as number,
          lastStep: cp.steps[cp.steps.length - 1] as number,
          moveCount: cp.steps.length,
          nonConstantZ: cp.nonConstantZ,
        })),
        pauses: timeline.pauses,
        segments: timeline.segments,
        meshes,
        ...(setup.fixture ? { fixtureSource: setup.fixture.source, fixtureUncertainty: setup.fixture.uncertainty } : {}),
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
   */
  const oracle = (predicted: readonly OraclePredicted[]): OracleReport => {
    const l = live;
    if (!l || l.kind !== 'swept') throw new Error('oracle: no swept program is loaded');
    const removal = l.sweep.removal;
    if (!removal) throw new Error('oracle: the loaded program removed no material');
    const contours = l.timeline.checkpoints.reduce((a, cp) => Math.max(a, cp.steps.length * 3), 0);
    return computeOracle(tl, removal, predicted, oracleBand(contours));
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
   * Times (the issue's rule): a move over a fully-known span takes `distance / feed × 60` s using
   * the move's own `feed` (mm/min) for a feed, and `DISPLAY_RAPID_MM_MIN` for a rapid. A move
   * whose start or end is unknown, or a feed with no known feed value, takes 0 s — the first
   * rapid of a program starts from an unknown position and so contributes nothing to the clock.
   */
  const simPath = (): SimPath => {
    const empty = (): SimPath => ({
      xyz: new Float32Array(0),
      step: new Uint32Array(0),
      kind: new Uint8Array(0),
      t: new Float32Array(0),
      line: new Uint32Array(0),
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
        if (ev.mode === 'rapid') dt = (dist / DISPLAY_RAPID_MM_MIN) * 60;
        else if (ev.feed !== null) dt = (dist / ev.feed) * 60;
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
    };
  };

  return { load, warmup, frameAt, stateAt, toolPath, simPath, oracle, dispose, get loaded() { return live !== null; } };
}

