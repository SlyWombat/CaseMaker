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
import { DEFAULT_SHORT_HOP_DIAMETERS, link, pathClClear, type LinkOptions, type LinkPoint, type MaterialField } from '../linking';
import { followLinearCutSurface, ridesCutSurface } from '../rideTest';
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
  /**
   * #962 — THE DESIGN'S TOP AT (x, y), in this op's datum, for the material field where the
   * sampled grid has no answer. The linker's tests and B's disc-aware down-leg floor read the
   * field up to a cutter radius past the grid's own edge, where the region's own top is NOT an
   * upper bound — a wall or land beside it can stand higher. Absent → the field states nothing
   * past the grid, exactly as before.
   */
  materialTopAt?: (x: number, y: number) => number | null;
  /** The stock top in this op's datum — the last-resort bound past the grid (see above). */
  stockTopZMm?: number;
  /**
   * #982 — BALL-AS-ROUGH ONLY (the no-flat fallback): every cut point must lie inside the
   * region's own footprint. A cell straddling the footprint edge keeps only its inside corner's
   * CL in the sampled grid, and cutting at its outside centre puts the ball's flank — which
   * reaches a full radius above the tip — into the part beside it (the balls-only elephant: the
   * centre's exact CL −1.432, the grid's lone inside corner −2.407, 0.95 mm of cut-into). Absent
   * → the flat's own path, unchanged.
   */
  cutPointInRegion?: boolean;
}

/**
 * #962 — THE MATERIAL FIELD OVER A SAMPLED GRID, with a true upper bound past it.
 *
 * `core` answers where the grid does (null outside its own reach). Past it the field answers the
 * DESIGN's top there (`materialTopAt`, the plan's goal/mesh heightfield), the stock top where even
 * the design is silent, and `+Infinity` only when the caller supplies neither — the safe old
 * default. The fallbacks exist because both readers of the field reach past the grid's edge —
 * the down-leg's disc-aware floor (B's 61ea3dd6) and `linkIsClear` — and an answer of +Infinity
 * costs the rapid-to-floor split, while the region's own top would be an UNDER-estimate wherever
 * a taller neighbour stands beside it.
 */
export function gridMaterial(
  core: (x: number, y: number) => number | null,
  opts: Pick<RoughOpOptions, 'materialTopAt' | 'stockTopZMm'>,
): MaterialField {
  return {
    topAt: (x, y) => {
      const v = core(x, y);
      if (v !== null) return v;
      const design = opts.materialTopAt?.(x, y);
      if (design !== null && design !== undefined) return design;
      return opts.stockTopZMm ?? Number.POSITIVE_INFINITY;
    },
  };
}

/** The ops' sampling-grid pitch for a flat: `min(0.5, max(0.1, min(stepOver, radius) / 4))`.
 * Exported so the plan's one shared grid (#970) matches the rough's own. */
export function gridPitchFor(stepOverMm: number | undefined, radiusMm: number): number {
  const stepOver = stepOverMm ?? radiusMm;
  return Math.min(0.5, Math.max(0.1, Math.min(stepOver, radiusMm) / 4));
}

interface SkimTourStep {
  index: number;
  reversed: boolean;
}

/**
 * #962 — THE SKIM'S RUN TOUR: nearest ENDPOINT from where the tool is, then 2-opt over the run
 * order (deterministic; ties to the lower index). Each run is an edge with two ends, so a 2-opt
 * move REVERSES a stretch of the order and flips those runs' directions; the stretch's internal
 * distances are unchanged and only its two boundary edges can improve — the delta needs no rebuild.
 * The first and last steps never move: the path's start is where the tool already is and its end is
 * where it stops.
 */
