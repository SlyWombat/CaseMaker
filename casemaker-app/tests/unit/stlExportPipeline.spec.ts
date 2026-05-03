// End-to-end self-print sanity: compile a real template through Manifold,
// pipe each emitted node through the same buildBinaryStl writer the
// production export pipeline uses, then parse the STL bytes back and
// assert the triangle count and bbox dimensions are within sane bounds.
//
// The existing manifoldIntegrity.spec.ts checks that every node is a
// single non-empty manifold; this spec covers what happens AFTER that —
// the writer's output has the right triangle count, the bbox lands at
// reasonable coordinates, and the file size matches the documented
// 84 + 50*tri formula. Catches regressions where a build silently
// produces zero triangles, an inverted bbox, or where the writer's
// header/footer math drifts.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import type { BuildOp } from '@/engine/compiler/buildPlan';
import { findTemplate } from '@/library/templates';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import type { Project } from '@/types';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('manifold-3d/manifold.wasm');

const tl = await ManifoldModule({
  locateFile: (p: string) => (p.endsWith('.wasm') ? wasmPath : p),
});
tl.setup();
const { Manifold, Mesh } = tl;
type ManifoldInstance = InstanceType<typeof Manifold>;

function dedupeVertices(positions: Float32Array, indices: Uint32Array): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const map = new Map<string, number>();
  const newPos: number[] = [];
  const newIdx = new Uint32Array(indices.length);
  const PREC = 1e5;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]!;
    const x = Math.round(positions[v * 3]! * PREC) / PREC;
    const y = Math.round(positions[v * 3 + 1]! * PREC) / PREC;
    const z = Math.round(positions[v * 3 + 2]! * PREC) / PREC;
    const k = `${x},${y},${z}`;
    let id = map.get(k);
    if (id === undefined) {
      id = newPos.length / 3;
      newPos.push(x, y, z);
      map.set(k, id);
    }
    newIdx[i] = id;
  }
  return { positions: new Float32Array(newPos), indices: newIdx };
}

function exec(op: BuildOp): ManifoldInstance {
  switch (op.kind) {
    case 'cube':
      return Manifold.cube(op.size, op.center ?? false);
    case 'cylinder':
      return Manifold.cylinder(
        op.height,
        op.radiusLow,
        op.radiusHigh ?? op.radiusLow,
        op.segments ?? 0,
        op.center ?? false,
      );
    case 'mesh': {
      const d = dedupeVertices(op.positions, op.indices);
      return new Manifold(
        new Mesh({ numProp: 3, vertProperties: d.positions, triVerts: d.indices }),
      );
    }
    case 'translate': {
      const c = exec(op.child);
      const r = c.translate(op.offset);
      c.delete();
      return r;
    }
    case 'rotate': {
      const c = exec(op.child);
      const r = c.rotate(op.degrees);
      c.delete();
      return r;
    }
    case 'scale': {
      const c = exec(op.child);
      const r = c.scale([op.factor, op.factor, op.factor]);
      c.delete();
      return r;
    }
    case 'union':
    case 'difference':
    case 'intersection': {
      const cs = op.children.map(exec);
      let r: ManifoldInstance;
      if (op.kind === 'union') r = Manifold.union(cs);
      else if (op.kind === 'difference') r = Manifold.difference(cs);
      else r = Manifold.intersection(cs);
      cs.forEach((c) => c.delete());
      return r;
    }
  }
}

function manifoldToBuffer(m: ManifoldInstance): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const mesh = m.getMesh();
  return {
    positions: new Float32Array(mesh.vertProperties),
    indices: new Uint32Array(mesh.triVerts),
  };
}

function parseBinaryStl(buf: ArrayBuffer): {
  triCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
} {
  const dv = new DataView(buf);
  const triCount = dv.getUint32(80, true);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let off = 84;
  for (let i = 0; i < triCount; i++) {
    off += 12; // skip normal
    for (let v = 0; v < 3; v++) {
      const x = dv.getFloat32(off, true);
      const y = dv.getFloat32(off + 4, true);
      const z = dv.getFloat32(off + 8, true);
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
      off += 12;
    }
    off += 2;
  }
  return { triCount, bbox: { min, max } };
}

