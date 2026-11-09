/**
 * #1131 — 3MF TRANSFORMS ARE APPLIED WHEN THE MESH IS COMPOSED.
 *
 * #1130 taught the reader the model's unit, the material tail on a triangle, and components
 * holders. It still ignored every transform: a `<component transform="…">` or a
 * `<build><item transform="…">` that turns, scales or moves the object was dropped, so a part
 * built rotated imported at the wrong orientation at the goal door (and for an enclosure asset)
 * and was cut that way.
 *
 * The 3MF core transform is a 4×3 affine in row-major order — `m00 m01 m02 m10 m11 m12 m20 m21 m22
 * m30 m31 m32` — applied with the point on the left: x' = x·m00 + y·m10 + z·m20 + m30. The unit
 * applies to the translation too (the model's unit is the unit of all its coordinates), so a
 * centimetre model's "5 6 7" translation is 50/60/70 mm.
 *
 * Red at the base: every transform is ignored; the fixtures read at their untransformed bbox.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parse3MF } from '@/engine/import/threeMfParser';
import { readTargetObjectFile } from '@/engine/import/targetObject';

type V3 = [number, number, number];

/** A closed tetra 20 × 10 × 5, asymmetric so a turn changes the extents it is read as. */
const TET_VERTS: V3[] = [
  [0, 0, 0],
  [20, 0, 0],
  [0, 10, 0],
  [0, 0, 5],
];
const TET_TRIS: [number, number, number][] = [
  [0, 2, 1],
  [0, 1, 3],
  [0, 3, 2],
  [1, 2, 3],
];

/** The tetra's `<object>` body, with the given id and optional extra attributes. */
function meshObject(id: string): string {
  const vertices = TET_VERTS.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}" />`).join('');
  const triangles = TET_TRIS.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}" />`).join('');
  return `<object id="${id}" type="model"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object>`;
}

/** Pack one model XML into a 3MF zip the way the Escutcheon file is packed. */
function pack(model: string): ArrayBuffer {
  const zip = zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    ),
    '3D/3dmodel.model': strToU8(model),
  });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

function modelXml(opts: { unit?: string; resources: string; build: string }): ArrayBuffer {
  const unitAttr = opts.unit === undefined ? '' : ` unit="${opts.unit}"`;
  return pack(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      `<model${unitAttr} xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
      `<resources>${opts.resources}</resources>` +
      `<build>${opts.build}</build>` +
      '</model>',
  );
}

/** 90° about Z, the core spec's own example: (x, y) → (−y, x). */
const ROTATE_Z = '0 1 0 -1 0 0 0 0 1 0 0 0';
/** A pure translation, in the model's own units. */
const translate = (x: number, y: number, z: number): string => `1 0 0 0 1 0 0 0 1 ${x} ${y} ${z}`;

describe('#1131 — 3MF transforms', () => {
  it('a rotated build item is read at the transformed bbox: 20 × 10 × 5 turns into 10 × 20 × 5', () => {
    const parsed = parse3MF(
      modelXml({
        resources: meshObject('1'),
        build: `<item objectid="1" transform="${ROTATE_Z}" />`,
      }),
    );
    expect(parsed.bbox.min.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([-10, 0, 0]);
    expect(parsed.bbox.max.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 20, 5]);
    // A transformed vertex, not only the box: (20,0,0) becomes (0,20,0).
    const positions = Array.from(parsed.positions);
    expect(positions.slice(3, 6)).toEqual([0, 20, 0]);
  });

  it('a translated component is read where the component puts it', () => {
    const parsed = parse3MF(
      modelXml({
        resources:
          meshObject('1') +
          `<object id="2" type="model"><components><component objectid="1" transform="${translate(5, 6, 7)}" /></components></object>`,
        build: '<item objectid="2" />',
      }),
    );
    expect(parsed.bbox.min).toEqual([5, 6, 7]);
    expect(parsed.bbox.max).toEqual([25, 16, 12]);
  });

  it('composes the item and the component transforms, the component first', () => {
    const parsed = parse3MF(
      modelXml({
        resources:
          meshObject('1') +
          `<object id="2" type="model"><components><component objectid="1" transform="${translate(5, 6, 7)}" /></components></object>`,
        build: `<item objectid="2" transform="${translate(100, 0, 0)}" />`,
      }),
    );
    // Component translation then item translation.
    expect(parsed.bbox.min).toEqual([105, 6, 7]);
  });

  it('scales the transform’s translation by the declared unit: a centimetre model’s 5 mm is 50', () => {
    const parsed = parse3MF(
      modelXml({
        unit: 'centimeter',
        resources:
          meshObject('1') +
          `<object id="2" type="model"><components><component objectid="1" transform="${translate(5, 6, 7)}" /></components></object>`,
        build: '<item objectid="2" />',
      }),
    );
    // The unit is the unit of ALL the model's coordinates, transforms included.
    expect(parsed.bbox.min).toEqual([50, 60, 70]);
    expect(parsed.bbox.max).toEqual([250, 160, 120]);
  });

  it('the goal door imports the rotated part at the transformed size, not the file’s raw one', async () => {
    const file = new File(
      [
        modelXml({
          resources: meshObject('1'),
          build: `<item objectid="1" transform="${ROTATE_Z}" />`,
        }),
      ],
      'rotated.3mf',
    );
    const read = await readTargetObjectFile(file, 'rotated');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.size).toEqual({ x: 10, y: 20, z: 5 });
  });

  it('an object the build does not place is still read, at its own place — the old soup behaviour', () => {
    const parsed = parse3MF(
      modelXml({
        resources: meshObject('1') + meshObject('2'),
        build: '<item objectid="1" />',
      }),
    );
    // Object 2 is not referenced; the reader has always included every mesh object, and this
    // pins that an unreferenced object does not vanish when the build is composed.
    expect(parsed.triangleCount).toBe(8);
  });

  it('refuses a transform that is not twelve finite numbers, by name', () => {
    expect(() =>
      parse3MF(
        modelXml({
          resources: meshObject('1'),
          build: '<item objectid="1" transform="1 0 0 0 1" />',
        }),
      ),
    ).toThrow(/transform "1 0 0 0 1" is not 12 finite numbers/);
  });

  it('refuses a component that names an object the model does not define', () => {
    expect(() =>
      parse3MF(
        modelXml({
          resources: `<object id="2" type="model"><components><component objectid="9" /></components></object>`,
          build: '<item objectid="2" />',
        }),
      ),
    ).toThrow(/references object "9", which it does not define/);
  });
});
