/**
 * cam/model/ops/rough.ts — §3.3 of `docs/design/cam-model-engine.md`.
 *
 * Z-level roughing of stock minus the CL surface (#957) for a curved `RemainderRegion`, largest flat
 * cutter that fits, no cap carried forward from the old `rough3d.ts`/its budgets (§6: a stall guard
 * only). `rest` is the next cutter's own CL surface compared against the previous cutter's — same
 * method, smaller cutter, no separate rest code path (C's per-slice minimum groups the two).
 *
 * THE RULE, per level z: the material that may be cut is where the CL surface PLUS the finish's
 * stock-to-leave is BELOW z. A level that cut where `cl + leave >= z` would take the cutter under
 * the surface it is meant to leave standing (a gouge); where `cl + leave < z` it removes only
 * stock above the target. The mask is sampled on a grid (each cell's MAX over its centre and four
 * corners, so a cell straddling a rise is judged by its high side), vectorised into rectilinear
 * loops, and pocketed with `pocketLoops` — the same ring machinery the pocket op uses, which
 * offsets the tool-centre path in by the cutter radius so the disc stays inside the mask. The
 * first level above a point's own target is then at most one step-down above it, which is the
 * leftover the finish is promised.
 *
 * The cut never descends at the cutting feed (the same rule 9e976f0b fixed in the pocket op):
 * every link between rings goes through #962's `link()` against the CURRENT level's material
 * field, and a level change links horizontally at the level just finished before it plunges.
 */

import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { estimateCycleSeconds, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { pocketLoops, type OffsetFn, type Polygons } from '@/engine/cnc/cam/pocket';
import { tourNearest } from '@/engine/cnc/cam/tour';
import { link, type LinkOptions, type LinkPoint, type MaterialField } from '../linking';
import { cutterKeyOf } from '../sequence';
import type { RemainderRegion } from '../features';
import type { ClSurface } from '../clsurface';
import type { OpOutcome, PassRef, RegionAtZ, RegionRef } from '../plan';
import { maskLoopsFromPredicate } from './rasterMask';

export interface RoughOpOptions {
  cutter: Tool;
  region: RemainderRegion;
  regionRef: RegionRef;
  clSurface: ClSurface;
  stepDownMm: number;
  /**
   * The finish's own allowance above the CL surface, mm. Absent → 0. The levels never cut below
   * `cl + stockToLeaveMm`: a level cuts only where that target is below it.
   */
  stockToLeaveMm?: number;
  /** The rings' spacing within a level, mm. Absent → the cutter's radius (`pocketLoops`' own limit). */
  stepOverMm?: number;
  /**
   * The grid the CL surface is sampled on for the level masks, mm. Absent → `min(stepOver,
   * radius) / 3`, clamped to [0.1, 0.6]. Finer than the step-over: the mask's own boundary is the
   * level's waterline, and a coarse grid would shift it by a whole cell.
   */
  gridPitchMm?: number;
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number };
  /** The real Clipper2 offset (as `pocketLoops` requires), or a test fake. */
  offset: OffsetFn;
  safeZMm: number;
  hopZMm: number;
  toolNumber: number;
  spindleRpm: number;
  air: boolean;
  rapid: RapidEstimate;
  /** Where the tool starts, for the first ring's tour — the work origin by default. */
  startFrom?: readonly [number, number];
}

/** The Z passes from `zTop` down to `zBottom`, each `stepDownMm` apart (the last one shorter). */
function depthPasses(zTop: number, zBottom: number, stepDownMm: number): number[] {
  const total = zTop - zBottom;
  if (!(total > 0)) return [zBottom];
  const count = Math.ceil(total / stepDownMm);
  const levels: number[] = [];
  for (let i = 1; i <= count; i++) levels.push(i === count ? zBottom : zTop - i * stepDownMm);
  return levels;
}

/**
 * The level's mask as rectilinear loops: every cell whose sampled target (`cl + leave`, the MAX
 * over the cell's centre and four corners) is below the level becomes one cell square, and the
 * shared edges between two inside cells are dropped — what is left is the boundary, stitched
 * head-to-tail into rings. Each edge is directed with the inside cell on its left, so outer rings
 * come out counter-clockwise and holes clockwise, the winding Clipper2's offset expects.
 */
