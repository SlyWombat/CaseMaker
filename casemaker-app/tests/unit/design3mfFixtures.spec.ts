/**
 * The two fixture files #221 is accepted against (#221, J14).
 *
 * The synthetic `badgeProject()` covers the reader's rules; these two files are the ACTUAL
 * maintainer's projects, so this spec pins the numbers the V-carve slices will be measured
 * against: the blank, the two-colour split, every region's shadow, and its measured floor.
 *
 * The files are fixtures now (committed under `samples/badge-blank/`), so this spec runs on
 * every checkout rather than behind an `existsSync` skip. If a file changes, the numbers here
 * must be re-measured, not adjusted to make the spec pass.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePrusaThreeMf } from '@/engine/import/prusa3mf';
import { readDesign, type DesignImport } from '@/engine/import/design3mf';
import { designJobFor } from '@/engine/cnc/engrave/fromDesign';
import { tl } from './helpers/manifoldExec';

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, '..', '..', '..', 'samples', 'badge-blank');

function read(name: string): DesignImport {
  const buf = readFileSync(join(samples, name));
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return readDesign(tl, parsePrusaThreeMf(bytes));
}

function region(design: DesignImport, name: string) {
  const found = design.regions.find((r) => r.name === name);
  if (found === undefined) throw new Error(`the fixture has no region named "${name}"`);
  return found;
}

describe('the thick badge fixture (single.3mf)', () => {
  const design = read('single.3mf');

  it('measures the 3.81 mm blank and its 0.81 mm top colour', () => {
    expect(design.stock.lengthX).toBeCloseTo(76.2, 2);
    expect(design.stock.widthY).toBeCloseTo(38.1, 2);
    expect(design.stock.thickness).toBeCloseTo(3.81, 2);
    expect(design.stock.zMin).toBeCloseTo(0, 2);
    expect(design.stock.zMax).toBeCloseTo(3.81, 2);
    expect(design.colourSplit).toBeCloseTo(3.0, 2);
    expect(design.layerHeight).toBeCloseTo(0.2, 2);
    expect(design.firstLayerHeight).toBeCloseTo(0.2, 2);
  });

  it('reads three cutting volumes with their own shadows and measured floors', () => {
    expect(design.regions.map((r) => r.name)).toEqual([
      '(Like the Whiskey)',
      'Single Barrel',
      'br',
    ]);

    const title = region(design, 'Single Barrel');
    expect(title.width).toBeCloseTo(66.915, 2);
    expect(title.height).toBeCloseTo(10.531, 2);
    expect(title.depth).toBeCloseTo(0.985, 3);

    const sub = region(design, '(Like the Whiskey)');
    expect(sub.width).toBeCloseTo(41.593, 2);
    expect(sub.height).toBeCloseTo(5.171, 2);
    expect(sub.depth).toBeCloseTo(0.985, 3);

    const logo = region(design, 'br');
    expect(logo.width).toBeCloseTo(21.04, 2);
    expect(logo.height).toBeCloseTo(13.773, 2);
    expect(logo.depth).toBeCloseTo(0.998, 3);
  });

  it('states PETG for both blank extruders; the PLA filaments are not blank material', () => {
    expect(design.filament).toEqual({
      types: ['PETG'],
      settingsIds: ['Generic PETG @XL'],
      material: 'petg',
      fibre: null,
    });
  });

  it('turns the blank onto the jaws and carries PETG', () => {
    const patch = designJobFor(design);
    expect(patch.stock.length).toBeCloseTo(38.1, 2);
    expect(patch.stock.width).toBeCloseTo(76.2, 2);
    expect(patch.stock.thickness).toBeCloseTo(3.81, 2);
    expect(patch.stock.material).toBe('petg');
    expect(patch.stock.print).toEqual({ split: 3, layerHeight: 0.2 });
    expect(patch.vectors).toHaveLength(3);
    expect(patch.vectors.map((v) => v.name)).toEqual([
      '(Like the Whiskey)',
      'Single Barrel',
      'br',
    ]);
  });
});

describe('the thin-film fixture (thin-film/single-thin.3mf)', () => {
  const design = read(join('thin-film', 'single-thin.3mf'));

  it('measures the 1.5 mm blank and its 0.2 mm film', () => {
    expect(design.stock.lengthX).toBeCloseTo(76.0, 2);
    expect(design.stock.widthY).toBeCloseTo(25.35, 2);
    expect(design.stock.thickness).toBeCloseTo(1.5, 2);
    expect(design.stock.zMin).toBeCloseTo(0, 2);
    expect(design.stock.zMax).toBeCloseTo(1.5, 2);
    expect(design.colourSplit).toBeCloseTo(1.3, 2);
    expect(design.layerHeight).toBeCloseTo(0.2, 2);
    expect(design.firstLayerHeight).toBeCloseTo(0.2, 2);
  });

  it('reads the title, the whiskey line and the logo at the film’s measured depth', () => {
    expect(design.regions.map((r) => r.name)).toEqual([
      '(Like the Whiskey)',
      'Single Barrel',
      'br',
    ]);

    const title = region(design, 'Single Barrel');
    expect(title.width).toBeCloseTo(49.969, 2);
    expect(title.height).toBeCloseTo(7.864, 2);
    expect(title.depth).toBeCloseTo(0.394, 3);

    const sub = region(design, '(Like the Whiskey)');
    expect(sub.width).toBeCloseTo(49.969, 2);
    expect(sub.height).toBeCloseTo(6.212, 2);
    expect(sub.depth).toBeCloseTo(0.394, 3);

    const logo = region(design, 'br');
    expect(logo.width).toBeCloseTo(23.031, 2);
    expect(logo.height).toBeCloseTo(15.076, 2);
    expect(logo.depth).toBeCloseTo(0.399, 3);
  });

  it('states PETG for every blank extruder', () => {
    expect(design.filament).toEqual({
      types: ['PETG'],
      settingsIds: ['Generic PETG @XL'],
      material: 'petg',
      fibre: null,
    });
  });

  it('turns the 76 × 25.35 blank onto the jaws and carries PETG', () => {
    const patch = designJobFor(design);
    expect(patch.stock.length).toBeCloseTo(25.35, 2);
    expect(patch.stock.width).toBeCloseTo(76.0, 2);
    expect(patch.stock.thickness).toBeCloseTo(1.5, 2);
    expect(patch.stock.material).toBe('petg');
    expect(patch.stock.print).toEqual({ split: 1.3, layerHeight: 0.2 });
    expect(patch.vectors).toHaveLength(3);
  });
});
