// #410 — reading a PrusaSlicer project as a DESIGN.
//
// The reader is checked against `samples/badge-blank/single.3mf`, the maintainer's own file: every
// number below is measured off it (the file's own mesh), and the expectations are the file's own
// dimensions — 3 × 1.5 × 0.15 in, Segoe UI Black text about 1 mm deep, a 45 × 13 mm magnet pocket.
// That is the point of the module: nothing is typed in from a table, so a different project file
// produces different numbers with no code change.
//
// The oracle files are the user's and are only read; the specs skip when they are not checked out.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync, strToU8 } from 'fflate';

import { parsePrusaThreeMf, PrusaThreeMfError } from '@/engine/import/prusa3mf';
import { readDesign } from '@/engine/import/design3mf';
import { fixtureBlank, fixtureCut, project } from './helpers/prusa3mfFixture';
import { tl } from './helpers/manifoldExec';

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = join(here, '..', '..', '..', 'samples', 'badge-blank', 'single.3mf');
const hasSample = existsSync(samplePath);

/** The sample, read once. `ArrayBuffer` because that is what the reader takes. */
function sample(): ArrayBuffer {
  const buf = readFileSync(samplePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const codes = (buf: ArrayBuffer) => parsePrusaThreeMf(buf);

/**
 * The maintainer's project with every vertex lifted `dz` mm in z — the same part, placed higher in
 * the file. Rebuilt in memory: their file is read, never written.
 */
function liftedSample(dz: number): ArrayBuffer {
  const raw = readFileSync(samplePath);
  const zip = unzipSync(new Uint8Array(raw));
  const model = new TextDecoder().decode(zip['3D/3dmodel.model']!);
  const moved = model.replace(
    /<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\s*\/>/g,
    (_all, x: string, y: string, z: string) => `<vertex x="${x}" y="${y}" z="${Number(z) + dz}"/>`,
  );
  const out = zipSync({ ...zip, '3D/3dmodel.model': strToU8(moved) });
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

/** The z extent of one volume's OWN triangles in the merged mesh — the raw, placed coordinates. */
function rawZ(file: ReturnType<typeof parsePrusaThreeMf>, name: string): { min: number; max: number } {
  const v = file.volumes.find((x) => x.name === name)!;
  let min = Infinity;
  let max = -Infinity;
  for (let t = v.firstId; t <= v.lastId; t++) {
    for (let c = 0; c < 3; c++) {
      const z = file.mesh.vertProperties[file.mesh.triVerts[t * 3 + c]! * 3 + 2]!;
      if (z < min) min = z;
      if (z > max) max = z;
    }
  }
  return { min, max };
}

describe.skipIf(!hasSample)('the PrusaSlicer project reader (#410)', () => {
  it('splits the object into its five named volumes by facet range', () => {
    const file = codes(sample());
    expect(file.objectName).toBe('single');
    expect(file.unit).toBe('millimeter');
    expect(file.volumes.map((v) => v.name)).toEqual([
      'T2 bottom',
      'T3 top',
      '(Like the Whiskey)',
      'Single Barrel',
      'br',
    ]);
    expect(file.volumes.map((v) => v.volumeType)).toEqual([
      'ModelPart',
      'ModelPart',
      'NegativeVolume',
      'NegativeVolume',
      'NegativeVolume',
    ]);
    // The ranges tile the mesh with no gap and no overlap: the config addresses triangles.
    let next = 0;
    for (const v of file.volumes) {
      expect(v.firstId).toBe(next);
      next = v.lastId + 1;
    }
    expect(next).toBe(file.mesh.triVerts.length / 3);
    expect(file.volumes.map((v) => v.extruder)).toEqual([2, 3, 0, 0, 0]);
  });

  it('reads the text tool parameters, face and weight, off the volumes it generated', () => {
    const file = codes(sample());
    const title = file.volumes.find((v) => v.name === 'Single Barrel')!;
    expect(title.text).not.toBeNull();
    expect(title.text!.text).toBe('Single Barrel');
    expect(title.text!.font).toBe('Segoe UI');
    expect(title.text!.weight).toBe(700); // the Black face
    expect(title.text!.lineHeight).toBeCloseTo(10.8, 4); // 10.80000686…, float32 noise and all

    const sub = file.volumes.find((v) => v.name === '(Like the Whiskey)')!;
    expect(sub.text!.weight).toBe(400); // regular
    expect(sub.text!.lineHeight).toBeCloseTo(5.3, 4);

    // The logo is a SHAPE, not text, and its SVG is embedded in the same zip.
    const logo = file.volumes.find((v) => v.name === 'br')!;
    expect(logo.text).toBeNull();
    expect(logo.shape!.filepath3mf).toBe('3D/br.svg');
    expect(file.entries['3D/br.svg']).toBeDefined();
    expect(file.entries['3D/br.svg']!.length).toBeGreaterThan(0);
  });

  it('does NOT re-apply the per-volume matrix — the mesh is already in the object frame (#410 constraint)', () => {
    // The trap the issue names. Measured, not assumed:
    //   * the raw mesh IS the design the file describes — exactly 3 × 1.5 × 0.15 in, T2's own
    //     triangles starting at z = 0;
    //   * applying the matrices does not — T2 would rise to 1.5…4.5 and the logo, whose linear part
    //     is 0.4713, would shrink to half size.
    const file = codes(sample());
    const design = readDesign(tl, file);
    expect(design.stock.lengthX).toBeCloseTo(76.2, 3);
    expect(design.stock.widthY).toBeCloseTo(38.1, 3);
    expect(design.stock.thickness).toBeCloseTo(3.81, 3);

    // The matrices are there, and they are not the identity.
    const t2 = file.volumes.find((v) => v.name === 'T2 bottom')!;
    expect(t2.matrix).toHaveLength(16);
    expect(t2.matrix![11]).toBeCloseTo(1.5, 6); // row-major: the translation is elements 3, 7, 11
    expect(t2.matrix!.slice(12)).toEqual([0, 0, 0, 1]); // …and the bottom row is 0 0 0 1
    expect(t2.sourceOffsetZ).toBeCloseTo(1.5, 6); // the same fact, recorded beside it
    const logo = file.volumes.find((v) => v.name === 'br')!;
    expect(logo.matrix![0]).toBeCloseTo(0.4713, 4);
    expect(logo.matrix![15]).toBeCloseTo(1, 6);

    // And this is the proof they are not applied: T2's triangles are at z 0…3 in the mesh itself.
    const t2z = rawZ(file, 'T2 bottom');
    expect(t2z.min).toBeCloseTo(0, 3);
    expect(t2z.max).toBeCloseTo(3, 3);
    // …while applying its matrix would put them at 1.5…4.5 — a blank 4.5 mm thick, not 3.81.
    expect(t2z.max + t2.matrix![11]!).toBeCloseTo(4.5, 3);
  });

  it('measures the blank and its colour split from the ModelPart volumes', () => {
    const design = readDesign(tl, codes(sample()));
    expect(design.stock.zMin).toBeCloseTo(0, 3);
    expect(design.stock.zMax).toBeCloseTo(3.81, 3);
    expect(design.colourSplit).toBeCloseTo(3.0, 3); // T2 bottom tops out at 3.0
    // A HEIGHT above the back face (#410 review item 4) — the frame `PartSpec.colourSplit` and
    // `stock.print.split` state — so the top colour's thickness is the blank's own thickness less it.
    expect(design.stock.thickness - design.colourSplit!).toBeCloseTo(0.81, 3);
  });

  it('reads the colour split in the SAME frame wherever it is used — a blank lifted 5 mm in z is the same part (#410 review item 4)', () => {
    // The blank is lifted rigidly: the part does not change, only where its back face sits in the
    // file. Everything the reader measures must therefore come back the same, and the two places the
    // split is used — the `print.split` the job carries, and the slice the magnet pocket is read
    // from — are where a frame mix-up hides: the split reported as the file's absolute z (7.5 here)
    // makes `stock.print.split` a nonsense height AND puts the pocket slice at 5 + 3.75 = 8.75 mm,
    // above the blank, where it finds no hole and reports a blank that has no void.
    const design = readDesign(tl, codes(liftedSample(5)));
    expect(design.stock.zMin).toBeCloseTo(5, 3);
    expect(design.stock.thickness).toBeCloseTo(3.81, 3);
    expect(design.colourSplit).toBeCloseTo(3.0, 3); // a height — the lift cannot change it
    expect(design.stock.thickness - design.colourSplit!).toBeCloseTo(0.81, 3);

    // The pocket survives the move, at the same ceiling and footprint.
    expect(design.pocket).not.toBeNull();
    expect(design.pocket!.length).toBeCloseTo(45, 2);
    expect(design.pocket!.width).toBeCloseTo(13, 2);
    expect(design.pocket!.ceiling).toBeCloseTo(2.3, 2);
    expect(design.pocket!.holes).toBe(1);

    // And so does every cut: depth is measured from the top face, which moved with the blank.
    const depth = Object.fromEntries(design.regions.map((r) => [r.name, r.depth]));
    expect(depth['(Like the Whiskey)']).toBeCloseTo(0.985, 3);
    expect(depth['Single Barrel']).toBeCloseTo(0.985, 3);
    expect(depth['br']).toBeCloseTo(0.998, 3);

    // The note states the frame it is in, so a reader of the sheet is not left to infer it.
    expect(design.notes.join('\n')).toContain('3 mm above its back face');
  });
});

describe.skipIf(!hasSample)('a design read as regions (#410)', () => {
  it('turns each NegativeVolume into a region with its own measured footprint and depth', () => {
    const design = readDesign(tl, codes(sample()));
    expect(design.regions.map((r) => r.name)).toEqual(['(Like the Whiskey)', 'Single Barrel', 'br']);

    const title = design.regions.find((r) => r.name === 'Single Barrel')!;
    // The volume's own bounding box, measured by the probe (and the issue's table).
    expect(title.width).toBeCloseTo(66.915, 2);
    expect(title.height).toBeCloseTo(10.531, 2);
    expect(title.centre[0]).toBeCloseTo(0.452, 2);
    expect(title.centre[1]).toBeCloseTo(8.2, 1);
    // Depth is the distance from the TOP FACE down to the volume's own floor — 3.81 − 2.825.
    expect(title.depth).toBeCloseTo(0.985, 3);
    expect(title.zMin).toBeCloseTo(2.825, 3);
    expect(title.text!.font).toBe('Segoe UI');

    // The subtitle is thinner and shorter; the logo is a shape with the same 1 mm depth.
    const sub = design.regions.find((r) => r.name === '(Like the Whiskey)')!;
    expect(sub.width).toBeCloseTo(41.593, 2);
    expect(sub.height).toBeCloseTo(5.171, 2);
    expect(sub.depth).toBeCloseTo(0.985, 3);
    const logo = design.regions.find((r) => r.name === 'br')!;
    expect(logo.width).toBeCloseTo(21.04, 2);
    expect(logo.height).toBeCloseTo(13.773, 2);
    expect(logo.depth).toBeCloseTo(0.998, 3);
  });

  it('carries the footprint as rings with holes, recentred on the item frame', () => {
    const design = readDesign(tl, codes(sample()));
    const title = design.regions.find((r) => r.name === 'Single Barrel')!;
    // 19 rings: the 12 glyphs' outlines plus the counters of the 'g', 'l'… — a filled region, which
    // is the whole reason this is a pocket and not a stroke font (#410).
    expect(title.contours.length).toBe(19);
    // Recentred: the rings' bbox centre IS the origin, and their size is the region's size.
    let minX = Infinity;
    let maxX = -Infinity;
    for (const ring of title.contours) {
      for (const [x] of ring) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
    expect((minX + maxX) / 2).toBeCloseTo(0, 6);
    expect(maxX - minX).toBeCloseTo(title.width, 6);

    const sub = design.regions.find((r) => r.name === '(Like the Whiskey)')!;
    expect(sub.contours.length).toBe(21);
  });

  it('measures the magnet pocket out of the bottom colour, at its own ceiling', () => {
    const design = readDesign(tl, codes(sample()));
    expect(design.pocket).not.toBeNull();
    // make_badge.py's default pocket is 45 × 13 × 2.3; the file's own mesh says 45.000 × 13.000.
    expect(design.pocket!.length).toBeCloseTo(45, 2);
    expect(design.pocket!.width).toBeCloseTo(13, 2);
    expect(design.pocket!.centre[0]).toBeCloseTo(0, 2);
    expect(design.pocket!.centre[1]).toBeCloseTo(0, 2);
    expect(design.pocket!.ceiling).toBeCloseTo(2.3, 2);
    expect(design.pocket!.holes).toBe(1);
  });

  it('says what it measured, in the notes', () => {
    const design = readDesign(tl, codes(sample()));
    expect(design.notes.join('\n')).toContain('76.2 × 38.1 × 3.81 mm');
    expect(design.notes.join('\n')).toContain('colour');
  });
});

// #410 review item 3 — a NegativeVolume only means a cut FROM THE FACE if it reaches the face.
//
// The maintainer's file has three negative volumes and all three cross the top face (measured: two
// tops at 3.825, one at 3.8115, against the blank's 3.81), so the rule cannot be exercised on it. A
// fixture can: a blank whose two negative volumes are one crossing the face and one enclosed inside
// it. The enclosed one is what the rule is about — its bottom is 2 mm down, and cutting to
// `topZ − bottom` would machine away the material the design keeps over a void.
describe('a NegativeVolume must reach the top face (#410 review item 3)', () => {
  const blank = (): ReturnType<typeof fixtureBlank> => fixtureBlank();
  const through = () =>
    fixtureCut('a cut', [
      [2, 2, 2],
      [8, 8, 5], // crosses the face at 4, 1 mm of it proud
    ]);
  const enclosed = () =>
    fixtureCut('a void', [
      [12, 2, 1],
      [18, 8, 2], // wholly inside: 2 mm of material above it
    ]);

  it('takes the volume that crosses the face, at its own measured depth', () => {
    const design = readDesign(tl, parsePrusaThreeMf(project({ volumes: [blank(), through(), enclosed()] })));
    expect(design.regions.map((r) => r.name)).toEqual(['a cut']);
    expect(design.regions[0]!.depth).toBeCloseTo(2, 6); // 4 − 2
    expect(design.regions[0]!.zMax).toBeCloseTo(5, 6); // proud of the face, and still a cut from it
  });

  it('leaves out the enclosed volume, and says so in the notes', () => {
    const design = readDesign(tl, parsePrusaThreeMf(project({ volumes: [blank(), through(), enclosed()] })));
    const text = design.notes.join('\n');
    expect(text).toContain('"a void"');
    expect(text).toContain('void inside the blank');
    expect(text).toContain('below the top face at 4 mm');
    // Not an error: the rest of the design is cut, and the sheet carries the sentence.
    expect(design.regions.map((r) => r.name)).not.toContain('a void');
  });

  it('makes no region at all from a design whose only negative volume is enclosed', () => {
    const design = readDesign(tl, parsePrusaThreeMf(project({ volumes: [blank(), enclosed()] })));
    expect(design.regions).toEqual([]);
    expect(design.notes.join('\n')).toContain('"a void"');
  });
});

// `samples/badge-blank/br.3mf` is the plain-export case: a 3MF with no `Metadata/Slic3r_PE_model
// .config`, so its one object has no volume names and no NegativeVolume flags — nothing here to
// turn into a job, and the message says which save option produces one that works.
const plainPath = join(here, '..', '..', '..', 'samples', 'badge-blank', 'br.3mf');

describe.skipIf(!existsSync(plainPath))('the reader refuses what it cannot use (#410)', () => {
  it('refuses a plain 3MF export, which has no volume names or NegativeVolume flags', () => {
    const raw = readFileSync(plainPath);
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    expect(() => parsePrusaThreeMf(buf)).toThrow(PrusaThreeMfError);
    expect(() => parsePrusaThreeMf(buf)).toThrow(/project/);
  });

  it('refuses bytes that are not a 3MF at all', () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    expect(() => parsePrusaThreeMf(buf)).toThrow(PrusaThreeMfError);
  });
});

describe.skipIf(!hasSample)('the blank’s material, read from the project (#456)', () => {
  it('reads the maintainer’s blank as PETG, from the two blank extruders only', () => {
    expect(readDesign(tl, parsePrusaThreeMf(sample())).filament).toEqual({
      types: ['PETG'],
      settingsIds: ['Generic PETG @XL'],
      material: 'petg',
    });
  });
});

describe('the blank’s material maps only classes the app knows (#456)', () => {
  const designWith = (settings?: string) =>
    // The fixture blank prints with extruder 2, so a per-extruder list needs a first entry.
    readDesign(
      tl,
      parsePrusaThreeMf(
        project({
          volumes: [fixtureBlank()],
          settings: settings?.replace('filament_type = ', 'filament_type = PLA;'),
        }),
      ),
    );
  const twoParts = (type: string, ids?: string) => {
    const settings = [
      ...(type === '' ? [] : [`filament_type = ${type}`]),
      ...(ids === undefined ? [] : [`filament_settings_id = ${ids}`]),
    ].join('\n');
    return readDesign(
      tl,
      parsePrusaThreeMf(
        project({
          volumes: [
            { ...fixtureBlank(), name: 'bottom', extruder: 1 },
            { ...fixtureBlank(), name: 'top', extruder: 2, box: [[0, 0, 4], [20, 10, 6]] },
          ],
          settings,
        }),
      ),
    );
  };

  it('maps PLA, PETG and ABS to the app’s own names', () => {
    expect(designWith('filament_type = PLA').filament?.material).toBe('pla');
    expect(designWith('filament_type = PETG').filament?.material).toBe('petg');
    expect(designWith('filament_type = ABS').filament?.material).toBe('abs');
  });

  it('leaves an unknown type unmapped — it never falls back to PLA', () => {
    const filament = designWith('filament_type = ASA').filament!;
    expect(filament.types).toEqual(['ASA']);
    expect(filament.material).toBeNull();
  });

  it('leaves an absent filament_type unmapped', () => {
    const filament = designWith().filament!;
    expect(filament.types).toEqual([]);
    expect(filament.material).toBeNull();
  });

  it('uses filament_settings_id only when the type is absent, and only a whole-word class', () => {
    const fallback = designWith('filament_settings_id = "a";"Prusament PETG @XL"').filament!;
    expect(fallback.material).toBe('petg');
    // The type WINS: an unknown ASA profile whose settings id says PETG is still ASA.
    const stated = twoParts('ASA;ASA', '"Other";"Prusament PETG @XL"');
    expect(stated.filament?.material).toBeNull();
  });

  it('states no single material when the blank’s extruders disagree', () => {
    const mixed = twoParts('PETG;PLA');
    expect(mixed.filament?.types).toEqual(['PETG', 'PLA']);
    expect(mixed.filament?.material).toBeNull();
  });
});
