import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { buildThreeMf, buildModelXml } from '@/workers/export/threeMf';

const tet = {
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
};

describe('3MF writer', () => {
  it('produces a zip containing 3D/3dmodel.model and the relationships file', () => {
    const buf = buildThreeMf([tet]);
    const zip = unzipSync(new Uint8Array(buf));
    expect(Object.keys(zip)).toContain('3D/3dmodel.model');
    expect(Object.keys(zip)).toContain('[Content_Types].xml');
    expect(Object.keys(zip)).toContain('_rels/.rels');
  });

  it('the model XML declares mm units and contains 4 vertices and 4 triangles', () => {
    const xml = buildModelXml([tet]);
    expect(xml).toContain('unit="millimeter"');
    expect(xml.match(/<vertex /g)?.length).toBe(4);
    expect(xml.match(/<triangle /g)?.length).toBe(4);
  });
});

/**
 * Issue #168 — a two-colour badge has to open in the slicer as ONE object with
 * two parts, each already on its own tool. That is not a property of the mesh;
 * it lives in `Metadata/Slic3r_PE_model.config`, whose format is
 * `samples/badge-blank/make_badge.py:120-130` — known to work in PrusaSlicer.
 * The parts that ask for nothing keep writing the file they always did, which
 * is why the plain cases above are unchanged and the first test below pins it.
 */
describe('3MF writer — slicer material (#168)', () => {
  const tri = {
    positions: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    indices: new Uint32Array([0, 1, 2]),
  };
  const bottom = { ...tet, material: { extruder: 2 }, name: 'badge-bottom' };
  const top = { ...tri, material: { extruder: 3 }, name: 'badge-top' };
  const read = (
    meshes: Parameters<typeof buildThreeMf>[0],
    opts?: Parameters<typeof buildThreeMf>[1],
  ): { files: Record<string, Uint8Array>; model: string; config?: string } => {
    const zip = unzipSync(new Uint8Array(buildThreeMf(meshes, opts)));
    const model = new TextDecoder().decode(zip['3D/3dmodel.model']!);
    const cfg = zip['Metadata/Slic3r_PE_model.config'];
    return { files: zip, model, config: cfg ? new TextDecoder().decode(cfg) : undefined };
  };

  it('writes no sidecar and no slic3rpe namespace when no part carries material', () => {
    const { files, model } = read([tet, tri]);
    expect(Object.keys(files)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      '3D/3dmodel.model',
    ]);
    expect(model).not.toContain('slic3rpe');
    expect(model).toContain('<metadata name="Application">CaseMaker</metadata>');
    expect(model.match(/<object /g)?.length).toBe(2);
    expect(model.match(/<item /g)?.length).toBe(2);
  });

  it('merges the materials into one object with one volume per part', () => {
    const { model, config } = read([bottom, top], { objectName: 'badge blank' });

    // One object, not two — that is what makes the slicer treat the colours as
    // parts of one thing.
    expect(model.match(/<object /g)?.length).toBe(1);
    expect(model.match(/<item /g)?.length).toBe(1);
    expect(model).toContain('xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06"');
    expect(model).toContain('<metadata name="slic3rpe:Version3mf">1</metadata>');
    // The second part's vertices are renumbered into the shared list, never
    // restarting at 0 — otherwise both parts would claim vertex 0.
    expect(model.match(/<vertex /g)?.length).toBe(7);
    expect(model).toContain('<triangle v1="4" v2="5" v3="6"/>');

    expect(config).toContain('<object id="1" instances_count="1">');
    expect(config).toContain('<metadata type="object" key="name" value="badge blank"/>');
    expect(config).toContain('<metadata type="object" key="extruder" value="2"/>');
    // Volume ranges are running TRIANGLE counts across the merged mesh.
    expect(config).toContain('<volume firstid="0" lastid="3">');
    expect(config).toContain('<volume firstid="4" lastid="4">');
    expect(config).toContain('<metadata type="volume" key="name" value="badge-bottom"/>');
    expect(config).toContain('<metadata type="volume" key="name" value="badge-top"/>');
    expect(config).toContain('<metadata type="volume" key="extruder" value="2"/>');
    expect(config).toContain('<metadata type="volume" key="extruder" value="3"/>');
    expect(config?.match(/volume_type" value="ModelPart"/g)?.length).toBe(2);
  });

  it('writes infill once at the object level, and names an unnamed volume by position', () => {
    const { config } = read([
      { ...bottom, material: { extruder: 2, fillDensity: '15%' } },
      { positions: tri.positions, indices: tri.indices, material: { extruder: 3 } },
    ]);
    expect(config).toContain('<metadata type="object" key="fill_density" value="15%"/>');
    expect(config).toContain('key="name" value="part-2"');
  });

  it('leaves an unannotated part as its own object beside the multi-material one', () => {
    const { model, config } = read([bottom, tet]);
    expect(model.match(/<object /g)?.length).toBe(2);
    expect(model).toContain('<object id="1" type="model">');
    expect(model).toContain('<object id="2" type="model">');
    expect(model).toContain('<item objectid="2"/>');
    // Only the annotated part appears in the sidecar.
    expect(config?.match(/<volume /g)?.length).toBe(1);
  });

  it('escapes the object and volume names it interpolates', () => {
    const { config } = read([{ ...bottom, name: 'a & b <c>' }], {
      objectName: 'x "y" & z',
    });
    expect(config).toContain('value="a &amp; b &lt;c&gt;"');
    expect(config).toContain('value="x &quot;y&quot; &amp; z"');
  });
});
