// The pure helpers that turn a session's plain data into what the viewport draws (#197).
// No React, no worker: hand-built paths, so the arithmetic is checked by hand rather than
// against whatever the session happens to produce.

import { describe, it, expect } from 'vitest';
import {
  checkpointAtStep,
  geometryFromMesh,
  pathBounds,
  segmentGeometry,
  splitPath,
  toolPositionAt,
  vertexIndexAtStep,
} from '@/components/viewport/simGeometry';
import type { CheckpointInfo, SimPath } from '@/workers/sim/session';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';

/**
 * A five-vertex path: a rapid into the first known position (drawn as nothing — it has no
 * start), two cuts, then two rapids. Kinds describe the move that ENDS at each vertex.
 */
const PATH: SimPath = {
  xyz: Float32Array.from([
    0, 0, 5,
    10, 0, 5,
    10, 0, -1,
    30, 0, -1,
    30, 0, 5,
    30, 10, 5,
  ]),
  step: Uint32Array.from([3, 4, 5, 6, 7]),
  kind: Uint8Array.from([0, 1, 1, 0, 0]),
  t: Float32Array.from([0, 0.1, 0.2, 0.3, 0.4]),
};

describe('splitPath', () => {
  it('draws one segment per step from the second vertex on, split by kind', () => {
    const s = splitPath(PATH);
    // Two cuts (i = 1, 2) and two rapids (i = 3, 4); the first vertex has no predecessor.
    expect(Array.from(s.cutStep)).toEqual([4, 5]);
    expect(Array.from(s.rapidStep)).toEqual([6, 7]);
    // Each segment is two vertices (6 floats): previous position -> this position.
    expect(Array.from(s.cuts.slice(0, 6))).toEqual([0, 0, 5, 10, 0, 5]);
    expect(s.cuts).toHaveLength(2 * 6);
    expect(s.rapids).toHaveLength(2 * 6);
    expect(Array.from(s.rapids.slice(0, 6))).toEqual([10, 0, -1, 30, 0, -1]);
  });

  it('puts a feed with the spindle off in the cuts buffer (kind 2)', () => {
    const off: SimPath = {
      xyz: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      step: Uint32Array.from([0, 1, 2]),
      kind: Uint8Array.from([1, 2, 1]),
      t: Float32Array.from([0, 0, 0]),
    };
    const s = splitPath(off);
    expect(s.cutStep).toHaveLength(2);
    expect(s.rapidStep).toHaveLength(0);
  });

  it('an empty path has four empty buffers', () => {
    const s = splitPath({ xyz: new Float32Array(0), step: new Uint32Array(0), kind: new Uint8Array(0), t: new Float32Array(0) });
    expect(s.cuts).toHaveLength(0);
    expect(s.rapids).toHaveLength(0);
    expect(s.cutStep).toHaveLength(0);
    expect(s.rapidStep).toHaveLength(0);
  });
});

describe('vertexIndexAtStep', () => {
  it('counts the entries at or before the step', () => {
    expect(vertexIndexAtStep(PATH.step, 2)).toBe(0); // before the first
    expect(vertexIndexAtStep(PATH.step, 3)).toBe(1);
    expect(vertexIndexAtStep(PATH.step, 5)).toBe(3);
    expect(vertexIndexAtStep(PATH.step, 999)).toBe(5); // past the last
  });

  it('a step with no vertex of its own counts the ones that exist', () => {
    // Step 6.5 has no vertex; the count is still everything up to and including step 6.
    expect(vertexIndexAtStep(PATH.step, 6.5)).toBe(4);
  });
});

describe('toolPositionAt', () => {
  it('is null before the first known position, then the last vertex at or before the step', () => {
    expect(toolPositionAt(PATH, 2)).toBeNull();
    expect(toolPositionAt(PATH, 3)).toEqual([0, 0, 5]);
    expect(toolPositionAt(PATH, 5)).toEqual([10, 0, -1]);
    expect(toolPositionAt(PATH, 6.5)).toEqual([30, 0, -1]);
    expect(toolPositionAt(PATH, 999)).toEqual([30, 0, 5]);
  });
});

describe('checkpointAtStep', () => {
  const cp = (firstStep: number): CheckpointInfo => ({
    segment: 0,
    z: 0,
    run: 0,
    firstStep,
    lastStep: firstStep,
    moveCount: 1,
    nonConstantZ: false,
  });
  const checkpoints = [cp(10), cp(20), cp(30)];

  it('is -1 before the first cut, k inside checkpoint k, and count-1 after the last', () => {
    expect(checkpointAtStep(checkpoints, 9)).toBe(-1);
    expect(checkpointAtStep(checkpoints, 10)).toBe(0);
    expect(checkpointAtStep(checkpoints, 25)).toBe(1);
    expect(checkpointAtStep(checkpoints, 30)).toBe(2);
    expect(checkpointAtStep(checkpoints, 9999)).toBe(2);
  });

  it('no checkpoints at all is -1, never 0', () => {
    expect(checkpointAtStep([], 42)).toBe(-1);
  });
});

describe('pathBounds', () => {
  it('is the extent of the known vertices', () => {
    expect(pathBounds(PATH)).toEqual({ min: [0, 0, -1], max: [30, 10, 5] });
  });
  it('is null for a path with no vertices', () => {
    expect(pathBounds({ xyz: new Float32Array(0), step: new Uint32Array(0), kind: new Uint8Array(0), t: new Float32Array(0) })).toBeNull();
  });
});

describe('geometryFromMesh', () => {
  it('carries the positions and the index across, with normals computed', () => {
    // One triangle, so there is something to normal.
    const mesh: NodeMeshOutput = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]),
      triangleCount: 1,
      vertexCount: 3,
      bbox: { min: [0, 0, 0], max: [1, 1, 0] },
      componentCount: 1,
    };
    const g = geometryFromMesh(mesh);
    expect(g.getAttribute('position').count).toBe(3);
    expect(g.getIndex()?.count).toBe(3);
    expect(g.getAttribute('normal')).toBeDefined();
    g.dispose();
  });
});

// Issue #197 review, fix 1 — the to-come RAPIDS drew solid. On a fresh load the step is the last
// one, so the to-come layer's drawRange is empty and it renders nothing; the old code computed
// line distances in an effect keyed on a ref that was null, so a later step back mounted the
// line with no `lineDistance` attribute and `LineDashedMaterial` fell back to solid.
describe('segmentGeometry', () => {
  const SEGMENTS = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 5, 0]);

  it('gives a dashed geometry its line distances at build time', () => {
    const g = segmentGeometry(SEGMENTS, true);
    const distances = g.getAttribute('lineDistance');
    expect(distances).toBeDefined();
    expect(distances!.count).toBe(4); // one per vertex of the two segments
    g.dispose();
  });

  it('keeps them when a fresh load draws no to-come segments and the step then moves back', () => {
    const g = segmentGeometry(SEGMENTS, true);
    g.setDrawRange(0, 0); // fresh load, step is the last one: nothing to come is drawn
    g.setDrawRange(0, 2); // the step moves back: the to-come segments render now
    expect(g.getAttribute('lineDistance')).toBeDefined();
    g.dispose();
  });

  it('leaves a solid geometry without line distances', () => {
    const g = segmentGeometry(SEGMENTS, false);
    expect(g.getAttribute('lineDistance')).toBeUndefined();
    g.dispose();
  });
});
