// #825 — AN OBJ MESH, READ BESIDE THE STL READER AND THROUGH THE SAME TWO DOORS.
//
// Makera Studio imports OBJ through assimp; the parity scorecard's row 64 found this app had no
// reader. The parser is `engine/import/objParser.ts`; the doors are the goal's
// (`readTargetObjectFile`) and the stock's (`readStockFile`). This spec pins the format itself
// (quads and n-gons, negative and `i/j/k` indices, continuation lines), the UNIT statement (a
// comment is read and its numbers scaled; a file that states none is read as millimetres and the
// door says so), and that a malformed file is ONE sentence naming its line, never a throw.

import { describe, expect, it } from 'vitest';

import { parseObj } from '@/engine/import/objParser';
import { readTargetObjectFile, targetObjectMesh } from '@/engine/import/targetObject';
import { readStockFile } from '@/engine/import/meshStock';
import { readGoalObjectFile } from '@/engine/import/targetObject';

/** A 100 × 60 × 12 box of QUADS — six faces, each two triangles after the fan. */
const BOX = `# a box
v 0 0 0
v 100 0 0
v 100 60 0
v 0 60 0
v 0 0 12
v 100 0 12
v 100 60 12
v 0 60 12
f 1 4 3 2
f 5 6 7 8
f 1 2 6 5
f 2 3 7 6
f 3 4 8 7
f 4 1 5 8
`;

const withUnit = (unit: string): string => `# units: ${unit}\n${BOX.slice(BOX.indexOf('\n') + 1)}`;

describe('#825 — the OBJ format', () => {
  it('triangulates quads and n-gons by a fan, and takes the mesh size from its own vertices', () => {
    const mesh = parseObj(BOX);
    expect(mesh.triangleCount).toBe(12);
    expect(mesh.indices.length).toBe(36);
    expect(mesh.bbox.min).toEqual([0, 0, 0]);
    expect(mesh.bbox.max).toEqual([100, 60, 12]);

    // A pentagon is three triangles, a hexagon four: the fan rule the file's one polygon states.
    const pentagon = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0.5 1.5 0\nv 0 1 0\nf 1 2 3 4 5\n';
    expect(parseObj(pentagon).triangleCount).toBe(3);
    const hexagon = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0.5 1.5 0\nv 0 1 0\nv -0.5 0.5 0\nf 1 2 3 4 5 6\n';
    expect(parseObj(hexagon).triangleCount).toBe(4);
  });

  it('reads negative (relative) indices and the i/j, i//k and i/j/k face forms', () => {
    const relative = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf -4 -3 -2 -1\n';
    const mesh = parseObj(relative);
    expect(mesh.triangleCount).toBe(2);
    expect(mesh.bbox.max).toEqual([1, 1, 0]);

    // The texture and normal slots are ignored — they can change no triangle.
    const full = 'v 0 0 0\nv 2 0 0\nv 0 2 0\nvt 0 0\nvn 0 0 1\nf 1/1/1 2/1/1 3//1\n';
    const three = parseObj(full);
    expect(three.triangleCount).toBe(1);
    expect(three.bbox.max).toEqual([2, 2, 0]);
  });

  it('joins a continued line, and skips the records a triangle mesh has no use for', () => {
    const text = 'v 0 0 0\nv 1 0 \\\n0\nv 0 1 0\no thing\ng group\ns off\nusemtl m\nmtllib m.mtl\nl 1 2\nf 1 \\\n2 3\n';
    const mesh = parseObj(text);
    expect(mesh.bbox.max).toEqual([1, 1, 0]);
    expect(mesh.triangleCount).toBe(1);
  });
});

