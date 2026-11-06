/**
 * cam/model/ops/rest.ts — §3.3's rest half of `docs/design/cam-model-engine.md` (#959).
 *
 * REST BY CL DIFFERENCE, not a separate algorithm: the material a previous cutter left standing
 * is where its own CL surface is above a level, and the smaller cutter can remove it only where
 * ITS CL surface is below the finish's allowance. So a level z cuts exactly the cells where
 *
 *     prevCL + 0 < z   (the previous cutter left material standing at z)   AND
 *     nextCL + stockToLeave < z   (the level is still above the finish's own target)
 *
 * — the same two-sided rule the rough op applies to the true surface, with the previous cutter's
 * CL surface standing in for "the surface as it now is". The mask is sampled and pocketed the same
 * way (cell MAX over centre and corners, rectilinear loops, `pocketLoops`' radius inset), links go
 * through `link()` against the level's own material field, and a level change links at the level
 * just finished before it plunges.
 *
 * The machinery mirrors `ops/rough.ts` rather than importing it: the two land on separate
 * branches, and the shared core is B's to unify once both are in `plan.ts`.
 */

import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { estimateCycleSeconds, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { pocketLoops, type OffsetFn, type Polygons } from '@/engine/cnc/cam/pocket';
import { tourNearest } from '@/engine/cnc/cam/tour';
import { clearedGroundZ, link, pathClClear, type LinkOptions, type LinkPoint, type MaterialField } from '../linking';
import { cutterKeyOf } from '../sequence';
import type { RemainderRegion } from '../features';
import type { ClSurface } from '../clsurface';
import type { OpOutcome, PassRef, RegionAtZ, RegionRef } from '../plan';

export interface RestOpOptions {
  cutter: Tool;
  region: RemainderRegion;
  regionRef: RegionRef;
  /** The PREVIOUS cutter's CL surface — what its own pass left standing. */
  prevClSurface: ClSurface;
  /** The smaller cutter's CL surface — the finish's own target. */
  clSurface: ClSurface;
  stepDownMm: number;
  /** The finish's allowance above the next cutter's CL surface, mm. Absent → 0. */
  stockToLeaveMm?: number;
  stepOverMm?: number;
  gridPitchMm?: number;
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number };
  offset: OffsetFn;
  safeZMm: number;
  hopZMm: number;
  toolNumber: number;
  spindleRpm: number;
  air: boolean;
  rapid: RapidEstimate;
  startFrom?: readonly [number, number];
}

function depthPasses(zTop: number, zBottom: number, stepDownMm: number): number[] {
  const total = zTop - zBottom;
  if (!(total > 0)) return [zBottom];
  const count = Math.ceil(total / stepDownMm);
  const levels: number[] = [];
  for (let i = 1; i <= count; i++) levels.push(i === count ? zBottom : zTop - i * stepDownMm);
  return levels;
}

/**
 * #961 — CELLS TO LOOPS: the rectilinear boundary of every cell a predicate accepts, as closed
 * rings (`ops/rough.ts`'s `maskLoops` rule). Exported for the coverage rest's own region, which is
 * built from the chain-so-far's stamped leftover rather than from a CL difference.
 */
export function cellPolygons(
  inside: (i: number, j: number) => boolean,
  nx: number,
  ny: number,
  x0: number,
  y0: number,
  pitch: number,
): Polygons {
  type Edge = { a: [number, number]; b: [number, number] };
  const edges: Edge[] = [];
  const push = (ai: number, aj: number, bi: number, bj: number): void => {
    edges.push({ a: [x0 + ai * pitch, y0 + aj * pitch], b: [x0 + bi * pitch, y0 + bj * pitch] });
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!inside(i, j)) continue;
      if (!inside(i, j - 1)) push(i, j, i + 1, j);
      if (!inside(i + 1, j)) push(i + 1, j, i + 1, j + 1);
      if (!inside(i, j + 1)) push(i + 1, j + 1, i, j + 1);
      if (!inside(i - 1, j)) push(i, j + 1, i, j);
    }
  }
  if (edges.length === 0) return [];
  const key = (p: readonly [number, number]): string => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const byStart = new Map<string, Edge[]>();
  for (const e of edges) {
    const list = byStart.get(key(e.a));
    if (list === undefined) byStart.set(key(e.a), [e]);
    else list.push(e);
  }
  const used = new Set<Edge>();
  const loops: Polygons = [];
  for (const startEdge of edges) {
    if (used.has(startEdge)) continue;
    const ring: [number, number][] = [];
    let current: Edge | undefined = startEdge;
    while (current !== undefined && !used.has(current)) {
      used.add(current);
      ring.push(current.a);
      const nextList: Edge[] = byStart.get(key(current.b)) ?? [];
      current = nextList.find((e: Edge) => !used.has(e));
    }
    if (ring.length >= 4) loops.push(ring);
  }
  return loops;
}

