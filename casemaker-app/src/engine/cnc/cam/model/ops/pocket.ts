/**
 * cam/model/ops/pocket.ts — §3.1 of `docs/design/cam-model-engine.md`.
 *
 * Z-level pocketing per recognised `PocketNode` (#958), largest flat that fits — uses the EXISTING
 * `pocketLoops` (`cam/pocket.ts:204`) unchanged for the 2D rings at each level; there is no new
 * pocketing math. What this file adds is the Z-level stepping and the ring→move conversion
 * `pocketLoops` itself does not do (it is deliberately kernel-free and 2D-only, returning rings,
 * not `CamMove[]`).
 *
 * The `offset` function is INJECTED, exactly as `pocketLoops` itself requires (`cam/pocket.ts`'s own
 * header: "Do NOT write polygon offsetting by hand" — the real one is Clipper2's `CrossSection.offset`,
 * built once by the caller; this file's own tests use a trivial fake, the same pattern `pocket.ts`'s
 * own tests use).
 *
 * Linking: EVERY move between one ring/level and the next — same-level ring-to-ring as much as
 * level-to-level — goes through #962's `link()` (A's review 6622610124, finding 1): a plain feed
 * from one ring's exit to the next ring's start is only safe when `pocketLoops`' own "ring i+1
 * lies one step-over inside ring i" holds for a SIMPLE nested region, and it does not for a
 * pocket with an island between the two rings, or a region whose erosion has split into separate
 * lobes — either gouges the island or cuts across the wall between lobes. The `MaterialField` this
 * op builds is a global one, not a per-ring one: `topAt(x, y)` reports the floor Z anywhere inside
 * `freeSpace` (`node.region` eroded by the cutter radius, less a 0.01 mm chord grace — the same
 * free space A's `pocketRedFirst959.spec.ts` checks the moves against) and "never cut" everywhere
 * else, so `link()` feeds through material this op WILL remove and retracts around anything it
 * will not (an island, the wall between lobes, open air outside the node). `link()`'s own
 * `retract()` is also what fixes the diagonal rapid-from-depth this file used to emit on every
 * level change (straight up, across, straight down — never X/Y/Z together below the safe plane).
 */

import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import type { RapidEstimate, ToolpathIR } from '@/engine/cnc/cam/ir';
import { estimateCycleSeconds } from '@/engine/cnc/cam/ir';
import type { BooleanFn } from '@/engine/cnc/cam/engraveJob';
import { pocketLoops, type OffsetFn, type Polygons } from '@/engine/cnc/cam/pocket';
import { tourNearest } from '@/engine/cnc/cam/tour';
import { pointInPolygons } from '@/engine/cnc/engrave/throughMask';
import { link, type LinkOptions, type LinkPoint, type MaterialField } from '../linking';
import { cutterKeyOf } from '../sequence';
import type { PocketNode } from '../features';
import type { OpOutcome, PassRef, RegionAtZ, RegionRef } from '../plan';

export interface PocketOpOptions {
  cutter: Tool;
  node: PocketNode;
  region: RegionRef;
  /** mm; the rings' own spacing within one level. */
  stepOverMm: number;
  /** mm; the Z distance between depth passes. The last pass is shorter when it does not divide evenly. */
  stepDownMm: number;
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number };
  /** The real Clipper2 offset, or a test fake — `pocketLoops`' own contract, unchanged. */
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
   * For an OPEN node only (A's review 6622610124, finding 3): the part's own outer outline
   * (`FeatureTree.contour.outline`) and a boolean pair to extend `node.region` across its open
   * edge before `pocketLoops` ever sees it — otherwise the open boundary is offset inward like a
   * real wall, this cutter's radius never reaches the true edge, and `pocketLoops` can throw on a
   * ledge narrower than the cutter. Absent on a non-open node; absent here on an open one leaves
   * the old (unextended) behaviour, stated by the caller, not silently assumed.
   */
  openOutline?: Polygons;
  boolean?: { union: BooleanFn; subtract: BooleanFn };
}

