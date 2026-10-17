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
  /**
   * A sealed rectangular cavity inside `box` (#437), mm. Sliced, it reads as an interior ring —
   * the same thing the badge blank's magnet pocket presents below the colour split — so the pocket
   * reader can be exercised without the maintainer's file.
   */
  cavity?: [V3, V3];
  /**
   * Extra XML inside the volume element of `Metadata/Slic3r_PE_model.config` — the `slic3rpe:text`
   * and `slic3rpe:shape` tags PrusaSlicer writes for generated volumes (#437).
   */
  xml?: string;
  /** `matrix` metadata: sixteen row-major numbers, the volume's placement in the object. */
  matrix?: string;
  /** `source_offset_z` metadata, which PrusaSlicer records beside the matrix. */
  sourceOffsetZ?: number;
}

/** A volume box mesh, plus its sealed cavity's triangles wound INWARD when one is given. */
function volumeMesh(v: FixtureVolume): { verts: V3[]; tris: [number, number, number][] } {
  const outer = box(v.box[0], v.box[1]);
  if (v.cavity === undefined) return outer;
  const inner = box(v.cavity[0], v.cavity[1]);
  // Reversed winding: the cavity's normals point into the void, so a slice sees its ring as a hole.
  const reversed = inner.tris.map(([a, b, c]): [number, number, number] => [a, c, b]);
  return {
    verts: [...outer.verts, ...inner.verts],
    tris: [...outer.tris, ...reversed.map(([a, b, c]): [number, number, number] => [a + outer.verts.length, b + outer.verts.length, c + outer.verts.length])],
  };
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
  /** More zip entries, e.g. the SVG a `slic3rpe:shape` volume names (#437). */
  extraEntries?: Record<string, string>;
  /** Lift every vertex by this much in Z (#437) — the design reader measures relative to the part. */
  zOffset?: number;
}): ArrayBuffer {
  const parts = opts.volumes.map((v) => volumeMesh(v));
  const verts: V3[] = parts.flatMap((p) =>
    p.verts.map(([x, y, z]): V3 => [x, y, z + (opts.zOffset ?? 0)]),
  );
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
          (v.matrix === undefined
            ? ''
            : `<metadata type="volume" key="matrix" value="${v.matrix}"/>`) +
          (v.sourceOffsetZ === undefined
            ? ''
            : `<metadata type="volume" key="source_offset_z" value="${v.sourceOffsetZ}"/>`) +
          (v.xml ?? '') +
          '</volume>',
      )
      .join('\n') +
    '\n</object></config>';

  const zip = zipSync({
    '3D/3dmodel.model': strToU8(model),
    'Metadata/Slic3r_PE_model.config': strToU8(config),
    ...(opts.settings === undefined ? {} : { 'Metadata/Slic3r_PE.config': strToU8(opts.settings) }),
    ...Object.fromEntries(
      Object.entries(opts.extraEntries ?? {}).map(([path, body]) => [path, strToU8(body)]),
    ),
  });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

/**
 * The badge blank as a synthetic PrusaSlicer project (#437).
 *
 * The maintainer's `samples/badge-blank/single.3mf` is not tracked, so every reader spec that used
 * it `skipIf`-ed away and the file reported green while running none of them. This builds the same
 * shape from boxes: 76.2 × 38.1 × 3.81 mm, two colour parts at a 3 mm split, a 45 × 13 mm sealed
 * cavity whose ceiling is 2.3 mm up (the magnet pocket, as a slice sees it), and the file's own
 * names — so the readers run everywhere. It is a FIXTURE, not a measurement: the sample's exact
 * numbers still have their own optional oracle blocks.
 */
