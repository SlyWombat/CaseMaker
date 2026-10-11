import { describe, it, expect } from 'vitest';
import {
  computePartTransforms,
  applyPartTransform,
  applyLayoutToMeshes,
  PRINT_FLIP_NODE_IDS,
} from '@/engine/exportLayout';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import { parseBinaryStl } from '@/engine/import/stlParser';
import type { MeshNode } from '@/types';

function makeNode(id: string, positions: number[], indices: number[]): MeshNode {
  const pos = new Float32Array(positions);
  const idx = new Uint32Array(indices);
  return {
    id,
    buffer: { positions: pos, indices: idx },
    stats: {
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3,
      bbox: { min: [0, 0, 0], max: [0, 0, 0] },
    },
  };
}

/** The signed volume a mesh's surface encloses: (1/6) Σ a·(b×c). Positive = outward winding. */
function signedVolume(positions: Float32Array, indices: Uint32Array): number {
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const [ax, ay, az] = [positions[a]!, positions[a + 1]!, positions[a + 2]!];
    const [bx, by, bz] = [positions[b]!, positions[b + 1]!, positions[b + 2]!];
    const [cx, cy, cz] = [positions[c]!, positions[c + 1]!, positions[c + 2]!];
    // a · (b × c)
    sum +=
      ax * (by * cz - bz * cy) +
      ay * (bz * cx - bx * cz) +
      az * (bx * cy - by * cx);
  }
  return sum / 6;
}

/** Every triangle's normal points away from the bbox centre — the fixture's own winding is outward. */
function allOutward(positions: Float32Array, indices: Uint32Array): boolean {
  let cxm = 0,
    cym = 0,
    czm = 0;
  const n = positions.length / 3;
  for (let i = 0; i < positions.length; i += 3) {
    cxm += positions[i]!;
    cym += positions[i + 1]!;
    czm += positions[i + 2]!;
  }
  cxm /= n;
  cym /= n;
  czm /= n;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    // Triangle normal u × v, and the outward direction from the centre to the triangle's centroid.
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const ox = (positions[a]! + positions[b]! + positions[c]!) / 3 - cxm;
    const oy = (positions[a + 1]! + positions[b + 1]! + positions[c + 1]!) / 3 - cym;
    const oz = (positions[a + 2]! + positions[b + 2]! + positions[c + 2]!) / 3 - czm;
    if (nx * ox + ny * oy + nz * oz <= 0) return false;
  }
  return true;
}

/** A 1×1×1 cube on [0,1]³, wound so every face points outward (volume +1). */
function unitCube(id: string): MeshNode {
  const positions = [
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, // z = 0
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, // z = 1
  ];
  const indices = [
    // top (z=1, +z)
    4, 5, 6, 4, 6, 7,
    // bottom (z=0, -z)
    0, 2, 1, 0, 3, 2,
    // front (y=0, -y)
    0, 1, 5, 0, 5, 4,
    // back (y=1, +y)
    7, 6, 2, 7, 2, 3,
    // right (x=1, +x)
    1, 2, 6, 1, 6, 5,
    // left (x=0, -x)
    0, 4, 7, 0, 7, 3,
  ];
  return makeNode(id, positions, indices);
}