/** The Z passes from the node's mouth down to its floor, each `stepDownMm` apart (the last one shorter, never longer). */
function depthPasses(mouthZ: number, floorZ: number, stepDownMm: number): number[] {
  const total = mouthZ - floorZ;
  if (!(total > 0)) return [floorZ];
  const count = Math.ceil(total / stepDownMm);
  const levels: number[] = [];
  for (let i = 1; i <= count; i++) {
    levels.push(i === count ? floorZ : mouthZ - i * stepDownMm);
  }
  return levels;
}

/** One closed ring's own cutting moves, NOT including how the tool arrives at its start — the caller (`pocket`) decides that: a plunge for the first ring of a level, a plain feed from the previous ring's exit otherwise. */
function traceRing(ring: readonly [number, number][], z: number, feedMmPerMin: number): ToolpathIR['operations'][number]['moves'] {
  const start = ring[0]!;
  const moves: ToolpathIR['operations'][number]['moves'] = [];
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i]!;
    moves.push({ kind: 'feed', x: p[0], y: p[1], z, f: feedMmPerMin });
  }
  // Close the ring back to its own start.
  moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: feedMmPerMin });
  return moves;
}

/**
 * Rings in a deterministic, short-travel order (#487's tour) — WITHIN one offset step only. Tour
 * ordering ACROSS steps would interleave inner and outer rings and turn some of them into
 * full-width slots (ring i+1 is only safe to feed into directly when it is truly one step-over
 * inside ring i, which only holds within a single `pocketLoops` offset step).
 */
function orderedRings(loops: readonly [number, number][][]): [number, number][][] {
  if (loops.length <= 1) return loops as [number, number][][];
  const points = loops.map((r) => r[0]! as readonly [number, number]);
  return tourNearest(points).map((i) => loops[i]!);
}

/** Index of `ring`'s vertex nearest `target`; ties to the lower index — same rule `tour.ts`
 * itself uses, so the same input always rotates the same way. */
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

/**
 * `ring`, rotated so its own vertex nearest `target` is first — same points, same winding, just a
 * different seam. The manager's own named lever toward Makera's 5.9 rapids/1,000: `ring[0]` used
 * to be whichever vertex Clipper happened to emit first, so a same-level or level-change link into
 * this ring often had most of its own perimeter to cross before `link()` even got a choice between
 * a short hop and a retract — the SAME pattern `engraveJob.ts`'s own `entryOn` already fixed for
 * engrave regions (no reversal here: a pocket ring's winding is already the cutting one).
 */
function rotatedToEntry(ring: readonly [number, number][], target: readonly [number, number]): [number, number][] {
  const start = nearestVertexIndex(ring, target);
  return start === 0 ? (ring as [number, number][]) : [...ring.slice(start), ...ring.slice(0, start)];
}

/**
 * What a round tool of radius `toolRadius`, centred ANYWHERE inside `node.region`'s valid
 * centre-space, can ever reach — `dilate(erode(region, r), r)`, the morphological OPENING (A's
 * review 6622610124, finding 5). `region \ erode(region, D)` (the old formula) overclaims a SHARP
 * convex corner: polygon erosion does not round a convex corner, so the "frame" between the true
 * boundary and ANY eroded copy fills the corner's full square wedge, when a round tool can only
 * ever reach the OPENING's rounded profile there, leaving `r² − πr²/4` per corner permanently
 * uncut, however many rings are cut. Computed once per op: it does not depend on progress.
 */
function fullyReachable(region: Polygons, offset: OffsetFn, toolRadius: number): Polygons {
  return offset(offset(region, -toolRadius), toolRadius);
}

/**
 * The region cleared once the tool has traced out to `depthMm` from the true boundary — a
 * CONSERVATIVE account (never claims more cleared than is certain): `open` (the opening, finding
 * 5's fix) with whatever is still uncut at `depthMm` subtracted as a hole. `offset(region,
 * -depthMm)` returning nothing means `open` itself is fully reached; otherwise the hole is always
 * a subset of `open` (eroding further only shrinks it), so subtracting it is always consistent.
 */
