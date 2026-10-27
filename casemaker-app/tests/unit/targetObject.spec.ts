// #435 — reading a picked STL/3MF as the embedded target object.
//
// The parser is the existing #410 STL/3MF reader; what is new here is the size guard, the hash,
// the base64 embedding and the SHA-keyed mesh cache the viewport decodes from. Node has `File` and
// `crypto.subtle`, so the real path is exercised rather than a stub.

import { describe, it, expect } from 'vitest';
import { clearTargetObjectMeshCache, readTargetObjectFile, targetObjectMesh } from '@/engine/import/targetObject';
import { base64ToArrayBuffer } from '@/engine/import/base64';

const ASCII = `solid tet
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 10 0 0
    vertex 0 10 0
  endloop
endfacet
facet normal 0 1 0
  outer loop
    vertex 0 0 0
    vertex 10 0 0
    vertex 0 0 10
  endloop
endfacet
facet normal 1 0 0
  outer loop
    vertex 0 0 0
    vertex 0 0 10
    vertex 0 10 0
  endloop
endfacet
facet normal 1 1 1
  outer loop
    vertex 10 0 0
    vertex 0 10 0
    vertex 0 0 10
  endloop
endfacet
endsolid tet
`;

describe('#435 — reading a target object', () => {
  it('parses a picked STL, states its size and embeds the exact bytes', async () => {
    const file = new File([ASCII], 'tet.stl');
    const result = await readTargetObjectFile(file, 'tgt-test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.id).toBe('tgt-test');
    expect(result.name).toBe('tet.stl');
    expect(result.format).toBe('stl');
    expect(result.size).toEqual({ x: 10, y: 10, z: 10 });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The embedded payload is the file, not a re-serialisation of the mesh.
    const bytes = new Uint8Array(base64ToArrayBuffer(result.data));
    expect(new TextDecoder().decode(bytes)).toBe(ASCII);
  });

  it('refuses a file that is not STL/3MF/PNG, an empty file, a flat mesh and an oversized one', async () => {
    expect(await readTargetObjectFile(new File(['hello'], 'notes.txt'), 't')).toMatchObject({
      ok: false,
      error: 'notes.txt is not an STL, 3MF or PNG file.',
    });
    expect(await readTargetObjectFile(new File([], 'empty.stl'), 't')).toMatchObject({
      ok: false,
      error: 'empty.stl is empty.',
    });

    const flat = ASCII.replace(/vertex 0 0 10/g, 'vertex 0 0 0').replace(/vertex 0 0 10/g, 'vertex 0 0 0');
    const flatResult = await readTargetObjectFile(new File([flat], 'flat.stl'), 't');
    expect(flatResult.ok).toBe(false);
    if (flatResult.ok) return;
    expect(flatResult.error).toContain('flat in at least one direction');
  });

  it('#720 — a mesh larger than the old 4 MiB cap imports: there is no cap any more', async () => {
    // A VALID ASCII STL past the old limit (facets repeated with a changing z): the cap is what
    // #720 removed, and a real 3D model is often three times its size.
    const facet = (i: number): string =>
      `facet normal 0 0 1\n  outer loop\n    vertex 0 0 0\n    vertex 10 0 0\n    vertex 0 10 ${i % 7}\n  endloop\nendfacet\n`;
    let big = 'solid big\n';
    for (let i = 0; big.length <= 4.5 * 1024 * 1024; i++) big += facet(i);
    big += 'endsolid big\n';
    expect(big.length).toBeGreaterThan(4 * 1024 * 1024);

    const result = await readTargetObjectFile(new File([big], 'big.stl'), 'tgt-big');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe('stl');
    expect(result.size).toEqual({ x: 10, y: 10, z: 6 });
    // The embedded payload is the file's bytes, base64'd, with no trimming at any size.
    expect(result.data.length).toBe(Math.ceil(big.length / 3) * 4);
  });

  it('decodes the embedded mesh, and the cache is keyed by the hash', () => {
    clearTargetObjectMeshCache();
    const embedded = {
      sha256: 'b'.repeat(64),
      format: 'stl' as const,
      data: btoa(ASCII),
    };
    const mesh = targetObjectMesh(embedded);
    expect(mesh.triangleCount).toBe(4);
    expect(mesh.bbox.max).toEqual([10, 10, 10]);
    // The same hash answers from the cache even when the caller hands over a different string
    // object; the test hook clears it so a replaced file is parsed again.
    expect(targetObjectMesh({ ...embedded })).toBe(mesh);
    clearTargetObjectMeshCache();
    expect(targetObjectMesh({ ...embedded })).not.toBe(mesh);
  });
});
