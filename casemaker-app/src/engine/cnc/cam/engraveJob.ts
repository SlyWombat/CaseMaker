/**
 * One label → one operation: the engrave job's toolpath IR (#172).
 *
 * It takes #201's tool-opened glyph POLYGONS — never a `Profile`, never a mesh — pockets each
 * region with `pocketLoops`, stacks the depth passes, and emits the machine-independent IR.
 * It does NOT re-open, re-offset or "clean up" the polygons: they are the contract with the
 * preview (#205) and the oracle (#206).
 *
 * MOUNTED WHERE IT RUNS. The offset below is `CrossSection.offset` (Clipper2), so this needs
 * a Manifold toplevel and runs in the SIM worker (CNC work is not the geometry worker, which
 * rebuilds the case on every edit — #182 comment, item 1). It takes `tl` as a parameter
 * exactly as `executeProfile`/`sweep` do, so node tests drive it through the same wasm
 * harness (`tests/unit/helpers/manifoldExec.ts`).
 *
 * ASSUMPTIONS recorded so they are revisitable:
 *   - A STRAIGHT PLUNGE. The cutters in scope are centre-cutting end mills at shallow passes
 *     in wood. Ramped entry is a follow-up, and a non-constant-Z move is one the simulator
 *     handles conservatively (/Simulation.md §3.2).
 *   - CONVENTIONAL milling (see `MILLING`), chosen for thin, tape-held work.
 *   - Every contour hops back to `hopZ` between loops. Linking adjacent rings without
 *     retracting is an optimisation, and it is OUT OF SCOPE here because a straight link can
 *     cross an island and cut it; it would need its own issue and a containment test.
 *
 * The conversions live in exactly one place: `depth` arrives POSITIVE (mm) from `EngraveJob`,
 * and every emitted `z` is NEGATIVE (work Z, Z = 0 on the stock top). `zPasses` is that one
 * conversion.
 */

import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import type { CutParams } from '../feeds';
import { cuttingRadiusForSweep, type Tool } from '../tool';
import { drillMoves, orderHolesNearest } from './drill';
import { estimateCycleSeconds, HOP_Z, SAFE_Z, type CamMove, type CamOperation, type ToolpathIR } from './ir';
import { pocketLoops, type OffsetFn, type Polygons } from './pocket';

/**
 * A clockwise spindle, so conventional milling on the INSIDE of a pocket means travelling
 * CLOCKWISE around an outer contour and COUNTER-CLOCKWISE around an island.
 * `CrossSection.toPolygons()` returns outers CCW and holes CW, so every contour is reversed
 * (see `buildMoves`). Named and cited so the choice is one place: conventional direction cuts
 * thin, tape-held PLA (and the blank wood) with less pull-in. Revisit against #176's first
 * cut.
 */
export const MILLING = 'conventional' as const;

/** One item's opened region (#201), ready to pocket. A text label or a shape pocket (#214). */
export interface EngraveRegion {
  id: string;
  /** The label's text (empty for a shape). The FALLBACK operation name. */
  text: string;
  /**
   * The operation's ready-made display name, WITHOUT the `[T#]` prefix or the depth suffix —
   * `Engrave "CASE"`, `Pocket rect 20×10`, `Pocket circle ⌀6` (#214). Built next to the item,
   * where its kind and size are known (`itemOperationName`, `partPlan.ts`), so this layer stays
   * free of the document's shape fields. When absent the name falls back to `Engrave "<text>"`,
   * which keeps a text-only caller byte-identical.
   */
  name?: string;
  /** Positive mm. */
  depth: number;
  /** #201's opened polygons — outer CCW, holes CW. NOT re-derived here. */
  polygons: Polygons;
  /**
   * A PLUNGE DRILL (#220), present only on a drilled region. The hole CENTRES, in the stock
   * frame — one point for a `drill`, the whole lattice for a `drill-array`. Present => this
   * region is drilled, not pocketed: `polygons` is the union of cutter-radius discs (built by
   * the region builder for preview and oracle only) and CAM emits `drillMoves` instead of the
   * pocket loop. `depth` is the hole's flat floor.
   */
  drill?: { holes: [number, number][] };
}