function maskLoops(
  target: Float64Array,
  nx: number,
  ny: number,
  x0: number,
  y0: number,
  pitch: number,
  levelZ: number,
  marginMm: number,
): Polygons {
  const inside = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < nx && j < ny && Number.isFinite(target[j * nx + i]!) && target[j * nx + i]! + marginMm < levelZ;
  return maskLoopsFromPredicate(nx, ny, x0, y0, pitch, inside);
}

/** Rings in a deterministic, short-travel order — the same tour rule `ops/pocket.ts` uses. */
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

export function rough(opts: RoughOpOptions): OpOutcome {
  const toolRadius = (cuttingDiameter(opts.cutter) ?? 0) / 2;
  if (!(toolRadius > 0)) {
    throw new Error(`cam/model/ops/rough: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const leave = Math.max(0, opts.stockToLeaveMm ?? 0);
  const stepOver = opts.stepOverMm ?? toolRadius;
  const pitch = opts.gridPitchMm ?? Math.min(0.5, Math.max(0.1, Math.min(stepOver, toolRadius) / 4));
  const { min, max } = opts.regionRef.bounds;
  const nx = Math.max(2, Math.floor((max[0] - min[0]) / pitch + 1e-9) + 1);
  const ny = Math.max(2, Math.floor((max[1] - min[1]) / pitch + 1e-9) + 1);

  // ONE sampling pass: each cell's target is the MAX of the drop-cutter over the cell's centre and
  // four corners — a cell that straddles a rise is judged by its high side, never its low one.
  const target = new Float64Array(nx * ny).fill(Number.NaN);
  const half = pitch / 2;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = min[0] + i * pitch;
      const y = min[1] + j * pitch;
      let hi = -Infinity;
      for (const [dx, dy] of [[0, 0], [-half, -half], [half, -half], [-half, half], [half, half]] as const) {
        const cl = opts.clSurface.dropCutter(x + dx, y + dy);
        if (cl !== null && cl > hi) hi = cl;
      }
      if (hi > -Infinity) target[j * nx + i] = hi + leave;
    }
  }

  // The discretisation guard on the mask's own boundary: a cell is judged by its MAX sample
  // (centre and four corners), and `pocketLoops` simplifies ring vertices by
  // `ARC_CHORD_TOLERANCE_MM`, so the mask sits one sampling tolerance inside the true waterline.
  // The leftover promise pays for that in the same coin: the level a cell joins at is within one
  // step-down of its own target plus the cell's own half-cell rise — the number the tests state.
  const margin = opts.clSurface.toleranceMm;

  const targetAt = (x: number, y: number): number => {
    const i = Math.round((x - min[0]) / pitch);
    const j = Math.round((y - min[1]) / pitch);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return Number.NaN;
    return target[j * nx + i]!;
  };
  /** The material the CURRENT level z has not removed: the target where it stands above z, else z. */
  const materialFor = (_levelZ: number): MaterialField => ({
    // ITEM 7 — the field reports the STANDING SURFACE (the target grid), never a level floor under
    // it. `math.max(levelZ, target)` was honest only for a link travelling at that same level's
    // own z: at any other travel height it claims a floor that pass never left, and the skim's
    // first link() routing trusted it and fed THROUGH standing material (the organizer's rough
    // measured 10,063 s -> 18,645 s before this fix). The level loop's own links are unchanged by
    // it: at travel z == levelZ, cleared cells read target < z (clear either way) and uncut cells
    // read target > z (hop either way).
    topAt: (x, y) => {
      const t = targetAt(x, y);
      return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
    },
  });

  const moves: ToolpathIR['operations'][number]['moves'] = [];
  const passes: PassRef[] = [];
  const cleared: RegionAtZ[] = [];
  const linkBase = {
    tool: { radiusMm: toolRadius },
    feeds: { feed: opts.feeds.feedMmPerMin, plungeFeed: opts.feeds.plungeFeedMmPerMin },
    hopClearanceMm: opts.hopZMm,
  } as const;
  const linkOptionsFor = (levelZ: number): LinkOptions => ({
    ...linkBase,
    material: materialFor(levelZ),
    clearanceZ: opts.regionRef.regionClearanceZ,
  });

  let prevExit: [number, number, number] | null = null;
  let prevLevelZ: number | null = null;
  const comingFrom = (): readonly [number, number] => (prevExit === null ? (opts.startFrom ?? [0, 0]) : [prevExit[0], prevExit[1]]);

  let cutLevels = 0;
  for (const z of depthPasses(opts.region.zTop, opts.region.zBottom, opts.stepDownMm)) {
    const polygons = maskLoops(target, nx, ny, min[0], min[1], pitch, z, margin);
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
          // The horizontal part links at the level just FINISHED, where the field is honest;
          // the descent is always a plain feed at plungeFeed, never a diagonal at cutting rate.
          moves.push(...link(from, landing, linkOptionsFor(prevLevelZ ?? prevExit[2])));
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

  // ── THE BAND SKIM (item 4b): shallow ground the Z-levels cannot reach ──────────────────────
  // A cell whose CL + band lies between the FIRST level and zTop met no mask at any level (every
  // level wants cl + band below that level). On ground shallower than one step-down that is the
  // whole region: the op emitted nothing, and the tray's fourteen remainder regions said exactly
  // 'rough "…" emitted no moves'. The flat skims those cells at cl + band — the material standing
  // above the ball's promised band, never the band itself.
  const skimFirstLevel = depthPasses(opts.region.zTop, opts.region.zBottom, opts.stepDownMm)[0] ?? opts.region.zBottom;
  // `target` ALREADY holds `cl + stockToLeave` (the grid above) — the skim reads it directly;
  // adding the band a second time put feeds at the stock top (-0.0025 in the red-first's first
  // run, the double band and a half-cell sampling rise).
  // (ii) THE MANAGER'S RULING: where the flat can reach, it cuts to its OWN drop-cutter CL —
  // exact contact, never deeper, so there is no gouge and no band left under the blade. The grid
  // holds `cl + stockToLeave`, so the CL is that value less the leave. The ball's mask (item 4a)
  // then only visits the cells where this skim could not reach, plus the terraces and scallops it
  // left. The steep Z-steps keep their `cl + band` target.
  const skimLeave = Math.max(0, opts.stockToLeaveMm ?? 0);
  const skimTarget = (i: number, j: number): number | null => {
    const z = target[j * nx + i]!;
    if (!Number.isFinite(z)) return null;
    const cl = z - skimLeave;
    return cl < opts.region.zTop && cl >= skimFirstLevel ? cl : null;
  };
  let skimRuns = 0;
  const skimRun = (i0: number, i1: number, j: number): void => {
    const points: [number, number, number][] = [];
    for (let i = i0; i <= i1; i++) points.push([min[0] + i * pitch, min[1] + j * pitch, skimTarget(i, j) as number]);
    if (points.length < 2) return;
    const start = points[0]!;
    // Between skim runs the cutter joins through #962's `link()` — the same rule the Z-level loop
    // has used since its first review, and the one finish.ts took in item 6: the link reads the
    // material field at the depth just left, stays down where the material says it may, and every
    // VERTICAL leg runs at `plungeFeed`, never as a diagonal at the cutting feed. The previous
    // vertical-lift-then-hop form was safe but expensive: F measured the organizer's rough at
    // 7,676 s of rapids against 2,387 s of cut. B's vertical-legs rule (8be24f73's link()) is the
    // one that landed, so the routing is the shared one now; the first run of the op still enters
    // from the hop plane, exactly as the Z-level loop's own first pass does.
    if (prevExit !== null) {
      const from: LinkPoint = { x: prevExit[0], y: prevExit[1], z: prevExit[2] };
      const to: LinkPoint = { x: start[0], y: start[1], z: start[2] };
      // THE TRANSIT HEIGHT IS THE OP'S OWN HOP PLANE, the height this join flew at before it went
      // through `link()` — the skim visits only cells within one step-down of the region top, and
      // the material beside them stands at that top, which `hopZMm` clears by the same margin the
      // op's own first entry already trusts. The region's clearance plane (+5 over the part top)
      // cost the organizer 619 s of rapid travel on these joins for margin it does not need.
      moves.push(...link(from, to, { ...linkOptionsFor(prevLevelZ ?? start[2]), clearanceZ: opts.hopZMm }));
    } else {
      moves.push({ kind: 'rapid', x: start[0], y: start[1], z: opts.hopZMm });
      moves.push({ kind: 'feed', x: start[0], y: start[1], z: start[2], f: opts.feeds.plungeFeedMmPerMin });
    }
    for (let q = 1; q < points.length; q++) {
      const p = points[q]!;
      moves.push({ kind: 'feed', x: p[0], y: p[1], z: p[2], f: opts.feeds.feedMmPerMin });
    }
    const end = points[points.length - 1]!;
    const line = points.map((p) => [p[0], p[1]] as [number, number]);
    const zMin = Math.min(...points.map((p) => p[2]));
    passes.push({ z: zMin, boundary: [line], cleared: { z: zMin, boundary: [line] }, entry: [start[0], start[1], start[2]], exit: [end[0], end[1], end[2]] });
    prevExit = [end[0], end[1], end[2]];
    prevLevelZ = zMin;
    skimRuns++;
  };
  for (let j = 0; j < ny; j++) {
    let i0 = -1;
    for (let i = 0; i <= nx; i++) {
      const inRun = i < nx && skimTarget(i, j) !== null;
      if (inRun && i0 < 0) i0 = i;
      if (!inRun && i0 >= 0) {
        skimRun(i0, i - 1, j);
        i0 = -1;
      }
    }
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
        name: `[T${opts.toolNumber}] Rough "${opts.region.id}"`,
        labelId: opts.region.id,
        depth,
        depthPasses: cutLevels + (skimRuns > 0 ? 1 : 0),
        passStepMm: opts.stepDownMm,
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, opts.rapid),
      },
    ],
  };

  return { ir, cutter: cutterKeyOf(opts.cutter), passes, cleared };
}

export interface RestOpOptions {
  prev: OpOutcome;
  next: Tool;
  region: RemainderRegion;
  regionRef: RegionRef;
  clSurface: ClSurface;
}

export function rest(_opts: RestOpOptions): OpOutcome {
  throw new Error('cam/model/ops/rough: rest() not implemented (#959)');
}

/**
 * `skin()` — THE FLAT SURFACE-FOLLOWING PASS OVER THE SKIN (#959, 2026-11-05 ruling; C6's
 * Makera T1 shape). The facing stage used to remove the stock above the part top; this pass does
 * it Makera's way: the flat follows the CL surface over the land, capped per pass at the cutter
 * row's own step-down (1.0 mm on the ⌀6: two passes on the tray's 1.2 mm skin, one on the
 * organizer's 0.8), and only on cells at or under `maxSlopeDeg` — steeper cells are the rough's
 * and the ball's, not the flat's.
 *
 * The machinery is the rough's own, deliberately: the target grid (CL, max over centre + corners),
 * `maskLoops` → `pocketLoops` → rings, links through `link()` against the standing surface. The
 * one difference is the target is the DESIGN (no stock-to-leave) — the pass cuts the skin down to
 * where the part is.
 */
export interface SkinOpOptions {
  cutter: Tool;
  regionRef: RegionRef;
  /** The part's outline; the pass covers `offset(outline, +2r)`, the region facing used. */
  outline: Polygons;
  /** The flat's CL over the whole scene, SHIFTED to the stock datum (IR Z 0 = the stock top). */
  clSurface: ClSurface;
  /** The skin's thickness, mm (stock top − part top). */
  skinMm: number;
  /** The per-pass cap (the cutter row's step-down). */
  stepDownMm: number;
  /** Cells steeper than this are left to the rough and the ball. */
  maxSlopeDeg: number;
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

export function skin(opts: SkinOpOptions): OpOutcome {
  const toolRadius = (cuttingDiameter(opts.cutter) ?? 0) / 2;
  if (!(toolRadius > 0)) {
    throw new Error(`cam/model/ops/rough: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const stepOver = opts.stepOverMm ?? toolRadius;
  const pitch = opts.gridPitchMm ?? Math.min(0.5, Math.max(0.1, Math.min(stepOver, toolRadius) / 4));
  const grown = opts.offset(opts.outline, 2 * toolRadius);
  const foot = grown.length > 0 ? grown : opts.outline;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of foot) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  const min: [number, number] = [minX, minY];
  const max: [number, number] = [maxX, maxY];
  const nx = Math.max(2, Math.floor((max[0] - min[0]) / pitch + 1e-9) + 1);
  const ny = Math.max(2, Math.floor((max[1] - min[1]) / pitch + 1e-9) + 1);
  const half = pitch / 2;

  // The design grid: the flat's CL, max over the cell's centre and corners (a cell straddling a
  // rise is judged by its high side, the rough's own rule).
  const target = new Float64Array(nx * ny).fill(Number.NaN);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = min[0] + i * pitch;
      const y = min[1] + j * pitch;
      let hi = -Infinity;
      for (const [dx, dy] of [[0, 0], [-half, -half], [half, -half], [-half, half], [half, half]] as const) {
        const cl = opts.clSurface.dropCutter(x + dx, y + dy);
        if (cl !== null && cl > hi) hi = cl;
      }
      if (hi > -Infinity) target[j * nx + i] = hi;
    }
  }

  // THE SLOPE GATE (the shared parameter): the grid's own gradient, in degrees. A cell whose
  // steepest neighbour departure exceeds `maxSlopeDeg` is not the flat's to take.
  const tanMax = Math.tan((Math.max(0, opts.maxSlopeDeg) * Math.PI) / 180);
  const gentle = new Uint8Array(nx * ny);
  const at = (i: number, j: number): number =>
    i < 0 || j < 0 || i >= nx || j >= ny ? Number.NaN : target[j * nx + i]!;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const t = target[j * nx + i]!;
      if (!Number.isFinite(t)) continue;
      let grad = 0;
      const left = at(i - 1, j), right = at(i + 1, j);
      const down = at(i, j - 1), up = at(i, j + 1);
      if (Number.isFinite(left)) grad = Math.max(grad, Math.abs(t - left) / pitch);
      if (Number.isFinite(right)) grad = Math.max(grad, Math.abs(right - t) / pitch);
      if (Number.isFinite(down)) grad = Math.max(grad, Math.abs(t - down) / pitch);
      if (Number.isFinite(up)) grad = Math.max(grad, Math.abs(up - t) / pitch);
      gentle[j * nx + i] = grad <= tanMax + 1e-9 ? 1 : 0;
    }
  }

  const standing: MaterialField = {
    topAt: (x, y) => {
      const i = Math.round((x - min[0]) / pitch);
      const j = Math.round((y - min[1]) / pitch);
      if (i < 0 || j < 0 || i >= nx || j >= ny) return Number.POSITIVE_INFINITY;
      const t = target[j * nx + i]!;
      return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
    },
  };
  const linkOptionsFor: LinkOptions = {
    tool: { radiusMm: toolRadius },
    feeds: { feed: opts.feeds.feedMmPerMin, plungeFeed: opts.feeds.plungeFeedMmPerMin },
    material: standing,
    clearanceZ: opts.regionRef.regionClearanceZ,
  };

  const moves: ToolpathIR['operations'][number]['moves'] = [];
  const passes: PassRef[] = [];
  const cleared: RegionAtZ[] = [];
  let prevExit: [number, number, number] | null = null;
  const comingFrom = (): readonly [number, number] => (prevExit === null ? (opts.startFrom ?? [0, 0]) : [prevExit[0], prevExit[1]]);
  let cutLevels = 0;
  for (const z of depthPasses(0, -opts.skinMm, opts.stepDownMm)) {
    const masked = new Float64Array(nx * ny);
    for (let k = 0; k < target.length; k++) {
      const t = target[k]!;
      masked[k] = Number.isFinite(t) && gentle[k] === 1 ? t : Number.NaN;
    }
    // THE SKIN'S FINAL PASS MEETS THE DESIGN: maskLoops' rule is `target + margin < levelZ`, the
    // rough's way of never cutting AT its CL — but a skin's last level sits exactly on the part
    // top, and the whole point is to reach it. A NEGATIVE tolerance makes the comparison
    // inclusive (`target <= levelZ`), the one place that sign is right.
    const polygons = maskLoops(masked, nx, ny, min[0], min[1], pitch, z, -1e-6);
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
          moves.push(...link(from, landing, linkOptionsFor));
          if (z !== prevExit[2]) moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: opts.feeds.plungeFeedMmPerMin });
        }
        moves.push(...traceRing(ring, z, opts.feeds.feedMmPerMin));
        const entry: [number, number, number] = [start[0], start[1], z];
        passes.push({ z, boundary: [ring], cleared: { z, boundary: polygons }, entry, exit: entry });
        prevExit = entry;
      }
    }
    cleared.push({ z, boundary: polygons });
  }

  const lastMove = moves[moves.length - 1];
  if (lastMove) moves.push({ kind: 'rapid', x: lastMove.x, y: lastMove.y, z: opts.safeZMm });
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
        name: `[T${opts.toolNumber}] Skin "${opts.regionRef.id}"`,
        labelId: 'skin',
        depth: opts.skinMm,
        depthPasses: cutLevels,
        passStepMm: opts.stepDownMm,
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, opts.rapid),
      },
    ],
  };
  return { ir, cutter: cutterKeyOf(opts.cutter), passes, cleared };
}
