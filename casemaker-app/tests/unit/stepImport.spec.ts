/**
 * STEP import (#774) — the CAD kernel at the import door.
 *
 * The fixtures are OpenCascade-generated STEP files committed under `tests/fixtures/step/`:
 *
 *   box.step                 20 × 10 × 5 mm box (a prism, so it is also a stock)
 *   box-with-hole.step       the same box, ⌀6 mm through hole on Z at its centre
 *                            volume = 1000 − π·3²·5 = 858.628 mm³
 *   assembly-two-bodies.step two 10 × 10 × 5 mm boxes 5 mm apart, in one file
 *
 * The kernel is a real wasm module and the assertions are geometric: a closed mesh, the right
 * volume and bounding box, and the merge of a multi-body file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { stepToStl } from '@/engine/import/stepMesh';
import { parseStl } from '@/engine/import/stlParser';
import { base64ToArrayBuffer } from '@/engine/import/base64';
import { readTargetObjectFile } from '@/engine/import/targetObject';
import { readStockFile } from '@/engine/import/meshStock';

const FIXTURES = path.resolve(__dirname, '../fixtures/step');

function fixture(name: string): ArrayBuffer {
  const bytes = fs.readFileSync(path.join(FIXTURES, name));
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Signed-tetrahedron volume of a triangle soup, mm³. Positive for outward faces. */
function volumeOf(positions: Float32Array, indices: Uint32Array): number {
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = (indices[t] as number) * 3;
    const b = (indices[t + 1] as number) * 3;
    const c = (indices[t + 2] as number) * 3;
    const ax = positions[a] as number;
    const ay = positions[a + 1] as number;
    const az = positions[a + 2] as number;
    const bx = positions[b] as number;
    const by = positions[b + 1] as number;
    const bz = positions[b + 2] as number;
    const cx = positions[c] as number;
    const cy = positions[c + 1] as number;
    const cz = positions[c + 2] as number;
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return volume;
}

/**
 * Boundary edges of a welded triangle soup: edges used by exactly one triangle. A closed mesh has
 * none. Vertices are welded at 1 µm first, because each face's tessellation may repeat a point.
 */
