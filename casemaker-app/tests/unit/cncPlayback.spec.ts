// Checkpointed playback (#182 step 8): stockAt(k) = stock − union(removals 0..k), cached,
// scrubbable both ways. Asserted against the sweep's own totals and closed-form volumes.

import { describe, it, expect } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { createPlayback } from '@/workers/geometry/playback';
import { capsuleArea, sweepTimeline } from '@/workers/geometry/sweep';
import { buildTimeline, parseGcode, stubSetup, type Setup } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 5 };
const HOLD = { kind: 'tape-down' as const, contact: SLAB.outline };
const R = 0.5;
const N = segmentsForRadius(R);
const tool = flatEndMill(2 * R);

function run(src: string, o: Partial<Setup> = {}) {
  const setup = stubSetup(SLAB, HOLD, o);
  const timeline = buildTimeline(parseGcode(src), setup);
  const out = sweepTimeline(tl, timeline, tool, setup);
  if (!out.ok) throw new Error(JSON.stringify(out.diagnostics));
  return { timeline, sweep: out.value, playback: createPlayback(tl, timeline, out.value) };
}

// Three strokes at three depths, each in a fresh place so their volumes simply add.
const THREE = [
  'S1000 M3',
  'G0 X10 Y10 Z1', 'G1 Z-0.5 F100', 'G1 X30', // checkpoint 0: capsule(20) x 0.5
  'G0 Z1', 'G0 X10 Y30', 'G1 Z-1.0', 'G1 X30', // checkpoint 1: capsule(20) x 1.0
  'G0 Z1', 'G0 X10 Y50', 'G1 Z-1.5', 'G1 X30', // checkpoint 2: capsule(20) x 1.5
].join('\n');
const V = (d: number) => capsuleArea(20, R, N) * d;

describe('stockAt(k)', () => {
  it('k = -1 is the uncut stock, and the last k is the sweep result', () => {
    const { sweep, playback } = run(THREE);
    expect(playback.count).toBe(3);
    expect(playback.stockAt(-1).volume()).toBeCloseTo(sweep.stats.stockVolume, 6);
    expect(playback.stockAt(2).volume()).toBeCloseTo(sweep.stats.resultVolume, 6);
    playback.dispose();
  });

  it('is cumulative, against closed forms: each checkpoint adds its own capsule column', () => {
    const { playback } = run(THREE);
    const base = playback.stockAt(-1).volume();
    expect(base - playback.stockAt(0).volume()).toBeCloseTo(V(0.5), 1);
    expect(base - playback.stockAt(1).volume()).toBeCloseTo(V(0.5) + V(1.0), 1);
    expect(base - playback.stockAt(2).volume()).toBeCloseTo(V(0.5) + V(1.0) + V(1.5), 1);
    playback.dispose();
  });

  it('removedVolumeAt is monotone and matches', () => {
    const { playback } = run(THREE);
    const vs = [-1, 0, 1, 2].map((k) => playback.removedVolumeAt(k));
    expect(vs[0]).toBe(0);
    for (let i = 1; i < vs.length; i++) expect(vs[i]).toBeGreaterThan(vs[i - 1] as number);
    expect(vs[3]).toBeCloseTo(V(0.5) + V(1.0) + V(1.5), 1);
    playback.dispose();
  });

  it('scrubs BACKWARDS from a cache: the same handle comes back, no recompute', () => {
    const { playback } = run(THREE);
    const late = playback.stockAt(2);
    const early = playback.stockAt(0);
    expect(playback.stockAt(2)).toBe(late);
    expect(playback.stockAt(0)).toBe(early);
    playback.dispose();
  });

  it('clamps past the end', () => {
    const { playback } = run(THREE);
    expect(playback.stockAt(99)).toBe(playback.stockAt(2));
    playback.dispose();
  });

  it('a checkpoint that removed nothing carries the cumulative forward unchanged', () => {
    // A cut above the stock top makes a checkpoint the sweep skips (null solid).
    const { playback, sweep } = run('S1000 M3\nG0 X10 Y10 Z1\nG1 Z-0.5 F100\nG1 X30\nG0 Z1\nG0 X10 Y30 Z2\nG1 X30\n');
    expect(sweep.perCheckpoint[1]).toBeNull();
    expect(playback.stockAt(1).volume()).toBeCloseTo(playback.stockAt(0).volume(), 6);
    playback.dispose();
  });

  it('with no checkpoints at all, every k is the stock — as the playback\'s OWN clone, never the sweep\'s handle', () => {
    // Review #4: returning `sweep.stock` itself made the caller guess which handles it owned.
    const { playback, sweep } = run('G0 X1 Y1 Z1\n');
    expect(playback.count).toBe(0);
    const s = playback.stockAt(0);
    expect(s).not.toBe(sweep.stock);
    expect(s.volume()).toBeCloseTo(sweep.stock.volume(), 6);
    expect(playback.stockAt(-1)).toBe(s);
    expect(playback.removedVolumeAt(5)).toBe(0);
    playback.dispose();
    expect(sweep.stock.volume()).toBeGreaterThan(0);
  });
});

