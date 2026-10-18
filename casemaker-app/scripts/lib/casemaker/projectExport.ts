/**
 * The ProjectCompiler → Manifold → STL path shared by `scripts/export-sample.ts` and
 * `casemaker export` (#477).
 *
 * The sample script has always done this: compile the project's plan, evaluate every node into a
 * mesh, lay the parts out print-ready, write one binary STL, and write the PRINT-NOTES sidecar from
 * the same parts. Extracting the two functions is deliberately all that moved — the layout options
 * and the notes' `print-ready` mode are the sample script's own and are named here once so the CLI
 * cannot export a subtly different file.
 */
import type { ManifoldToplevel } from 'manifold-3d';

import { compileProject } from '../../../src/engine/compiler/ProjectCompiler';
import { executeOp } from '../../../src/workers/geometry/evaluateOp';
import { buildBinaryStl } from '../../../src/workers/export/stlBinary';
import { applyLayoutToMeshes, PRINT_FLIP_NODE_IDS } from '../../../src/engine/exportLayout';
import { partForId } from '../../../src/engine/exporters/parts';
import { printNotesText } from '../../../src/engine/exporters/printNotes';
import type { Project, MeshNode } from '../../../src/types';

/** One compiled node as the STL writer wants it. */
export interface NodeOutput {
  id: string;
  positions: Float32Array;
  indices: Uint32Array;
  triCount: number;
}

/** Compile a project and evaluate each of its plan's nodes into a mesh. */
export async function buildNodeMeshes(
  tl: ManifoldToplevel,
  project: Project,
): Promise<NodeOutput[]> {
  const plan = compileProject(project);
  const out: NodeOutput[] = [];
  for (const node of plan.nodes) {
    const m = await executeOp(tl, node.op);
    try {
      const mesh = m.getMesh();
      const numProp = mesh.numProp;
      const verts = mesh.vertProperties;
      const indices = new Uint32Array(mesh.triVerts);
      let positions: Float32Array;
      if (numProp === 3) {
        positions = new Float32Array(verts);
      } else {
        const numVert = verts.length / numProp;
        positions = new Float32Array(numVert * 3);
        for (let i = 0; i < numVert; i++) {
          positions[i * 3] = verts[i * numProp]!;
          positions[i * 3 + 1] = verts[i * numProp + 1]!;
          positions[i * 3 + 2] = verts[i * numProp + 2]!;
        }
      }
      out.push({ id: node.id, positions, indices, triCount: indices.length / 3 });
    } finally {
      m.delete();
    }
  }
  return out;
}

/** What one exported project wrote. */
export interface WrittenProject {
  /** The STL's file name (no directory), as written. */
  fileName: string;
  /** The PRINT-NOTES sidecar's file name (no directory). */
  notesFileName: string;
  /** Raw triangle count across the compiled nodes — before layout, which does not change it. */
  triangles: number;
  /** Bytes in the binary STL. */
  bytes: number;
}

/**
 * Lay a project's parts out print-ready, write its binary STL and its PRINT-NOTES sidecar into
 * `outDir`. The `filename` is the caller's: the sample script keeps its committed names, and the
 * CLI derives one from the project's own.
 */
export async function writeProjectStl(
  tl: ManifoldToplevel,
  project: Project,
  outDir: string,
  filename: string,
): Promise<WrittenProject> {
  const rawMeshes = await buildNodeMeshes(tl, project);
  // Apply the print-ready layout (issue #10): flip the lid 180° on X, drop every part to Z=0,
  // pack side-by-side along +X with a 5 mm gap.
  const meshNodes: MeshNode[] = rawMeshes.map((m) => ({
    id: m.id,
    buffer: { positions: m.positions, indices: m.indices },
    stats: {
      vertexCount: m.positions.length / 3,
      triangleCount: m.triCount,
      bbox: { min: [0, 0, 0], max: [0, 0, 0] },
    },
  }));
  const laid = applyLayoutToMeshes(meshNodes, { gap: 5, bedWidth: 220, flipNodeIds: PRINT_FLIP_NODE_IDS });
  const buf = buildBinaryStl(laid.map((m) => ({ positions: m.positions, indices: m.indices })));
  const { writeFileSync } = nodeFs();
  writeFileSync(joinPath(outDir, filename), Buffer.from(buf));
  // Issue #154 — the print guidance reaches the file the user actually gets. The sample is laid
  // out print-ready (above), so the sidecar says the parts are already turned over.
  const notesFileName = filename.replace(/\.stl$/i, '') + '-PRINT-NOTES.txt';
  writeFileSync(
    joinPath(outDir, notesFileName),
    printNotesText(laid.map((m) => partForId(m.id)), 'print-ready'),
  );
  return {
    fileName: filename,
    notesFileName,
    triangles: rawMeshes.reduce((s, m) => s + m.triCount, 0),
    bytes: buf.byteLength,
  };
}

// ---------------------------------------------------------------------------------------------
// Node, without a static `node:fs` import
// ---------------------------------------------------------------------------------------------

/**
 * This module sits under `scripts/`, which `tsconfig.scripts.json` compiles with Node types, but
 * keeping the import dynamic leaves it importable by a browser-typed caller (the same seam the
 * bootstrap uses). It is never imported by app code.
 */
declare const process:
  | { getBuiltinModule?: (id: string) => unknown }
  | undefined;

interface FsLike {
  writeFileSync(path: string, data: string | Uint8Array): void;
}
interface PathLike {
  join(...parts: string[]): string;
}

function nodeFs(): FsLike {
  const get = typeof process === 'undefined' ? undefined : process.getBuiltinModule;
  if (typeof get !== 'function') throw new Error('project export needs Node >= 22.3');
  return get('node:fs') as FsLike;
}

function joinPath(...parts: string[]): string {
  const get = typeof process === 'undefined' ? undefined : process.getBuiltinModule;
  if (typeof get !== 'function') throw new Error('project export needs Node >= 22.3');
  return (get('node:path') as PathLike).join(...parts);
}
