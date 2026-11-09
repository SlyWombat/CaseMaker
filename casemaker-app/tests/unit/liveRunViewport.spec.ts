// #1123 items 36/38 — THE LIVE VIEW of a running machine.
//
// Phase 1 (this branch): while the machine is busy (or a probe owns it), the viewport shows the
// UNcut blank and the design's extents, with the live tool/probe at WPos — never the finished
// simulation's swept stock and never its yellow path. The readout states positions, not a verdict.
// Phase 2 (material removed so far, driven by the controller's line) is #1141.
import { describe, expect, it } from 'vitest';
import {
  designExtents,
  liveEdgeWords,
  liveMachineFor,
  sceneFor,
  type DesignExtents,
} from '@/components/viewport/liveRun';
import type { EngravePreview } from '@/workers/sim/engravePreview';

const box = (min: [number, number, number], max: [number, number, number]) => ({ min, max });

const PREVIEW = {
  floors: [
    { mesh: { bbox: box([9.344, 1, -1], [77.344, 125, -0.5]) } },
    { mesh: { bbox: box([20, 10, -2], [30, 20, -0.5]) } },
  ],
} as unknown as EngravePreview;

describe('#1123-36 — the live view wins over the finished simulation', () => {
  it('a live machine in the CNC section shows the engrave preview, not the simulation', () => {
    expect(sceneFor(true, true, true)).toBe('engrave');
  });

  it('idle and other sections keep today’s scene', () => {
    expect(sceneFor(true, true, false)).toBe('sim');
    // Live but the operator deliberately in the Simulate tab: their choice stands.
    expect(sceneFor(true, false, true)).toBe('sim');
    expect(sceneFor(false, true, false)).toBe('engrave');
    expect(sceneFor(false, true, true)).toBe('engrave');
    expect(sceneFor(false, false, false)).toBe('case');
  });

  it('live means busy, a registration owning the machine, or a release starting/running/uploading', () => {
    expect(liveMachineFor(true, false, [])).toBe(true);
    expect(liveMachineFor(false, true, [])).toBe(true);
    expect(liveMachineFor(false, false, ['starting'])).toBe(true);
    expect(liveMachineFor(false, false, ['running'])).toBe(true);
    expect(liveMachineFor(false, false, ['uploading'])).toBe(true);
    expect(liveMachineFor(false, false, ['idle', 'ready', 'bit-change', 'stopped'])).toBe(false);
    expect(liveMachineFor(null, false, [])).toBe(false);
    expect(liveMachineFor(false, false, [])).toBe(false);
  });
});

describe('#1123-38 — factual positions, never a verdict', () => {
  it('reads the design extents from the preview floors and states the tool against the nearest edge', () => {
    const extents = designExtents(PREVIEW);
    expect(extents).toEqual({ minX: 9.344, maxX: 77.344, minY: 1, maxY: 125 });
    const words = liveEdgeWords({ x: 9.56, y: 15.3, z: -0.6 }, extents);
    expect(words).toBe(
      "tool centre X 9.560, Y 15.300 · the design's extents (bounding box) span X 9.344–77.344, Y 1.000–125.000: the tool centre is 0.216 mm right of the design's left edge",
    );
    // Positions only: no claim about whether the cutter is cutting the part.
    expect(words).not.toMatch(/inside the part|outside the part|too far|correct/i);
  });

  it('names a Y edge factually when that is the nearest', () => {
    const extents: DesignExtents = { minX: 0, maxX: 80, minY: 0, maxY: 80 };
    const words = liveEdgeWords({ x: 40, y: 1.5, z: 0 }, extents);
    expect(words).toContain("1.500 mm from the design's Y-min edge");
  });

  it('states the WPos alone when no design extents are known, and nothing without a whole position', () => {
    expect(liveEdgeWords({ x: 1, y: 2, z: 3 }, null)).toBe('tool centre X 1.000, Y 2.000');
    expect(liveEdgeWords({ x: null, y: 2, z: 3 }, { minX: 0, maxX: 10, minY: 0, maxY: 10 })).toBeNull();
    expect(liveEdgeWords(null, null)).toBeNull();
  });

  it('has no extents when the preview has no floors', () => {
    expect(designExtents(null)).toBeNull();
    expect(designExtents({ floors: [] } as unknown as EngravePreview)).toBeNull();
  });
});
