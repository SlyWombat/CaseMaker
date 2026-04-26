import { zipSync, strToU8 } from 'fflate';
import type { StlMeshInput } from './stlBinary';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

export function buildModelXml(meshes: StlMeshInput[]): string {
  const objects: string[] = [];
  const items: string[] = [];
  meshes.forEach((m, idx) => {
    const objId = idx + 1;
    const numVert = m.positions.length / 3;
    const verts: string[] = [];
    for (let i = 0; i < numVert; i++) {
      verts.push(
        `<vertex x="${m.positions[i * 3]}" y="${m.positions[i * 3 + 1]}" z="${m.positions[i * 3 + 2]}"/>`,
      );
    }
    const triCount = m.indices.length / 3;
    const tris: string[] = [];
    for (let t = 0; t < triCount; t++) {
      tris.push(
        `<triangle v1="${m.indices[t * 3]}" v2="${m.indices[t * 3 + 1]}" v3="${m.indices[t * 3 + 2]}"/>`,
      );
    }
    objects.push(
      `<object id="${objId}" type="model"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`,
    );
    items.push(`<item objectid="${objId}"/>`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Application">${escapeXml('CaseMaker')}</metadata>
  <resources>${objects.join('')}</resources>
  <build>${items.join('')}</build>
</model>`;
}

export function buildThreeMf(meshes: StlMeshInput[]): ArrayBuffer {
  const modelXml = buildModelXml(meshes);
  const zipped = zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': strToU8(modelXml),
  });
  return zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  ) as ArrayBuffer;
}
