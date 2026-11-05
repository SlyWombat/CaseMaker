/**
 * cam/model/ops/pencil.ts — §3.4 of `docs/design/cam-model-engine.md` (#960).
 *
 * Pencil for creases: one pass along a CONCAVE edge under the finish cutter's own reach.
 * OpenCamLib's method, re-implemented from its description — scope open item (§8): creases only,
 * not a general rest-machining pass, until a real part needs more.
 *
 * WHERE A CREASE IS. A concave surface edge is a VALLEY in the ball's CL height field: the
 * floor-to-wall line of a scoop is where the ball settles lowest, and the CL height dips across
 * the crease while staying near constant along it. So the op samples the CL surface on a grid and
 * keeps the cells that are a strict local MINIMUM along x or along y (`neighbour means − this >
 * creaseMm`); those cells chain into the crease lines, and each chain becomes one feed pass at
 * the CL height — the same convention `finish()` uses for a dropped point's Z.
 */

import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { estimateCycleSeconds, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { cutterKeyOf } from '../sequence';
import type { RemainderRegion } from '../features';
import type { ClSurface } from '../clsurface';
import { dropRow } from '../rowDropper';
import type { OpOutcome, PassRef, RegionRef } from '../plan';

export interface PencilOpOptions {
  cutter: Tool;
  region: RemainderRegion;
  regionRef: RegionRef;
  clSurface: ClSurface;
  /** How much lower than both neighbours a cell must sit to count as the crease, mm. Default 0.02. */
  creaseMm?: number;
  /** The sampling grid, mm. Default min(0.5, max(0.1, radius / 2)). */
  gridPitchMm?: number;
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number };
  safeZMm: number;
  hopZMm: number;
  toolNumber: number;
  spindleRpm: number;
  air: boolean;
  rapid: RapidEstimate;
}

type Cell = { i: number; j: number; z: number };

/**
 * The crease cells as ordered chains. Cells are 8-connected; a chain starts at an end cell (one
 * neighbour) or, for a closed loop, at the first unvisited cell, and is walked choosing the
 * neighbour that keeps the direction (straightest first) so a noisy line does not zig-zag.
 */
function creaseChains(valley: Uint8Array, nx: number, ny: number): Cell[][] {
  const at = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < nx && j < ny && valley[j * nx + i] === 1;
  const neighbours = (i: number, j: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        if (at(i + di, j + dj)) out.push([i + di, j + dj]);
      }
    }
    return out;
  };
  const visited = new Uint8Array(nx * ny);
  const chains: Cell[][] = [];
  const starts: [number, number][] = [];
  // End cells first, then anything left (closed loops).
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!at(i, j) || visited[j * nx + i] === 1) continue;
      if (neighbours(i, j).length <= 1) starts.push([i, j]);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) if (at(i, j) && visited[j * nx + i] === 0) starts.push([i, j]);
  }
  for (const [si, sj] of starts) {
    if (visited[sj * nx + si] === 1) continue;
    const chain: Cell[] = [];
    let i = si;
    let j = sj;
    let di = 0;
    let dj = 0;
    while (true) {
      visited[j * nx + i] = 1;
      chain.push({ i, j, z: Number.NaN });
      const nexts = neighbours(i, j).filter(([ni, nj]) => visited[nj * nx + ni] === 0);
      if (nexts.length === 0) break;
      let pick = nexts[0]!;
      if (nexts.length > 1 && (di !== 0 || dj !== 0)) {
        let bestScore = -Infinity;
        for (const [ni, nj] of nexts) {
          const s = (ni - i) * di + (nj - j) * dj;
          if (s > bestScore) {
            bestScore = s;
            pick = [ni, nj];
          }
        }
      }
      di = pick[0] - i;
      dj = pick[1] - j;
      i = pick[0];
      j = pick[1];
    }
    if (chain.length >= 2) chains.push(chain);
  }
  return chains;
}

