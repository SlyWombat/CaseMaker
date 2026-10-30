// The pure helpers that turn a session's plain data into what the viewport draws (#197).
// No React, no worker: hand-built paths, so the arithmetic is checked by hand rather than
// against whatever the session happens to produce.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  applyRemovedDepthColours,
  checkpointAtStep,
  cleanStockGeometry,
  geometryFromMesh,
  pathBounds,
  segmentGeometry,
  splitMapPath,
  splitPath,
  toolPositionAt,
  vertexIndexAtStep,
} from '@/components/viewport/simGeometry';
import type { CheckpointInfo, SimPath } from '@/workers/sim/session';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import { meshFlat, meshRotary, meshRotaryMap, type ColumnGrid } from '@/workers/geometry/columnEngine';

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

describe('splitMapPath (#716 slice 2)', () => {
  const R = 10;
  const C = 2 * Math.PI * R;

  /** A path of one vertex per angle, X stepping by 1 mm, cutting at the surface (z = R). */
  function helix(angles: number[]): SimPath {
    const step: number[] = [];
    const xyz: number[] = [];
    const kind: number[] = [];
    const t: number[] = [];
    angles.forEach((_, i) => {
      step.push(i);
      xyz.push(i, 0, R);
      kind.push(i === 0 ? 0 : 1);
      t.push(i);
    });
    return {
      xyz: Float32Array.from(xyz),
      step: Uint32Array.from(step),
      kind: Uint8Array.from(kind),
      t: Float32Array.from(t),
      a: Float64Array.from(angles),
    };
  }

  const ys = (buffer: Float32Array): number[] => {
    const out: number[] = [];
    for (let i = 1; i < buffer.length; i += 3) out.push(buffer[i] as number);
    return out;
  };

  it('keeps every turn on the map: a 2.5-turn helix stays in 0…2πR', () => {
    const split = splitMapPath(helix([0, 180, 360, 540, 720, 900]), R);
    expect(split.cutStep).toHaveLength(5); // one segment per move; seams are the endpoints
    for (const y of ys(split.cuts)) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(C + 1e-6);
    }
  });

  it('a segment that crosses 360°→0° ends on the 360 edge and the next piece starts at 0', () => {
    // The unwound A runs 350° → 370°, so the cut crosses the seam once.
    const split = splitMapPath(helix([350, 370]), R);
    expect(Array.from(split.cutStep)).toEqual([1, 1]);
    const seg = (k: number): number[] => Array.from(split.cuts.slice(k * 6, k * 6 + 6));
    expect(seg(0)[1]).toBeCloseTo((350 * Math.PI * R) / 180, 5);
    expect(seg(0)[4]).toBeCloseTo(C, 5); // the 360° edge
    expect(seg(1)[1]).toBeCloseTo(0, 9); // the 0° edge
    expect(seg(1)[4]).toBeCloseTo((10 * Math.PI * R) / 180, 5);
  });

  it('a negative A wraps onto the map rather than going off it', () => {
    const split = splitMapPath(helix([-10, 0]), R);
    const y = ys(split.cuts);
    expect(y[0]).toBeCloseTo((350 * Math.PI * R) / 180, 5); // −10° is 350° on the map
    expect(y[1]).toBeCloseTo(C, 5); // arriving at 0° from below is the 360° edge
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
    a: null,
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

// #552 — the uncut stock's per-column side skirts read as a comb; the cleaned geometry replaces
// them with one flat wall per side while keeping the heightfield top and the underside intact.
describe('cleanStockGeometry', () => {
  /** Triangles whose face normal is horizontal (|nz| ≈ 0): the vertical skirts/walls. */
  const verticalTriangles = (positions: ArrayLike<number>, indices: ArrayLike<number>): number => {
    let n = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const ia = indices[i]! * 3;
      const ib = indices[i + 1]! * 3;
      const ic = indices[i + 2]! * 3;
      const ax = positions[ia]!, ay = positions[ia + 1]!;
      const bx = positions[ib]!, by = positions[ib + 1]!;
      const cx = positions[ic]!, cy = positions[ic + 1]!;
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(nz) < 1e-9) n += 1;
    }
    return n;
  };

  it('replaces the per-column skirts with four flat walls, keeping the top and underside', () => {
    const grid: ColumnGrid = {
      kind: 'flat',
      nu: 4,
      nv: 4,
      u0: 0,
      du: 1,
      v0: 0,
      dv: 1,
      initial: 0,
      base: -10,
      h: new Float32Array(16).fill(0),
    };
    const mesh = meshFlat(grid, { dx: 0.5, dThetaDeg: 0.5 });
    const skirts = verticalTriangles(mesh.positions, mesh.indices);
    expect(skirts).toBeGreaterThan(8); // the per-column comb this removes

    const cleaned = cleanStockGeometry(mesh);
    const positions = cleaned.getAttribute('position').array as Float32Array;
    const indices = cleaned.getIndex()!.array as Uint32Array;
    expect(verticalTriangles(positions, indices)).toBe(8); // exactly the four walls
    // The top heightfield and the underside are carried over untouched: only the skirts (dropped)
    // and the four new walls (8 triangles) differ.
    expect(indices.length / 3).toBe(mesh.indices.length / 3 - skirts + 8);
    // The clean block keeps the same extent.
    const pos = cleaned.getAttribute('position');
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    expect(minX).toBeCloseTo(mesh.bbox.min[0]!, 6);
    expect(maxX).toBeCloseTo(mesh.bbox.max[0]!, 6);
    expect(minZ).toBeCloseTo(mesh.bbox.min[2]!, 6);
    expect(maxZ).toBeCloseTo(mesh.bbox.max[2]!, 6);
    cleaned.dispose();
  });
});


// #723 R-4 review — A FINISHED RELIEF READS AS CUT. The unrolled stock is a heightfield, and from
// the top camera every top face meets the light the same way, so depth was invisible: the result
// said 1466 mm3 removed while the picture showed an uncut sheet. The stock's vertices now carry
// the radius the cut took — white where nothing was removed, the deep colour at the frame's
// deepest point.
describe('#723 the stock’s removed depth is coloured', () => {
  it('paints the cut columns and leaves the uncut stock white (the unrolled map)', () => {
    // θ = 180° is cut to radius 5; the other columns stand at R = 10.
    const grid: ColumnGrid = {
      kind: 'rotary', nu: 1, nv: 4, u0: 0.5, du: 1, v0: 0, dv: 90, initial: 10, base: 0,
      h: Float32Array.from([10, 10, 5, 10]),
    };
    const mesh = meshRotaryMap(grid, { dx: 1, dThetaDeg: 90 });
    const geom = geometryFromMesh(mesh);
    applyRemovedDepthColours(geom, { map: true, radius: 10, base: '#c9a26b' });
    const colour = geom.getAttribute('color');
    expect(colour).not.toBeNull();
    // Vertex (I, J) is I·5 + J; the θ = 180° top vertex is (0, 2), the seam (0, 4) is uncut.
    const at = (I: number, J: number): [number, number, number] => {
      const v = I * 5 + J;
      return [colour.getX(v), colour.getY(v), colour.getZ(v)];
    };
    const cut = at(0, 2);
    const uncut = at(0, 4);
    // Nothing removed: the material's own colour, exactly (baked in — vertex colours multiply the
    // material, so the material is white while they are on).
    const base = new THREE.Color('#c9a26b');
    expect(uncut[0]).toBeCloseTo(base.r, 5);
    expect(uncut[1]).toBeCloseTo(base.g, 5);
    expect(uncut[2]).toBeCloseTo(base.b, 5);
    // The cut vertex is pulled toward the deep colour: bluer than the stock and bluer than white.
    expect(cut[2] - cut[0]).toBeGreaterThan(0.2);
    expect(cut[2]).toBeLessThan(0.95);
    geom.dispose();
  });

  it('keeps the rod’s end-cap apexes the material colour — they are closure, not cut', () => {
    // The ROD mesh's cap fans converge on the axis at each end. Measured by the radius they lost
    // (R), they would read as a full-depth cut and paint the rod's whole end face blue; they are
    // the solid's closure to the axis, so they keep the base colour while the cut surface does not.
    const grid: ColumnGrid = {
      kind: 'rotary', nu: 1, nv: 4, u0: 0.5, du: 1, v0: 0, dv: 90, initial: 10, base: 0,
      h: Float32Array.from([10, 10, 5, 10]),
    };
    const mesh = meshRotary(grid, { dx: 1, dThetaDeg: 90 });
    const geom = geometryFromMesh(mesh);
    applyRemovedDepthColours(geom, { map: false, radius: 10, base: '#c9a26b' });
    const colour = geom.getAttribute('color');
    const base = new THREE.Color('#c9a26b');
    for (const v of [mesh.vertexCount - 2, mesh.vertexCount - 1]) {
      expect(colour.getX(v)).toBeCloseTo(base.r, 5);
      expect(colour.getY(v)).toBeCloseTo(base.g, 5);
      expect(colour.getZ(v)).toBeCloseTo(base.b, 5);
    }
    // The θ = 180° column (r = 5) IS the cut surface: pulled toward the deep colour.
    const cut = [colour.getX(2), colour.getY(2), colour.getZ(2)];
    expect(cut[2]! - cut[0]!).toBeGreaterThan(0.2);
    geom.dispose();
  });
});
