import type ManifoldModule from 'manifold-3d';

import type { BuildOp, Profile } from '@/engine/compiler/buildPlan';

/**
 * The single BuildOp → Manifold evaluator.
 *
 * It takes the initialised Manifold toplevel as an argument rather than owning
 * one so both callers can share it: the browser worker (ManifoldRuntime, which
 * loads the wasm through Vite) and the node-side sample exporter. Before this
 * split the switch was duplicated in both places, and every new primitive had
 * to be added twice.
 */
export type ManifoldToplevel = Awaited<ReturnType<typeof ManifoldModule>>;
type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;
type CrossSectionInstance = InstanceType<ManifoldToplevel['CrossSection']>;

/** Called between steps so a long build can be cancelled; may throw to abort. */
export type GenerationCheck = () => void;

const JOIN_TYPE = { round: 'Round', miter: 'Miter', square: 'Square' } as const;

/**
 * Evaluate a 2D profile to a Clipper2-backed CrossSection. Intermediates are
 * released as we go — CrossSection lives on the wasm heap just like Manifold.
 */
export function executeProfile(tl: ManifoldToplevel, p: Profile): CrossSectionInstance {
  const CS = tl.CrossSection;
  switch (p.kind) {
    case 'p-poly':
      // Even-odd so inner contours read as holes whichever way they wind.
      return CS.ofPolygons(p.contours, 'EvenOdd');
    case 'p-rect':
      return CS.square(p.size, p.center ?? false);
    case 'p-circle':
      return CS.circle(p.radius, p.segments ?? 0);
    case 'p-union':
    case 'p-difference':
    case 'p-intersection':
    case 'p-hull': {
      const kids = p.children.map((c) => executeProfile(tl, c));
      let result: CrossSectionInstance;
      if (p.kind === 'p-union') result = CS.union(kids);
      else if (p.kind === 'p-difference') result = CS.difference(kids);
      else if (p.kind === 'p-intersection') result = CS.intersection(kids);
      else result = CS.hull(kids);
      kids.forEach((k) => k.delete());
      return result;
    }
    case 'p-offset': {
      const child = executeProfile(tl, p.child);
      const result = child.offset(
        p.delta,
        JOIN_TYPE[p.join ?? 'round'],
        p.miterLimit ?? 2,
        p.segments ?? 0,
      );
      child.delete();
      return result;
    }
    case 'p-translate': {
      const child = executeProfile(tl, p.child);
      const result = child.translate(p.offset);
      child.delete();
      return result;
    }
    case 'p-rotate': {
      const child = executeProfile(tl, p.child);
      const result = child.rotate(p.degrees);
      child.delete();
      return result;
    }
    case 'p-mirror': {
      const child = executeProfile(tl, p.child);
      const result = child.mirror(p.normal);
      child.delete();
      return result;
    }
  }
}

/**
 * Async entry point kept for the worker's call signature. The evaluation is
 * synchronous — `check()` is polled between steps, and awaiting between ops
 * never let the worker receive a cancellation message anyway (that needs a
 * macrotask), so there is nothing to yield to.
 */
export async function executeOp(
  tl: ManifoldToplevel,
  op: BuildOp,
  check: GenerationCheck = () => {},
): Promise<ManifoldInstance> {
  return executeOpSync(tl, op, check);
}

export function executeOpSync(
  tl: ManifoldToplevel,
  op: BuildOp,
  check: GenerationCheck = () => {},
): ManifoldInstance {
  check();
  const Manifold = tl.Manifold;
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
      const dedup = deduplicateMesh(op.positions, op.indices);
      const meshObj = new tl.Mesh({
        numProp: 3,
        vertProperties: dedup.positions,
        triVerts: dedup.indices,
      });
      return new Manifold(meshObj);
    }
    case 'translate': {
      const child = executeOpSync(tl, op.child, check);
      const result = child.translate(op.offset);
      child.delete();
      return result;
    }
    case 'rotate': {
      const child = executeOpSync(tl, op.child, check);
      const result = child.rotate(op.degrees);
      child.delete();
      return result;
    }
    case 'scale': {
      const child = executeOpSync(tl, op.child, check);
      const result = child.scale([op.factor, op.factor, op.factor]);
      child.delete();
      return result;
    }
    case 'extrude': {
      const cs = executeProfile(tl, op.profile);
      // scaleTop MUST go in as a Vec2. The wasm binding accepts the scalar
      // form its .d.ts advertises but builds a broken solid from it (correct
      // bounding box, half the volume, inverted top face).
      const s = op.scaleTop ?? 1;
      const scaleTop: [number, number] = typeof s === 'number' ? [s, s] : [s[0], s[1]];
      const result = Manifold.extrude(
        cs,
        op.height,
        op.divisions ?? 0,
        op.twistDegrees ?? 0,
        scaleTop,
        op.center ?? false,
      );
      cs.delete();
      return result;
    }
    case 'revolve': {
      const cs = executeProfile(tl, op.profile);
      const result = Manifold.revolve(cs, op.segments ?? 0, op.degrees ?? 360);
      cs.delete();
      return result;
    }
    case 'union':
    case 'difference':
    case 'intersection':
    case 'hull': {
      const children: ManifoldInstance[] = [];
      for (const c of op.children) children.push(executeOpSync(tl, c, check));
      check();
      let result: ManifoldInstance;
      if (op.kind === 'union') result = Manifold.union(children);
      else if (op.kind === 'difference') result = Manifold.difference(children);
      else if (op.kind === 'intersection') result = Manifold.intersection(children);
      else result = Manifold.hull(children);
      children.forEach((c) => c.delete());
      return result;
    }
  }
}

const DEDUP_PRECISION = 1e5;

/**
 * Weld coincident vertices in a hand-built mesh. Manifold rejects a mesh whose
 * shared edges do not reference identical vertex indices, and generated
 * triangle soup routinely emits the same corner more than once.
 */
export function deduplicateMesh(
  positions: Float32Array,
  indices: Uint32Array,
): { positions: Float32Array; indices: Uint32Array } {
  const map = new Map<string, number>();
  const newPos: number[] = [];
  const newIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]!;
    const x = Math.round(positions[v * 3]! * DEDUP_PRECISION) / DEDUP_PRECISION;
    const y = Math.round(positions[v * 3 + 1]! * DEDUP_PRECISION) / DEDUP_PRECISION;
    const z = Math.round(positions[v * 3 + 2]! * DEDUP_PRECISION) / DEDUP_PRECISION;
    const key = `${x},${y},${z}`;
    let id = map.get(key);
    if (id === undefined) {
      id = newPos.length / 3;
      newPos.push(x, y, z);
      map.set(key, id);
    }
    newIdx[i] = id;
  }
  return { positions: new Float32Array(newPos), indices: newIdx };
}
