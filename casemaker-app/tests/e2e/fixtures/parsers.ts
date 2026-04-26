export interface ParsedStl {
  triCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export function parseBinaryStl(buf: ArrayBuffer): ParsedStl {
  const dv = new DataView(buf);
  const triCount = dv.getUint32(80, true);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  let off = 84;
  for (let i = 0; i < triCount; i++) {
    off += 12;
    for (let v = 0; v < 3; v++) {
      const x = dv.getFloat32(off, true);
      const y = dv.getFloat32(off + 4, true);
      const z = dv.getFloat32(off + 8, true);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
      off += 12;
    }
    off += 2;
  }
  return { triCount, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
}

export async function downloadToBuffer(stream: NodeJS.ReadableStream): Promise<ArrayBuffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
