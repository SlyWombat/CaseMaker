import { unzipSync } from 'fflate';
import type { ParsedMesh } from './stlParser';

export function parse3MF(buf: ArrayBuffer): ParsedMesh {
  const zip = unzipSync(new Uint8Array(buf));
  const modelEntry = zip['3D/3dmodel.model'] ?? zip['3d/3dmodel.model'];
  if (!modelEntry) throw new Error('3MF: missing 3D/3dmodel.model entry');
  const xml = new TextDecoder('utf-8').decode(modelEntry);

  const positions: number[] = [];
  const indices: number[] = [];

  let vertexBase = 0;
  const objectRe = /<object\b[^>]*>[\s\S]*?<\/object>/g;
  let objectMatch: RegExpExecArray | null;
  while ((objectMatch = objectRe.exec(xml)) !== null) {
    const objBlock = objectMatch[0];
    const localVerts: number[] = [];
    const vertexRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"\s*\/>/g;
    let vm: RegExpExecArray | null;
    while ((vm = vertexRe.exec(objBlock)) !== null) {
      localVerts.push(parseFloat(vm[1]!), parseFloat(vm[2]!), parseFloat(vm[3]!));
    }
    const triRe = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"\s*\/>/g;
    let tm: RegExpExecArray | null;
    const objectTris: number[] = [];
    while ((tm = triRe.exec(objBlock)) !== null) {
      objectTris.push(
        vertexBase + parseInt(tm[1]!, 10),
        vertexBase + parseInt(tm[2]!, 10),
        vertexBase + parseInt(tm[3]!, 10),
      );
    }
    if (localVerts.length === 0 || objectTris.length === 0) continue;
    // #720 — APPEND, do not spread: a real model's vertex/triangle arrays run to hundreds of
    // thousands of entries, and `push(...array)` overflows the call stack at that size (observed on
    // a 318k-triangle terrain: "Maximum call stack size exceeded"). The cap this slice removes was
    // hiding the ceiling; a 12 MB model reaches it immediately.
    for (const value of localVerts) positions.push(value);
    for (const value of objectTris) indices.push(value);
    vertexBase += localVerts.length / 3;
  }

  if (indices.length === 0) throw new Error('3MF: no triangles found in model');

  const positionsTyped = new Float32Array(positions);
  const indicesTyped = new Uint32Array(indices);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  const vertCount = positionsTyped.length / 3;
  for (let i = 0; i < vertCount; i++) {
    const x = positionsTyped[i * 3]!;
    const y = positionsTyped[i * 3 + 1]!;
    const z = positionsTyped[i * 3 + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    positions: positionsTyped,
    indices: indicesTyped,
    triangleCount: indicesTyped.length / 3,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}