/**
 * The real offset: Clipper2 through Manifold's `CrossSection`, with the segment count chosen
 * from the offset radius (`segmentsForRadius`) so a "round" join at a small tool radius does
 * not silently become a square (#190). The argument order is
 * `offset(delta, joinType, miterLimit, circularSegments)`.
 *
 * Both CrossSections are released on every path — CrossSection lives on the wasm heap, and a
 * leak here is paid on every regeneration (#201 hit the same trap). Exported because the
 * specs build their "region shrunk by r − ε" reference with THIS function, so the polygonized
 * arcs line up instead of differing by a chord error.
 */
export function makeClipperOffset(tl: ManifoldToplevel): OffsetFn {
  const CS = tl.CrossSection;
  return (region, delta) => {
    // `ofPolygons([])` throws; an empty region has no rings, so short-circuit.
    if (region.length === 0) return [];
    const cs = CS.ofPolygons(region);
    const out = cs.offset(delta, 'Round', 2, segmentsForRadius(Math.abs(delta)));
    const polygons = out.toPolygons() as Polygons;
    out.delete();
    cs.delete();
    return polygons;
  };
}

/**
 * The negative cutting Z for each depth pass of a label, shallowest first.
 *
 * `z_k = −min(k × stepDown, depth)` for `k = 1…n`, where `n = ceil(depth / stepDown)`; the
 * last pass lands EXACTLY on `−depth`. A float `ceil` can produce a final pass of ~zero
 * height, so a trailing pass thinner than 1e-6 mm is dropped (and the previous pass already
 * sits on the floor).
 */
export function zPasses(depth: number, stepDown: number): number[] {
  let n = Math.ceil(depth / stepDown);
  if (n > 0 && depth - (n - 1) * stepDown < 1e-6) n -= 1;
  const passes: number[] = [];
  for (let k = 1; k <= n; k++) passes.push(-Math.min(k * stepDown, depth));
  return passes;
}

/** Index of the vertex nearest `target`; ties go to the LOWEST index (deterministic start point). */
function nearestVertexIndex(contour: readonly [number, number][], target: readonly [number, number]): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < contour.length; i++) {
    const [x, y] = contour[i]!;
    const dx = x - target[0];
    const dy = y - target[1];
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * The first point this label cuts: the start of the innermost ring's first contour, with the
 * contour reversed (milling direction) and rotated to begin nearest the origin — the same
 * rotation `buildMoves` applies with its initial previous position of (0, 0). Labels are
 * ordered by this point, so it must be a pure function of the label.
 */
function firstCuttingPoint(rings: Polygons[]): [number, number] {
  if (rings.length === 0) return [0, 0];
  const inner = rings[rings.length - 1]!;
  if (inner.length === 0) return [0, 0];
  const reversed = [...inner[0]!].reverse();
  return reversed[nearestVertexIndex(reversed, [0, 0])]!;
}

interface Prepared {
  label: EngraveRegion;
  rings: Polygons[];
  passes: number[];
  firstCut: [number, number];
  /** A drilled region's moves, computed at prepare time (#220). Present => `buildMoves` is not used. */
  drillMoves?: CamMove[];
}

/** Greedy nearest-neighbour from (0, 0) on each label's first cutting point; ties by `labelId`. */
function orderNearest(items: readonly Prepared[]): Prepared[] {
  const remaining = [...items];
  const ordered: Prepared[] = [];
  const position: [number, number] = [0, 0];
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i]!;
      const dx = item.firstCut[0] - position[0];
      const dy = item.firstCut[1] - position[1];
      const distance = dx * dx + dy * dy;
      const tieById = Math.abs(distance - bestDistance) <= 1e-9 && item.label.id < remaining[bestIndex]!.label.id;
      if (distance < bestDistance - 1e-9 || tieById) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    const chosen = remaining.splice(bestIndex, 1)[0]!;
    ordered.push(chosen);
    position[0] = chosen.firstCut[0];
    position[1] = chosen.firstCut[1];
  }
  return ordered;
}

/**
 * The moves for one operation: every pass, every ring innermost first (the wall is finished by
 * a light final cut), every contour. Between contours the tool hops to `hopZ`; the operation
 * ends with a retract to `safeZ` (the move before an operation's first rapid is therefore
 * always `safeZ`).
 *
 * Direction: every contour is reversed (see `MILLING`). Start point: each contour is rotated to
 * begin at the vertex nearest the previous position, ties to the lowest index. The initial
 * previous position is (0, 0) — the same choice `firstCuttingPoint` makes, so the ordering and
 * the generated path agree.
 */
