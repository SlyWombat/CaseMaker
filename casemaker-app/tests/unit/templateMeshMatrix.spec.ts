// #1180 B3 — THE TEMPLATE MESH MATRIX. Every template, compiled once and meshed once per node,
// asserted for the facts the three older specs each re-derived from their own build:
//
//   templateIntegrity.spec.ts > "compiles every template with every node a single connected solid"
//   manifoldIntegrity.spec.ts > "protective-case template …" and "snap-fit-test template …"
//   stlExportPipeline.spec.ts > "protective-case … shell + lid" and "snap-fit-test … every node"
//
// are all subsumed here: one `it` per template, each node checked for non-empty, NoError, one
// connected component, and well-formed binary STL bytes — the old protective-case/snap-fit tri and
// size bounds are kept as data below. The three older files are deleted; `meshFor`/`meshFacts`
// live in helpers/templateMeshes.ts so a spec that needs the same mesh does not build it again.

import { describe, expect, it } from 'vitest';

import { buildBinaryStl } from '@/workers/export/stlBinary';
import { TEMPLATES } from '@/library/templates';
import { meshBuffers, meshFacts, meshFor, templatePlan } from './helpers/templateMeshes';

interface SizeRange {
  x: [number, number];
  y: [number, number];
  z: [number, number];
}

interface NodeBounds {
  triRange: [number, number];
  sizeRange: SizeRange;
}

/**
 * The bounds the old STL spec pinned, kept for the templates it pinned them on. A `*` entry applies
 * to every node of that template; a named entry wins for that node. Generous by design: the point
 * is to catch silent zeros and runaway geometry, not to pin exact triangle counts.
 */
const BOUNDS: Record<string, Record<string, NodeBounds>> = {
  'protective-case': {
    shell: { triRange: [200, 200_000], sizeRange: { x: [60, 250], y: [40, 250], z: [10, 80] } },
    lid: { triRange: [50, 200_000], sizeRange: { x: [60, 250], y: [40, 250], z: [2, 60] } },
  },
  'snap-fit-test': {
    '*': { triRange: [12, 200_000], sizeRange: { x: [1, 250], y: [1, 250], z: [0.5, 80] } },
  },
};

function parseBinaryStl(buf: ArrayBuffer): {
  triCount: number;
  size: { x: number; y: number; z: number };
} {
  const dv = new DataView(buf);
  const triCount = dv.getUint32(80, true);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let off = 84;
  for (let i = 0; i < triCount; i++) {
    off += 12; // skip the normal
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
  return { triCount, size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] } };
}

describe('#1180 the template mesh matrix — every template, every node, once', () => {
  for (const template of TEMPLATES) {
    it(
      `${template.id}: every emitted node is one non-empty manifold with well-formed STL`,
      () => {
        const plan = templatePlan(template.id);
        expect(plan.nodes.length, `${template.id} emits parts`).toBeGreaterThan(0);
        for (const node of plan.nodes) {
          const detail = `${template.id}/${node.id}`;
          const nodeFacts = meshFacts(node.op);
          expect(nodeFacts.empty, `${detail} is empty`).toBe(false);
          expect(nodeFacts.triangles, `${detail} has triangles`).toBeGreaterThan(0);
          expect(
            nodeFacts.status === 'NoError' || nodeFacts.status === 0,
            `${detail} status=${nodeFacts.status}`,
          ).toBe(true);
          expect(nodeFacts.components, `${detail} is one connected solid`).toBe(1);

          const buffers = meshBuffers(meshFor(node.op));
          const stl = buildBinaryStl([buffers]);
          const triangleCount = buffers.indices.length / 3;
          expect(stl.byteLength, `${detail} STL byte length`).toBe(84 + triangleCount * 50);
          const parsed = parseBinaryStl(stl);
          expect(parsed.triCount, `${detail} STL triangle count`).toBe(triangleCount);

          const bounds = BOUNDS[template.id]?.[node.id] ?? BOUNDS[template.id]?.['*'];
          if (bounds !== undefined) {
            expect(parsed.triCount, `${detail} triCount >= ${bounds.triRange[0]}`).toBeGreaterThanOrEqual(
              bounds.triRange[0],
            );
            expect(parsed.triCount, `${detail} triCount <= ${bounds.triRange[1]}`).toBeLessThanOrEqual(
              bounds.triRange[1],
            );
            for (const axis of ['x', 'y', 'z'] as const) {
              expect(parsed.size[axis], `${detail} size ${axis}`).toBeGreaterThanOrEqual(bounds.sizeRange[axis][0]);
              expect(parsed.size[axis], `${detail} size ${axis}`).toBeLessThanOrEqual(bounds.sizeRange[axis][1]);
            }
          }
        }
      },
      600_000,
    );
  }
});
