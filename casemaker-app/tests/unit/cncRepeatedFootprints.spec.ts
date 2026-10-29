// #749 — A THROUGH CUT REPEATS ONE FOOTPRINT AT EVERY DEPTH PASS.
//
// The exact sweep builds one extruded column per checkpoint, every column running from that
// checkpoint's Z to the stock top. A through cut-out is the same XY contour at every step-down,
// so those columns are IDENTICAL in XY and nested in Z. `Manifold.union` of coincident prisms
// grows combinatorially: measured on j24-spoke-wrench-z's 103 checkpoints, 8 columns cost
// 20 598 triangles, 32 cost 87 528, 64 cost 1 067 840, and 103 exhausted the wasm heap
// (`RuntimeError: memory access out of bounds`, 4.3 GB RSS, ~154 s).
//
// The union of nested prisms with one footprint IS the deepest prism, exactly. The sweep now
// unions one solid per footprint (the deepest), and playback does the same inside each anchor
// window. This spec is the reduction: a 20 mm circle cut through a 5 mm slab in 100 passes, at
// the same 128-segment resolution the CAM posts. The removed volume is the checkpoint region's
// area times the depth — no union of stacked duplicates can change it.

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { checkpointRegion, OVERSHOOT_MM, sweepTimeline } from '@/workers/geometry/sweep';
import { createPlayback } from '@/workers/geometry/playback';
import { buildTimeline, parseGcode, stubSetup } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 5 };
const HOLD = { kind: 'tape-down' as const, contact: SLAB.outline };
const R = 0.5;
const tool = flatEndMill(2 * R);
/** A 20 mm circle linearised so the CAM's own arc resolution is not the variable under test. */
const CX = 50;
const CY = 30;
const RADIUS = 20;
const SEGMENTS = 128;
const PASSES = 100;
const STEP = 0.05;

/** One closed circle per depth pass, all in the same segment: the through-cut shape. */
function throughCircleGcode(): string {
  const lines = ['G90 G21', 'S1000 M3', `G0 X${CX + RADIUS} Y${CY} Z1`];
  for (let pass = 1; pass <= PASSES; pass++) {
    lines.push(`G1 Z${(-STEP * pass).toFixed(3)} F100`);
    for (let i = 1; i <= SEGMENTS; i++) {
      const a = (2 * Math.PI * i) / SEGMENTS;
      lines.push(`G1 X${(CX + RADIUS * Math.cos(a)).toFixed(4)} Y${(CY + RADIUS * Math.sin(a)).toFixed(4)}`);
    }
  }
  return lines.join('\n');
}

function run() {
  const setup = stubSetup(SLAB, HOLD);
  const timeline = buildTimeline(parseGcode(throughCircleGcode()), setup);
  const started = Date.now();
  const out = sweepTimeline(tl, timeline, tool, setup);
  const elapsed = Date.now() - started;
  if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
  return { timeline, sweep: out.value, elapsed };
}

/** The 2D area one pass removes, read from the sweep's own checkpoint definition. */
function passArea(timeline: ReturnType<typeof run>['timeline']): number {
  const cp = timeline.checkpoints[0]!;
  const { region } = checkpointRegion(tl, cp, R);
  if (!region) throw new Error('the first checkpoint has no region');
  const area = region.area();
  region.delete();
  return area;
}

describe('#749 repeated depth-pass footprints finish, and remove the same material', () => {
  it('sweeps a 100-pass through circle inside a sane time, with the closed-form removal', () => {
    const { timeline, sweep, elapsed } = run();

    expect(timeline.checkpoints).toHaveLength(PASSES);
    expect(sweep.stats.checkpointsSwept).toBe(PASSES);
    // The old union of 100 coincident columns never returned in this test's lifetime.
    expect(elapsed, `the sweep took ${elapsed} ms`).toBeLessThan(60_000);

    // Identical feet and contiguous depths: the material removed is one column of this area,
    // as deep as the last pass — not a sum, and not less.
    const expected = passArea(timeline) * STEP * PASSES;
    expect(sweep.stats.removedVolume).toBeCloseTo(expected, 2);
    expect(sweep.removal).not.toBeNull();
    // The removal solid is the full column, which overshoots the stock top by OVERSHOOT_MM.
    expect((sweep.removal as NonNullable<typeof sweep.removal>).volume()).toBeCloseTo(
      passArea(timeline) * (STEP * PASSES + OVERSHOOT_MM),
      2,
    );
  }, 120_000);

  it('playback warmup survives the same job and every frame removes its own depth', () => {
    const { timeline, sweep } = run();
    const playback = createPlayback(tl, timeline, sweep);
    expect(playback.count).toBe(PASSES);
    // The anchors are built from the same repeated solids; before the dedupe this was the
    // second surface of the crash (`session.warmup()` in the app worker).
    playback.warmup();
    playback.warmup(); // idempotent

    const area = passArea(timeline);
    for (const k of [0, 31, 63, PASSES - 1]) {
      const depth = -(timeline.checkpoints[k]!.z);
      expect(playback.removedVolumeAt(k), `checkpoint ${k}`).toBeCloseTo(area * depth, 1);
    }
    // Monotone: each pass goes deeper and removes strictly more (a sample, not all 100 — every
    // frame is a real boolean and the point here is the dedupe, not scrub coverage).
    for (const k of [1, 32, 64, 99]) {
      expect(playback.removedVolumeAt(k), `checkpoint ${k}`).toBeGreaterThan(playback.removedVolumeAt(k - 1));
    }
    expect(() => playback.dispose()).not.toThrow();
  }, 120_000);
});