describe('export layout', () => {
  it('lid is flipped about X — its top vertices end up at the bed', () => {
    // Lid local: top plate at z=4..6 with center at z=5
    const lid = makeNode('lid', [0, 0, 4, 10, 0, 4, 0, 10, 6], [0, 1, 2]);
    const shell = makeNode('shell', [0, 0, 0, 10, 0, 0, 0, 10, 5], [0, 1, 2]);
    const transforms = computePartTransforms([shell, lid], { gap: 5, bedWidth: 220 });
    const lidTransform = transforms.get('lid')!;
    expect(lidTransform.flipAxis).toBe('x');
    // After applying, lid's bbox.min.z should be 0
    const flipped = applyPartTransform(lid.buffer.positions, lidTransform);
    let minZ = Infinity;
    for (let i = 2; i < flipped.length; i += 3) if (flipped[i]! < minZ) minZ = flipped[i]!;
    expect(minZ).toBeCloseTo(0, 4);
  });

  it('parts pack along +X with the configured gap', () => {
    const a = makeNode('a', [0, 0, 0, 10, 0, 0, 0, 10, 5], [0, 1, 2]);
    const b = makeNode('b', [0, 0, 0, 8, 0, 0, 0, 8, 4], [0, 1, 2]);
    const out = applyLayoutToMeshes([a, b], { gap: 5, bedWidth: 220, flipNodeIds: [] });
    // a starts at x=0, ends at x=10. b starts at x=15.
    let aMaxX = -Infinity;
    for (let i = 0; i < out[0]!.positions.length; i += 3) {
      if (out[0]!.positions[i]! > aMaxX) aMaxX = out[0]!.positions[i]!;
    }
    let bMinX = Infinity;
    for (let i = 0; i < out[1]!.positions.length; i += 3) {
      if (out[1]!.positions[i]! < bMinX) bMinX = out[1]!.positions[i]!;
    }
    expect(aMaxX).toBeCloseTo(10, 4);
    expect(bMinX).toBeCloseTo(15, 4);
    expect(bMinX - aMaxX).toBeCloseTo(5, 4);
  });

  it('wraps to the next row when bedWidth is exceeded', () => {
    const a = makeNode('a', [0, 0, 0, 200, 0, 0, 0, 50, 0], [0, 1, 2]);
    const b = makeNode('b', [0, 0, 0, 100, 0, 0, 0, 30, 0], [0, 1, 2]);
    const transforms = computePartTransforms([a, b], { gap: 5, bedWidth: 220, flipNodeIds: [] });
    const tA = transforms.get('a')!;
    const tB = transforms.get('b')!;
    expect(tA.translate[1]).toBeCloseTo(0, 4);
    // b should wrap onto a new row (Y > 0)
    expect(tB.translate[1]).toBeGreaterThan(0);
  });

  it('re-exports the one print-table flip set, fused racks included (#154)', () => {
    // The list is derived in @/engine/exporters/parts; the exporter keys off
    // this re-export, and partForId reports the same flags.
    expect(PRINT_FLIP_NODE_IDS).toContain('lid');
    expect(PRINT_FLIP_NODE_IDS).toContain('rack-bottom');
    expect(PRINT_FLIP_NODE_IDS).toContain('rack-assembled-frame');
    expect(PRINT_FLIP_NODE_IDS).toContain('rack-assembled-all');
    expect(PRINT_FLIP_NODE_IDS).not.toContain('rack-top');
  });

  it('keeps a flipped part facing outward — its signed volume stays positive (#357)', () => {
    // The regression this guards: the layout used to reverse every flipped part's triangle winding
    // "because a flip inverts it". The flip is not a mirror — it negates Y and Z, a half turn about
    // X, determinant +1 — so reversing on top of it wrote the part inside-out and Manifold read it
    // as a negative volume (a difference() then unions it). Volume is the witness: a mirror would
    // flip its sign.
    const cube = unitCube('lid');

    // Self-check the FIXTURE before trusting any measurement taken with it: every face must point
    // away from the cube's centre, so a positive volume below means "still outward", not "outward
    // to begin with, twice".
    expect(allOutward(cube.buffer.positions, cube.buffer.indices)).toBe(true);
    expect(signedVolume(cube.buffer.positions, cube.buffer.indices)).toBeCloseTo(1, 6);

    const [flipped] = applyLayoutToMeshes([cube], { flipNodeIds: ['lid'] });

    // The flip really ran, and as the declared half turn about X (y→−y+1, z→−z+1, x kept): the
    // cube's two extreme corners land opposite each other.
    const corner = (i: number) => [0, 1, 2].map((k) => flipped!.positions[i * 3 + k]!);
    expect(corner(0)).toEqual([0, 1, 1]);
    expect(corner(6)).toEqual([1, 0, 0]);
    // And the part is still a solid one cubic unit of outward-facing surface, with the index
    // buffer exactly as the mesh supplied it.
    expect(signedVolume(flipped!.positions, flipped!.indices)).toBeCloseTo(1, 6);
    expect(Array.from(flipped!.indices)).toEqual(Array.from(cube.buffer.indices));

    // The instrument is sensitive to exactly the defect it is meant to catch: reverse the same
    // cube's winding (what the old exporter did to every flipped part) and the volume goes
    // negative. Had this test run against the old layout code, it would have read −1.
    const insideOut = new Uint32Array(cube.buffer.indices);
    for (let t = 0; t < insideOut.length; t += 3) {
      const swap = insideOut[t + 1]!;
      insideOut[t + 1] = insideOut[t + 2]!;
      insideOut[t + 2] = swap;
    }
    expect(allOutward(cube.buffer.positions, insideOut)).toBe(false);
    expect(signedVolume(cube.buffer.positions, insideOut)).toBeCloseTo(-1, 6);
  });

  it('an EXPORTED flipped part measures positive — the bytes, not just the layout (#357)', () => {
    // The issue is about the file on disk, so this measures the file: lay the cube out, write it
    // through the same `buildBinaryStl` the export uses, read it back the way a slicer (or Manifold)
    // would, and take the volume of the parsed triangles. Against the old code the writer carried
    // the reversed index buffer through, and this would read −1.
    const cube = unitCube('lid');
    const [flipped] = applyLayoutToMeshes([cube], { flipNodeIds: ['lid'] });
    const bytes = buildBinaryStl([
      { positions: flipped!.positions, indices: flipped!.indices },
    ]);
    const parsed = parseBinaryStl(bytes);
    expect(parsed.triangleCount).toBe(12);
    expect(signedVolume(parsed.positions, parsed.indices)).toBeCloseTo(1, 5);

    // Same round trip, but with the index buffer the OLD layout produced: the writer and parser
    // carry the reversal through faithfully, so this reads −1. That is the measurement the old
    // export would have produced, so the assertion above is testing the fix and not the fixture.
    const backward = new Uint32Array(cube.buffer.indices);
    for (let t = 0; t < backward.length; t += 3) {
      const swap = backward[t + 1]!;
      backward[t + 1] = backward[t + 2]!;
      backward[t + 2] = swap;
    }
    const oldBytes = buildBinaryStl([{ positions: flipped!.positions, indices: backward }]);
    const oldParsed = parseBinaryStl(oldBytes);
    expect(signedVolume(oldParsed.positions, oldParsed.indices)).toBeCloseTo(-1, 5);
  });
});
