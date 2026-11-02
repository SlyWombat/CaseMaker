/**
 * #846 — ADAPTIVE 3D ROUGHING: each roughing level cleared with the 2D adaptive
 * engine (`cam/adaptive.ts`, #433) instead of the raster.
 *
 * The raster rough in `surface3d.ts` walks every covered column at every layer,
 * the tip clamped up to `H + allowance`; on a deep goal it traverses a lot of
 * air and holds no engagement guarantee. This module clears each layer the way
 * the 2D adaptive engine clears a pocket:
 *
 *   1. THE REGION at layer L is the set of cells with `H + allowance > L` — the
 *      material still standing above the cut. Its boundary is traced off the
 *      heightfield's own cell grid (a cell-edge walk, even-odd fill), so the
 *      cutter follows the goal's shape instead of scanning over cleared air.
 *   2. `planAdaptive` plans that region at ONE level (depth = the layer step),
 *      giving capped engagement and a helix or ramp entry.
 *   3. The plan's Zs are shifted so its single level lands on L; its hops and
 *      retracts map to the 3D job's own hop/safe heights.
 *
 * STOCK-TO-LEAVE IS BY CONSTRUCTION: the region stops where `H + allowance <= L`,
 * so no cutting move crosses the allowance surface, and the final layer rides it
 * exactly as the raster's does. The FINISHING passes never see this module.
 */

import type { Polygons } from './pocket';
import { planAdaptive, type AdaptiveProvenance, type AdaptiveSettings } from './adaptive';
import { HOP_Z, SAFE_Z, type CamMove } from './ir';
import { cuttingRadiusForSweep, type Tool } from '../tool';
import type { GoalHeightfield, SurfaceFeeds } from './surface3d';

const EPS = 1e-6;

/**
 * The region a layer must clear, as polygons in the work frame: cells where the
 * goal's top plus the allowance stands ABOVE `levelZ`. Even-odd fill, so the
 * winding of the traced loops does not matter to the adaptive planner.
 */
export function roughLevelRegion(hf: GoalHeightfield, levelZ: number, allowance: number): Polygons {
  const mask = roughLevelMask(hf, levelZ, allowance);
  if (mask === null) return [];
  return polygonalizeMask(hf, mask);
}

/**
 * #868 — THE MASK a level clears (see {@link roughLevelRegion}): 1 where the goal's top plus the
 * allowance stands above the level, 0 elsewhere. Null when nothing stands above it. Pulled out
 * of `roughLevelRegion` so the caller can HASH it: two levels that clear exactly the same cells
 * get exactly the same plan, and the second one reuses the first's instead of walking again.
 */
export function roughLevelMask(hf: GoalHeightfield, levelZ: number, allowance: number): Uint8Array | null {
  const { nx, ny } = hf;
  const mask = new Uint8Array(nx * ny);
  let any = false;
  for (let k = 0; k < mask.length; k++) {
    if (hf.covered[k] === 0) continue;
    // Material standing ABOVE the cut: the allowance surface is below the level
    // (the raster's own rule — a cell is cut at L where H + allowance < L, and
    // the final layer rides the allowance surface itself, so <= there).
    if ((hf.z[k] as number) + allowance <= levelZ + EPS) {
      mask[k] = 1;
      any = true;
    }
  }
  return any ? mask : null;
}

/** The mask's outline as polygons in the work frame (cell indices → mm, edes half a pitch out). */
export function polygonalizeMask(hf: GoalHeightfield, mask: Uint8Array): Polygons {
  const loops = traceMaskLoops(mask, hf.nx, hf.ny);
  const { x0, y0, pitch } = hf;
  return loops.map((loop) => loop.map(([i, j]) => [x0 + (i - 0.5) * pitch, y0 + (j - 0.5) * pitch] as [number, number]));
}

