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
 * Linking: adjacent rings of the SAME region at the SAME level are joined by a plain FEED move
 * (the standard contour-parallel convention — ring i+1 lies one step-over inside ring i, so the
 * tool's own just-cut path makes the connecting move safe without needing a material check).
 * `link()` is for moves between DISCONNECTED regions/levels, which this op does not yet have (a
 * single `PocketNode` is one connected region cut at successive levels) — between LEVELS this op
 * still rapids/plunges rather than calling #962's material-aware `link()`, named as the next
 * integration point once #961's cutter sequence (below) is wired through `plan.ts` and a real
 * `MaterialField` exists to query. E's first run (6621584766) measured 67.7 rapids/1,000 feed
 * lines against Makera's 5.9 — the per-ring retract this file no longer does; the remaining gap is
 * that still-open level-to-level integration.
 */

import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import type { RapidEstimate, ToolpathIR } from '@/engine/cnc/cam/ir';
import { estimateCycleSeconds } from '@/engine/cnc/cam/ir';
import { pocketLoops, type OffsetFn, type Polygons } from '@/engine/cnc/cam/pocket';
import { tourNearest } from '@/engine/cnc/cam/tour';
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

/**
 * The region still uncut once the tool has traced out to `depthMm` from the true boundary — a
 * CONSERVATIVE account (never claims more cleared than is certain), as a hole in `region`'s own
 * loops. `offset(region, -depthMm)` returning nothing means the whole region is cleared at this
 * depth; otherwise each returned loop becomes a hole (reversed winding — `pocket.ts`'s own
 * convention, outer CCW, holes CW).
 */
function clearedToDepth(region: Polygons, offset: OffsetFn, depthMm: number): Polygons {
  const uncut = offset(region, -depthMm);
  if (uncut.length === 0) return region;
  return [...region, ...uncut.map((ring) => [...ring].reverse())];
}

export function pocket(opts: PocketOpOptions): OpOutcome {
  const toolRadius = (cuttingDiameter(opts.cutter) ?? 0) / 2;
  if (!(toolRadius > 0)) {
    throw new Error(`cam/model/ops/pocket: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const levels = depthPasses(opts.node.mouthZ, opts.node.floorZ, opts.stepDownMm);

  const moves: ToolpathIR['operations'][number]['moves'] = [];
  const passes: PassRef[] = [];
  const cleared: RegionAtZ[] = [];

  // Tracks where the tool actually is, so a ring can be fed into directly when it is still at
  // the SAME Z as the last move (the same level) — a plunge only starts the very first ring and
  // every new level.
  let prevExit: [number, number, number] | null = null;

  for (const z of levels) {
    const steps = pocketLoops(opts.node.region, toolRadius, opts.stepOverMm, opts.offset);
    for (const [stepIndex, step] of steps.entries()) {
      const loops = orderedRings(step);
      for (const ring of loops) {
        const start = ring[0]!;
        if (prevExit !== null && prevExit[2] === z) {
          // Still on this level: feed directly from the last ring's exit to this ring's start —
          // ring i+1 lies one step-over inside ring i, so this move is a cut, not a hop.
          moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: opts.feeds.feedMmPerMin });
        } else {
          // The very first ring of the whole op, or a new level: rapid up, then plunge down.
          moves.push({ kind: 'rapid', x: start[0], y: start[1], z: opts.hopZMm });
          moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: opts.feeds.plungeFeedMmPerMin });
        }
        moves.push(...traceRing(ring, z, opts.feeds.feedMmPerMin));
        const entry: [number, number, number] = [start[0], start[1], z];
        prevExit = entry; // the ring closes back to its own start
        // `toolRadius + stepIndex * stepOverMm` is this step's own offset from the true boundary
        // (pocketLoops' own convention); clearedToDepth adds the tool's own radius again, since
        // that is how far out the tool has actually swept once its centre reaches this step's path.
        const depthMm = toolRadius + stepIndex * opts.stepOverMm + toolRadius;
        passes.push({ z, boundary: [ring as [number, number][]], cleared: { z, boundary: clearedToDepth(opts.node.region, opts.offset, depthMm) }, entry, exit: entry });
      }
    }
    const finalDepthMm = toolRadius + Math.max(0, steps.length - 1) * opts.stepOverMm + toolRadius;
    cleared.push({ z, boundary: clearedToDepth(opts.node.region, opts.offset, finalDepthMm) });
  }

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