interface NodeBounds {
  /** Inclusive lower / upper bounds for triangle count on this node. */
  triRange: [number, number];
  /** Inclusive bounds on the world-space size of the node along each axis. */
  sizeRange: { x: [number, number]; y: [number, number]; z: [number, number] };
}

function checkNode(id: string, op: BuildOp, bounds: NodeBounds): void {
  const m = exec(op);
  try {
    const buf = manifoldToBuffer(m);
    const stl = buildBinaryStl([buf]);
    const expectedBytes = 84 + (buf.indices.length / 3) * 50;
    expect(stl.byteLength, `${id} STL byte length`).toBe(expectedBytes);
    const parsed = parseBinaryStl(stl);
    expect(parsed.triCount, `${id} triangle count`).toBe(buf.indices.length / 3);
    expect(
      parsed.triCount,
      `${id} triCount within [${bounds.triRange[0]}, ${bounds.triRange[1]}]`,
    ).toBeGreaterThanOrEqual(bounds.triRange[0]);
    expect(
      parsed.triCount,
      `${id} triCount within [${bounds.triRange[0]}, ${bounds.triRange[1]}]`,
    ).toBeLessThanOrEqual(bounds.triRange[1]);
    const sx = parsed.bbox.max[0] - parsed.bbox.min[0];
    const sy = parsed.bbox.max[1] - parsed.bbox.min[1];
    const sz = parsed.bbox.max[2] - parsed.bbox.min[2];
    expect(sx, `${id} size X`).toBeGreaterThanOrEqual(bounds.sizeRange.x[0]);
    expect(sx, `${id} size X`).toBeLessThanOrEqual(bounds.sizeRange.x[1]);
    expect(sy, `${id} size Y`).toBeGreaterThanOrEqual(bounds.sizeRange.y[0]);
    expect(sy, `${id} size Y`).toBeLessThanOrEqual(bounds.sizeRange.y[1]);
    expect(sz, `${id} size Z`).toBeGreaterThanOrEqual(bounds.sizeRange.z[0]);
    expect(sz, `${id} size Z`).toBeLessThanOrEqual(bounds.sizeRange.z[1]);
  } finally {
    m.delete();
  }
}

describe('STL export pipeline — Manifold output → buildBinaryStl → parse', () => {
  it('protective-case template emits well-formed STL bytes for shell + lid', () => {
    const tpl = findTemplate('protective-case');
    if (!tpl) throw new Error('protective-case template not found');
    const project: Project = tpl.build();
    const plan = compileProject(project);
    const shell = plan.nodes.find((n) => n.id === 'shell');
    const lid = plan.nodes.find((n) => n.id === 'lid');
    if (!shell || !lid) throw new Error('expected shell + lid in protective-case plan');
    // The protective-case template wraps a roughly 100x70 enclosure with
    // ~30mm tall walls plus latches/hinge. Generous bounds so feature
    // tweaks don't break the spec — the goal is to catch silent zeros
    // and runaway geometry, not pin a specific tri count.
    checkNode('shell', shell.op, {
      triRange: [200, 200_000],
      sizeRange: { x: [60, 250], y: [40, 250], z: [10, 80] },
    });
    checkNode('lid', lid.op, {
      triRange: [50, 200_000],
      sizeRange: { x: [60, 250], y: [40, 250], z: [2, 60] },
    });
  }, 120_000);

  it('snap-fit-test template emits well-formed STL bytes for every node', () => {
    const tpl = findTemplate('snap-fit-test');
    if (!tpl) throw new Error('snap-fit-test template not found');
    const project: Project = tpl.build();
    const plan = compileProject(project);
    expect(plan.nodes.length).toBeGreaterThanOrEqual(2);
    for (const node of plan.nodes) {
      checkNode(node.id, node.op, {
        triRange: [12, 200_000],
        sizeRange: { x: [1, 250], y: [1, 250], z: [0.5, 80] },
      });
    }
  }, 120_000);
});