function boundaryEdges(positions: Float32Array, indices: Uint32Array, tol = 1e-3): number {
  const key = (v: number): string =>
    `${Math.round((positions[v * 3] as number) / tol)},${Math.round((positions[v * 3 + 1] as number) / tol)},${Math.round((positions[v * 3 + 2] as number) / tol)}`;
  const welded = new Map<string, number>();
  const id = new Uint32Array(positions.length / 3);
  for (let v = 0; v < id.length; v++) {
    const k = key(v);
    let known = welded.get(k);
    if (known === undefined) {
      known = welded.size;
      welded.set(k, known);
    }
    id[v] = known;
  }
  const edges = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [id[indices[t] as number] as number, id[indices[t + 1] as number] as number, id[indices[t + 2] as number] as number];
    for (let e = 0; e < 3; e++) {
      const p = tri[e] as number;
      const q = tri[(e + 1) % 3] as number;
      if (p === q) continue;
      const k = p < q ? `${p}:${q}` : `${q}:${p}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let boundary = 0;
  for (const count of edges.values()) if (count === 1) boundary++;
  return boundary;
}

describe('STEP import (#774)', () => {
  it('reads a box with a hole to a closed mesh of the right volume and bounding box', async () => {
    const { mesh, stl, parts } = await stepToStl(fixture('box-with-hole.step'));
    expect(parts).toBe(1);
    expect(mesh.triangleCount).toBeGreaterThan(100);
    // The bounding box is the file's own geometry: 20 × 10 × 5 mm, on the origin.
    for (let axis = 0; axis < 3; axis++) {
      expect(mesh.bbox.min[axis] as number).toBeCloseTo(0, 3);
    }
    expect(mesh.bbox.max[0]).toBeCloseTo(20, 3);
    expect(mesh.bbox.max[1]).toBeCloseTo(10, 3);
    expect(mesh.bbox.max[2]).toBeCloseTo(5, 3);
    // The hole is tessellated, so the volume is the polygonal hole: within 1% of the analytic value.
    expect(volumeOf(mesh.positions, mesh.indices)).toBeCloseTo(858.628, -1);
    expect(Math.abs(volumeOf(mesh.positions, mesh.indices) - 858.628) / 858.628).toBeLessThan(0.01);
    // Closed: no edge belongs to one triangle only.
    expect(boundaryEdges(mesh.positions, mesh.indices)).toBe(0);
    // The stored bytes are the same mesh in the format every reader knows.
    const stored = parseStl(stl);
    expect(stored.triangleCount).toBe(mesh.triangleCount);
  });

  it('merges an assembly file\'s bodies into one mesh, and says how many it read', async () => {
    const { mesh, parts } = await stepToStl(fixture('assembly-two-bodies.step'));
    // Two bodies, MERGED — the goal door takes the triangle soup; the stock door refuses the
    // outline below. This is the choice #774's brief allowed us to make.
    expect(parts).toBe(2);
    expect(mesh.triangleCount).toBe(24);
    expect(mesh.bbox.max[0]).toBeCloseTo(25, 3);
    expect(mesh.bbox.max[1]).toBeCloseTo(10, 3);
    expect(mesh.bbox.max[2]).toBeCloseTo(5, 3);
    expect(volumeOf(mesh.positions, mesh.indices)).toBeCloseTo(1000, 3);
  });

  it('reads a STEP goal through the target-object door and embeds a mesh, not the STEP bytes', async () => {
    const file = new File([fixture('box-with-hole.step')], 'box-with-hole.step');
    const read = await readTargetObjectFile(file, 'goal-1');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.name).toBe('box-with-hole.step');
    // What is stored is the tessellated mesh, so the document carries the STL format...
    expect(read.format).toBe('stl');
    expect(read.sha256).toMatch(/^[0-9a-f]{64}$/);
    // ...which the existing reader parses back to the same part.
    const stored = parseStl(base64ToArrayBuffer(read.data));
    expect(stored.bbox.max[0]).toBeCloseTo(20, 3);
    expect(stored.bbox.max[1]).toBeCloseTo(10, 3);
    expect(stored.bbox.max[2]).toBeCloseTo(5, 3);
    expect(read.size.x).toBeCloseTo(20, 3);
    // The hash identifies the stored bytes: the same file imports to the same id bytes.
    const again = await readTargetObjectFile(file, 'goal-2');
    expect(again.ok && again.sha256).toBe(read.sha256);
  });

  it('reads a STEP prism as stock, and refuses a multi-body file by its outline', async () => {
    const box = await readStockFile(new File([fixture('box.step')], 'box.step'));
    expect(box.kind).toBe('mesh');
    if (box.kind !== 'mesh') return;
    expect(box.length).toBeCloseTo(20, 3);
    expect(box.width).toBeCloseTo(10, 3);
    expect(box.thickness).toBeCloseTo(5, 3);

    // A merged two-body mesh is closed and prismatic, but its top face fills only 80% of its
    // bounding rectangle — `meshAsStock`'s own refusal, reached through the STEP door.
    const assembly = await readStockFile(new File([fixture('assembly-two-bodies.step')], 'assembly-two-bodies.step'));
    expect(assembly.kind).toBe('refused');
    if (assembly.kind !== 'refused') return;
    expect(assembly.reason).toMatch(/rectangle|covers/i);
  });

  it('refuses a file that is not STEP data with a sentence naming the file', async () => {
    const bytes = new TextEncoder().encode('this is not a STEP file').buffer;
    const read = await readTargetObjectFile(new File([bytes], 'bogus.step'), 'goal-3');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toContain('bogus.step');
    expect(read.error).toMatch(/could not be read as STEP/i);
  });
});