/** The level's mask as rectilinear loops — `cellPolygons` with the two surfaces' own rule. */
function restMask(
  prev: Float64Array,
  next: Float64Array,
  nx: number,
  ny: number,
  x0: number,
  y0: number,
  pitch: number,
  levelZ: number,
  leave: number,
  marginMm: number,
): Polygons {
  return cellPolygons(
    (i, j) => {
      if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
      const k = j * nx + i;
      const n = next[k]!;
      const p = prev[k]!;
      if (!Number.isFinite(n) || !Number.isFinite(p)) return false;
      return n + leave + marginMm < levelZ && p > levelZ;
    },
    nx, ny, x0, y0, pitch,
  );
}

function orderedRings(loops: readonly [number, number][][], from: readonly [number, number]): [number, number][][] {
  if (loops.length <= 1) return loops as [number, number][][];
  const points = loops.map((r) => r[0]! as readonly [number, number]);
  return tourNearest(points, from).map((i) => loops[i]!);
}

function nearestVertexIndex(ring: readonly [number, number][], target: readonly [number, number]): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [x, y] = ring[i]!;
    const distance = (x - target[0]) ** 2 + (y - target[1]) ** 2;
    if (distance < bestDistance - 1e-9) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

function rotatedToEntry(ring: readonly [number, number][], target: readonly [number, number]): [number, number][] {
  const start = nearestVertexIndex(ring, target);
  return start === 0 ? (ring as [number, number][]) : [...ring.slice(start), ...ring.slice(0, start)];
}

function traceRing(ring: readonly [number, number][], z: number, feedMmPerMin: number): ToolpathIR['operations'][number]['moves'] {
  const start = ring[0]!;
  const moves: ToolpathIR['operations'][number]['moves'] = [];
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i]!;
    moves.push({ kind: 'feed', x: p[0], y: p[1], z, f: feedMmPerMin });
  }
  moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: feedMmPerMin });
  return moves;
}

