/**
 * #964 — THE SYNTHETIC FIXTURES' MESH GUARD, WITH ITS RED CASE.
 *
 * B's hand-built repro on #959 (comment 6649361890) entered a quad with a vertex count one
 * short: the missing facet was still "a mesh", the checker accepted it, and the hole read as a
 * 4 mm drop-cutter error — a round of engine review spent on a fixture bug. The fix's self-test
 * is generic, not a rerun of that quad: `assertFixtureMesh` states what every Manifold-built
 * fixture must satisfy (non-zero-area triangles, every edge shared by exactly two), the shared
 * builders call it on every mesh they hand a test, and this spec proves both the passing builders
 * and the failing shapes.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { assertFixtureMesh } from '../tools/fixtureMesh';
import { buildRandomPart, type PartKind } from '../tools/randomParts';

const KINDS: PartKind[] = ['rectilinear', 'filleted', 'sloped', 'filletedFloor', 'scooped', 'figure'];

describe('#964 the synthetic fixture meshes are closed and non-degenerate', () => {
  it('every seeded part builder passes its own guard', () => {
    for (const kind of KINDS) {
      for (const seed of [1, 2]) {
        const part = buildRandomPart(seed, kind, tl);
        expect(part.mesh.triangleCount, `${kind} seed ${seed} built no triangles`).toBeGreaterThan(0);
        // The builder already ran the guard; running it here again proves the exported check and
        // the builder cannot drift apart.
        assertFixtureMesh(part.mesh, `randomParts ${kind} seed ${seed}`);
      }
    }
  });

  it('FAILS a quad that dropped a vertex — B’s #959 defect, red-first', () => {
    // A 2 × 2 square entered as two triangles; the second triangle's third index repeats vertex
    // 2, so the facet has zero area. This is the shape of the #959 repro's mistake: a vertex lost
    // to an argument count, a facet that is not there, and a surface no longer closed.
    const droppedVertexQuad = {
      positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0],
      indices: [0, 1, 2, 0, 2, 2],
    };
    expect(() => assertFixtureMesh(droppedVertexQuad, 'dropped-vertex quad')).toThrow(/repeats a vertex|zero area/);
  });

  it('FAILS an open surface — a box with one facet missing', () => {
    const box = tl.Manifold.cube([10, 10, 10]);
    const m = box.getMesh();
    const positions = Array.from(m.vertProperties);
    const indices = Array.from(m.triVerts);
    box.delete();
    expect(() =>
      assertFixtureMesh({ positions, indices: indices.slice(0, indices.length - 3) }, 'box with a missing facet'),
    ).toThrow(/not closed|shared by 1 triangle/);
  });

  it('FAILS an index that addresses no vertex', () => {
    const quad = {
      positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0],
      indices: [0, 1, 2, 0, 3, 4],
    };
    expect(() => assertFixtureMesh(quad, 'out-of-range quad')).toThrow(/outside 0\.\.3/);
  });
});
