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
import { cuttingForTrace, type Tool } from '../tool';
import { vCarvePassPitch } from '../vCarveGeometry';
import { boreMoves, drillMoves, orderHolesNearest } from './drill';
import {
  estimateCycleSeconds,
  HOP_Z,
  SAFE_Z,
  type CamMove,
  type CamOperation,
  type CamPassKind,
  type RapidEstimate,
  type ToolpathIR,
  toolNumberFor,
} from './ir';
import { pocketLoops, type OffsetFn, type Polygons } from './pocket';
import { tourNearest, twoOptOrder } from './tour';

/**
 * A clockwise spindle, so conventional milling on the INSIDE of a pocket means travelling
 * CLOCKWISE around an outer contour and COUNTER-CLOCKWISE around an island.
 * `CrossSection.toPolygons()` returns outers CCW and holes CW, so every contour is reversed
 * (see `buildMoves`). Named and cited so the choice is one place: conventional direction cuts
 * thin, tape-held PLA (and the blank wood) with less pull-in. Revisit against #176's first
 * cut.
 */
export const MILLING = 'conventional' as const;

/**
 * The three outlines a V-carve region has (#221), and where the colour plane sits. The CAM uses
 * `planeRadius` for its offset; the preview draws all three and the oracle predicts `floor`.
 * `plane` is the same polygon set as the region's `polygons` — kept here so a consumer holding
 * only the cut has the whole geometry without re-deriving it.
 */
export interface VCarveRegion {
  /** The design at the colour plane — the polygons this region pockets. */
  plane: Polygons;
  /** The floor at `depth`, `floorInset` narrower per side. */
  floor: Polygons;
  /** The opening at the top face, `surfaceOutset` wider per side. */
  surface: Polygons;
  /** The colour plane's depth below the top face, mm — the cut's depth when there is no film. */
  planeDepth: number;
  /** `tipRadius + belowPlane·tanHalf`: the CAM's inward offset of the design, mm. */
  planeRadius: number;
  floorInset: number;
  surfaceOutset: number;
}

/**
 * #250 — the finish pass as the CAM receives it.
 *
 * `mode` says which half of the pair THIS program cuts, because one program is one tool and the
 * split that decides how many programs a job has is #472's (setup, tool) split, not a second one
 * here:
 *   - `rough-and-finish`: the same cutter cuts both passes, in this file;
 *   - `rough-only`: the first cutter of a multi-tool setup leaves the allowance for a named later
 *     cutter, whose measured-rest program is `finish-only`;
 *   - `finish-only`: the later cutter's program, cutting its rest geometry at full depth.
 *
 * Only a FLAT cutter is split. A V-carve region is cut by the cone's whole geometry and a drill,
 * trace or thread is not a pocket, so those keep their one-pass output even when the job names an
 * allowance. `stockToLeaveMm <= 0` disables the split entirely (the pre-#250 output).
 */
export interface FinishPassSpec {
  /** Material left on the walls and floor by the roughing pass, mm. */
  stockToLeaveMm: number;
  mode: 'rough-and-finish' | 'rough-only' | 'finish-only';
}