function tourSkimRuns(
  runs: readonly (readonly [number, number, number][])[],
  from: readonly [number, number],
): SkimTourStep[] {
  const remaining = runs.map((_, k) => k);
  const steps: SkimTourStep[] = [];
  let px = from[0];
  let py = from[1];
  while (remaining.length > 0) {
    let bestPos = 0;
    let bestReversed = false;
    let best = Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const pts = runs[remaining[k]!]!;
      const a = pts[0]!;
      const b = pts[pts.length - 1]!;
      const da = Math.hypot(a[0] - px, a[1] - py);
      const db = Math.hypot(b[0] - px, b[1] - py);
      const reversed = db < da;
      const d = Math.min(da, db);
      if (d < best - 1e-12) {
        best = d;
        bestPos = k;
        bestReversed = reversed;
      }
    }
    const index = remaining.splice(bestPos, 1)[0]!;
    steps.push({ index, reversed: bestReversed });
    const pts = runs[index]!;
    const end = bestReversed ? pts[0]! : pts[pts.length - 1]!;
    px = end[0];
    py = end[1];
  }
  const entryOf = (s: SkimTourStep): readonly [number, number, number] => {
    const pts = runs[s.index]!;
    return s.reversed ? pts[pts.length - 1]! : pts[0]!;
  };
  const exitOf = (s: SkimTourStep): readonly [number, number, number] => {
    const pts = runs[s.index]!;
    return s.reversed ? pts[0]! : pts[pts.length - 1]!;
  };
  const d = (a: readonly [number, number, number], b: readonly [number, number, number]): number =>
    Math.hypot(b[0] - a[0], b[1] - a[1]);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 64) {
    improved = false;
    for (let i = 1; i + 1 < steps.length; i++) {
      // k may be the LAST step: flipping the tail changes only the edge into i and leaves the
      // path's end wherever the flipped tail puts it. Without this the greedy's stranded tail
      // survived — the fixture kept one 30 mm jump at the end among otherwise 0.5 mm turns.
      for (let k = i; k < steps.length; k++) {
        const before = d(exitOf(steps[i - 1]!), entryOf(steps[i]!))
          + (k + 1 < steps.length ? d(exitOf(steps[k]!), entryOf(steps[k + 1]!)) : 0);
        const after = d(exitOf(steps[i - 1]!), exitOf(steps[k]!))
          + (k + 1 < steps.length ? d(entryOf(steps[i]!), entryOf(steps[k + 1]!)) : 0);
        if (after < before - 1e-9) {
          const flipped = steps.slice(i, k + 1).reverse().map((s) => ({ index: s.index, reversed: !s.reversed }));
          steps.splice(i, k - i + 1, ...flipped);
          improved = true;
        }
      }
    }
  }
  return steps;
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
  cutPoint: (i: number, j: number) => boolean,
): Polygons {
  const inside = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < nx && j < ny &&
    Number.isFinite(target[j * nx + i]!) && target[j * nx + i]! + marginMm < levelZ &&
    // #982 — the ball fallback's rule: a cell whose own centre is outside the region never joins a
    // level's mask (the rings are offset from the mask, so a straddling cell would put one there).
    cutPoint(i, j);
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
  const pitch = opts.gridPitchMm ?? gridPitchFor(stepOver, toolRadius);
  const { min, max } = opts.regionRef.bounds;
  const nx = Math.max(2, Math.floor((max[0] - min[0]) / pitch + 1e-9) + 1);
  const ny = Math.max(2, Math.floor((max[1] - min[1]) / pitch + 1e-9) + 1);

  // ONE sampling pass: each cell's target is the MAX of the drop-cutter over the cell's centre and
  // four corners — a cell that straddles a rise is judged by its high side, never its low one.
  const target = new Float64Array(nx * ny).fill(Number.NaN);
  // #982 — WHERE THE CELL'S OWN CENTRE ANSWERS (inside the region): the first sample of each cell
  // is its centre, so this costs nothing. Read only when `cutPointInRegion` is set.
  const centreIn = new Uint8Array(nx * ny);
  const half = pitch / 2;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = min[0] + i * pitch;
      const y = min[1] + j * pitch;
      let hi = -Infinity;
      let first = true;
      for (const [dx, dy] of [[0, 0], [-half, -half], [half, -half], [-half, half], [half, half]] as const) {
        const cl = opts.clSurface.dropCutter(x + dx, y + dy);
        if (first) {
          centreIn[j * nx + i] = cl === null ? 0 : 1;
          first = false;
        }
        if (cl !== null && cl > hi) hi = cl;
      }
      if (hi > -Infinity) target[j * nx + i] = hi + leave;
    }
  }
  const cutPoint = (i: number, j: number): boolean => opts.cutPointInRegion !== true || centreIn[j * nx + i] === 1;

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
  // ITEM 7 — the field reports the STANDING SURFACE (the target grid), never a level floor under
  // it. `math.max(levelZ, target)` was honest only for a link travelling at that same level's
  // own z: at any other travel height it claims a floor that pass never left, and the skim's
  // first link() routing trusted it and fed THROUGH standing material (the organizer's rough
  // measured 10,063 s -> 18,645 s before this fix). Past the grid, #962's true upper bound (the
  // goal/mesh top, else the stock top) — see `gridMaterial`.
  const materialFor = (_levelZ: number): MaterialField =>
    gridMaterial((x, y) => {
      const t = targetAt(x, y);
      return Number.isFinite(t) ? t : null;
    }, opts);

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
    const polygons = maskLoops(target, nx, ny, min[0], min[1], pitch, z, margin, cutPoint);
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
          moves.push(...link(from, landing, { ...linkOptionsFor(prevLevelZ ?? prevExit[2]) }));
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
    if (!(cl < opts.region.zTop && cl >= skimFirstLevel)) return null;
    // #982 — THE CELL IS CUT AT ITS OWN CENTRE, WHICH MUST BE IN THE REGION (the ball fallback's
    // rule; see `cutPointInRegion`): a straddling cell's value is its one inside corner's.
    return cutPoint(i, j) ? cl : null;
  };
  // #962 — THE SKIM'S OWN STANDING SURFACE, the field its joins read. `materialFor` reports the
  // rough's TARGET (cl + band) everywhere: the material the Z-levels are to LEAVE. But the skim
  // does not leave it — it cuts the band down to the CL wherever it may cut (the gentle cells,
  // the same mask its own rows use). Reporting the target to a skim join therefore says 0.3 mm of
  // material stands above the tool at EVERY point of the join, including the row the skim has
  // just cut, and `linkIsClear` refuses it at the first disc sample: the organizer's 804 joins per
  // pass cost 3,097 s of up-across-down for 0.5 mm steps. This field reports the skim's own cut
  // surface (the CL) where the skim cuts, the target everywhere else — so a join between two
  // skimmed rows rides down, and a join whose disc reaches a cell the skim does not cut (steep,
  // or outside its band) still retracts.
  const skimStanding = gridMaterial((x, y) => {
    const i = Math.round((x - min[0]) / pitch);
    const j = Math.round((y - min[1]) / pitch);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
    const t = target[j * nx + i]!;
    if (!Number.isFinite(t)) return null;
    // #982 — a cell whose own centre is outside the region is NOT cut by the skim, so it must not
    // report the cut surface either: the ride test then reads the design top (materialTopAt) and
    // retracts, instead of riding a join 0.44 mm into the part beside it.
    if (!cutPoint(i, j)) return null;
    const cl = t - skimLeave;
    // The rough's skim has no slope gate (that belongs to the skin op): it cuts every cell of its
    // band, so every band cell reports its own cut surface here.
    return cl < opts.region.zTop && cl >= skimFirstLevel ? cl : t;
  }, opts);
  let skimRuns = 0;
  const skimEmit = (points: [number, number, number][]): void => {
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
      // #962 — THE SKIM'S JOIN RIDES ITS OWN TARGET. The field alone does not unlock these joins:
      // `linkIsClear` tests the whole cutter DISC, and a 0.5 mm join's disc necessarily reaches
      // cells the skim has not cut yet, which stand at the target (cl + band) above the link's z —
      // refused, even when the field reports the skim's own cut surface (measured: the field fix
      // alone is worth 23 s). But the join cuts the band exactly as the rows either side of it do;
      // what must be proved is that it does not cut BELOW the skim's own target. So sample the
      // link at its centre and require z >= the skim target there — the finish's `ridesTheCl`,
      // against this op's own grid. A join over a cell outside the band still retracts.
      // BAND CELLS ONLY: a join whose path leaves the skim's band crosses ground this op is not
      // cutting, and stays a retract. Measured: allowing the deeper cells as well (their material
      // stands below the link) converted more joins but made the plan SLOWER — 13,290.6 ->
      // 13,068.8 s against this version's 12,982.2 — because the longer stay-down feeds at the
      // cutting rate lose to the rapid they replace. THE SHORT HOP (B's review of e3f25fc7): a
      // ride longer than Kiri's 2 x diameter is a retract by rule, cap included in `ridesCutSurface`.
      // THE HONEST STANDING FIELD (#962, the out-of-band class): band cells are the skim's own cut
      // surface, every other cell its own target — the deeper ground's material stands below z, so
      // a stay-down over it is safe, and the cells ABOVE the band still refuse. (The earlier
      // unguarded version of this converted more joins and measured 86 s slower; the follow's time
      // guard now keeps only the profitable ones.)
      const rides = ridesCutSurface(
        { x: from.x, y: from.y, z: from.z },
        { x: to.x, y: to.y, z: to.z },
        skimStanding.topAt,
        opts.clSurface.toleranceMm,
        DEFAULT_SHORT_HOP_DIAMETERS * 2 * toolRadius,
        pitch,
      ) &&
        // #982/#1001 — EVERY CUTTER PROVES THE RIDE EXACTLY. `ridesCutSurface` reads the standing
        // field along the join's CENTRE line only — a GRID of point samples — so a rise between
        // its samples is invisible; the ball's disc reaching sideways let a 3.6 mm ride cut
        // 0.44 mm into the part beside it (#982, the balls-only elephant), and the flat's disc
        // reaches a full radius too: the organizer STL row's (57.1, 99.8) cell is a flat skim
        // join whose grid proof passed and whose 20° descent cut 0.186 mm into the slope beside
        // it (#1001). The exact CL at a point already accounts for the whole disc — the tip there
        // first touches the design — so the ride must also pass `pathClClear` against the surface,
        // the same necessary proof the link above/retract below uses, for every cutter (#982 had
        // it on for the ball fallback only; the flat's own joins are proven now too).
        pathClClear(from, to, (x, y) => opts.clSurface.dropCutter(x, y), Math.max(pitch / 4, 0.05), opts.clSurface.toleranceMm);
      if (rides) {
        const f = to.z < from.z - 1e-9 ? opts.feeds.plungeFeedMmPerMin : opts.feeds.feedMmPerMin;
        moves.push({ kind: 'feed', x: to.x, y: to.y, z: to.z, f });
      } else {
        // THE DIP CLASS: follow the skim's own target where the chord would dip below it — the
        // ball cuts the band's rise exactly as the rows either side do, never below the CL.
        // #1001 — THE FOLLOW READS THE EXACT CL, not the grid: the grid's per-cell values are what
        // the join just failed to chord over, so following them would repeat the point-sample
        // blindness. The skim's own CUT MASK still decides where the join may follow at all (a
        // cell outside the band or the region is a retract, unchanged); inside it, the height is
        // the cutter's own drop-cutter value at the sample.
        const follow = followLinearCutSurface(
          { x: from.x, y: from.y, z: from.z },
          { x: to.x, y: to.y, z: to.z },
          (x, y) => {
            const i = Math.round((x - min[0]) / pitch);
            const j = Math.round((y - min[1]) / pitch);
            if (skimTarget(i, j) === null) return null;
            return opts.clSurface.dropCutter(x, y);
          },
          // #1001 — the follow samples at the PROOF's own spacing, not the grid's: a chord between
          // 0.5 mm samples of a convex CL dips below it between them, which is the very blindness
          // the proof just caught (the organizer's residual 7.7e-7 came from this).
          Math.max(pitch / 4, 0.05),
          Number.NEGATIVE_INFINITY,
          opts.feeds,
          opts.rapid,
          opts.hopZMm,
        );
        if (follow !== null) moves.push(...follow);
        else {
          // THE TRANSIT HEIGHT IS THE OP'S OWN HOP PLANE, the height this join flew at before it
          // went through `link()` — the skim visits only cells within one step-down of the region
          // top, and the material beside them stands at that top, which `hopZMm` clears by the same
          // margin the op's own first entry already trusts. The region's clearance plane (+5 over
          // the part top) cost the organizer 619 s of rapid travel on these joins for margin it does
          // not need.
          // #970 — B's link audit: the ride test above reads skimStanding, a GRID, and a rise
          // between its samples is invisible. Prove the centre line against the CL surface itself;
          // a negative short hop forces link()'s own retract where the CL does not clear, without
          // touching the shared rule.
          // #966 — NO `landingCut` HERE, DELIBERATELY. The landing is the NEXT skim row's start,
          // and the skim cuts it at ITS OWN CL — ground the program has not cut yet (the row before
          // ran at a different z). Claiming a proof here is what sent a rapid 0.739 mm below the
          // stock top through standing stock; `link()`'s retract now descends only to the stock top
          // plus the hop and feeds the rest for this join.
          const skimLinkOpts: LinkOptions = {
            ...linkOptionsFor(prevLevelZ ?? start[2]),
            material: skimStanding,
            clearanceZ: opts.hopZMm,
          };
          if (!pathClClear(from, to, (x, y) => opts.clSurface.dropCutter(x, y), Math.max(pitch / 4, 0.05), opts.clSurface.toleranceMm)) {
            skimLinkOpts.shortHopMm = -1;
          }
          moves.push(...link(from, to, skimLinkOpts));
        }
      }
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
  // 1. COLLECT every run of the skim, in its natural low-i -> high-i direction.
  const skimRunList: [number, number, number][][] = [];
  for (let j = 0; j < ny; j++) {
    let i0 = -1;
    for (let i = 0; i <= nx; i++) {
      const inRun = i < nx && skimTarget(i, j) !== null;
      if (inRun && i0 < 0) i0 = i;
      if (!inRun && i0 >= 0) {
        if (i - 1 > i0) {
          const pts: [number, number, number][] = [];
          for (let q = i0; q <= i - 1; q++) pts.push([min[0] + q * pitch, min[1] + j * pitch, skimTarget(q, j) as number]);
          skimRunList.push(pts);
        }
        i0 = -1;
      }
    }
  }
  // 2. TOUR the runs (#962): nearest ENDPOINT from where the tool already is, then 2-opt over the
  //    run order — each run's exit joins the nearest other run's start, not the next row by
  //    position. The row alternation this replaces was the special case of the same greedy where
  //    the runs happen to form full rows; on the organizer's sparse band it could not see the
  //    short step to the run beside it.
  const tourFrom: readonly [number, number] = prevExit === null ? (opts.startFrom ?? [min[0], min[1]]) : [prevExit[0], prevExit[1]];
  for (const step of tourSkimRuns(skimRunList, tourFrom)) {
    const pts = skimRunList[step.index]!;
    skimEmit(step.reversed ? [...pts].reverse() : pts);
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
  /** #962 — the design's top past the grid, for the material field (see `gridMaterial`). */
  materialTopAt?: (x: number, y: number) => number | null;
  /** #962 — the stock top in this op's datum, the last-resort bound (see `gridMaterial`). */
  stockTopZMm?: number;
}

export interface SkinTargetGrid {
  nx: number;
  ny: number;
  min: [number, number];
  pitch: number;
  /** The CL sampled once per grid point (the cell's own centre), row-major `j*nx+i`. */
  clGrid: Float64Array;
  /** Per cell, the design target: the max CL over the cell and its eight neighbours (NaN where none sampled). */
  target: Float64Array;
}

/**
 * #970 — the skin's own target grid, one `dropCutter` call per grid point (reused as both a
 * cell's own centre sample and a corner of its four diagonal neighbours), instead of the 5
 * radius-3 `dropCutter` calls per cell the exact rule costs (its share of the elephant's 7.6x).
 *
 * The design grid: the flat's CL, max over the cell's centre and corners (a cell straddling a
 * rise is judged by its high side, the rough's own rule, `rough()`'s own header above). A
 * half-pitch corner sits exactly midway between the cell's own grid point and ONE diagonal
 * neighbour, tied with its two axis neighbours too (all four equidistant from the true corner) —
 * so the four corners' own tied candidate sets union to exactly the 3x3 block of grid points
 * centred on the cell, and maxing all four corners is maxing that whole block. Read directly by
 * integer index, no rounding of a continuous coordinate at all: an earlier version asked
 * `clAt(x±half, y±half)` for a point that never lands exactly on a grid sample, and
 * `Math.round`'s tie-break (round HALF UP) is directional — `+half` always lands one cell over,
 * `-half` always lands back on the SAME cell — so all four "corners" collapsed onto the single
 * 2x2 block `{i, i+1} x {j, j+1}`, a block centred a quarter-pitch off the cell in both axes, not
 * on it (#970, E's SKIN-EQUIV finding on the organizer: 19,331 of 111,918 cells differed from the
 * per-query five-sample rule, 2,451 by more than 0.5 mm, the worst by 22 mm).
 */
export function skinTargetGrid(clSurface: ClSurface, foot: Polygons, pitch: number): SkinTargetGrid {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of foot) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  const min: [number, number] = [minX, minY];
  const nx = Math.max(2, Math.floor((maxX - minX) / pitch + 1e-9) + 1);
  const ny = Math.max(2, Math.floor((maxY - minY) / pitch + 1e-9) + 1);

  const clGrid = new Float64Array(nx * ny).fill(Number.NaN);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = clSurface.dropCutter(min[0] + i * pitch, min[1] + j * pitch);
      if (v !== null) clGrid[j * nx + i] = v;
    }
  }
  const target = new Float64Array(nx * ny).fill(Number.NaN);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let hi = -Infinity;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= nx) continue;
          const cl = clGrid[jj * nx + ii]!;
          if (cl > hi) hi = cl;
        }
      }
      if (hi > -Infinity) target[j * nx + i] = hi;
    }
  }
  return { nx, ny, min, pitch, clGrid, target };
}

