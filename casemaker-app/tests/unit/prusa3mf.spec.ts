// #410 review item 2 — what the FORMAT reader refuses, and why it has to.
//
// The reader's premise is that one object's single mesh carries every named volume, so the config's
// `<volume firstid lastid>` ranges address that mesh and nothing else. Two shapes break the premise
// while still parsing into a plausible-looking design, and both are refused here:
//
//   * a second `<object>` — the ranges would be counted into another object's triangles, so every
//     named volume would be measured out of the wrong geometry;
//   * a `<build><item transform="…">` whose linear part is not the identity — the mesh in the file
//     would not be the part as it prints, and nothing here can undo a rotation or a scale.
//
// The fixtures are built here rather than taken from `samples/`, because neither shape occurs in a
// file the maintainer would cut from — the point is the refusal, and a fixture that is a box is the
// smallest thing that can be refused for the right reason. The maintainer's OWN project is the
// control: its build transform IS a pure translation, it parses, and the translation is not applied.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePrusaThreeMf, PrusaThreeMfError } from '@/engine/import/prusa3mf';
import { fixtureBlank, project, type FixtureVolume, type V3 } from './helpers/prusa3mfFixture';

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = join(here, '..', '..', '..', 'samples', 'badge-blank', 'single.3mf');

/** The fixture's ModelPart blank — a shared shape, not a shape under test. */
const blank = (): FixtureVolume => fixtureBlank();

describe('the project reader refuses a model it cannot read correctly (#410 review item 2)', () => {
  it('parses the fixture itself — the control for the two refusals below', () => {
    const file = parsePrusaThreeMf(project({ volumes: [blank()] }));
    expect(file.objectName).toBe('fixture');
    expect(file.volumes.map((v) => v.name)).toEqual(['the blank']);
    expect(file.mesh.triVerts.length / 3).toBe(12);
  });

  it('refuses more than one object, naming the count', () => {
    const buf = project({
      volumes: [blank()],
      extraObject: [
        [30, 0, 0],
        [40, 10, 4],
      ] as [V3, V3],
    });
    expect(() => parsePrusaThreeMf(buf)).toThrow(PrusaThreeMfError);
    // Why it matters, in the message: the config's ranges address ONE merged mesh.
    expect(() => parsePrusaThreeMf(buf)).toThrow(/2 objects/);
    expect(() => parsePrusaThreeMf(buf)).toThrow(/merged mesh/);
  });

  it('refuses a build transform that is not a pure translation', () => {
    // 90° about Z, row-major — a legitimate 3MF placement and not one this reader may ignore.
    const buf = project({
      volumes: [blank()],
      build: '<item objectid="1" transform="0 1 0 -1 0 0 0 0 1 10 20 0"/>',
    });
    expect(() => parsePrusaThreeMf(buf)).toThrow(PrusaThreeMfError);
    expect(() => parsePrusaThreeMf(buf)).toThrow(/pure translation/);
    // The linear part is quoted, so the message can be checked against the file.
    expect(() => parsePrusaThreeMf(buf)).toThrow(/0 1 0 -1 0 0 0 0 1/);
  });

  it('refuses a build that places more than one item', () => {
    const buf = project({
      volumes: [blank()],
      build: '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 30 0 0"/>',
    });
    expect(() => parsePrusaThreeMf(buf)).toThrow(PrusaThreeMfError);
    expect(() => parsePrusaThreeMf(buf)).toThrow(/2 items/);
  });

  it('refuses a build transform that is not twelve numbers', () => {
    const buf = project({ volumes: [blank()], build: '<item objectid="1" transform="1 0 0 0 1"/>' });
    expect(() => parsePrusaThreeMf(buf)).toThrow(/twelve numbers/);
  });

  it('accepts a pure translation, and does NOT apply it', () => {
    const file = parsePrusaThreeMf(
      project({ volumes: [blank()], build: '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 200 3"/>' }),
    );
    // The vertex list is the object's own, exactly as written: nothing downstream is anchored to
    // the bed origin (the design reader measures relative to the part's bounding box).
    const xs = [];
    for (let i = 0; i < file.mesh.vertProperties.length; i += 3) xs.push(file.mesh.vertProperties[i]!);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(20);
  });
});

describe('the maintainer’s own project passes the same checks (#410 review item 2)', () => {
  it.skipIf(!existsSync(samplePath))('parses, with its 183 mm bed translation left where it is', () => {
    const raw = readFileSync(samplePath);
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
    const file = parsePrusaThreeMf(buf);
    expect(file.objectName).toBe('single');
    // The build's transform really is a pure translation — 182.927 / 174.197, and no rotation.
    // If that ever stops being true the parse above throws, which is the point of reading it here.
    const xs: number[] = [];
    for (let i = 0; i < file.mesh.vertProperties.length; i += 3) xs.push(file.mesh.vertProperties[i]!);
    expect(Math.max(...xs)).toBeCloseTo(38.1, 3); // the blank's own half-width, NOT 38.1 + 182.9
  });
});
