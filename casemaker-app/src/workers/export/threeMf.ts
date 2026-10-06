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

/**
 * Issue #168 — does this mesh ask the slicer for something the geometry alone
 * cannot say? A tool, an infill, or a bed of its own: exactly the things that
 * have to be written into `Metadata/Slic3r_PE_model.config` rather than into
 * the `<mesh>`. Parts that say nothing here are untouched by every branch
 * below, so a single-material project still writes the same bytes it did
 * before this issue.
 */
function hasSlicerMaterial(m: StlMeshInput): boolean {
  return m.material?.extruder !== undefined || m.material?.fillDensity !== undefined;
}

/**
 * `<mesh>` for a run of parts, with the vertex ids made cumulative so several
 * parts can share one `<object>`. Triangle ids are NOT written: the slicer
 * derives a volume's range from the running triangle counts, which is what
 * `volumeRanges` below mirrors.
 */
function meshXml(meshes: StlMeshInput[]): string {
  const verts: string[] = [];
  const tris: string[] = [];
  let vertexOffset = 0;
  for (const m of meshes) {
    const numVert = m.positions.length / 3;
    for (let i = 0; i < numVert; i++) {
      verts.push(
        `<vertex x="${m.positions[i * 3]}" y="${m.positions[i * 3 + 1]}" z="${m.positions[i * 3 + 2]}"/>`,
      );
    }
    const triCount = m.indices.length / 3;
    for (let t = 0; t < triCount; t++) {
      tris.push(
        `<triangle v1="${m.indices[t * 3]! + vertexOffset}" v2="${m.indices[t * 3 + 1]! + vertexOffset}" v3="${m.indices[t * 3 + 2]! + vertexOffset}"/>`,
      );
    }
    vertexOffset += numVert;
  }
  return `<mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh>`;
}

export function buildModelXml(meshes: StlMeshInput[]): string {
  // Issue #168 — the plain path. Nothing below this line changed: no parts
  // carry slicer material, so the file is exactly what it was.
  if (!meshes.some(hasSlicerMaterial)) {
    const objects: string[] = [];
    const items: string[] = [];
    meshes.forEach((m, idx) => {
      const objId = idx + 1;
      objects.push(`<object id="${objId}" type="model">${meshXml([m])}</object>`);
      items.push(`<item objectid="${objId}"/>`);
    });
    return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Application">${escapeXml('CaseMaker')}</metadata>
  <resources>${objects.join('')}</resources>
  <build>${items.join('')}</build>
</model>`;
  }

  // Issue #168 — the multi-material path. Parts that carry slicer material
  // become ONE object whose volumes are the parts, in the shape
  // `samples/badge-blank/make_badge.py:108-130` writes and PrusaSlicer is
  // known to load as one two-part object. Writing them as separate objects
  // instead is what a two-colour badge used to arrive as: two loose objects
  // with no tool assignment, which the user then had to pair up by hand.
  const annotated = meshes.filter(hasSlicerMaterial);
  const plain = meshes.filter((m) => !hasSlicerMaterial(m));

  const objects: string[] = [`<object id="1" type="model">${meshXml(annotated)}</object>`];
  const items: string[] = ['<item objectid="1"/>'];
  plain.forEach((m, i) => {
    const objId = i + 2;
    objects.push(`<object id="${objId}" type="model">${meshXml([m])}</object>`);
    items.push(`<item objectid="${objId}"/>`);
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
  <metadata name="slic3rpe:Version3mf">1</metadata>
  <resources>${objects.join('')}</resources>
  <build>${items.join('')}</build>
</model>`;
}

interface VolumeRange {
  firstId: number;
  lastId: number;
  name: string;
  extruder?: number;
}

/** Running triangle counts across the merged object, which is how the slicer
 *  splits one `<mesh>` back into named parts. */
function volumeRanges(meshes: StlMeshInput[]): VolumeRange[] {
  const out: VolumeRange[] = [];
  let first = 0;
  meshes.forEach((m, i) => {
    const triCount = m.indices.length / 3;
    out.push({
      firstId: first,
      lastId: first + triCount - 1,
      name: m.name ?? `part-${i + 1}`,
      extruder: m.material?.extruder,
    });
    first += triCount;
  });
  return out;
}

/**
 * `Metadata/Slic3r_PE_model.config` — the sidecar that turns one object back
 * into named parts and assigns each one a tool. Format is
 * `make_badge.py:120-130`'s, which is the reference: it is known to open in
 * PrusaSlicer as one object with two parts.
 */
function buildConfigXml(meshes: StlMeshInput[], objectName?: string): string {
  const cfg: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>', ' <object id="1" instances_count="1">'];
  if (objectName) {
    cfg.push(`  <metadata type="object" key="name" value="${escapeXml(objectName)}"/>`);
  }
  // Object-level infill: the parts of one object share a fill density, and the
  // slicer wants it once. First one wins; a project that asks for two
  // densities on one object is asking for something the format cannot say.
  const fillDensity = meshes.find((m) => m.material?.fillDensity !== undefined)?.material
    ?.fillDensity;
  if (fillDensity !== undefined) {
    cfg.push(`  <metadata type="object" key="fill_density" value="${escapeXml(fillDensity)}"/>`);
  }
  // The object-level extruder is the FIRST part's tool: PrusaSlicer uses it for
  // the object's own colour chip, and every volume overrides it below.
  const firstExtruder = meshes[0]?.material?.extruder;
  if (firstExtruder !== undefined) {
    cfg.push(`  <metadata type="object" key="extruder" value="${firstExtruder}"/>`);
  }
  for (const v of volumeRanges(meshes)) {
    cfg.push(`  <volume firstid="${v.firstId}" lastid="${v.lastId}">`);
    cfg.push(`   <metadata type="volume" key="name" value="${escapeXml(v.name)}"/>`);
    cfg.push('   <metadata type="volume" key="volume_type" value="ModelPart"/>');
    cfg.push('   <metadata type="volume" key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>');
    if (v.extruder !== undefined) {
      cfg.push(`   <metadata type="volume" key="extruder" value="${v.extruder}"/>`);
    }
    cfg.push('  </volume>');
  }
  cfg.push(' </object>', '</config>');
  return cfg.join('\n');
}

export interface ThreeMfOptions {
  /** Name the slicer shows for the multi-material object (#168). Ignored on the
   *  plain path, which emits no sidecar at all. */
  objectName?: string;
}

export function buildThreeMf(meshes: StlMeshInput[], opts: ThreeMfOptions = {}): ArrayBuffer {
  const modelXml = buildModelXml(meshes);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': strToU8(modelXml),
  };
  if (meshes.some(hasSlicerMaterial)) {
    files['Metadata/Slic3r_PE_model.config'] = strToU8(
      buildConfigXml(meshes.filter(hasSlicerMaterial), opts.objectName),
    );
  }
  const zipped = zipSync(files);
  return zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  ) as ArrayBuffer;
}