export function rest(opts: RestOpOptions): OpOutcome {
  const toolRadius = (cuttingDiameter(opts.cutter) ?? 0) / 2;
  if (!(toolRadius > 0)) {
    throw new Error(`cam/model/ops/rest: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const leave = Math.max(0, opts.stockToLeaveMm ?? 0);
  const stepOver = opts.stepOverMm ?? toolRadius;
  const pitch = opts.gridPitchMm ?? Math.min(0.5, Math.max(0.1, Math.min(stepOver, toolRadius) / 4));
  const { min, max } = opts.regionRef.bounds;
  const nx = Math.max(2, Math.floor((max[0] - min[0]) / pitch + 1e-9) + 1);
  const ny = Math.max(2, Math.floor((max[1] - min[1]) / pitch + 1e-9) + 1);

  // One sampling pass per surface: each cell's value is the MAX over its centre and four corners.
  const prev = new Float64Array(nx * ny).fill(Number.NaN);
  const next = new Float64Array(nx * ny).fill(Number.NaN);
  const half = pitch / 2;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = min[0] + i * pitch;
      const y = min[1] + j * pitch;
      let hiPrev = -Infinity;
      let hiNext = -Infinity;
      for (const [dx, dy] of [[0, 0], [-half, -half], [half, -half], [-half, half], [half, half]] as const) {
        const p = opts.prevClSurface.dropCutter(x + dx, y + dy);
        if (p !== null && p > hiPrev) hiPrev = p;
        const n = opts.clSurface.dropCutter(x + dx, y + dy);
        if (n !== null && n > hiNext) hiNext = n;
      }
      if (hiPrev > -Infinity) prev[j * nx + i] = hiPrev;
      if (hiNext > -Infinity) next[j * nx + i] = hiNext;
    }
  }

  const margin = opts.clSurface.toleranceMm;
  const cellAt = (x: number, y: number, grid: Float64Array): number => {
    const i = Math.round((x - min[0]) / pitch);
    const j = Math.round((y - min[1]) / pitch);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return Number.NaN;
    return grid[j * nx + i]!;
  };
  /** The material standing at (x, y) after the levels cut so far, at this level. */
  const materialFor = (levelZ: number): MaterialField => ({
    topAt: (x, y) => {
      const n = cellAt(x, y, next);
      const p = cellAt(x, y, prev);
      if (!Number.isFinite(n) || !Number.isFinite(p)) return Number.POSITIVE_INFINITY;
      const inMask = n + leave + margin < levelZ && p > levelZ;
      return inMask ? levelZ : p;
    },
  });

  const moves: ToolpathIR['operations'][number]['moves'] = [];
  const passes: PassRef[] = [];
  const cleared: RegionAtZ[] = [];

  // #1002 — THE LANDING PROOF, as the LEVEL the ground under the landing has been cut to: the
  // deepest recorded swept area containing it — the rings already traced at a level and the
  // levels that finished. A same-level link's rapid floor becomes that level + the hop (one
  // step-down's feed), never the stock-top plunge; a level-change landing keeps the level just
  // finished. Same rule the pocket op states in full.
  const landingClearedZ = (x: number, y: number, _z: number): number | null => clearedGroundZ(x, y, passes, cleared);
  const linkOptionsFor = (levelZ: number): LinkOptions => ({
    material: materialFor(levelZ),
    clearanceZ: opts.regionRef.regionClearanceZ,
    tool: { radiusMm: toolRadius },
    feeds: { feed: opts.feeds.feedMmPerMin, plungeFeed: opts.feeds.plungeFeedMmPerMin },
    hopClearanceMm: opts.hopZMm,
  });

  let prevExit: [number, number, number] | null = null;
  let prevLevelZ: number | null = null;
  const comingFrom = (): readonly [number, number] => (prevExit === null ? (opts.startFrom ?? [0, 0]) : [prevExit[0], prevExit[1]]);
  /**
   * #970 — B's link audit: the level's MATERIAL FIELD is a grid of the previous cutter's CL, and a
   * rise between its samples is invisible to `linkIsClear`. This reads the exact previous surface
   * where the plan's own mask does not cut (there the material still stands as the previous
   * cutter left it); inside the mask the level plane is what stands, as `materialFor` states.
   */
  const exactStandingAt = (levelZ: number, x: number, y: number): number | null => {
    const i = Math.round((x - min[0]) / pitch);
    const j = Math.round((y - min[1]) / pitch);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
    const n = next[j * nx + i]!;
    const p = prev[j * nx + i]!;
    if (Number.isFinite(n) && Number.isFinite(p) && n + leave + margin < levelZ && p > levelZ) return levelZ;
    return opts.prevClSurface.dropCutter(x, y);
  };

  let cutLevels = 0;
  for (const z of depthPasses(opts.region.zTop, opts.region.zBottom, opts.stepDownMm)) {
    const polygons = restMask(prev, next, nx, ny, min[0], min[1], pitch, z, leave, margin);
    if (polygons.length === 0) continue;
    const steps = pocketLoops(polygons, toolRadius, stepOver, opts.offset);
    if (steps.length === 0) continue;
    cutLevels++;
    for (const step of steps) {
      const loops = orderedRings(step, comingFrom());
      for (const loop of loops) {
        const ring = rotatedToEntry(loop, comingFrom());
        const start = ring[0]!;
        if (prevExit === null) {
          moves.push({ kind: 'rapid', x: start[0], y: start[1], z: opts.hopZMm });
          moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: opts.feeds.plungeFeedMmPerMin });
        } else {
          const from: LinkPoint = { x: prevExit[0], y: prevExit[1], z: prevExit[2] };
          const landing: LinkPoint = { x: start[0], y: start[1], z: prevExit[2] };
          const levelZ = prevLevelZ ?? prevExit[2];
          // A negative short hop refuses the stay-down without touching the shared rule, so
          // link() still emits its own retract (vertical legs, hop floor) where the proof fails.
          const clClear = pathClClear(from, landing, (x, y) => exactStandingAt(levelZ, x, y), Math.max(pitch / 4, 0.05), opts.prevClSurface.toleranceMm);
          moves.push(...link(from, landing, { ...(clClear ? linkOptionsFor(levelZ) : { ...linkOptionsFor(levelZ), shortHopMm: -1 }), landingClearedZMm: landingClearedZ }));
          if (z !== prevLevelZ) moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: opts.feeds.plungeFeedMmPerMin });
        }
        moves.push(...traceRing(ring, z, opts.feeds.feedMmPerMin));
        const entry: [number, number, number] = [start[0], start[1], z];
        passes.push({ z, boundary: [ring], cleared: { z, boundary: polygons }, entry, exit: entry });
        prevExit = entry;
        prevLevelZ = z;
      }
    }
    cleared.push({ z, boundary: polygons });
  }

  const lastMove = moves[moves.length - 1];
  if (lastMove) moves.push({ kind: 'rapid', x: lastMove.x, y: lastMove.y, z: opts.safeZMm });

  const depth = opts.region.zTop - opts.region.zBottom;
  const ir: ToolpathIR = {
    frame: 'flat',
    tool: opts.cutter,
    toolNumber: opts.toolNumber,
    spindleRpm: opts.spindleRpm,
    air: opts.air,
    safeZ: opts.safeZMm,
    hopZ: opts.hopZMm,
    operations: [
      {
        number: 1,
        name: `[T${opts.toolNumber}] Rest "${opts.region.id}"`,
        labelId: opts.region.id,
        depth,
        depthPasses: cutLevels,
        passStepMm: opts.stepDownMm,
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, opts.rapid),
      },
    ],
  };

  return { ir, cutter: cutterKeyOf(opts.cutter), passes, cleared };
}
