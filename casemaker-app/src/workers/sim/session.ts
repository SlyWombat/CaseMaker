/**
 * The simulation session (#182 step 8b, `/Simulation.md` §8.0): load a program, show the stock
 * at any checkpoint, dispose. Headless — it knows nothing about workers or the UI, so it runs
 * (and is tested) in plain Node; `sim.worker.ts` is a thin Comlink shell over it.
 *
 *   load(gcode, setup, tool, machineId)  -> diagnostics, summary, stats, plain checkpoint /
 *                                          pause / segment lists, and the stock, result,
 *                                          removal and gouge MESHES
 *   frameAt(k, gen)                      -> { stock, removalSoFar } meshes, or null if stale
 *   stateAt(step), toolPath(from, to)    -> on demand; per-step state is never shipped whole
 *   dispose()
 *
 * OWNERSHIP, exactly. One session holds at most one loaded program. `load` disposes any
 * existing one first, and a REFUSED load leaves none. The session owns the `SweepResult`
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

import { applyEvent, buildTimeline, parseGcode, MACHINES, type MachineState, type PausePoint, type Segment, type Setup, type Timeline } from '@/engine/cnc';

import type { Tool } from '@/engine/cnc/tool';
import type { ManifoldToplevel } from '../geometry/evaluateOp';
import { meshOutputOf, type NodeMeshOutput } from '../geometry/meshOutput';
import { createPlayback, type Playback } from '../geometry/playback';
import { sweepTimeline, type SweepDiagnostic, type SweepResult, type SweepStats } from '../geometry/sweep';

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
  meshes: { stock: NodeMeshOutput; result: NodeMeshOutput; removal: NodeMeshOutput | null; gouges: SimGougeMesh[] };
}

export interface SimLoadRefused {
  ok: false;
  diagnostics: SimDiagnostic[];
}

export type SimLoadResult = SimLoadOk | SimLoadRefused;

export interface SimFrame {
  k: number;
  stock: NodeMeshOutput;
  /** Everything cut up to and including checkpoint k; null when nothing has been. */
  removalSoFar: NodeMeshOutput | null;
}

interface Live {
  sweep: SweepResult;
  playback: Playback;
  timeline: Timeline;
  setup: Setup;
}

export interface SimSession {
  load(gcodeText: string, setup: Setup, tool: Tool, machineId: string | null): SimLoadResult;
  /** `null` when `gen` is older than one already seen, or when nothing is loaded. */
  frameAt(k: number, gen: number): SimFrame | null;
  stateAt(step: number): MachineState | null;
  /** Work-frame [x, y, z, …] of the tool after each step in [from, to] whose position is fully known. */
  toolPath(fromStep: number, toStep: number): Float32Array;
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
  sweep.result.delete();
  sweep.removal?.delete();
  for (const s of sweep.perCheckpoint) s?.delete();
  for (const g of sweep.gouges) g.solid.delete();
}

const refuse = (code: string, message: string): SimLoadRefused => ({ ok: false, diagnostics: [{ source: 'sweep', severity: 'error', code, message }] });

const tagSweep = (d: SweepDiagnostic): SimDiagnostic => ({ source: 'sweep', severity: d.severity, code: d.code, message: d.message, ...(d.checkpoint !== undefined ? { checkpoint: d.checkpoint } : {}) });

export function createSimSession(tl: ManifoldToplevel, hooks?: SimSessionHooks): SimSession {
  let live: Live | null = null;
  let latestGen = Number.NEGATIVE_INFINITY;

  const dispose = (): void => {
    const l = live;
    live = null;
    if (!l) return;
    // Playback first: its anchors and cached unions are built over the sweep's solids.
    l.playback.dispose();
    hooks?.onDispose?.('playback');
    disposeSweep(l.sweep);
    hooks?.onDispose?.('sweep');
  };

  const load = (gcodeText: string, setup: Setup, tool: Tool, machineId: string | null): SimLoadResult => {
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
    const out = sweepTimeline(tl, timeline, tool, setup);
    if (!out.ok) return { ok: false, diagnostics: [...diagnostics, ...out.diagnostics.map(tagSweep)] };
    const sweep = out.value;
    let playback: Playback | null = null;
    try {
      playback = createPlayback(tl, timeline, sweep);
      const meshes = {
        stock: meshOutputOf(sweep.stock),
        result: meshOutputOf(sweep.result),
        removal: sweep.removal ? meshOutputOf(sweep.removal) : null,
        gouges: sweep.gouges.map((g): SimGougeMesh => ({ step: g.step, line: g.line, mesh: meshOutputOf(g.solid) })),
      };
      diagnostics.push(...sweep.diagnostics.map(tagSweep));
      live = { sweep, playback, timeline, setup };
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

  const frameAt = (k: number, gen: number): SimFrame | null => {
    if (gen < latestGen) return null;
    latestGen = gen;
    const l = live;
    if (!l) return null;
    if (!Number.isFinite(k)) throw new RangeError(`checkpoint index must be a finite number, got ${k}`);
    const kk = Math.max(-1, Math.min(l.playback.count - 1, Math.trunc(k)));
    // Both handles are the playback's and evictable: mesh them here, keep neither.
    const stock = meshOutputOf(l.playback.stockAt(kk));
    const removal = l.playback.removalAt(kk);
    return { k: kk, stock, removalSoFar: removal ? meshOutputOf(removal) : null };
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

  return { load, frameAt, stateAt, toolPath, dispose, get loaded() { return live !== null; } };
}