export function skin(opts: SkinOpOptions): OpOutcome {
  const toolRadius = (cuttingDiameter(opts.cutter) ?? 0) / 2;
  if (!(toolRadius > 0)) {
    throw new Error(`cam/model/ops/rough: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const stepOver = opts.stepOverMm ?? toolRadius;
  const pitch = opts.gridPitchMm ?? gridPitchFor(stepOver, toolRadius);
  const grown = opts.offset(opts.outline, 2 * toolRadius);
  const foot = grown.length > 0 ? grown : opts.outline;
  const { nx, ny, min, target } = skinTargetGrid(opts.clSurface, foot, pitch);

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

  const standing: MaterialField = gridMaterial((x, y) => {
    const i = Math.round((x - min[0]) / pitch);
    const j = Math.round((y - min[1]) / pitch);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
    const t = target[j * nx + i]!;
    return Number.isFinite(t) ? t : null;
  }, opts);
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
    const polygons = maskLoops(masked, nx, ny, min[0], min[1], pitch, z, -1e-6, () => true);
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
          // #970 — B's link audit: `standing` is a GRID, and a rise between its samples is
          // invisible to `linkIsClear`. Prove the centre line against the CL surface itself; a
          // negative short hop refuses the stay-down without touching the shared rule, so
          // link() still emits its own retract (vertical legs, hop floor) when the proof fails.
          const clClear = pathClClear(from, landing, (x, y) => opts.clSurface.dropCutter(x, y), Math.max(pitch / 4, 0.05), opts.clSurface.toleranceMm);
          moves.push(...link(from, landing, { ...(clClear ? linkOptionsFor : { ...linkOptionsFor, shortHopMm: -1 }) }));
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
