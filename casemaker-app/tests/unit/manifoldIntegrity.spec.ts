// Manifold integrity check for the protective-case template — runs the
// build through Manifold WASM and asserts every emitted node is:
//   • non-empty
//   • status === 'NoError'  (manifold accepts the mesh)
//   • a single connected component
//
// I (Claude) wrote and deleted this same scratch script ~6 times during
// the Pelican feature work — every regression in mesh winding, embed
// overlap, or coplanar fusion sneaks past vitest because vitest only
// inspects BuildOp tree shape, not the produced mesh. Promoting it to
// a spec means future edits get the same guardrail without anyone
// having to remember to run a one-shot script.
//
// We test the protective-case template specifically because it
// exercises the largest cross-section of features: shell + lid (shell
// mode + lid cavity) + gasket + 2 latches (knuckles + arms + pins +
// caps + protective ribs + pin holes) + 1 piano-segmented hinge +
// rugged exterior (corner bumpers + ribbed walls) + alignment flange.
// If any of those interact badly with each other, this spec catches it.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import type { BuildOp } from '@/engine/compiler/buildPlan';
import { findTemplate } from '@/library/templates';
import type { Project } from '@/types';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('manifold-3d/manifold.wasm');

// Top-level await isn't allowed in vitest beforeAll; load the module
// once at module-eval time and reuse.
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

interface NodeCheck {
  isEmpty: boolean;
  triCount: number;
  status: string | number;
  numComponents: number;
}

function checkNode(op: BuildOp): NodeCheck {
  const m = exec(op);
  try {
    const components = m.decompose();
    const numComponents = components.length;
    components.forEach((c) => c.delete());
    return {
      isEmpty: m.isEmpty(),
      triCount: m.numTri(),
      status: m.status(),
      numComponents,
    };
  } finally {
    m.delete();
  }
}

function expectNodeClean(id: string, op: BuildOp): void {
  const r = checkNode(op);
  // Combine into one assertion message so failures point at the
  // specific node + the reason it failed.
  const detail = `${id} — status=${r.status} empty=${r.isEmpty} tris=${r.triCount} components=${r.numComponents}`;
  expect(r.isEmpty, detail).toBe(false);
  expect(r.triCount, detail).toBeGreaterThan(0);
  expect(r.status === 'NoError' || r.status === 0, detail).toBe(true);
  expect(r.numComponents, detail).toBe(1);
}

describe('Manifold integrity — every emitted node is a single non-empty manifold', () => {
  it('protective-case template (shell + lid + gasket + latches + hinge + rugged + flange)', () => {
    const tpl = findTemplate('protective-case');
    if (!tpl) throw new Error('protective-case template not found');
    const project: Project = tpl.build();
    const plan = compileProject(project);
    expect(plan.nodes.length, 'plan should emit at least shell + lid').toBeGreaterThanOrEqual(2);
    for (const node of plan.nodes) {
      expectNodeClean(node.id, node.op);
    }
  }, 120_000);

  it('snap-fit-test template (snap catches + recessed lid path)', () => {
    const tpl = findTemplate('snap-fit-test');
    if (!tpl) throw new Error('snap-fit-test template not found');
    const project: Project = tpl.build();
    const plan = compileProject(project);
    for (const node of plan.nodes) {
      expectNodeClean(node.id, node.op);
    }
  }, 120_000);
});
