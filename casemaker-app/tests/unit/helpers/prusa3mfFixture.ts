// Project 3MF fixtures for the import specs (#410).
//
// The real project file (`samples/badge-blank/single.3mf`) is read wherever it can answer a
// question, but it is ONE shape: it cannot be made two-object, or rotated on the bed, or have a
// volume that never reaches the top face. Those are the cases the readers refuse, and a refusal has
// to be shown a fixture — so this builds one in the same shape PrusaSlicer writes, verified against
// that file's own layout:
//
//   * ONE `<object>` whose single `<mesh>` concatenates its volumes' triangles in write order;
//   * a config that names each volume by its TRIANGLE range, inclusive, into that concatenation;
//   * a `<build>` whose item may carry a transform.

import { zipSync, strToU8 } from 'fflate';

export type V3 = [number, number, number];

/** A closed box between two corners: 8 vertices and 12 triangles, wound outward. */
export function box(min: V3, max: V3): { verts: V3[]; tris: [number, number, number][] } {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    verts: [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
    tris: [
      [0, 3, 2],
      [0, 2, 1], // bottom, −z
      [4, 5, 6],
      [4, 6, 7], // top, +z
      [0, 1, 5],
      [0, 5, 4], // front, −y
      [2, 3, 7],
      [2, 7, 6], // back, +y
      [1, 2, 6],
      [1, 6, 5], // right, +x
      [3, 0, 4],
      [3, 4, 7], // left, −x
    ],
  };
}

/** One `<volume>` of the fixture's object. */
export interface FixtureVolume {
  name: string;
  type: 'ModelPart' | 'NegativeVolume';
  /** The extruder the config assigns it; `0` is what PrusaSlicer writes for a NegativeVolume. */
  extruder: number;
  /** Its geometry, as the corners of a box. */
  box: [V3, V3];
}

/** A ModelPart blank 20 × 10 × 4 on the origin, the stand-in for the real badge blank. */
export const fixtureBlank = (): FixtureVolume => ({
  name: 'the blank',
  type: 'ModelPart',
  extruder: 2,
  box: [
    [0, 0, 0],
    [20, 10, 4],
  ],
});

export const fixturePart = (name: string, box: [V3, V3]): FixtureVolume => ({
  name,
  type: 'ModelPart',
  extruder: 2,
  box,
});

export const fixtureCut = (name: string, box: [V3, V3]): FixtureVolume => ({
  name,
  type: 'NegativeVolume',
  extruder: 0,
  box,
});

/** A project 3MF: one object holding every volume, its config, and a build. */
export function project(opts: {
  /** One `<volume>` per entry, in write order. */
  volumes: FixtureVolume[];
  /** A second `<object>` in the model, for the multi-object refusal — the config does not know. */
  extraObject?: [V3, V3];
  /** The build's items, verbatim. One pure translation by default. */
  build?: string;
  /** The project's Title, which becomes the object name. */
  title?: string;
  /**
   * `Metadata/Slic3r_PE.config` verbatim, for the print-settings readers (#456). Omitted means the
   * project carries none, as neither shape above needs it.
   */
  settings?: string;
}): ArrayBuffer {
  const parts = opts.volumes.map((v) => box(v.box[0], v.box[1]));
  const verts: V3[] = parts.flatMap((p) => p.verts);
  const tris: [number, number, number][] = [];
  const ranges: { firstId: number; lastId: number }[] = [];
  // Vertex indices are per the concatenated list, so each box's own indices shift by its offset.
  let vertOffset = 0;
  for (const p of parts) {
    const first = tris.length;
    for (const [a, b, c] of p.tris) tris.push([a + vertOffset, b + vertOffset, c + vertOffset]);
    ranges.push({ firstId: first, lastId: tris.length - 1 });
    vertOffset += p.verts.length;
  }

  const vertexXml = (vs: V3[]): string =>
    vs.map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join('');
  const triangleXml = (ts: [number, number, number][]): string =>
    ts.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('');

  let extraXml = '';
  if (opts.extraObject !== undefined) {
    const b = box(opts.extraObject[0], opts.extraObject[1]);
    extraXml =
      `<object id="2" type="model"><mesh><vertices>${vertexXml(b.verts)}</vertices>` +
      `<triangles>${triangleXml(b.tris)}</triangles></mesh></object>`;
  }

  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
    `<metadata name="Title">${opts.title ?? 'fixture'}</metadata>\n` +
    '<resources><object id="1" type="model"><mesh><vertices>' +
    vertexXml(verts) +
    '</vertices><triangles>' +
    triangleXml(tris) +
    '</triangles></mesh></object>' +
    extraXml +
    '</resources>\n' +
    `<build>${opts.build ?? '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>'}</build>\n` +
    '</model>';

  const config =
    '<?xml version="1.0" encoding="UTF-8"?>\n<config><object id="1" instances_count="1">\n' +
    opts.volumes
      .map(
        (v, i) =>
          `<volume firstid="${ranges[i]!.firstId}" lastid="${ranges[i]!.lastId}">` +
          `<metadata type="volume" key="name" value="${v.name}"/>` +
          `<metadata type="volume" key="volume_type" value="${v.type}"/>` +
          `<metadata type="volume" key="extruder" value="${v.extruder}"/>` +
          '</volume>',
      )
      .join('\n') +
    '\n</object></config>';

  const zip = zipSync({
    '3D/3dmodel.model': strToU8(model),
    'Metadata/Slic3r_PE_model.config': strToU8(config),
    ...(opts.settings === undefined ? {} : { 'Metadata/Slic3r_PE.config': strToU8(opts.settings) }),
  });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}
