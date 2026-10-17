// #410 — reading a PrusaSlicer project as a DESIGN.
//
// The subject is a SYNTHETIC badge project (#437): 76.2 × 38.1 × 3.81 mm, two colour parts at a
// 3 mm split, a 45 × 13 mm magnet pocket and the file's own volume names. It is built here, in the
// same shape PrusaSlicer writes, so these specs run on any checkout. The maintainer's own
// `samples/badge-blank/single.3mf` is still read where only the real file can answer — glyph ring
// counts and its exact 0.998 mm logo floor — in the clearly-labelled optional oracle at the end.
//
// The point of the module is unchanged: nothing is typed in from a table, so a different project
// file produces different numbers with no code change. The fixture is a different file.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePrusaThreeMf, PrusaThreeMfError } from '@/engine/import/prusa3mf';
import { readDesign } from '@/engine/import/design3mf';
import {
  badgeProject,
  fixtureBlank,
  fixtureCut,
  plainProject,
  project,
} from './helpers/prusa3mfFixture';
import { tl } from './helpers/manifoldExec';

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = join(here, '..', '..', '..', 'samples', 'badge-blank', 'single.3mf');
const hasSample = existsSync(samplePath);

/** The maintainer's sample, read once. Only the optional oracle below uses it. */
function sample(): ArrayBuffer {
  const buf = readFileSync(samplePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** The fixture project, read as the reader reads a file. */
const fixtureFile = (opts: { zOffset?: number } = {}) => parsePrusaThreeMf(badgeProject(opts));

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

describe('the PrusaSlicer project reader (#410)', () => {
  it('splits the object into its five named volumes by facet range', () => {
    const file = fixtureFile();
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
    const file = fixtureFile();
    const title = file.volumes.find((v) => v.name === 'Single Barrel')!;
    expect(title.text).not.toBeNull();
    expect(title.text!.text).toBe('Single Barrel');
    expect(title.text!.font).toBe('Segoe UI');
    expect(title.text!.weight).toBe(700); // the Black face
    expect(title.text!.lineHeight).toBeCloseTo(10.8, 4);

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
    // The trap the issue names. The fixture writes a real placement on each generated volume:
    //   * T2's matrix translates z by 1.5, while its triangles sit at 0…3 in the mesh itself;
    //   * the logo's linear part is 0.4713, so applying it would shrink that volume to half size.
    // The reader takes the mesh as the design and ignores both.
    const file = fixtureFile();
    const design = readDesign(tl, file);
    expect(design.stock.lengthX).toBeCloseTo(76.2, 3);
    expect(design.stock.widthY).toBeCloseTo(38.1, 3);
    expect(design.stock.thickness).toBeCloseTo(3.81, 3);

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
    const design = readDesign(tl, fixtureFile());
    expect(design.stock.zMin).toBeCloseTo(0, 3);
    expect(design.stock.zMax).toBeCloseTo(3.81, 3);
    expect(design.colourSplit).toBeCloseTo(3.0, 3); // T2 bottom tops out at 3.0
    // A HEIGHT above the back face (#410 review item 4) — the frame `PartSpec.colourSplit` and
    // `stock.print.split` state — so the top colour's thickness is the blank's own thickness less it.
    expect(design.stock.thickness - design.colourSplit!).toBeCloseTo(0.81, 3);
  });

  it('reads the colour split in the SAME frame wherever it is used — a blank lifted 5 mm in z is the same part (#410 review item 4)', () => {
    // The blank is lifted rigidly by the fixture builder: the part does not change, only where its
    // back face sits in the file. Everything the reader measures must therefore come back the same,
    // and the two places the split is used — the `print.split` the job carries, and the slice the
    // magnet pocket is read from — are where a frame mix-up hides: the split reported as the file's
    // absolute z (7.5 here) makes `stock.print.split` a nonsense height AND puts the pocket slice at
    // 5 + 3.75 = 8.75 mm, above the blank, where it finds no hole and reports no void.
    const design = readDesign(tl, fixtureFile({ zOffset: 5 }));
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
    expect(depth['br']).toBeCloseTo(1.0, 3);

    // The note states the frame it is in, so a reader of the sheet is not left to infer it.
    expect(design.notes.join('\n')).toContain('3 mm above its back face');
  });
});

describe('a design read as regions (#410)', () => {
  it('turns each NegativeVolume into a region with its own measured footprint and depth', () => {
    const design = readDesign(tl, fixtureFile());
    expect(design.regions.map((r) => r.name)).toEqual(['(Like the Whiskey)', 'Single Barrel', 'br']);

    const title = design.regions.find((r) => r.name === 'Single Barrel')!;
    // The cut box's own bounding measurements, off the fixture's mesh.
    expect(title.width).toBeCloseTo(66.915, 2);
    expect(title.height).toBeCloseTo(10.531, 2);
    expect(title.centre[0]).toBeCloseTo(38.4575, 2);
    expect(title.centre[1]).toBeCloseTo(10.2655, 2);
    // Depth is the distance from the TOP FACE down to the volume's own floor — 3.81 − 2.825.
    expect(title.depth).toBeCloseTo(0.985, 3);
    expect(title.zMin).toBeCloseTo(2.825, 3);
    expect(title.text!.font).toBe('Segoe UI');

    // The subtitle is thinner and shorter; the logo is a shape with the same 1 mm depth.
    const sub = design.regions.find((r) => r.name === '(Like the Whiskey)')!;
    expect(sub.width).toBeCloseTo(41.594, 2);
    expect(sub.height).toBeCloseTo(5.171, 2);
    expect(sub.depth).toBeCloseTo(0.985, 3);
    const logo = design.regions.find((r) => r.name === 'br')!;
    expect(logo.width).toBeCloseTo(21.05, 2);
    expect(logo.height).toBeCloseTo(7.5, 2);
    expect(logo.depth).toBeCloseTo(1.0, 3);
  });

  it('carries the footprint as rings, recentred on the item frame', () => {
    const design = readDesign(tl, fixtureFile());
    const title = design.regions.find((r) => r.name === 'Single Barrel')!;
    // The fixture's cut is one closed box ring; the real file's glyphs give 19 (the optional oracle
    // below checks those). Either way the ring is recentred: its bbox centre IS the origin, and its
    // size is the region's size.
    expect(title.contours.length).toBe(1);
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
    expect(sub.contours.length).toBe(1);
  });

  it('measures the magnet pocket out of the bottom colour, at its own ceiling', () => {
    const design = readDesign(tl, fixtureFile());
    expect(design.pocket).not.toBeNull();
    // The fixture's sealed cavity is 45 × 13, centred on the blank, ceiling 2.3 — the same shape
    // the real file's pocket presents to this slice.
    expect(design.pocket!.length).toBeCloseTo(45, 2);
    expect(design.pocket!.width).toBeCloseTo(13, 2);
    expect(design.pocket!.centre[0]).toBeCloseTo(38.1, 2);
    expect(design.pocket!.centre[1]).toBeCloseTo(19.05, 2);
    expect(design.pocket!.ceiling).toBeCloseTo(2.3, 2);
    expect(design.pocket!.holes).toBe(1);
  });

  it('says what it measured, in the notes', () => {
    const design = readDesign(tl, fixtureFile());
    expect(design.notes.join('\n')).toContain('76.2 × 38.1 × 3.81 mm');
    expect(design.notes.join('\n')).toContain('colour');
  });
});

// #410 review item 3 — a NegativeVolume only means a cut FROM THE FACE if it reaches the face.
//
// The badge fixture has three negative volumes and all three cross the top face, so the rule cannot
// be exercised on it. A smaller fixture can: a blank whose two negative volumes are one crossing the
// face and one enclosed inside it. The enclosed one is what the rule is about — its bottom is 2 mm
// down, and cutting to `topZ − bottom` would machine away the material the design keeps over a void.
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

describe('the reader refuses what it cannot use (#410)', () => {
  it('refuses a plain 3MF export, which has no volume names or NegativeVolume flags', () => {
    expect(() => parsePrusaThreeMf(plainProject())).toThrow(PrusaThreeMfError);
    expect(() => parsePrusaThreeMf(plainProject())).toThrow(/project/);
  });

  it('refuses bytes that are not a 3MF at all', () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    expect(() => parsePrusaThreeMf(buf)).toThrow(PrusaThreeMfError);
  });
});

describe('the blank’s material, read from the project (#456)', () => {
  it('reads the badge fixture as PETG, from the two blank extruders only', () => {
    expect(readDesign(tl, fixtureFile()).filament).toEqual({
      types: ['PETG'],
      settingsIds: ['Generic PETG @XL'],
      material: 'petg',
    });
  });
});

describe('the blank’s material maps the classes the app knows (#456)', () => {
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

  it.each([
    ['PLA', 'pla'],
    ['PETG', 'petg'],
    ['PET', 'pet'],
    ['ABS', 'abs'],
    ['ASA', 'asa'],
    ['HIPS', 'hips'],
    ['PA', 'pa'],
    ['NYLON', 'pa'],
    ['PA-CF', 'pa-cf'],
    ['PA-GF', 'pa-gf'],
    ['PC', 'pc'],
    ['PP', 'pp'],
    ['FLEX', 'tpu'],
    ['TPU', 'tpu'],
    ['PVA', 'pva'],
  ])('maps filament_type %s to %s', (type, material) => {
    expect(designWith(`filament_type = ${type}`).filament?.material).toBe(material);
  });

  it('leaves a class this app cannot name unmapped — it never falls back to PLA', () => {
    const filament = designWith('filament_type = PVB').filament!;
    expect(filament.types).toEqual(['PVB']);
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
    // The type WINS: a PETG profile whose settings id says carbon-fibre nylon is still PETG.
    const stated = twoParts('PETG;PETG', '"Other";"Prusament PA11 Carbon Fiber @XL"');
    expect(stated.filament?.material).toBe('petg');
  });

  it('reads the fibre-filled nylons from the profile name when the type is absent', () => {
    expect(designWith('filament_settings_id = "a";"Prusament PA11 Carbon Fiber @XL"').filament?.material).toBe('pa-cf');
    expect(designWith('filament_settings_id = "a";"Generic PA6 Glass Fiber @XL"').filament?.material).toBe('pa-gf');
    // A nylon base the profile spells PA11 is still nylon.
    expect(designWith('filament_settings_id = "a";"Prusament PA11 @XL"').filament?.material).toBe('pa');
    // A composite this app does not model is unknown, not its unreinforced base.
    expect(designWith('filament_settings_id = "a";"Generic PET-CF @XL"').filament?.material).toBeNull();
  });

  it('states no single material when the blank’s extruders disagree', () => {
    const mixed = twoParts('PETG;PLA');
    expect(mixed.filament?.types).toEqual(['PETG', 'PLA']);
    expect(mixed.filament?.material).toBeNull();
  });
});

// OPTIONAL ORACLE, not the subject. The maintainer's file is untracked, so nothing above depends on
// it; these two facts are the ones a synthetic box cannot show — the glyph outlines' ring counts and
// the logo's real 0.998 mm floor. They run only where `samples/` is checked out.
describe.skipIf(!hasSample)('the maintainer’s own project, as an oracle', () => {
  it('reads the same design, with the glyph ring counts and floor the fixture cannot show', () => {
    const design = readDesign(tl, parsePrusaThreeMf(sample()));
    const title = design.regions.find((r) => r.name === 'Single Barrel')!;
    expect(title.contours.length).toBe(19);
    const sub = design.regions.find((r) => r.name === '(Like the Whiskey)')!;
    expect(sub.contours.length).toBe(21);
    expect(design.regions.find((r) => r.name === 'br')!.depth).toBeCloseTo(0.998, 3);
    expect(design.filament).toEqual({
      types: ['PETG'],
      settingsIds: ['Generic PETG @XL'],
      material: 'petg',
    });
  });
});
