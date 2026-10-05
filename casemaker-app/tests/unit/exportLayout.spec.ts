import { describe, it, expect } from 'vitest';
import {
  computePartTransforms,
  applyPartTransform,
  applyLayoutToMeshes,
  PRINT_FLIP_NODE_IDS,
} from '@/engine/exportLayout';
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

  it('reverses triangle winding when a part is flipped', () => {
    const lid = makeNode(
      'lid',
      [0, 0, 4, 10, 0, 4, 0, 10, 6],
      [0, 1, 2],
    );
    const out = applyLayoutToMeshes([lid], { flipNodeIds: ['lid'] });
    expect(Array.from(out[0]!.indices)).toEqual([0, 2, 1]);
  });
});