describe('causality and bounded memory (review #4)', () => {
  it('a return to an earlier Z is a later checkpoint: the picture at k never shows a cut from after k', () => {
    // Z -0.5 at Y 10, then Z -1.0 at Y 30, then BACK to Z -0.5 at Y 50. With (segment, Z) keys
    // the third stroke joined the first checkpoint, and stockAt(0) already showed it.
    const { playback } = run([
      'S1000 M3',
      'G0 X10 Y10 Z1', 'G1 Z-0.5 F100', 'G1 X30',
      'G0 Z1', 'G0 X10 Y30', 'G1 Z-1.0', 'G1 X30',
      'G0 Z1', 'G0 X10 Y50', 'G1 Z-0.5', 'G1 X30',
    ].join('\n'));
    expect(playback.count).toBe(3);
    expect(playback.removedVolumeAt(0)).toBeCloseTo(V(0.5), 1);
    expect(playback.removedVolumeAt(1)).toBeCloseTo(V(0.5) + V(1.0), 1);
    expect(playback.removedVolumeAt(2)).toBeCloseTo(V(0.5) * 2 + V(1.0), 1);
    playback.dispose();
  });

  it('many checkpoints: scrubbing everywhere, in both directions, stays correct and disposes cleanly', () => {
    // 40 strokes at 40 depths, more than one anchor span and far more than the stock cache.
    const lines = ['S1000 M3'];
    for (let i = 0; i < 40; i++) {
      const x = 5 + (i % 8) * 12;
      const y = 5 + Math.floor(i / 8) * 11;
      lines.push(`G0 X${x} Y${y} Z1`, `G1 Z${(-0.1 * (i + 1)).toFixed(1)} F100`, `G1 X${x + 6}`, 'G0 Z1');
    }
    const { playback, sweep } = run(lines.join('\n'));
    expect(playback.count).toBe(40);
    const expected = (k: number) => { let v = 0; for (let i = 0; i <= k; i++) v += capsuleArea(6, R, N) * 0.1 * (i + 1); return v; };
    for (const k of [39, 0, 31, 32, 17, 39, 5, 38, 33]) expect(playback.removedVolumeAt(k)).toBeCloseTo(expected(k), 0);
    // Anchors are materialised through a mesh round-trip, which re-merges vertices: agreement
    // with the sweep's single union is to ~1e-4 mm³ on ~550 mm³, not to the bit.
    expect(playback.removedVolumeAt(39)).toBeCloseTo(sweep.stats.removedVolume, 3);
    expect(() => playback.dispose()).not.toThrow();
    expect(sweep.result.volume()).toBeGreaterThan(0);
  });
});

describe('checkpointAtStep: the picture at a program step is "everything cut so far"', () => {
  it('maps steps to the last checkpoint that has started', () => {
    const { timeline, playback } = run(THREE);
    const firsts = timeline.checkpoints.map((c) => c.steps[0] as number);
    expect(firsts).toHaveLength(3);
    expect(playback.checkpointAtStep(-1)).toBe(-1);
    expect(playback.checkpointAtStep(0)).toBe(-1); // S1000 M3: nothing cut yet
    expect(playback.checkpointAtStep((firsts[0] as number) - 1)).toBe(-1);
    expect(playback.checkpointAtStep(firsts[0] as number)).toBe(0);
    expect(playback.checkpointAtStep((firsts[1] as number) - 1)).toBe(0);
    expect(playback.checkpointAtStep(firsts[1] as number)).toBe(1);
    expect(playback.checkpointAtStep(firsts[2] as number)).toBe(2);
    expect(playback.checkpointAtStep(10_000)).toBe(2);
    playback.dispose();
  });
});

describe('ownership', () => {
  it('dispose() deletes every cached handle exactly once, and the sweep result survives it', () => {
    const { playback, sweep } = run(THREE);
    playback.stockAt(0);
    playback.stockAt(2);
    expect(() => playback.dispose()).not.toThrow();
    // The sweep's own handles are not the playback's to delete.
    expect(sweep.stock.volume()).toBeGreaterThan(0);
    expect(sweep.result.volume()).toBeGreaterThan(0);
    expect(sweep.perCheckpoint.every((s) => s === null || s.volume() > 0)).toBe(true);
  });
});