function buildMoves(prepared: Prepared, params: CutParams): CamMove[] {
  const moves: CamMove[] = [];
  const previous: [number, number] = [0, 0];
  for (const z of prepared.passes) {
    for (let ri = prepared.rings.length - 1; ri >= 0; ri--) {
      for (const contour of prepared.rings[ri]!) {
        if (contour.length < 3) continue;
        // Conventional milling: reverse the emitted winding relative to toPolygons().
        const reversed = [...contour].reverse();
        const start = nearestVertexIndex(reversed, previous);
        const points = [...reversed.slice(start), ...reversed.slice(0, start)];
        const [x0, y0] = points[0]!;

        moves.push({ kind: 'rapid', x: x0, y: y0, z: HOP_Z });
        moves.push({ kind: 'feed', x: x0, y: y0, z, f: params.plungeFeed });
        for (let j = 1; j < points.length; j++) {
          const [x, y] = points[j]!;
          moves.push({ kind: 'feed', x, y, z, f: params.feed });
        }
        // Close the loop back on its start point.
        moves.push({ kind: 'feed', x: x0, y: y0, z, f: params.feed });
        moves.push({ kind: 'rapid', x: x0, y: y0, z: HOP_Z });
        previous[0] = x0;
        previous[1] = y0;
      }
    }
  }
  if (moves.length > 0) {
    moves.push({ kind: 'rapid', x: previous[0], y: previous[1], z: SAFE_Z });
  }
  return moves;
}

/**
 * The toolpath IR for a set of opened label regions.
 *
 * `labels` are #201's opened regions in document order; `tool` must be a plain flat end mill
 * (`cuttingRadiusForSweep`), and `params` arrive from `feedsFor` (#202) — this module owns no
 * feeds, RPM or step values. `order` is the label ordering strategy; only `'nearest'` exists
 * in V1.
 */
export function generateEngrave(
  tl: ManifoldToplevel,
  labels: readonly EngraveRegion[],
  tool: Tool,
  params: CutParams,
  order: 'nearest' = 'nearest',
): ToolpathIR {
  const radiusResult = cuttingRadiusForSweep(tool);
  if (!radiusResult.ok) throw new Error(`generateEngrave: ${radiusResult.reason}`);
  const toolRadius = radiusResult.radius;
  const toolNumber = tool.number ?? 1;
  const offset = makeClipperOffset(tl);

  const prepared: Prepared[] = labels.map((label) => {
    if (label.drill) {
      // Drilled region (#220): no rings to pocket. The holes are visited nearest-neighbour and
      // the FIRST becomes the operation's first cutting point, so the ordering and the emitted
      // path agree exactly as they do for a pocket.
      const holes = orderHolesNearest(label.drill.holes);
      return {
        label,
        rings: [],
        passes: [],
        firstCut: holes[0] ?? [0, 0],
        drillMoves: drillMoves(holes, label.depth, params.peck, params),
      };
    }
    const rings = pocketLoops(label.polygons, toolRadius, params.stepOver, offset);
    return {
      label,
      rings,
      passes: zPasses(label.depth, params.stepDown),
      firstCut: firstCuttingPoint(rings),
    };
  });

  const strategies: Record<'nearest', (items: readonly Prepared[]) => Prepared[]> = { nearest: orderNearest };
  // Drills run FIRST, before any cut-out (#220 work item 4): a peck cycle leaves the blank
  // unweakened, whereas a finished cut-out can let the part shift under the tape. Within each
  // group the ordering is unchanged, so a job with no drills is byte-identical to before.
  const drilled = prepared.filter((p) => p.drillMoves !== undefined);
  const pocketed = prepared.filter((p) => p.drillMoves === undefined);
  const ordered =
    drilled.length === 0
      ? strategies[order](prepared)
      : [...strategies[order](drilled), ...strategies[order](pocketed)];

  const operations: CamOperation[] = ordered.map((item, index) => {
    const moves = item.drillMoves ?? buildMoves(item, params);
    // A shape's ready-made descriptor when the caller supplied one (#214); otherwise the
    // label text, exactly as before, so a text-only caller's `.nc` is unchanged.
    const descriptor = item.label.name ?? `Engrave "${item.label.text}"`;
    return {
      number: index + 1,
      name: `[T${toolNumber}]${descriptor} ${item.label.depth.toFixed(1)}mm`,
      labelId: item.label.id,
      depth: item.label.depth,
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