export function badgeVolumes(opts: { pocket?: boolean } = {}): FixtureVolume[] {
  const L = 76.2;
  const W = 38.1;
  const T = 3.81;
  const pocket = opts.pocket ?? true;
  return [
    {
      name: 'T2 bottom',
      type: 'ModelPart',
      extruder: 2,
      box: [
        [0, 0, 0],
        [L, W, 3],
      ],
      // A placement the reader must NOT apply: the mesh is already the part as it prints (#410).
      // Applied, this would lift the bottom colour to 1.5…4.5 and make the blank 4.5 mm thick.
      matrix: '1 0 0 0 0 1 0 0 0 0 1 1.5 0 0 0 1',
      sourceOffsetZ: 1.5,
      ...(pocket
        ? {
            cavity: [
              [15.6, 12.55, 0.3],
              [60.6, 25.55, 2.3],
            ] as [V3, V3],
          }
        : {}),
    },
    {
      name: 'T3 top',
      type: 'ModelPart',
      extruder: 3,
      box: [
        [0, 0, 3],
        [L, W, T],
      ],
    },
    // The cut volumes cross the top face by 0.015, as the real text/SVG extrusions do, so the
    // reader measures their floors from the blank's own top rather than from the box's max.
    {
      ...fixtureCut('(Like the Whiskey)', [
        [5, 20, T - 0.985],
        [46.594, 25.171, T + 0.015],
      ]),
      xml:
        '<slic3rpe:text text="(Like the Whiskey)" font_descriptor="1;9;-24;0;0;0;400;0;0;0;1;0;0;2;32;Segoe UI" line_height="5.3"/>',
    },
    {
      ...fixtureCut('Single Barrel', [
        [5, 5, T - 0.985],
        [71.915, 15.531, T + 0.015],
      ]),
      xml:
        '<slic3rpe:text text="Single Barrel" font_descriptor="1;9;-24;0;0;0;700;0;0;0;1;0;0;2;32;Segoe UI Black" line_height="10.8"/>',
    },
    {
      ...fixtureCut('br', [
        [5, 28, T - 1],
        [26.05, 35.5, T + 0.01],
      ]),
      matrix: '0.4713 0 0 0 0 0.4713 0 0 0 0 0.4713 1 0 0 0 1',
      xml: '<slic3rpe:shape filepath="br.svg" filepath3mf="3D/br.svg" scale="1" depth="1"/>',
    },
  ];
}

/** The project settings the badge fixture carries — PETG on both colour extruders. */
export const BADGE_SETTINGS = [
  '; generated by PrusaSlicer',
  'filament_type = PLA;PETG;PETG',
  'filament_settings_id = "a";"Generic PETG @XL";"Generic PETG @XL"',
  'layer_height = 0.2',
  'first_layer_height = 0.2',
].join('\n');

/** The badge fixture's whole project, titled `single` like the maintainer's own file. */
export function badgeProject(
  opts: { pocket?: boolean; zOffset?: number; settings?: string | null } = {},
): ArrayBuffer {
  return project({
    title: 'single',
    volumes: badgeVolumes({ pocket: opts.pocket }),
    settings: opts.settings === null ? undefined : (opts.settings ?? BADGE_SETTINGS),
    zOffset: opts.zOffset,
    extraEntries: {
      '3D/br.svg':
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    },
  });
}

/**
 * A 3MF with a model but no `Slic3r_PE_model.config` — a generic 3MF, which the PrusaSlicer
 * project reader must refuse by name rather than read as an empty design (#410 review item 1).
 */
export function plainProject(): ArrayBuffer {
  const b = box([0, 0, 0], [20, 10, 4]);
  const vertexXml = b.verts.map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join('');
  const triangleXml = b.tris.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('');
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
    '<metadata name="Title">plain</metadata>\n' +
    '<resources><object id="1" type="model"><mesh><vertices>' +
    vertexXml +
    '</vertices><triangles>' +
    triangleXml +
    '</triangles></mesh></object></resources>\n' +
    '<build><item objectid="1"/></build>\n</model>';
  const zip = zipSync({ '3D/3dmodel.model': strToU8(model) });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}