/** One item's opened region (#201), ready to pocket. A text label or a shape pocket (#214). */export interface EngraveRegion {
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
   * A V-carve's plane/floor/surface geometry (#221), present only when this region is cut by a
   * cone. The CAM takes its offset and stepover from here; absent on a V region means the caller
   * has no film, so the plane is the floor and the tip radius is the offset.
   */
  vCarve?: VCarveRegion;
  /**
   * A PLUNGE DRILL (#220), present only on a drilled region. The hole CENTRES, in the stock
   * frame — one point for a `drill`, the whole lattice for a `drill-array`. Present => this
   * region is drilled, not pocketed: `polygons` is the union of cutter-radius discs (built by
   * the region builder for preview and oracle only) and CAM emits `drillMoves` instead of the
   * pocket loop. `depth` is the hole's flat floor.
   *
   * #668 — `bore` makes it a HOLE TO SIZE: the cutter helixes down the wall of a hole `radius`
   * wide (`boreMoves`) instead of plunging, and `polygons` is that hole's disc — the region
   * builder puts the HOLE's radius here, not the cutter's, so the preview and the oracle see the
   * cylinder the job asked for.
   */
  drill?: {
    holes: [number, number][];
    bore?: { radius: number };
  };
  /**
   * This region cuts through the blank into the under-board (#218). `depth` already carries
   * `thickness + breakthrough`; the flag is what marks the operation as a `'through'` pass and
   * what the preview/verifier read as "the floor is the board, not the part".
   *
   * #668 — a through region also carries the BLANK's own thickness, because a bore cuts its core
   * level by level and must clear the core to the blank's underside before the cutter crosses it
   * (`boreLevels`): the level that frees the core has to be the one that clears it.
   */
  through?: boolean;
  /** #668 — the blank's thickness, mm, on a through region (see `through`); unread by any other cut. */
  stockThickness?: number;
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
function nearestVertexIndex(
  contour: readonly (readonly [number, number])[],
  target: readonly [number, number],
): number {
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
 * A contour in emitted winding (reversed — see `MILLING`), rotated to begin at the vertex
 * nearest `target`; ties to the lowest index. The first point is the loop's entry AND its exit:
 * the loop closes back on it.
 */
function entryOn(
  contour: readonly (readonly [number, number])[],
  target: readonly [number, number],
): [number, number][] {
  const reversed = [...contour].reverse();
  const start = nearestVertexIndex(reversed, target);
  return [...reversed.slice(start), ...reversed.slice(0, start)] as [number, number][];
}

/** The mean of a contour's vertices — the point a tour compares loops by (#487). */
function centroidOf(contour: readonly (readonly [number, number])[]): [number, number] {
  let sx = 0;
  let sy = 0;
  for (const [x, y] of contour) {
    sx += x;
    sy += y;
  }
  return [sx / contour.length, sy / contour.length];
}

/**
 * The first point this region cuts when it is the first one placed: the innermost ring's NEAREST
 * contour to the origin, entered at its nearest vertex. Labels are ordered by this point, and the
 * proximity order places the innermost ring first, so the two agree.
 */
function firstCuttingPoint(rings: Polygons[]): [number, number] {
  if (rings.length === 0) return [0, 0];
  const inner = rings[rings.length - 1]!;
  let best: [number, number] = [0, 0];
  let bestDistance = Infinity;
  for (const contour of inner) {
    if (contour.length < 3) continue;
    const [x, y] = entryOn(contour, [0, 0])[0]!;
    const distance = x * x + y * y;
    if (distance < bestDistance - 1e-9) {
      bestDistance = distance;
      best = [x, y];
    }
  }
  return best;
}

/** One pass of one item: its rings and the Z levels it cuts them at (#250). */
interface PreparedPass {
  rings: Polygons[];
  /** Negative work Z, shallowest first. */
  passes: number[];
  /** `rough`/`finish` when the item was split; absent on a one-pass cut. */
  passKind?: Extract<CamPassKind, 'rough' | 'finish'>;
}

interface Prepared {
  label: EngraveRegion;
  /** One entry for a one-pass cut; two (rough then finish) when #250 split the item. */
  passList: PreparedPass[];
  firstCut: [number, number];
  /** A drilled region's moves, computed at prepare time (#220). Present => `buildMoves` is not used. */
  drillMoves?: CamMove[];
}

/**
 * Greedy nearest-neighbour from (0, 0) on each label's first cutting point, ties by `labelId`,
 * then a 2-opt pass over that order (#487 item 1).
 */
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
  const improved = twoOptOrder(
    ordered.map((item) => item.firstCut),
    ordered.map((_, i) => i),
  );
  return improved.map((i) => ordered[i]!);
}

/** How a region's loops are ordered (#487). `document` is the pre-#487 order, kept to price it. */
export type LoopOrder = 'proximity' | 'document';

/** One loop of one depth pass, already rotated to its entry vertex. */
interface PlacedLoop {
  /** Emitted winding, rotated so `points[0]` is the entry — and the exit, because the loop closes. */
  points: [number, number][];
  /** The entry vertex, repeated for readability at the emit site. */
  entry: [number, number];
  /** Work Z, negative. */
  z: number;
}

/**
 * Place one region's loops in cut order, without emitting moves.
 *
 * RINGS ARE INNERMOST FIRST IN BOTH ORDERS. That is #173's rule — the wall is finished by a
 * light final cut — and it is a machining rule, not a convenience, so an optimisation does not
 * get to reverse it.
 *
 * `'document'` is the pre-#487 order: a level at a time across the whole region, every ring,
 * every contour in the order the offset emitted them. It is kept because the before/after the
 * issue asks for has to be the REAL old order, not a re-derivation of it.
 *
 * `'proximity'` is #487's: within ONE ring the contours are visited in a nearest-neighbour tour
 * with a 2-opt pass, and each contour is taken to its full depth before the next is entered —
 * "each letter to full depth, then the next". The tool therefore crosses the design once per
 * ring, not once per ring per pass, and enters every loop at the vertex nearest where it just
 * was (item 3). Rings are compared by their centroid; the entry itself is the nearest VERTEX.
 *
 * `from` is where the tool already is — the previous operation's exit. The pre-#487 emitter used
 * (0, 0) for every operation; the baseline here keeps that rule, which is one of the things the
 * comparison measures.
 */
function placeLoops(
  pass: PreparedPass,
  order: LoopOrder,
  from: readonly [number, number],
): PlacedLoop[] {
  const contours = pass.rings
    .map((ring) => ring.filter((contour) => contour.length >= 3))
    .filter((ring) => ring.length > 0);
  const loops: PlacedLoop[] = [];
  const previous: [number, number] = [from[0], from[1]];
  const place = (contour: readonly (readonly [number, number])[], z: number): void => {
    const points = entryOn(contour, previous);
    loops.push({ points, entry: points[0]!, z });
    previous[0] = points[0]![0];
    previous[1] = points[0]![1];
  };

  if (order === 'document') {
    for (const z of pass.passes) {
      for (let ri = contours.length - 1; ri >= 0; ri--) {
        for (const contour of contours[ri]!) place(contour, z);
      }
    }
    return loops;
  }

  for (let ri = contours.length - 1; ri >= 0; ri--) {
    const ring = contours[ri]!;
    const tour = tourNearest(ring.map(centroidOf), previous);
    for (const k of tour) {
      const contour = ring[k]!;
      // Depth first: this contour is finished before the tool leaves it.
      for (const z of pass.passes) place(contour, z);
    }
  }
  return loops;
}

/**
 * The moves for one operation, from its placed loops. Between loops the tool hops to `hopZ`;
 * the operation ends with a retract to `safeZ` (the move before an operation's first rapid is
 * therefore always `safeZ`).
 *
 * Direction: every loop already carries the reversed winding (see `MILLING`) and its entry
 * rotation. A retained Z-only rapid precedes every plunge, including the second and later passes
 * of one contour, so the shape of the file is the same whichever order placed the loops.
 */
function buildMoves(loops: readonly PlacedLoop[], params: CutParams): CamMove[] {
  const moves: CamMove[] = [];
  for (const loop of loops) {
    const [x0, y0] = loop.entry;
    const { z } = loop;
    moves.push({ kind: 'rapid', x: x0, y: y0, z: HOP_Z });
    moves.push({ kind: 'feed', x: x0, y: y0, z, f: params.plungeFeed });
    for (let j = 1; j < loop.points.length; j++) {
      const [x, y] = loop.points[j]!;
      moves.push({ kind: 'feed', x, y, z, f: params.feed });
    }
    // Close the loop back on its start point.
    moves.push({ kind: 'feed', x: x0, y: y0, z, f: params.feed });
    moves.push({ kind: 'rapid', x: x0, y: y0, z: HOP_Z });
  }
  const last = loops[loops.length - 1];
  if (last) {
    moves.push({ kind: 'rapid', x: last.entry[0], y: last.entry[1], z: SAFE_Z });
  }
  return moves;
}

/** The XY length of one placed loop: its feeds, closing move included. */
function loopLength(loop: PlacedLoop): number {
  let length = 0;
  for (let i = 1; i < loop.points.length; i++) {
    const [x1, y1] = loop.points[i - 1]!;
    const [x2, y2] = loop.points[i]!;
    length += Math.hypot(x2 - x1, y2 - y1);
  }
  const [x0, y0] = loop.entry;
  const [xl, yl] = loop.points[loop.points.length - 1]!;
  return length + Math.hypot(x0 - xl, y0 - yl);
}

/**
 * XY rapid travel from `from` through each loop's entry, in order.
 *
 * `skipFirst` matches `travelStats`' rule: the IR does not carry where the program starts, so the
 * very first move of a program is not charged. It is passed for the first operation only, so the
 * report and the move walk count the same legs.
 */
function entryTravel(
  from: readonly [number, number],
  loops: readonly PlacedLoop[],
  skipFirst = false,
): number {
  let total = 0;
  let px = from[0];
  let py = from[1];
  for (let i = 0; i < loops.length; i++) {
    const loop = loops[i]!;
    if (!(skipFirst && i === 0)) total += Math.hypot(loop.entry[0] - px, loop.entry[1] - py);
    px = loop.entry[0];
    py = loop.entry[1];
  }
  return total;
}

/**
 * The toolpath IR for a set of opened label regions.
 *
 * `labels` are #201's opened regions in document order. `tool` is a flat end mill, or — since
 * #221 — a V-bit. For a V-bit the DESIGN is correct at the COLOUR PLANE: the region is pocketed
 * at `depth` with `rPlane = tipRadius + (depth − film)·tanHalf`, so the swept area at the plane
 * equals the design, while the tip disc clears the floor (`rPlane − e·tanHalf` narrower per side)
 * and the cone's flanks widen the opening above the plane (`film·tanHalf` wider per side at the
 * top face). The colour-plane geometry and depths arrive per region in `vCarve`, computed once by
 * the caller (`engraveRegions`); a V region without that block has no film, so the plane is the
 * floor and the tip radius is the offset. `params` arrive from `feedsFor` (#202) — this module
 * owns no feeds, RPM or step values. The V row's stepover fraction is applied to the groove's
 * width AT THE PLANE (`2 × rPlane`), so the pitch is per region: `params.stepOver` was resolved
 * against the tip diameter, and the fraction is `params.stepOver / tipWidth`. The floor is
 * cleared by the tip disc, so that plane pitch is then clamped to the TIP RADIUS
 * (`vCarvePassPitch`): a wider pitch leaves a ridge across every stroke whose level sets stop
 * between passes. `rapid` is the machine's
 * rapid model, which the operation's
 * `estimatedSeconds` is timed with (#281); it is required, like every other number a caller
 * owns, so this module never invents a rate. `order` is the label ordering strategy; only
 * `'nearest'` exists in V1.
 *
 * `rapid` sits BEFORE `order` because a required parameter cannot follow a defaulted one — the
 * caller that passed `order` positionally gets a type error rather than a silent shift.
 *
 * #487: the region order is nearest-neighbour refined by 2-opt, the contours within each ring are
 * toured the same way and taken to full depth one at a time, and every entry is the vertex nearest
 * the previous exit. `ToolpathIR.ordering` carries the rapid travel this cost and what the
 * pre-#487 order would have cost on the same job, so the sheet can print the gain.
 *
 * `peckClearanceMm` is the shop's `drill.peckClearanceMm` (#451), read on the main thread and sent
 * as a plain number; `null`/absent leaves `drillMoves`'s labelled fallback in charge. It is the only
 * shop default this CAM core takes, because the drill path is the only part of it that reads one.
 *
 * `finish` is #250's per-program pass mode. `null`/absent cuts every region in one pass, byte for
 * byte as before (the golden `.nc` depends on it). With an allowance, a flat region is cut as a
 * roughing pass that leaves `stockToLeaveMm` on walls and floor, then a finishing pass at full depth
 * on the ideal outline; `mode` selects which of the two THIS program writes, because the tool split
 * that decides the programs is #472's. A V region, and a program with no allowance, is untouched.
 *
 * #668 — `boreRampAngleDeg` is the shop's `bore.rampAngleDeg` (how steeply a bore's helix descends),
 * read on the main thread like `peckClearanceMm`; `null`/absent leaves the labelled fallback in
 * charge. It reaches only the bore path — a job with no bore is byte-identical whatever it is.
 */
export function generateEngrave(
  tl: ManifoldToplevel,
  labels: readonly EngraveRegion[],
  tool: Tool,
  params: CutParams,
  rapid: RapidEstimate,
  order: 'nearest' = 'nearest',
  peckClearanceMm: number | null = null,
  finish: FinishPassSpec | null = null,
  boreRampAngleDeg: number | null = null,
): ToolpathIR {
  const usable = cuttingForTrace(tool);
  if (!usable.ok) throw new Error(`generateEngrave: ${usable.reason}`);
  const cutTool = usable.tool;
  const cone = cutTool.shape === 'v' ? cutTool.cone : null;
  // A flat end mill's offset is its radius. A V-bit's offset is `rPlane`, the design's inward
  // offset at the COLOUR PLANE (#221), which depends on the item's depth and the blank's film, so
  // it is read per label from `vCarve`. A V region without that block has no film: the plane is
  // the floor and the tip radius is the offset.
  const flatRadius = cutTool.shape === 'v' ? 0 : cutTool.radius;
  const tipWidth = cone === null ? 0 : cone.tipRadius * 2;
  const toolNumber = toolNumberFor(tool);
  const offset = makeClipperOffset(tl);

  /**
   * The rings for one region. A flat cutter uses its radius and the resolved step-over. A V uses
   * the plane offset, and its stepover is the row's FRACTION applied to the groove's width at that
   * plane (`vCarvePlaneStepover`): `params.stepOver` was resolved against the tip diameter, so the
   * fraction is `params.stepOver / tipWidth` and the request grows with `planeRadius / tipRadius`.
   * The floor is cleared by the TIP disc, so `vCarvePassPitch` clamps the pitch to the tip radius
   * (#191's flat rule, which a stroke's centreline makes stricter than the tip width) and the same
   * radius is `pocketLoops`' bound.
   */
  const ringsFor = (label: EngraveRegion, extraRadius = 0): Polygons[] => {
    if (cone === null) return pocketLoops(label.polygons, flatRadius + extraRadius, params.stepOver, offset);
    const planeRadius = label.vCarve?.planeRadius ?? cone.tipRadius;
    if (!(planeRadius > 0) || !(tipWidth > 0)) {
      throw new Error(
        `generateEngrave: "${label.name ?? label.text}" has no groove at the colour plane (a point ` +
          `tip with no depth below the film) — there is no region for a V-bit to pocket; use a ` +
          `trace or cut deeper`,
      );
    }
    const pitch = vCarvePassPitch(planeRadius, cone, params.stepOver / tipWidth);
    if (!(pitch > 0)) {
      throw new Error(`generateEngrave: the V-carve step-over resolved to ${pitch} mm; it must be > 0`);
    }
    // The tip radius is also the bound `pocketLoops` is given: nothing wider may be asked of a
    // cut whose floor only the tip disc reaches.
    return pocketLoops(label.polygons, planeRadius, pitch, offset, cone.tipRadius);
  };

  // #250 — a flat cutter whose program asks for an allowance is cut in two passes. A V region is
  // the cone's whole geometry and is not split; the mode says which half this PROGRAM cuts, because
  // the (setup, tool) split that decides how many programs a job has is #472's.
  const finishOn = finish !== null && finish.stockToLeaveMm > 0 && cone === null;

  const prepared: Prepared[] = labels.map((label) => {
    if (label.drill) {
      const holes = orderHolesNearest(label.drill.holes);
      const bore = label.drill.bore;
      if (bore !== undefined) {
        // A BORE TO SIZE (#668): the cutter helixes down the hole's wall, laps it at full depth and
        // spirals the floor clean. Its first cutting point is the helix's start — the hole's edge
        // along +X — so the ordering is costed against where the tool really enters.
        if (cone !== null) {
          throw new Error(
            `generateEngrave: "${label.name ?? label.text}" is a bore, and a bore helixes down the ` +
              'wall of the hole with the side of a flat end mill; a V-bit cannot cut one',
          );
        }
        const centreRadius = bore.radius - flatRadius;
        if (!(centreRadius > 0)) {
          throw new Error(
            `generateEngrave: "${label.name ?? label.text}" asks for a ⌀${bore.radius * 2} mm hole, ` +
              `which is not wider than the ⌀${flatRadius * 2} mm cutter; a bore needs a hole wider than the cutter`,
          );
        }
        const first = holes[0];
        return {
          label,
          passList: [],
          firstCut: first === undefined ? [0, 0] : [first[0] + centreRadius, first[1]],
          drillMoves: boreMoves(
            holes,
            label.depth,
            bore.radius,
            flatRadius,
            params,
            boreRampAngleDeg,
            // A through bore clears its core to the blank's underside before crossing it.
            label.through === true ? (label.stockThickness ?? null) : null,
          ),
        };
      }
      // Drilled region (#220): no rings to pocket. The holes are visited nearest-neighbour and
      // the FIRST becomes the operation's first cutting point, so the ordering and the emitted
      // path agree exactly as they do for a pocket.
      return {
        label,
        passList: [],
        firstCut: holes[0] ?? [0, 0],
        drillMoves: drillMoves(holes, label.depth, params.peck, params, peckClearanceMm),
      };
    }
    const onePass: PreparedPass = {
      rings: ringsFor(label),
      passes: zPasses(label.depth, params.stepDown),
    };
    if (!finishOn || finish === null) {
      return { label, passList: [onePass], firstCut: firstCuttingPoint(onePass.rings) };
    }
    const leave = finish.stockToLeaveMm;
    const passList: PreparedPass[] = [];
    const roughDepth = label.depth - leave;
    if (finish.mode !== 'finish-only' && roughDepth > 0) {
      // The roughing region is eroded by the tool radius PLUS the wall allowance; its deepest pass
      // stops the same distance above the floor.
      passList.push({
        rings: ringsFor(label, leave),
        passes: zPasses(roughDepth, params.stepDown),
        passKind: 'rough',
      });
    }
    if (finish.mode !== 'rough-only') {
      // The finishing pass is the ideal region at the cutter's own radius, one full-depth pass.
      passList.push({ rings: ringsFor(label), passes: [-label.depth], passKind: 'finish' });
    }
    // A cut shallower than the allowance has no roughing pass to make; keeping the one-pass cut is
    // better than writing an item with no operation at all (#250 review).
    if (passList.length === 0) passList.push(onePass);
    return { label, passList, firstCut: firstCuttingPoint(passList[0]!.rings) };
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

  // #487 — the tool's position carries from one operation to the next. Before this, every
  // operation chose its entry as if the tool stood at the origin, so the first rapid of each
  // region started from wherever the last one had finished rather than from the vertex nearest
  // it. Drilled operations keep their own hole order and leave the tool at their last hole.
  let cursor: [number, number] = [0, 0];
  let regionRapidMm = 0;
  let baselineRegionRapidMm = 0;
  let regionCutMm = 0;

  const operations: CamOperation[] = [];
  for (const item of ordered) {
    // A shape's ready-made descriptor when the caller supplied one (#214); otherwise the
    // label text, exactly as before, so a text-only caller's `.nc` is unchanged.
    const descriptor = item.label.name ?? `Engrave "${item.label.text}"`;
    if (item.drillMoves !== undefined) {
      const moves = item.drillMoves;
      const last = moves[moves.length - 1];
      if (last) cursor = [last.x, last.y];
      operations.push({
        number: operations.length + 1,
        name: `[T${toolNumber}]${descriptor} ${item.label.depth.toFixed(1)}mm`,
        labelId: item.label.id,
        depth: item.label.depth,
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, rapid),
      });
      continue;
    }
    for (const pass of item.passList) {
      const loops = placeLoops(pass, 'proximity', cursor);
      const moves = buildMoves(loops, params);
      // Both orders are priced on the SAME legs: the first operation's opening leg is not
      // charged (see `entryTravel`), which is the rule `travelStats` uses on the emitted moves.
      const skipFirst = operations.length === 0;
      regionRapidMm += entryTravel(cursor, loops, skipFirst);
      // The pre-#487 order chose every entry as if the tool stood at (0, 0); it is re-placed
      // here so the before/after is the old order, not an approximation of it.
      const baseline = placeLoops(pass, 'document', [0, 0]);
      baselineRegionRapidMm += entryTravel(cursor, baseline, skipFirst);
      regionCutMm += loops.reduce((sum, loop) => sum + loopLength(loop), 0);
      cursor = loops.length > 0 ? loops[loops.length - 1]!.entry : cursor;
      // An unsplit item keeps yesterday's name exactly; a split pass says which half it is, so a
      // `.nc` opened in a sender names the two removals the sheet lists. A through cut is its own
      // kind (#218): it reaches the under-board, so it is never one half of a rough/finish pair
      // and the sheet names it as the through pass.
      const kind = item.label.through === true ? ('through' as const) : pass.passKind;
      const suffix = kind === undefined ? '' : ` (${kind})`;
      operations.push({
        number: operations.length + 1,
        name: `[T${toolNumber}]${descriptor} ${item.label.depth.toFixed(1)}mm${suffix}`,
        labelId: item.label.id,
        depth: item.label.depth,
        ...(kind === undefined ? {} : { passKind: kind }),
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, rapid),
      });
    }
  }

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
    // A drill-only program has no loops to order, so it gets no report: its moves are the same
    // in either order and there is no before/after to price.
    ...(pocketed.length === 0
      ? {}
      : {
          ordering: {
            order: 'proximity' as const,
            rapidMm: regionRapidMm,
            baselineRapidMm: baselineRegionRapidMm,
            cutMm: regionCutMm,
          },
        }),
  };
}