describe('#825 — units are stated, never assumed silently', () => {
  it('scales the numbers by the unit its comment states', () => {
    const cm = parseObj(withUnit('cm'));
    expect(cm.unit).toEqual({ stated: 'cm', mmPerUnit: 10 });
    expect(cm.bbox.max).toEqual([1000, 600, 120]);

    const inch = parseObj(withUnit('inches'));
    expect(inch.unit.stated).toBe('inches');
    expect(inch.bbox.max[0]).toBeCloseTo(2540, 6);
  });

  it('reads a file that states none as millimetres, and says so in one sentence', async () => {
    const read = await readTargetObjectFile(new File([BOX], 'box.obj'), 'tgt-obj');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.format).toBe('obj');
    expect(read.size).toEqual({ x: 100, y: 60, z: 12 });
    expect(read.note).toBe(
      'box.obj states no unit; an OBJ has none of its own, so its numbers are read as millimetres.',
    );

    const cm = await readTargetObjectFile(new File([withUnit('cm')], 'box-cm.obj'), 'tgt-cm');
    expect(cm.ok && cm.size).toEqual({ x: 1000, y: 600, z: 120 });
    expect(cm.ok && cm.note).toContain('states its unit as “cm”');
    expect(cm.ok && cm.note).toContain('centimetres (10 mm per unit)');
  });

  it('an unrecognised unit comment is no statement at all: read as mm, said in the same sentence', () => {
    const odd = parseObj(withUnit('furlongs'));
    expect(odd.unit).toEqual({ stated: null, mmPerUnit: 1 });
    expect(odd.bbox.max).toEqual([100, 60, 12]);
  });
});

describe('#825 — the two doors read an OBJ', () => {
  it('the goal door embeds the OBJ text and the mesh reads back from it', async () => {
    const read = await readTargetObjectFile(new File([BOX], 'box.obj'), 'tgt-readback');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.sha256).toMatch(/^[0-9a-f]{64}$/);
    const mesh = targetObjectMesh(read);
    expect(mesh.triangleCount).toBe(12);
    expect(mesh.bbox.max).toEqual([100, 60, 12]);
  });

  it('the stock door reads an OBJ prism as the block, with its unit reading stated', async () => {
    const read = await readStockFile(new File([BOX], 'block.obj'));
    expect(read.kind).toBe('mesh');
    if (read.kind !== 'mesh') return;
    expect(read.length).toBe(100);
    expect(read.width).toBe(60);
    expect(read.thickness).toBe(12);
    expect(read.note).toContain('read as millimetres');

    const cm = await readStockFile(new File([withUnit('cm')], 'block-cm.obj'));
    expect(cm.kind === 'mesh' && cm.length).toBe(1000);
    expect(cm.kind === 'mesh' && cm.note).toContain('centimetres');
  });

  it('the wizard’s goal door carries the same note as the panel’s', async () => {
    const read = await readGoalObjectFile(new File([BOX], 'box.obj'), 'goal-obj', { length: 200, width: 100 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.target.format).toBe('obj');
    expect(read.target.role).toBe('goal');
    expect(read.note).toContain('read as millimetres');
  });
});

describe('#825 — a malformed file is one sentence, never a crash', () => {
  const why = (text: string): string => {
    try {
      parseObj(text);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    throw new Error('expected a refusal');
  };

  it('names the line, the record and the token it could not read', () => {
    expect(why('v 1 2\n')).toBe('OBJ line 1: "v" needs an x, a y and a z');
    expect(why('v 0 0 0\nv 1 two 0\n')).toBe('OBJ line 2: "v" has "two", which is not a number');
    expect(why('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n')).toBe(
      'OBJ line 4: face index 9 is outside the 3 vertices defined above it',
    );
    expect(why('v 0 0 0\nf 1 2\n')).toBe('OBJ line 2: "f" needs at least three vertices');
    expect(why('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/2/3/4 1 2\n')).toContain('is not a vertex index');
    expect(why('# nothing at all\n')).toBe('OBJ: the file holds no vertices (no "v" record)');
  });

  it('the doors wrap the sentence with the file’s name and never throw', async () => {
    const goal = await readTargetObjectFile(new File(['v 1 2\n'], 'bad.obj'), 'tgt-bad');
    expect(goal.ok).toBe(false);
    expect(goal.ok === false && goal.error).toBe(
      'bad.obj could not be parsed: OBJ line 1: "v" needs an x, a y and a z',
    );

    const stock = await readStockFile(new File(['v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'], 'open.obj'));
    expect(stock.kind).toBe('refused');
    expect(stock.kind === 'refused' && stock.reason).toContain('not closed');
  });
});