/** FNV-1a over a mask's bytes: the same bytes, the same plan. */
function maskHash(mask: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < mask.length; k++) {
    h ^= mask[k]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Trace the boundary loops of a cell mask. Every masked cell contributes its
 * four edges, oriented so the cell's interior is on the left; an edge shared
 * with another masked cell is cancelled, and the rest chain into closed loops.
 * Loop vertices are cell-corner indices ((i, j) is the corner at the cell's
 * low-x/low-y side).
 */
export function traceMaskLoops(mask: Uint8Array, nx: number, ny: number): [number, number][][] {
  type Edge = { from: [number, number]; to: [number, number] };
  const edges: Edge[] = [];
  const masked = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < nx && j < ny && mask[j * nx + i] === 1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!masked(i, j)) continue;
      // CCW around the cell (x right, y up): bottom, right, top, left.
      if (!masked(i, j - 1)) edges.push({ from: [i, j], to: [i + 1, j] });
      if (!masked(i + 1, j)) edges.push({ from: [i + 1, j], to: [i + 1, j + 1] });
      if (!masked(i, j + 1)) edges.push({ from: [i + 1, j + 1], to: [i, j + 1] });
      if (!masked(i - 1, j)) edges.push({ from: [i, j + 1], to: [i, j] });
    }
  }
  // Chain: each vertex has exactly one outgoing and one incoming edge in the
  // cancelled set (a boundary is a set of closed curves).
  const byStart = new Map<string, Edge>();
  const key = (p: [number, number]): string => `${p[0]},${p[1]}`;
  for (const e of edges) byStart.set(key(e.from), e);
  const loops: [number, number][][] = [];
  const seen = new Set<string>();
  for (const start of edges) {
    const k0 = key(start.from);
    if (seen.has(k0)) continue;
    const loop: [number, number][] = [];
    let cur: Edge | undefined = start;
    let guard = edges.length + 1;
    while (cur !== undefined && guard-- > 0) {
      const k = key(cur.from);
      if (seen.has(k)) break;
      seen.add(k);
      loop.push(cur.from);
      cur = byStart.get(key(cur.to));
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

export interface AdaptiveRoughOptions {
  tool: Tool;
  /** The adaptive planner's shop settings (engagement cap, feeds, entry geometry). */
  adaptive: AdaptiveSettings;
  safeZ: number;
  hopZ: number;
  /** #666 — where the cut numbers came from, when the job supplies them. */
  provenance?: AdaptiveProvenance;
  /** Per-level progress: (levels done, levels total). */
  onLayer?: (done: number, total: number) => void;
  /**
   * #881 — WHERE THE LEVELS ARE PLANNED. A pool on the other side of a MessagePort (the browser)
   * or worker_threads (Node) plans them in parallel; absent, every level is planned in this
   * thread, exactly as before. The reuse and the assembly below do not know which side computed
   * a plan, which is what makes a parallel plan byte-identical to the serial one.
   */
  planner?: LevelPlanner;
  /** #881 — the budget the pool may size itself against (`LevelPlanShared.memory`). */
  memory?: LevelPlanMemory;
}

/** #881 — one level's planning request: plain data, so it can cross to a pool worker. */
export interface LevelPlanRequest {
  /** This level's position among the requests, so the plans can be laid back in order. */
  index: number;
  /** The level the cut lands on, mm. */
  levelZ: number;
  /** The distance the planner descends (the layer's thickness, at least 0.01 mm). */
  depth: number;
  /**
   * #881 — how many cells this level clears: the pool's cost estimate, so the longest levels
   * start first and the makespan's tail shortens. Planning does not read it.
   */
  cells: number;
  /** The cells this level clears, as polygons in the work frame. */
  region: Polygons;
}

export type LevelPlanResult =
  | {
      ok: true;
      moves: CamMove[];
      maxEngagementMm: number;
      /** #908 — the level's typed-array high-water mark, bytes (AdaptivePlan.stats). */
      peakArrayBytes: number;
      /** #908 — the level's grid cells (nx × ny), so a reported peak can be stated per cell. */
      gridCells: number;
    }
  | { ok: false; reason: string };

/**
 * #881 — WHAT THE RUN MAY SPEND. The pool sizes itself from these numbers: each planner holds one
 * level at a time, so `planners × largest level + parent` must stay inside the page's budget.
 * #889 states the budget (640 MB on a computer, 256 MB on a phone) and the CAM states the
 * program's own estimate; absent, the pool keeps its core rule alone.
 */
export interface LevelPlanMemory {
  /** The page's stated budget for this program, bytes. */
  budgetBytes: number;
  /** The parent's estimated peak while the pool runs — the program the CAM is assembling, bytes. */
  parentBytes: number;
}

/** The arguments every level shares — the same ones `planAdaptive` takes. */
export interface LevelPlanShared {
  tool: Tool;
  settings: AdaptiveSettings;
  feed: number;
  plungeFeed: number;
  provenance?: AdaptiveProvenance;
  /** #881 — the budget the pool may size itself against; absent → cores alone decide. */
  memory?: LevelPlanMemory;
}

/**
 * #881 — WHERE LEVELS ARE PLANNED. `planLevels` returns one result per request, in request
 * order; `onPlanned` reports how many have finished, for the step's progress line.
 */
export interface LevelPlanner {
  planLevels(
    requests: readonly LevelPlanRequest[],
    shared: LevelPlanShared,
    onPlanned?: (done: number, total: number) => void,
  ): Promise<readonly LevelPlanResult[]>;
}

/**
 * Plan ONE level. The pool workers call this, and so does the in-process path — one function, so
 * a parallel plan cannot differ from a serial one.
 */
export function planLevel(shared: LevelPlanShared, request: LevelPlanRequest): LevelPlanResult {
  const planned = planAdaptive({
    tool: shared.tool,
    region: request.region,
    depth: request.depth,
    // One level per call: the planner's own step-down is the layer's thickness,
    // so it cannot subdivide it; its feeds come from the job's.
    settings: { ...shared.settings, stepDownMm: request.depth, cutFeed: shared.feed, entryFeed: shared.plungeFeed },
    ...(shared.provenance !== undefined ? { provenance: shared.provenance } : {}),
  });
  if (!planned.ok) return { ok: false, reason: planned.reason };
  return {
    ok: true,
    moves: planned.plan.moves,
    maxEngagementMm: planned.plan.stats.maxStepEngagement,
    peakArrayBytes: planned.plan.stats.peakArrayBytes,
    gridCells: planned.plan.stats.gridCells,
  };
}

export interface AdaptiveRoughResult {
  moves: CamMove[];
  layers: number;
  /** The largest clearing engagement the planner used across the levels, mm. */
  maxEngagementMm: number;
  /** The engagement cap the planner held itself to, mm (fraction × diameter). */
  capMm: number;
  /** #868 — levels that reused the level above's plan because their region mask was identical. */
  reusedLevels: number;
}

/** One layer as the assembly sees it: where it lands, what it clears, and whose plan it uses. */
interface LevelSlot {
  levelZ: number;
  /** The distance from the level above it (the stock top for the first), which the planner descends. */
  thickness: number;
  /** False when nothing stands above this level (no mask): it is skipped, but still counted. */
  cleared: boolean;
  /** The request this level planned, or null when it reuses the level above's plan. */
  requestIndex: number | null;
}

/**
 * Clear every roughing level adaptively, or refuse with the planner's own
 * reason when a level has no honest 2D plan (too tight a neck, no room for the
 * cutter). A refusal is the CALLER's to state — the chooser keeps the raster.
 *
 * #881 — ASYNC: the levels are independent, so a `planner` can compute them in parallel. Each
 * level is still `planLevel` (the same `planAdaptive` call), the reuse and the Z-shifted assembly
 * are unchanged, and the results are laid back in level order — so the parallel plan is
 * byte-identical to the serial one (the adaptiveReuse reference test pins it).
 */
export async function roughingAdaptiveMoves(
  hf: GoalHeightfield,
  feeds: SurfaceFeeds,
  allowance: number,
  opts: AdaptiveRoughOptions,
): Promise<{ ok: true; result: AdaptiveRoughResult } | { ok: false; reason: string }> {
  if (!(feeds.stepDown > 0)) {
    return { ok: false, reason: `3D roughing needs a positive step-down; the feeds gave ${feeds.stepDown} mm` };
  }
  if (hf.coveredCount === 0) {
    return { ok: true, result: { moves: [], layers: 0, maxEngagementMm: 0, capMm: 0, reusedLevels: 0 } };
  }
  const { topZ, minZ } = hf;
  const deepest = minZ + allowance;
  const levels: number[] = [];
  for (let L = topZ - feeds.stepDown; L > deepest + 1e-9; L -= feeds.stepDown) levels.push(L);
  levels.push(deepest);

  const flat = cuttingRadiusForSweep(opts.tool);
  const capMm = flat.ok ? opts.adaptive.engagementFraction * 2 * flat.radius : 0;
  const shared: LevelPlanShared = {
    tool: opts.tool,
    settings: opts.adaptive,
    feed: feeds.feed,
    plungeFeed: feeds.plungeFeed,
    ...(opts.provenance !== undefined ? { provenance: opts.provenance } : {}),
    ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
  };

  // ── THE SLOTS, in level order ────────────────────────────────────────────────────────────────
  // A level is EMPTY (no mask — nothing stands above it), REUSED (its mask and thickness repeat
  // the last planned level's, #868), or PLANNED (one request for the pool, or for this thread).
  const slots: LevelSlot[] = [];
  const requests: LevelPlanRequest[] = [];
  let lastLevel = levels[0] ?? topZ;
  // The #868 cache: the last PLANNED level's mask hash and thickness. A reused level does not
  // move it, so a run of identical levels all share the one plan.
  let cachedHash: number | null = null;
  let cachedDepth: number | null = null;
  let reusedLevels = 0;
  for (const [index, L] of levels.entries()) {
    const mask = roughLevelMask(hf, L, allowance);
    if (mask === null) {
      slots.push({ levelZ: L, thickness: 0, cleared: false, requestIndex: null });
      continue;
    }
    const thickness = index === 0 ? topZ - L : lastLevel - L;
    lastLevel = L;
    const depth = Math.max(thickness, 0.01);
    const hash = maskHash(mask);
    if (cachedHash !== null && cachedHash === hash && cachedDepth === depth) {
      reusedLevels++;
      slots.push({ levelZ: L, thickness, cleared: true, requestIndex: null });
      continue;
    }
    cachedHash = hash;
    cachedDepth = depth;
    let cells = 0;
    for (let k = 0; k < mask.length; k++) cells += mask[k] as number;
    requests.push({ index: requests.length, levelZ: L, depth, cells, region: polygonalizeMask(hf, mask) });
    slots.push({ levelZ: L, thickness, cleared: true, requestIndex: requests.length - 1 });
  }

  // ── THE PLANS ─────────────────────────────────────────────────────────────────────────────────
  const total = levels.length;
  let done = 0;
  const report = (): void => opts.onLayer?.(done, total);
  // Progress for the levels that need no planning (empty and reused), so the pool's count starts
  // from the right place.
  const settled = slots.filter((s) => !s.cleared || s.requestIndex === null).length;

  let pooledPlans: readonly LevelPlanResult[] | null = null;
  if (opts.planner !== undefined && requests.length > 1) {
    done = settled;
    report();
    pooledPlans = await opts.planner.planLevels(requests, shared, (planned) => {
      done = settled + planned;
      report();
    });
    if (pooledPlans.length !== requests.length) {
      return { ok: false, reason: `the level pool returned ${pooledPlans.length} plans for ${requests.length} levels` };
    }
  }

  // ── THE ASSEMBLY, in level order ─────────────────────────────────────────────────────────────
  const moves: CamMove[] = [];
  let maxEngagementMm = 0;
  // The last planned level's plan, which the reused levels share (#868).
  let lastPlanMoves: CamMove[] = [];
  let lastPlanMax = 0;
  // #908 — the shared plan's own cost, so a reused level reports the plan it really used.
  let lastPlanPeak = 0;
  let lastPlanGrid = 0;
  for (const slot of slots) {
    if (!slot.cleared) {
      if (pooledPlans === null) {
        done++;
        report();
      }
      continue;
    }
    let plan: LevelPlanResult;
    if (slot.requestIndex === null) {
      plan = {
        ok: true,
        moves: lastPlanMoves,
        maxEngagementMm: lastPlanMax,
        peakArrayBytes: lastPlanPeak,
        gridCells: lastPlanGrid,
      };
    } else if (pooledPlans !== null) {
      plan = pooledPlans[slot.requestIndex]!;
      if (plan.ok) {
        lastPlanMoves = plan.moves;
        lastPlanMax = plan.maxEngagementMm;
        lastPlanPeak = plan.peakArrayBytes;
        lastPlanGrid = plan.gridCells;
      }
    } else {
      plan = planLevel(shared, requests[slot.requestIndex]!);
      if (plan.ok) {
        lastPlanMoves = plan.moves;
        lastPlanMax = plan.maxEngagementMm;
        lastPlanPeak = plan.peakArrayBytes;
        lastPlanGrid = plan.gridCells;
      }
      done++;
      report();
    }
    if (!plan.ok) {
      return { ok: false, reason: `adaptive level at Z ${Math.round(slot.levelZ * 100) / 100}: ${plan.reason}` };
    }
    maxEngagementMm = Math.max(maxEngagementMm, plan.maxEngagementMm);
    // Shift the plan's Zs: its single level (−thickness) lands on the slot's level; its 0-plane
    // (the material's top at that layer) becomes the level above. Hops and safe retracts map to
    // the 3D job's own heights.
    const shift = slot.levelZ + slot.thickness;
    for (let i = 0; i < plan.moves.length; i++) {
      const m = plan.moves[i]!;
      moves.push(
        m.kind === 'rapid' && m.z >= HOP_Z - EPS
          ? { ...m, z: m.z >= SAFE_Z - EPS ? opts.safeZ : opts.hopZ }
          : { ...m, z: m.z + shift },
      );
    }
    if (slot.requestIndex === null && pooledPlans === null) {
      done++;
      report();
    }
  }
  if (moves.length > 0) {
    const last = moves[moves.length - 1]!;
    moves.push({ kind: 'rapid', x: last.x, y: last.y, z: opts.safeZ });
  }
  return { ok: true, result: { moves, layers: levels.length, maxEngagementMm, capMm, reusedLevels } };
}
