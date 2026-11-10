/**
 * #1180 B3 — ONE mesh per template node per spec file.
 *
 * Three specs compiled the same templates and re-executed the same nodes over and over
 * (`templateIntegrity` built every template, `manifoldIntegrity` rebuilt two of them,
 * `stlExportPipeline` rebuilt two again, and the rack/orientation specs rebuilt rack parts): the
 * protective case alone was compiled and meshed four times for one set of facts. This module holds
 * the compile and the Manifold mesh by identity, so a file asks once and every assertion in that
 * file reads the same mesh.
 *
 * The cache is PER SPEC FILE (vitest isolates modules), which is exactly the scope the specs share
 * — no cross-file worker state, nothing to leak between files. Cached meshes are never deleted by
 * callers: they live until the file's worker exits, which is the price of sharing them.
 */

import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { findTemplate } from '@/library/templates';
import type { BuildOp, BuildPlan } from '@/engine/compiler/buildPlan';
import { exec, type ManifoldInstance } from './manifoldExec';

const plans = new Map<string, BuildPlan>();
const meshes = new WeakMap<BuildOp, ManifoldInstance>();

/** The template's plan, compiled once per file. A missing template is a test-authoring error. */
export function templatePlan(templateId: string): BuildPlan {
  const cached = plans.get(templateId);
  if (cached !== undefined) return cached;
  const template = findTemplate(templateId);
  if (template === undefined) throw new Error(`${templateId}: no such template`);
  const plan = compileProject(template.build());
  plans.set(templateId, plan);
  return plan;
}

/** The node's evaluated mesh, executed once per file. DO NOT `delete()` it — later assertions in
 *  the same file read the same instance. */
export function meshFor(op: BuildOp): ManifoldInstance {
  const cached = meshes.get(op);
  if (cached !== undefined) return cached;
  const mesh = exec(op);
  meshes.set(op, mesh);
  return mesh;
}

export interface NodeFacts {
  /** Connected components the mesh decomposes into. */
  components: number;
  triangles: number;
  status: string | number;
  empty: boolean;
}

const facts = new WeakMap<BuildOp, NodeFacts>();

/** The mesh facts every emitted part must satisfy once, read from the one cached mesh. */
export function meshFacts(op: BuildOp): NodeFacts {
  const cached = facts.get(op);
  if (cached !== undefined) return cached;
  const mesh = meshFor(op);
  const parts = mesh.decompose();
  const value: NodeFacts = {
    components: parts.length,
    triangles: mesh.numTri(),
    status: mesh.status(),
    empty: mesh.isEmpty(),
  };
  parts.forEach((part) => part.delete());
  facts.set(op, value);
  return value;
}

/** The evaluated mesh's buffers, in the shape `buildBinaryStl` takes. */
export function meshBuffers(mesh: ManifoldInstance): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const measured = mesh.getMesh();
  return {
    positions: new Float32Array(measured.vertProperties),
    indices: new Uint32Array(measured.triVerts),
  };
}
