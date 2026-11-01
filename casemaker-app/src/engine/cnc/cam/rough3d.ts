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
  if (!any) return [];
  const loops = traceMaskLoops(mask, nx, ny);
  // Cell indices → work mm (a cell's centre is x0 + i·pitch; its edges are half a pitch out).
  const { x0, y0, pitch } = hf;
  return loops.map((loop) => loop.map(([i, j]) => [x0 + (i - 0.5) * pitch, y0 + (j - 0.5) * pitch] as [number, number]));
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
  /** Per-level progress: (layer done, layers total). */
  onLayer?: (done: number, total: number) => void;
}

export interface AdaptiveRoughResult {
  moves: CamMove[];
  layers: number;
  /** The largest clearing engagement the planner used across the levels, mm. */
  maxEngagementMm: number;
  /** The engagement cap the planner held itself to, mm (fraction × diameter). */
  capMm: number;
}

/**
 * Clear every roughing level adaptively, or refuse with the planner's own
 * reason when a level has no honest 2D plan (too tight a neck, no room for the
 * cutter). A refusal is the CALLER's to state — the chooser keeps the raster.
 */
export function roughingAdaptiveMoves(
  hf: GoalHeightfield,
  feeds: SurfaceFeeds,
  allowance: number,
  opts: AdaptiveRoughOptions,
): { ok: true; result: AdaptiveRoughResult } | { ok: false; reason: string } {
  if (!(feeds.stepDown > 0)) {
    return { ok: false, reason: `3D roughing needs a positive step-down; the feeds gave ${feeds.stepDown} mm` };
  }
  if (hf.coveredCount === 0) {
    return { ok: true, result: { moves: [], layers: 0, maxEngagementMm: 0, capMm: 0 } };
  }
  const { topZ, minZ } = hf;
  const deepest = minZ + allowance;
  const levels: number[] = [];
  for (let L = topZ - feeds.stepDown; L > deepest + 1e-9; L -= feeds.stepDown) levels.push(L);
  levels.push(deepest);

  const flat = cuttingRadiusForSweep(opts.tool);
  const capMm = flat.ok ? opts.adaptive.engagementFraction * 2 * flat.radius : 0;
  const moves: CamMove[] = [];
  let maxEngagementMm = 0;
  let lastLevel = levels[0] ?? topZ;

  for (const [index, L] of levels.entries()) {
    opts.onLayer?.(index + 1, levels.length);
    const region = roughLevelRegion(hf, L, allowance);
    if (region.length === 0) continue;
    // The layer's own thickness: the distance from the level above it (or the
    // stock top for the first), which is the depth the planner descends.
    const thickness = index === 0 ? topZ - L : lastLevel - L;
    lastLevel = L;
    const planned = planAdaptive({
      tool: opts.tool,
      region,
      depth: Math.max(thickness, 0.01),
      // One level per call: the planner's own step-down is the layer's thickness,
      // so it cannot subdivide it; its feeds come from the job's.
      settings: { ...opts.adaptive, stepDownMm: Math.max(thickness, 0.01), cutFeed: feeds.feed, entryFeed: feeds.plungeFeed },
      ...(opts.provenance !== undefined ? { provenance: opts.provenance } : {}),
    });
    if (!planned.ok) return { ok: false, reason: `adaptive level at Z ${Math.round(L * 100) / 100}: ${planned.reason}` };
    maxEngagementMm = Math.max(maxEngagementMm, planned.plan.stats.maxStepEngagement);
    // Shift the plan's Zs: its single level (−thickness) lands on L; its 0-plane
    // (the material's top at that layer) becomes the level above. Hops and safe
    // retracts map to the 3D job's own heights.
    const shift = L + thickness;
    for (let i = 0; i < planned.plan.moves.length; i++) {
      const m = planned.plan.moves[i]!;
      moves.push(
        m.kind === 'rapid' && m.z >= HOP_Z - EPS
          ? { ...m, z: m.z >= SAFE_Z - EPS ? opts.safeZ : opts.hopZ }
          : { ...m, z: m.z + shift },
      );
    }
  }
  if (moves.length > 0) {
    const last = moves[moves.length - 1]!;
    moves.push({ kind: 'rapid', x: last.x, y: last.y, z: opts.safeZ });
  }
  return { ok: true, result: { moves, layers: levels.length, maxEngagementMm, capMm } };
}
