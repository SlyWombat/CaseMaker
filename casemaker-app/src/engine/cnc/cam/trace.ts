/**
 * Traces → toolpath IR (#219).
 *
 * A trace is a polyline the cutter's CENTRE follows, so unlike `generateEngrave` there is no
 * region to open, no offset and no pocketing: the moves ARE the path, plunged to each depth pass.
 * That is the whole point — a single-stroke font's strokes are one cutter wide, so the cut line
 * is the artwork, and offsetting it (in or out) would widen the groove and close up the letters.
 *
 * Consequently this module needs NO `ManifoldToplevel`, and takes no `tl`: nothing here evaluates
 * geometry, so a trace toolpath is a pure function of the paths and the feeds — which is also why
 * it can be tested without the wasm harness. The tool is still validated with
 * `cuttingRadiusForSweep` (the same contract as `generateEngrave`) so a V-bit — whose cutting
 * width depends on depth and so cannot satisfy the "one cutter wide" promise — is refused; for a
 * flat end mill the radius is otherwise unused, because nothing is ever offset.
 *
 * CONVENTIONAL vs CLIMB is meaningless here: the cutter is on the line, and it cuts both walls of
 * the groove in one pass, so there is no "inside" to walk. `MILLING` (`engraveJob.ts`) applies to
 * region pockets only.
 *
 * The IR contract is `generateEngrave`'s: positive `depth` in, negative Z out, fully-resolved
 * moves, `[T#]<name> <depth>mm` operation names. Operations are numbered from 1 so this module is
 * usable alone; the worker (`engraveGenerate`) runs both and merges the two lists into one
 * program, renumbering as it goes.
 */

import type { Mm } from '@/types/units';
import type { CutParams } from '../feeds';
import { cuttingRadiusForSweep, type Tool } from '../tool';
import { zPasses } from './engraveJob';
import {
  estimateCycleSeconds,
  HOP_Z,
  SAFE_Z,
  type CamMove,
  type CamOperation,
  type ToolpathIR,
} from './ir';

/**
 * One trace's cut paths, in the STOCK frame — the CAM's view of a `PartPlan.traces` entry. Kept a
 * local interface (like `EngraveRegion`) so this layer never imports the document or the plan.
 */
export interface TracePaths {
  id: string;
  /** Ready-made operation descriptor, without the `[T#]` prefix or the depth suffix. */
  name?: string;
  /** One polyline per path; a line item has one, a stroke label one per pen stroke. */
  paths: [Mm, Mm][][];
  /** Whether `paths[i]` returns to its first point. */
  closed: boolean[];
  /** Positive mm. */
  depth: Mm;
}

/** The point a trace is "reached" at for ordering: the first point of its first non-empty path. */
function firstTracePoint(trace: TracePaths): [number, number] {
  for (const path of trace.paths) if (path.length > 0) return [path[0]![0], path[0]![1]];
  return [0, 0];
}

/** Does this trace have any path worth cutting (at least one point)? */
function hasCuts(trace: TracePaths): boolean {
  return trace.paths.some((path) => path.length > 0);
}

/** Greedy nearest-neighbour from (0, 0) on each trace's first point; ties by `id`. */
function orderNearest(items: readonly TracePaths[]): TracePaths[] {
  const remaining = [...items];
  const ordered: TracePaths[] = [];
  const position: [number, number] = [0, 0];
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const p = firstTracePoint(remaining[i]!);
      const dx = p[0] - position[0];
      const dy = p[1] - position[1];
      const distance = dx * dx + dy * dy;
      const tieById = Math.abs(distance - bestDistance) <= 1e-9 && remaining[i]!.id < remaining[bestIndex]!.id;
      if (distance < bestDistance - 1e-9 || tieById) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    const chosen = remaining.splice(bestIndex, 1)[0]!;
    ordered.push(chosen);
    const p = firstTracePoint(chosen);
    position[0] = p[0];
    position[1] = p[1];
  }
  return ordered;
}

/**
 * The moves for one trace: every depth pass, every path. Each path is a rapid to its start at
 * `HOP_Z`, a straight plunge, a feed along the polyline (closing back to the start when `closed`),
 * and a retract to `HOP_Z` at the end point. The operation ends with a retract to `SAFE_Z`, so the
 * move before the next operation's first rapid is always `safeZ` — the same invariant
 * `buildMoves` keeps.
 *
 * No offset, no ramping, no linking between paths (each path retracts to `hopZ` first): a straight
 * link between two strokes could cross a third and cut it, the same reason `engraveJob` hops.
 */
function buildTraceMoves(trace: TracePaths, params: CutParams): CamMove[] {
  const moves: CamMove[] = [];
  let last: [number, number] = [0, 0];
  for (const z of zPasses(trace.depth, params.stepDown)) {
    for (let pi = 0; pi < trace.paths.length; pi++) {
      const path = trace.paths[pi]!;
      if (path.length === 0) continue;
      const [x0, y0] = path[0]!;

      moves.push({ kind: 'rapid', x: x0, y: y0, z: HOP_Z });
      moves.push({ kind: 'feed', x: x0, y: y0, z, f: params.plungeFeed });

      let ex = x0;
      let ey = y0;
      for (let j = 1; j < path.length; j++) {
        const [x, y] = path[j]!;
        moves.push({ kind: 'feed', x, y, z, f: params.feed });
        ex = x;
        ey = y;
      }
      // Close the ring back on its start with no retract — the whole point of a `closed` trace.
      if ((trace.closed[pi] ?? false) && path.length >= 2) {
        moves.push({ kind: 'feed', x: x0, y: y0, z, f: params.feed });
        ex = x0;
        ey = y0;
      }
      moves.push({ kind: 'rapid', x: ex, y: ey, z: HOP_Z });
      last = [ex, ey];
    }
  }
  if (moves.length > 0) moves.push({ kind: 'rapid', x: last[0], y: last[1], z: SAFE_Z });
  return moves;
}

/**
 * The toolpath IR for a set of traces.
 *
 * `traces` are `PartPlan.traces` in document order; `tool` must be a plain flat end mill
 * (`cuttingRadiusForSweep`), and `params` arrive from `feedsFor` (#202) — this module owns no
 * feeds, RPM or step values. `order` is the ordering strategy; only `'nearest'` exists in V1,
 * matching `generateEngrave`.
 */
export function generateTrace(
  traces: readonly TracePaths[],
  tool: Tool,
  params: CutParams,
  order: 'nearest' = 'nearest',
): ToolpathIR {
  const radiusResult = cuttingRadiusForSweep(tool);
  if (!radiusResult.ok) throw new Error(`generateTrace: ${radiusResult.reason}`);
  const toolNumber = tool.number ?? 1;

  const strategies: Record<'nearest', (items: readonly TracePaths[]) => TracePaths[]> = {
    nearest: orderNearest,
  };
  const ordered = strategies[order](traces.filter(hasCuts));

  const operations: CamOperation[] = ordered.map((trace, index) => {
    const moves = buildTraceMoves(trace, params);
    return {
      number: index + 1,
      name: `[T${toolNumber}]${trace.name ?? 'Trace'} ${trace.depth.toFixed(1)}mm`,
      labelId: trace.id,
      depth: trace.depth,
      moves,
      estimatedSeconds: estimateCycleSeconds(moves),
    };
  });

  return {
    // The 3-axis work frame. A rotary IR has its own frame (#237); nothing emits one yet.
    frame: 'flat',
    tool,
    toolNumber,
    spindleRpm: params.rpm,
    air: params.air,
    safeZ: SAFE_Z,
    hopZ: HOP_Z,
    operations,
  };
}