function clearedToDepth(open: Polygons, region: Polygons, offset: OffsetFn, depthMm: number): Polygons {
  const uncut = offset(region, -depthMm);
  if (uncut.length === 0) return open;
  return [...open, ...uncut.map((ring) => [...ring].reverse())];
}

export function pocket(opts: PocketOpOptions): OpOutcome {
  const toolRadius = (cuttingDiameter(opts.cutter) ?? 0) / 2;
  if (!(toolRadius > 0)) {
    throw new Error(`cam/model/ops/pocket: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const levels = depthPasses(opts.node.mouthZ, opts.node.floorZ, opts.stepDownMm);

  // A's review 6622610124, finding 3: an OPEN node's own boundary at its open edge is not a real
  // wall — `pocketLoops` must not stand this cutter off it. Extending the region across that edge,
  // with a real boolean (never a hand-rolled one), lets the inward offset reach exactly to the
  // true edge there, same as the contour will cut it; the overshoot past the true edge is air,
  // removed by the contour op regardless. The extension must be STRICTLY more than the tool
  // radius: eroding by exactly `r` the same amount it was extended leaves the fake outer boundary
  // at the true edge with zero margin (degenerate — a ledge exactly `r` wide swept barely at all);
  // `2r` leaves a real margin whatever the ledge's own width, so only the node's OTHER (real)
  // walls end up deciding what the cutter can reach. The raw band runs the WHOLE outline's open
  // edge, not just this node's own stretch of it (advisor's review on dd150a9b) — clipped to
  // `near` (the node's own footprint, grown by the same 2r) before it is unioned in, or every
  // OTHER open node on the part gets this one's band too.
  const region = opts.node.open && opts.openOutline !== undefined && opts.boolean !== undefined
    ? opts.boolean.union(
        opts.node.region,
        (() => {
          const wholeBand = opts.boolean.subtract(opts.offset(opts.openOutline, 2 * toolRadius), opts.openOutline);
          const near = opts.offset(opts.node.region, 2 * toolRadius);
          // A ∩ B = A \ (A \ B) — the only intersection `union`/`subtract` alone can express.
          return opts.boolean.subtract(wholeBand, opts.boolean.subtract(wholeBand, near));
        })(),
      )
    : opts.node.region;

  const open = fullyReachable(region, opts.offset, toolRadius);

  // A's review 6622610124, finding 1: the free space EVERY same-level or level-to-level link must
  // stay inside is `open` (finding 5's own reachable area), NOT a second erosion of `region` —
  // `linkIsClear` already tests the whole cutter disc against this field, and a disc centred at
  // `region` eroded once more only fits when its CENTRE is eroded a second time (advisor's review
  // on dd150a9b): `erode(open, r) = erode(region, r)` (opening is idempotent), so testing the disc
  // against `open` is exactly A's own centre-line criterion, not a stricter one that forces a
  // retract on nearly every transition. A point outside `open` (an island, the wall between two
  // lobes, open air outside the node) is reported as never cut, so `link()` retracts around it.
  const material: MaterialField = {
    topAt: (x, y) => (pointInPolygons(open, x, y) ? opts.node.floorZ : Number.POSITIVE_INFINITY),
  };
  const linkOptions: LinkOptions = {
    material,
    // The REGION's own clearance plane (already above every obstacle IN this region), not the
    // program-wide `safeZMm` — `RegionRef.regionClearanceZ`'s own doc in `plan.ts` draws this
    // line; advisor's review on dd150a9b caught the two being swapped here.
    clearanceZ: opts.region.regionClearanceZ,
    tool: { radiusMm: toolRadius },
    feeds: { feed: opts.feeds.feedMmPerMin, plungeFeed: opts.feeds.plungeFeedMmPerMin },
  };

  const moves: ToolpathIR['operations'][number]['moves'] = [];
  const passes: PassRef[] = [];
  const cleared: RegionAtZ[] = [];

  // Tracks where the tool actually is, so a link is only asked for from the SECOND ring/level
  // onward — the very first ring of the whole op has no "from" position, just its own plunge.
  let prevExit: [number, number, number] | null = null;

  for (const z of levels) {
    const steps = pocketLoops(region, toolRadius, opts.stepOverMm, opts.offset);
    for (const [stepIndex, step] of steps.entries()) {
      const loops = orderedRings(step);
      for (const loop of loops) {
        // Rotated to the vertex nearest wherever the tool is COMING FROM — `opts.startFrom`
        // (the work origin by default) for the very first ring of the whole op, the previous
        // ring's own exit (which is always its own start — it closes on itself) after that. This
        // is the lever toward Makera's own rapids/1,000: `ring[0]` used to be whichever vertex
        // Clipper happened to emit first, so the link into this ring often had most of its own
        // perimeter to cross before `link()` ever got a choice between a short hop and a retract.
        const target: readonly [number, number] = prevExit === null ? (opts.startFrom ?? [0, 0]) : [prevExit[0], prevExit[1]];
        const ring = rotatedToEntry(loop, target);
        const start = ring[0]!;
        if (prevExit === null) {
          // The very first ring of the whole op: rapid up, then plunge down.
          moves.push({ kind: 'rapid', x: start[0], y: start[1], z: opts.hopZMm });
          moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: opts.feeds.plungeFeedMmPerMin });
        } else if (prevExit[2] === z) {
          // Same level: `open`'s own field is accurate everywhere on it (the whole op's footprint
          // is the same at every Z), so `link()` alone decides feed vs. retract.
          const from: LinkPoint = { x: prevExit[0], y: prevExit[1], z: prevExit[2] };
          const to: LinkPoint = { x: start[0], y: start[1], z };
          moves.push(...link(from, to, linkOptions));
        } else {
          // A level change (advisor's review on 9e976f0b): `open` reports every point in the
          // node's footprint as reachable, with no notion of "not yet, at THIS depth" — handing
          // `link()` the full 3D jump lets its short-hop branch read a same-XY descent as a clear
          // feed at the CUTTING rate, a plunge/ramp with no plunge feed at all. The horizontal
          // part of the move is linked at the level JUST FINISHED, where `open` is honestly
          // accurate (everything in it has actually been swept by now); the vertical part is
          // always a plain feed at plungeFeed, never left to `link()`'s own feed rate.
          const from: LinkPoint = { x: prevExit[0], y: prevExit[1], z: prevExit[2] };
          const landing: LinkPoint = { x: start[0], y: start[1], z: prevExit[2] };
          moves.push(...link(from, landing, linkOptions));
          moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: opts.feeds.plungeFeedMmPerMin });
        }
        moves.push(...traceRing(ring, z, opts.feeds.feedMmPerMin));
        const entry: [number, number, number] = [start[0], start[1], z];
        prevExit = entry; // the ring closes back to its own start
        // `toolRadius + stepIndex * stepOverMm` is this step's own offset from the true boundary
        // (pocketLoops' own convention); clearedToDepth adds the tool's own radius again, since
        // that is how far out the tool has actually swept once its centre reaches this step's path.
        const depthMm = toolRadius + stepIndex * opts.stepOverMm + toolRadius;
        passes.push({ z, boundary: [ring as [number, number][]], cleared: { z, boundary: clearedToDepth(open, region, opts.offset, depthMm) }, entry, exit: entry });
      }
    }
    const finalDepthMm = toolRadius + Math.max(0, steps.length - 1) * opts.stepOverMm + toolRadius;
    cleared.push({ z, boundary: clearedToDepth(open, region, opts.offset, finalDepthMm) });
  }

  // Every op leaves the tool at a safe height when it ends: a straight retract at the LAST XY
  // (no lateral travel below the safe plane), matching `generateProfile`'s own final move — the
  // next op, concatenated onto this one (`concatToolpathIR`), starts from a safe state, not depth.
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
        name: `[T${opts.toolNumber}] Pocket "${opts.node.id}"`,
        labelId: opts.node.id,
        depth: opts.node.mouthZ - opts.node.floorZ,
        depthPasses: levels.length,
        passStepMm: opts.stepDownMm,
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, opts.rapid),
      },
    ],
  };

  return { ir, cutter: cutterKeyOf(opts.cutter), passes, cleared };
}
