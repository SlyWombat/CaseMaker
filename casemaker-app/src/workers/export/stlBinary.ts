export interface StlMeshInput {
  positions: Float32Array;
  indices: Uint32Array;
}

export function buildBinaryStl(meshes: StlMeshInput[]): ArrayBuffer {
  let totalTris = 0;
  for (const m of meshes) totalTris += m.indices.length / 3;

  const HEADER = 80;
  const TRI_SIZE = 50;
  const buffer = new ArrayBuffer(HEADER + 4 + totalTris * TRI_SIZE);
  const view = new DataView(buffer);

  const headerText = 'CaseMaker binary STL';
  for (let i = 0; i < headerText.length && i < HEADER; i++) {
    view.setUint8(i, headerText.charCodeAt(i));
  }
  view.setUint32(HEADER, totalTris, true);

  let offset = HEADER + 4;
  for (const m of meshes) {
    const triCount = m.indices.length / 3;
    for (let t = 0; t < triCount; t++) {
      const i0 = m.indices[t * 3]!;
      const i1 = m.indices[t * 3 + 1]!;
      const i2 = m.indices[t * 3 + 2]!;
      const x0 = m.positions[i0 * 3]!;
      const y0 = m.positions[i0 * 3 + 1]!;
      const z0 = m.positions[i0 * 3 + 2]!;
      const x1 = m.positions[i1 * 3]!;
      const y1 = m.positions[i1 * 3 + 1]!;
      const z1 = m.positions[i1 * 3 + 2]!;
      const x2 = m.positions[i2 * 3]!;
      const y2 = m.positions[i2 * 3 + 1]!;
      const z2 = m.positions[i2 * 3 + 2]!;
      const ux = x1 - x0,
        uy = y1 - y0,
        uz = z1 - z0;
      const vx = x2 - x0,
        vy = y2 - y0,
        vz = z2 - z0;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) {
        nx /= len;
        ny /= len;
        nz /= len;
      }
      view.setFloat32(offset, nx, true);
      view.setFloat32(offset + 4, ny, true);
      view.setFloat32(offset + 8, nz, true);
      view.setFloat32(offset + 12, x0, true);
      view.setFloat32(offset + 16, y0, true);
      view.setFloat32(offset + 20, z0, true);
      view.setFloat32(offset + 24, x1, true);
      view.setFloat32(offset + 28, y1, true);
      view.setFloat32(offset + 32, z1, true);
      view.setFloat32(offset + 36, x2, true);
      view.setFloat32(offset + 40, y2, true);
      view.setFloat32(offset + 44, z2, true);
      view.setUint16(offset + 48, 0, true);
      offset += TRI_SIZE;
    }
  }
  return buffer;
}
