// #410 — the frame turn and the job patch.
//
// The subject is the TURN: the file lays the blank out on the print bed, the bench clamps it across
// the jaws, and getting from one to the other is a quarter rotation of the whole design. These
// specs check the three things that can go wrong there — a mirrored design, an item that lands off
// the blank, and an item whose stated `rotation` disagrees with where its own points ended up —
// against the maintainer's own file, and they check them for BOTH directions.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePrusaThreeMf } from '@/engine/import/prusa3mf';
import { readDesign, type DesignImport } from '@/engine/import/design3mf';
import {
  designJobFor,
  designPointToJob,
  DESIGN_POCKET_KEEP_OUT_ID,
  type DesignReadingDirection,
} from '@/engine/cnc/engrave/fromDesign';
import { tl } from './helpers/manifoldExec';

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = join(here, '..', '..', '..', 'samples', 'badge-blank', 'single.3mf');
const hasSample = existsSync(samplePath);

function sample(): ArrayBuffer {
  const buf = readFileSync(samplePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function design(): DesignImport {
  return readDesign(tl, parsePrusaThreeMf(sample()));
}

/** Deterministic ids, so a patch can be compared as a whole. */
const ids = (): (() => string) => {
  let n = 0;
  return () => `shp-${++n}`;
};

/** Signed area of a ring, for the mirroring check. */
function ringArea(ring: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Where an item's own ring point lands once the item's `position`/`rotation` are applied. */
function placed(
  position: { x: number; y: number },
  rotationDeg: number,
  lx: number,
  ly: number,
): { x: number; y: number } {
  const t = (rotationDeg * Math.PI) / 180;
  return {
    x: position.x + lx * Math.cos(t) - ly * Math.sin(t),
    y: position.y + lx * Math.sin(t) + ly * Math.cos(t),
  };
}

describe.skipIf(!hasSample)('the blank, as the job frame has it (#410)', () => {
  it('swaps the blank’s sides: 38.1 across the jaws, 76.2 along the feed', () => {
    const patch = designJobFor(design(), { id: ids() });
    expect(patch.name).toBe('single');
    expect(patch.stock.length).toBeCloseTo(38.1, 3); // X, across the jaws
    expect(patch.stock.width).toBeCloseTo(76.2, 3); // Y, along the feed
    expect(patch.stock.thickness).toBeCloseTo(3.81, 3);
    expect(patch.stock.material).toBe('pla');
  });

  it('carries the file’s own print facts, and the dome across the axis that is 38.1', () => {
    const stock = designJobFor(design()).stock;
    expect(stock.print).toEqual({ split: 3, layerHeight: 0.2 });
    // `across: 'length'` — NOT the badge route's `'width'`. The blanks are the same part but this
    // job's frame is turned, so the 38.1 mm span #345 measured the dome across is the LENGTH here.
    expect(stock.flatness).toEqual({ dome: 0.33, across: 'length', source: 'measured' });
  });

  it('stamps every field it writes as derived, never as a bench reading (#254)', () => {
    const patch = designJobFor(design());
    expect(patch.sources.stock).toEqual({
      length: 'computed',
      width: 'computed',
      thickness: 'computed',
      material: 'computed',
      print: 'computed',
      flatness: 'computed',
    });
  });
});

describe.skipIf(!hasSample)('the turn (#410)', () => {
  it('says which way it turned the design, in words', () => {
    const ccw = designJobFor(design(), { direction: 'ccw' });
    expect(ccw.notes.join('\n')).toContain('COUNTER-CLOCKWISE');
    expect(ccw.notes.join('\n')).toContain('Nothing was mirrored');
    const cw = designJobFor(design(), { direction: 'cw' });
    expect(cw.notes.join('\n')).toContain('CLOCKWISE');
  });

  it('does not MIRROR the design, either way — the rings keep their orientation', () => {
    const d = design();
    for (const direction of ['ccw', 'cw'] as const) {
      const patch = designJobFor(d, { direction, id: ids() });
      d.regions.forEach((region, i) => {
        const item = patch.vectors[i]!;
        const before = ringArea(region.contours[0]!);
        const after = ringArea(
          item.contours[0]!.map(([lx, ly]) => {
            const p = placed(item.position, item.rotation, lx, ly);
            return [p.x, p.y] as [number, number];
          }),
        );
        // A mirror would negate this. A rotation cannot.
        expect(Math.sign(after)).toBe(Math.sign(before));
        expect(after).toBeCloseTo(before, 6);
      });
    }
  });

  it('lands every item on the blank, in both directions', () => {
    const d = design();
    for (const direction of ['ccw', 'cw'] as const) {
      const patch = designJobFor(d, { direction, id: ids() });
      for (const item of patch.vectors) {
        for (const [lx, ly] of item.contours.flat()) {
          const p = placed(item.position, item.rotation, lx, ly);
          expect(p.x).toBeGreaterThanOrEqual(-1e-6);
          expect(p.x).toBeLessThanOrEqual(patch.stock.length + 1e-6);
          expect(p.y).toBeGreaterThanOrEqual(-1e-6);
          expect(p.y).toBeLessThanOrEqual(patch.stock.width + 1e-6);
        }
      }
    }
  });

  it('places each item’s points where the frame map puts them, to the micron the patch is written at', () => {
    // The item carries the turn as ONE number (`rotation`) and its contours untouched. This is the
    // check that the two agree: mapping the same file-frame point through the frame map must land
    // where the item's own position+rotation puts it.
    //
    // A couple of MICRONS apart, not the six decimals this asked for when the patch carried full
    // float noise. Two roundings are in the difference and neither is an error: the item's
    // `position` is written as mm to the micron (`um()`) while its rings are carried verbatim, so a
    // point rebuilt from the item is off by the rounding of the centre, and the rotation's own trig
    // adds a little on top. Asking for better than that would be asking the two roads to agree on
    // the triangle soup's arithmetic rather than on where the point is on the blank.
    const d = design();
    for (const direction of ['ccw', 'cw'] as const) {
      const patch = designJobFor(d, { direction, id: ids() });
      d.regions.forEach((region, i) => {
        const item = patch.vectors[i]!;
        for (const ring of region.contours) {
          for (const [lx, ly] of ring) {
            const direct = designPointToJob(
              d,
              region.centre[0] + lx,
              region.centre[1] + ly,
              direction,
            );
            const viaItem = placed(item.position, item.rotation, lx, ly);
            expect(Math.abs(viaItem.x - direct.x)).toBeLessThan(2e-3);
            expect(Math.abs(viaItem.y - direct.y)).toBeLessThan(2e-3);
          }
        }
      });
    }
  });

  it('turns one way round from the other: cw is ccw seen from the far end', () => {
    // The two directions are a 180° rotation of each other about the blank's centre — the reason
    // they are a convention rather than a correctness switch.
    const d = design();
    const a = designJobFor(d, { direction: 'ccw' });
    const b = designJobFor(d, { direction: 'cw' });
    d.regions.forEach((_region, i) => {
      const p = a.vectors[i]!.position;
      const q = b.vectors[i]!.position;
      expect(q.x).toBeCloseTo(a.stock.length - p.x, 6);
      expect(q.y).toBeCloseTo(a.stock.width - p.y, 6);
    });
    expect(a.vectors[0]!.rotation).toBe(90);
    expect(b.vectors[0]!.rotation).toBe(-90);
  });

  it('maps an item’s position to the measured spot on the blank', () => {
    // The title's file-frame centre is (0.452, 8.2045) — measured in the design spec. ccw puts it
    // at x = 19.05 − 8.2045 near the fixed jaw, y = 0.452 + 38.1 near the front edge.
    const patch = designJobFor(design(), { direction: 'ccw' });
    const title = patch.vectors.find((v) => v.name === 'Single Barrel')!;
    expect(title.position.x).toBeCloseTo(10.845, 3);
    expect(title.position.y).toBeCloseTo(38.552, 3);
  });
});

describe.skipIf(!hasSample)('the design’s items (#410)', () => {
  it('names every item after its volume, and gives it that volume’s own depth', () => {
    const patch = designJobFor(design());
    expect(patch.vectors.map((v) => v.name)).toEqual([
      '(Like the Whiskey)',
      'Single Barrel',
      'br',
    ]);
    const [sub, title, logo] = patch.vectors;
    expect(sub!.depth).toBeCloseTo(0.985, 3);
    expect(title!.depth).toBeCloseTo(0.985, 3);
    expect(logo!.depth).toBeCloseTo(0.998, 3);
    for (const item of patch.vectors) {
      expect(item.kind).toBe('vector');
      expect(item.enabled).toBe(true);
      expect(item.fillRule).toBe('EvenOdd');
      expect(item.sourceName).toBe(`single › ${item.name}`);
      expect(item.contours.length).toBeGreaterThan(0);
    }
  });

  it('swaps each item’s shown width and height with the turn, so width is still the X extent', () => {
    const d = design();
    const patch = designJobFor(d, { id: ids() });
    d.regions.forEach((region, i) => {
      expect(patch.vectors[i]!.width).toBeCloseTo(region.height, 3);
      expect(patch.vectors[i]!.height).toBeCloseTo(region.width, 3);
    });
  });

  it('writes every number it takes off the mesh as mm to the micron, not as float noise', () => {
    // A mesh measurement arrives at fifteen significant figures — the blank is 38.099998474121094 and
    // one volume's floor is 0.9849972724914551 — and those are not precision, they are the arithmetic
    // showing through. They also DISAGREE with the notes printed beside them ("76.2 × 38.1 × 3.81"),
    // and the panel's blank fields read them straight back to the operator. Measured, then written at
    // the precision every other number in the app is written at.
    const patch = designJobFor(design(), { id: ids() });
    const written: number[] = [
      patch.stock.length,
      patch.stock.width,
      patch.stock.thickness,
      ...patch.vectors.flatMap((v) => [v.width, v.height, v.depth, v.position.x, v.position.y]),
      ...(patch.keepOut?.kind === 'polygon' ? patch.keepOut.points.flat() : []),
    ];
    expect(written.length).toBeGreaterThan(10);
    for (const n of written) expect(Math.abs(n * 1000 - Math.round(n * 1000))).toBeLessThan(1e-9);
    // And the numbers the notes state are the numbers the job carries, so the two cannot read back
    // differently — 38.1 in the sentence and 38.099998 in the field was the state this replaced.
    expect(patch.stock.length).toBe(38.1);
    expect(patch.stock.width).toBe(76.2);
    expect(patch.stock.thickness).toBe(3.81);
  });

  it('declares the magnet pocket as the file’s own ring, at its own ceiling', () => {
    const patch = designJobFor(design());
    const ko = patch.keepOut!;
    expect(ko.id).toBe(DESIGN_POCKET_KEEP_OUT_ID);
    expect(ko.kind).toBe('polygon');
    expect(ko.zCeiling).toBeCloseTo(2.3, 2);
    if (ko.kind !== 'polygon') throw new Error('expected a polygon keep-out');
    // 13 × 45 in the job frame: the pocket's 45 mm ran in the file's X and 13 in its Y.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of ko.points) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    expect(maxX - minX).toBeCloseTo(13, 2);
    expect(maxY - minY).toBeCloseTo(45, 2);
    // Centred on the blank, as the file's own origin is.
    expect(ko.position.x + (minX + maxX) / 2).toBeCloseTo(patch.stock.length / 2, 2);
    expect(ko.position.y + (minY + maxY) / 2).toBeCloseTo(patch.stock.width / 2, 2);
  });
});

describe('a direction is a parameter, not a constant (#410 / #383)', () => {
  it('defaults to ccw', () => {
    // No file needed: the default is a property of the signature.
    const stub = {
      name: 'stub',
      stock: { lengthX: 20, widthY: 10, thickness: 3, minX: -10, minY: -5, zMin: 0, zMax: 3 },
      colourSplit: null,
      layerHeight: null,
      firstLayerHeight: null,
      regions: [],
      pocket: null,
      notes: [],
    } as unknown as DesignImport;
    expect(designJobFor(stub).stock).toMatchObject({ length: 10, width: 20 });
    // The file's four corners land on the job's four corners, whichever way it is turned.
    expect(designPointToJob(stub, -10, -5, 'ccw')).toEqual({ x: 10, y: 0 });
    expect(designPointToJob(stub, 10, 5, 'ccw')).toEqual({ x: 0, y: 20 });
    expect(designPointToJob(stub, -10, -5, 'cw')).toEqual({ x: 0, y: 20 });
    expect(designPointToJob(stub, 10, 5, 'cw')).toEqual({ x: 10, y: 0 });
    // No print in the file, no print on the blank — and the note says so rather than guessing one.
    expect(designJobFor(stub).stock.print).toBeUndefined();
    expect(designJobFor(stub).stock.flatness).toBeUndefined();
    expect(designJobFor(stub).notes.join('\n')).toContain('states no print');
  });

  it('carries no items and no void for a design that has none', () => {
    const patch = designJobFor(
      {
        name: 'plain',
        stock: { lengthX: 10, widthY: 10, thickness: 3, minX: 0, minY: 0, zMin: 0, zMax: 3 },
        colourSplit: null,
        layerHeight: null,
        firstLayerHeight: null,
        regions: [],
        pocket: null,
        notes: [],
      } as unknown as DesignImport,
      { direction: 'cw' as DesignReadingDirection },
    );
    expect(patch.vectors).toEqual([]);
    expect(patch.keepOut).toBeNull();
  });
});
