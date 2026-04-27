// Build sample STLs from the real ProjectCompiler + Manifold pipeline.
// Run with `npm run sample:export`.
//
// Each sample exercises geometry that downstream users care about — currently
// the snap-fit calibration cube tracked by issue #2 and a representative
// ESP32 DevKit V1 case with snap-fit lid.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import ManifoldModule from 'manifold-3d';

import { compileProject } from '../src/engine/compiler/ProjectCompiler';
import type { BuildOp } from '../src/engine/compiler/buildPlan';
import { createDefaultProject } from '../src/store/projectStore';
import { buildBinaryStl } from '../src/workers/export/stlBinary';
import { autoPortsForBoard } from '../src/engine/compiler/portFactory';
import type { Project, BoardProfile } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const samplesDir = join(repoRoot, 'samples');
mkdirSync(samplesDir, { recursive: true });

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('manifold-3d/manifold.wasm');

const tl = await ManifoldModule({
  locateFile: (p: string) => (p.endsWith('.wasm') ? wasmPath : p),
});
tl.setup();
const { Manifold, Mesh } = tl;
type ManifoldInstance = InstanceType<typeof Manifold>;

function dedupe(positions: Float32Array, indices: Uint32Array): {
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
      const d = dedupe(op.positions, op.indices);
      const mesh = new Mesh({ numProp: 3, vertProperties: d.positions, triVerts: d.indices });
      return new Manifold(mesh);
    }
    case 'translate': {
      const child = exec(op.child);
      const result = child.translate(op.offset);
      child.delete();
      return result;
    }
    case 'rotate': {
      const child = exec(op.child);
      const result = child.rotate(op.degrees);
      child.delete();
      return result;
    }
    case 'scale': {
      const child = exec(op.child);
      const result = child.scale([op.factor, op.factor, op.factor]);
      child.delete();
      return result;
    }
    case 'union':
    case 'difference':
    case 'intersection': {
      const children = op.children.map(exec);
      let result: ManifoldInstance;
      if (op.kind === 'union') result = Manifold.union(children);
      else if (op.kind === 'difference') result = Manifold.difference(children);
      else result = Manifold.intersection(children);
      children.forEach((c) => c.delete());
      return result;
    }
  }
}

interface NodeOutput {
  positions: Float32Array;
  indices: Uint32Array;
  triCount: number;
}

function buildNodeMeshes(project: Project): NodeOutput[] {
  const plan = compileProject(project);
  const out: NodeOutput[] = [];
  for (const node of plan.nodes) {
    const m = exec(node.op);
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
      out.push({ positions, indices, triCount: indices.length / 3 });
    } finally {
      m.delete();
    }
  }
  return out;
}

function buildCalibrationProject(): Project {
  // 30 × 30 × 1.6 mm "PCB" with no components and no holes — produces a tiny
  // hollow box + snap-fit lid that's quick to print for tolerance tuning.
  const board: BoardProfile = {
    id: 'snap-fit-calibration',
    name: 'Snap-fit calibration',
    manufacturer: 'Case Maker samples',
    pcb: { size: { x: 30, y: 30, z: 1.6 } },
    mountingHoles: [],
    components: [],
    defaultStandoffHeight: 3,
    recommendedZClearance: 4,
    builtin: false,
  };
  const now = new Date(0).toISOString();
  return {
    schemaVersion: 1,
    id: 'sample-calibration',
    name: 'Snap-fit calibration cube',
    createdAt: now,
    modifiedAt: now,
    board,
    case: {
      wallThickness: 2,
      floorThickness: 2,
      lidThickness: 2,
      cornerRadius: 2,
      internalClearance: 0.5,
      zClearance: 4,
      joint: 'snap-fit',
      ventilation: { enabled: false, pattern: 'none', coverage: 0 },
      bosses: {
        enabled: false,
        insertType: 'self-tap',
        outerDiameter: 5,
        holeDiameter: 2.5,
      },
    },
    ports: [],
    externalAssets: [],
  };
}

function buildEsp32Project(): Project {
  const project = createDefaultProject('esp32-devkit-v1');
  project.case.joint = 'snap-fit';
  project.name = 'ESP32 DevKit V1 — snap-fit sample';
  // Re-run port factory in case the default board profile changed shape
  project.ports = autoPortsForBoard(project.board);
  return project;
}

interface SampleSpec {
  filename: string;
  description: string;
  build: () => Project;
}

const SAMPLES: SampleSpec[] = [
  {
    filename: 'snap-fit-calibration-30x30.stl',
    description: 'Tiny snap-fit calibration cube (30×30 mm PCB, no components)',
    build: buildCalibrationProject,
  },
  {
    filename: 'esp32-devkit-snap-fit.stl',
    description: 'ESP32 DevKit V1 with snap-fit lid (full real-world test case)',
    build: buildEsp32Project,
  },
];

let totalTris = 0;
for (const sample of SAMPLES) {
  const project = sample.build();
  const meshes = buildNodeMeshes(project);
  const buf = buildBinaryStl(meshes);
  const path = join(samplesDir, sample.filename);
  writeFileSync(path, Buffer.from(buf));
  const tris = meshes.reduce((s, m) => s + m.triCount, 0);
  totalTris += tris;
  console.log(`${sample.filename}  ${tris} triangles  ${(buf.byteLength / 1024).toFixed(1)} KB`);
}
console.log(`\nWrote ${SAMPLES.length} samples (${totalTris} total triangles) to ${samplesDir}`);
