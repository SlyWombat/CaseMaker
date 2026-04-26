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
