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
 * Linking between rings and between levels is a straight rapid/plunge here, not yet #962's
 * material-aware `link()` — that integration (passing this op's `MaterialField` through) is the
 * next increment, named so in the design note's status log rather than silently assumed done.
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

/** One closed ring's cutting moves, entering from directly above its first point. */
function ringMoves(ring: readonly [number, number][], z: number, feedMmPerMin: number, plungeFeedMmPerMin: number, hopZMm: number): {
  moves: ToolpathIR['operations'][number]['moves'];
  entry: [number, number, number];
  exit: [number, number, number];
} {
  const start = ring[0]!;
  const moves: ToolpathIR['operations'][number]['moves'] = [
    { kind: 'rapid', x: start[0], y: start[1], z: hopZMm },
    { kind: 'feed', x: start[0], y: start[1], z, f: plungeFeedMmPerMin },
  ];
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i]!;
    moves.push({ kind: 'feed', x: p[0], y: p[1], z, f: feedMmPerMin });
  }
  // Close the ring back to its own start.
  moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: feedMmPerMin });
  return { moves, entry: [start[0], start[1], z], exit: [start[0], start[1], z] };
}

/**
 * `pocketLoops` returns one `Polygons` (outer + holes) PER OFFSET STEP, not a flat list of rings —
 * flatten every step's loops into one list, in step order, each loop kept as its own closed ring.
 */
function flattenRings(steps: readonly Polygons[]): [number, number][][] {
  const out: [number, number][][] = [];
  for (const step of steps) {
    for (const loop of step) out.push(loop);
  }
  return out;
}

/** Rings in a deterministic, short-travel order (#487's tour, lifted to whole rings by their first point). */
function orderedRings(rings: readonly [number, number][][]): [number, number][][] {
  if (rings.length <= 1) return rings as [number, number][][];
  const points = rings.map((r) => r[0]! as readonly [number, number]);
  return tourNearest(points).map((i) => rings[i]!);
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

  for (const z of levels) {
    const steps = pocketLoops(opts.node.region, toolRadius, opts.stepOverMm, opts.offset);
    const rings = orderedRings(flattenRings(steps));
    for (const ring of rings) {
      const { moves: ringMs, entry, exit } = ringMoves(ring, z, opts.feeds.feedMmPerMin, opts.feeds.plungeFeedMmPerMin, opts.hopZMm);
      moves.push(...ringMs);
      passes.push({ z, boundary: [ring as [number, number][]], cleared: { z, boundary: opts.node.region }, entry, exit });
    }
    cleared.push({ z, boundary: opts.node.region });
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
