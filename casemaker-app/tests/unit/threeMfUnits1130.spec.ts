/**
 * #1130 — THE ESCUTCHEON 3MF'S STRUCTURE, MINIMAL.
 *
 * The real file (`samples-gdrive/units-3mf/Escutcheon.3mf`, the maintainer's own, not checked in)
 * failed import with "3MF: no triangles found in model". Its structure, read from the zip:
 *
 *   * `<model unit="centimeter">` — the file's numbers are centimetres, not millimetres;
 *   * object 3 holds the mesh, and every `<triangle v1 v2 v3 pid="5" p1="0" />` names a material
 *     AFTER the three indices — the attribute tail the old reader's regex refused;
 *   * object 4 is a `<components>` holder referencing object 3, and the build item references 4.
 *
 * So the fixture below is a 10-unit tetra packed the same way: centimetre model, material
 * attributes on every triangle, a components object, a build item pointing at the holder. It is
 * generated here rather than checked in as a binary, the same way the Prusa fixtures are.
 */

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parse3MF, threeMfUnitSentence } from '@/engine/import/threeMfParser';
import { readTargetObjectFile } from '@/engine/import/targetObject';

type V3 = [number, number, number];
type Tri = [number, number, number];

/** A closed tetra 10 units on a side, in the model's own units. */
const TET_VERTS: V3[] = [
  [0, 0, 0],
  [10, 0, 0],
  [0, 10, 0],
  [0, 0, 10],
];
const TET_TRIS: Tri[] = [
  [0, 2, 1],
  [0, 1, 3],
  [0, 3, 2],
  [1, 2, 3],
];

/**
 * The Escutcheon-shaped package. `unit` is omitted to make the model state none (the format's
 * millimetre default); `materialAttributes` is on by default because that tail is the regression.
 */
function escutcheonShaped(opts: { unit?: string; materialAttributes?: boolean } = {}): ArrayBuffer {
  const { unit, materialAttributes = true } = opts;
  const unitAttr = unit === undefined ? '' : ` unit="${unit}"`;
  const vertices = TET_VERTS.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}" />`).join('');
  const triangles = TET_TRIS.map(([a, b, c]) =>
    materialAttributes
      ? `<triangle v1="${a}" v2="${b}" v3="${c}" pid="5" p1="0" />`
      : `<triangle v1="${a}" v2="${b}" v3="${c}" />`,
  ).join('');
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<model${unitAttr} xml:lang="en-US" ` +
    'xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" ' +
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    '<resources>' +
    '<basematerials id="2"><base name="Turquoise" displaycolor="#00A0E8FF" /></basematerials>' +
    '<m:colorgroup id="5"><m:color color="#BCBCBCFF" /></m:colorgroup>' +
    `<object id="3" type="model"><mesh><vertices>${vertices}</vertices>` +
    `<triangles>${triangles}</triangles></mesh></object>` +
    '<object id="4" type="model"><components><component objectid="3" /></components></object>' +
    '</resources>' +
    '<build><item objectid="4" /></build>' +
    '</model>';
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

describe('#1130 — the Escutcheon 3MF structure', () => {
  it('reads triangles that carry material attributes after v1/v2/v3', () => {
    const parsed = parse3MF(escutcheonShaped({ unit: 'centimeter' }));
    expect(parsed.triangleCount).toBe(4);
    // The components object holds no vertices of its own: the mesh object's 4 vertices are the whole mesh.
    expect(parsed.positions.length).toBe(TET_VERTS.length * 3);
  });

  it('states its unit as centimetres and converts the numbers to millimetres once', () => {
    const parsed = parse3MF(escutcheonShaped({ unit: 'centimeter' }));
    expect(parsed.unit).toEqual({ stated: 'centimeter', mmPerUnit: 10 });
    // 10 model units, read as centimetres, are 100 mm — not 10.
    expect(parsed.bbox).toEqual({ min: [0, 0, 0], max: [100, 100, 100] });
  });

  it('imports through the goal door with the correct size and a sentence naming the unit', async () => {
    const file = new File([escutcheonShaped({ unit: 'centimeter' })], 'escutcheon-3mf.3mf');
    const read = await readTargetObjectFile(file, 'escutcheon');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.format).toBe('3mf');
    expect(read.size).toEqual({ x: 100, y: 100, z: 100 });
    expect(read.note).toBe(
      'escutcheon-3mf.3mf states its unit as “centimeter”; its numbers are read as centimetres (10 mm per unit).',
    );
  });

  it('reads a model that states no unit as millimetres, silently — that is the format default', async () => {
    const parsed = parse3MF(escutcheonShaped());
    expect(parsed.unit).toEqual({ stated: null, mmPerUnit: 1 });
    expect(parsed.bbox.max).toEqual([10, 10, 10]);
    const read = await readTargetObjectFile(new File([escutcheonShaped()], 'plain.3mf'), 'plain');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.note).toBeUndefined();
  });

  it('a model that states millimetres needs no note — its numbers are already the app’s', async () => {
    const read = await readTargetObjectFile(
      new File([escutcheonShaped({ unit: 'millimeter' })], 'mm.3mf'),
      'mm',
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.note).toBeUndefined();
  });

  it('words the no-unit case as the format default, for any door that asks', () => {
    expect(threeMfUnitSentence('plain.3mf', { stated: null, mmPerUnit: 1 })).toBe(
      "plain.3mf states no unit; a 3MF without one is read as millimetres (the format's default).",
    );
  });

  it('refuses a unit the core spec does not define, naming the allowed tokens', () => {
    expect(() => parse3MF(escutcheonShaped({ unit: 'furlong' }))).toThrow(
      '3MF: the model\'s unit "furlong" is not one of micron, millimeter, centimeter, inch, foot or meter',
    );
  });
});