export function pencil(opts: PencilOpOptions): OpOutcome {
  const toolRadius = (cuttingDiameter(opts.cutter) ?? 0) / 2;
  if (!(toolRadius > 0)) {
    throw new Error(`cam/model/ops/pencil: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const creaseMm = opts.creaseMm ?? 0.02;
  const pitch = opts.gridPitchMm ?? Math.min(0.5, Math.max(0.1, toolRadius / 2));
  const { min, max } = opts.regionRef.bounds;
  const nx = Math.max(2, Math.floor((max[0] - min[0]) / pitch + 1e-9) + 1);
  const ny = Math.max(2, Math.floor((max[1] - min[1]) / pitch + 1e-9) + 1);
  const h = new Float64Array(nx * ny).fill(Number.NaN);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const z = opts.clSurface.dropCutter(min[0] + i * pitch, min[1] + j * pitch);
      if (z !== null) h[j * nx + i] = z;
    }
  }
  const valley = new Uint8Array(nx * ny);
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      const z = h[k]!;
      if (!Number.isFinite(z)) continue;
      const left = h[k - 1]!;
      const right = h[k + 1]!;
      const down = h[k - nx]!;
      const up = h[k + nx]!;
      // A strict dip along ONE axis: the crease's cross-section. Along the line the surface stays
      // nearly constant, so the other axis has no dip and the cell is not double-counted there.
      const dipX = Number.isFinite(left) && Number.isFinite(right) && Math.min(left, right) - z > creaseMm;
      const dipY = Number.isFinite(down) && Number.isFinite(up) && Math.min(down, up) - z > creaseMm;
      if (dipX || dipY) valley[k] = 1;
    }
  }

  const chains = creaseChains(valley, nx, ny);
  const moves: ToolpathIR['operations'][number]['moves'] = [];
  const passes: PassRef[] = [];
  for (const chain of chains) {
    const points = chain.map((c) => ({
      x: min[0] + c.i * pitch,
      y: min[1] + c.j * pitch,
      z: h[c.j * nx + c.i]!,
    }));
    const first = points[0]!;
    // THE REVIEW FOUND THIS (pencil.ts:151-152): a chain after the first began with ONE rapid from
    // the previous chain's own CUT DEPTH to (start, hopZ). A post writes a 3-D rapid as a single
    // straight line, so that move drags diagonally through the material across the part — the
    // first crease's end to the second's start, through whatever stands between them. Lift
    // VERTICALLY at the current position first; the travel then runs at the hop plane. The op has
    // no material field to hand `link()`, so this is the second form the review allows.
    const previous = moves[moves.length - 1];
    if (previous !== undefined) {
      moves.push({ kind: 'rapid', x: previous.x, y: previous.y, z: opts.hopZMm });
    }
    moves.push({ kind: 'rapid', x: first.x, y: first.y, z: opts.hopZMm });
    moves.push({ kind: 'feed', x: first.x, y: first.y, z: first.z, f: opts.feeds.plungeFeedMmPerMin });
    // #960 — a straight chord between two grid cells (0.5–0.7 mm apart) dipped under the CL across
    // a crease's own cross-section (0.029 mm on the organizer): each step is dropped as a row.
    for (let p = 1; p < points.length; p++) {
      const prev = points[p - 1]!;
      const q = points[p]!;
      for (const d of dropRow(opts.clSurface, [prev.x, prev.y], [q.x, q.y]).slice(1)) {
        moves.push({ kind: 'feed', x: d.x, y: d.y, z: d.z, f: opts.feeds.feedMmPerMin });
      }
    }
    const line = points.map((p) => [p.x, p.y] as [number, number]);
    passes.push({
      z: Math.min(...points.map((p) => p.z)),
      boundary: [line],
      // The pencil removes only the crease sliver: the pass's own line is what it claims.
      cleared: { z: Math.min(...points.map((p) => p.z)), boundary: [line] },
      entry: [first.x, first.y, first.z],
      exit: [points[points.length - 1]!.x, points[points.length - 1]!.y, points[points.length - 1]!.z],
    });
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
        name: `[T${opts.toolNumber}] Pencil "${opts.region.id}"`,
        labelId: opts.region.id,
        depth,
        depthPasses: 1,
        passStepMm: 0,
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, opts.rapid),
      },
    ],
  };

  return { ir, cutter: cutterKeyOf(opts.cutter), passes };
}
