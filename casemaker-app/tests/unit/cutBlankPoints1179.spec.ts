// #1179 slice B — TOUCH POINTS ON A BLANK THAT HAS BEEN CUT.
//
// The restart's registration must find the top on wood no program cut. These are the pure pieces:
// the cut footprint of a frozen package (the NC text, grown by each program's cutter radius + 1 mm),
// the part's placed silhouette (grown by the largest owned diameter + 1 mm), and the tiered choice
// the analyst ruled: tier 1 = outside both, tier 2 = outside the package's cut only; both touches
// from tier 1 when it has two points >= 20 mm apart, otherwise one from each, tier 2 alone only
// when tier 1 is empty.
import { describe, expect, it } from 'vitest';
import {
  CUT_BLANK_EDGE_MARGIN_MM,
  CUT_BLANK_MIN_SEPARATION_MM,
  cutFootprintMask,
  surfaceCandidates,
  stockRaster,
} from '@/engine/cnc/registration/cutBlank';

const STOCK = { xMin: 0, yMin: 0, xMax: 100, yMax: 60 };

/** A square cut 10..30 mm in X and Y, at Z -1, at feed 300 — a cutting footprint for the mask. */
const SQUARE_NC = [
  'G90',
  'G0 Z5',
  'G0 X10 Y10',
  'G1 Z-1 F100',
  'G1 X30 Y10 F300',
  'G1 X30 Y30',
  'G1 X10 Y30',
  'G1 X10 Y10',
  'G0 Z5',
].join('\n');

describe('#1179 the cut footprint of a package', () => {
  it('marks the cut square grown by the program’s cutter radius + 1 mm', () => {
    const raster = stockRaster(STOCK);
    const cut = cutFootprintMask(raster, [{ nc: SQUARE_NC, growMm: 1.5 + 1 }], 10);
    const at = (x: number, y: number): number => {
      const i = Math.floor((x - STOCK.xMin) / raster.pitchMm);
      const j = Math.floor((y - STOCK.yMin) / raster.pitchMm);
      return cut[j * raster.nx + i]!;
    };
    // The square is a CONTOUR: its wall is cut, grown by 2.5 — 32.5 is cut, 34 is not.
    expect(at(20, 10)).toBe(1);
    expect(at(32.5, 20)).toBe(1);
    expect(at(34, 20)).toBe(0);
    // Inside a contour-only path, far from any cutting move, is NOT a cut footprint (a real
    // pocket's passes would fill it); a point well outside is free too.
    expect(at(20, 20)).toBe(0);
    expect(at(80, 50)).toBe(0);
  });

  it('uses the fallback growth when a program’s cutter is unknown', () => {
    const raster = stockRaster(STOCK);
    const at = (x: number, y: number): number =>
      cut[jIndex(y) * raster.nx + Math.floor((x - STOCK.xMin) / raster.pitchMm)]!;
    const cut = cutFootprintMask(raster, [{ nc: SQUARE_NC, growMm: Number.NaN }], 12);
    const jIndex = (y: number): number => Math.floor((y - STOCK.yMin) / raster.pitchMm);
    // 11 mm above the square's top edge: cut at the 12 mm fallback, free beyond it.
    expect(at(20, 41)).toBe(1);
    expect(at(20, 44)).toBe(0);
  });
});

describe('#1179 tiered touch points', () => {
  const raster = stockRaster(STOCK);
  const noCut = new Uint8Array(raster.nx * raster.ny);
  const noPart = new Uint8Array(raster.nx * raster.ny);
  const everyCell = (): Uint8Array => new Uint8Array(raster.nx * raster.ny).fill(1);
  /** A mask with the rectangle (x0,y0)-(x1,y1) marked. */
  const box = (x0: number, y0: number, x1: number, y1: number): Uint8Array => {
    const mask = new Uint8Array(raster.nx * raster.ny);
    for (let j = 0; j < raster.ny; j++) {
      const y = STOCK.yMin + (j + 0.5) * raster.pitchMm;
      for (let i = 0; i < raster.nx; i++) {
        const x = STOCK.xMin + (i + 0.5) * raster.pitchMm;
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) mask[j * raster.nx + i] = 1;
      }
    }
    return mask;
  };

  it('takes both touches from tier 1 when it has two points >= 20 mm apart', () => {
    // The part occupies the middle; the cut square sits inside it. The ring is tier 1.
    const part = box(35, 15, 65, 45);
    const cut = box(10, 10, 30, 30);
    const points = surfaceCandidates({ raster, cut, part, obstacles: [] });
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points[0]!.tier).toBe(1);
    expect(points[1]!.tier).toBe(1);
    const apart = Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
    expect(apart).toBeGreaterThanOrEqual(CUT_BLANK_MIN_SEPARATION_MM);
    // Neither is inside the cut square nor the part.
    for (const p of points.slice(0, 2)) {
      expect(p.x < 10 || p.x > 30 || p.y < 10 || p.y > 30).toBe(true);
      expect(p.x >= 35 && p.x <= 65 && p.y >= 15 && p.y <= 45).toBe(false);
    }
  });

  it('falls to one from each tier when tier 1 cannot give two far points', () => {
    // The part covers all but a 10 × 10 island: tier 1 has cells, but no pair 20 mm apart.
    const part = everyCell();
    for (let j = 0; j < raster.ny; j++) {
      const y = STOCK.yMin + (j + 0.5) * raster.pitchMm;
      for (let i = 0; i < raster.nx; i++) {
        const x = STOCK.xMin + (i + 0.5) * raster.pitchMm;
        if (x >= 15 && x <= 25 && y >= 15 && y <= 25) part[j * raster.nx + i] = 0;
      }
    }
    const cut = box(60, 20, 80, 40);
    const points = surfaceCandidates({ raster, cut, part, obstacles: [] });
    expect(points[0]!.tier).toBe(1);
    expect(points[1]!.tier).toBe(2);
  });

  it('uses tier 2 alone when tier 1 is empty', () => {
    const part = everyCell();
    const cut = box(0, 40, 100, 60);
    const points = surfaceCandidates({ raster, cut, part, obstacles: [] });
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points[0]!.tier).toBe(2);
    expect(points[1]!.tier).toBe(2);
    for (const p of points.slice(0, 2)) expect(p.y).toBeLessThan(40);
  });

  it('keeps the 3 mm edge margin and the mount obstacles clear', () => {
    const points = surfaceCandidates({
      raster,
      cut: noCut,
      part: noPart,
      obstacles: [{ min: [40, 20], max: [60, 40] }],
    });
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(STOCK.xMin + CUT_BLANK_EDGE_MARGIN_MM);
      expect(p.x).toBeLessThanOrEqual(STOCK.xMax - CUT_BLANK_EDGE_MARGIN_MM);
      expect(p.y).toBeGreaterThanOrEqual(STOCK.yMin + CUT_BLANK_EDGE_MARGIN_MM);
      expect(p.y).toBeLessThanOrEqual(STOCK.yMax - CUT_BLANK_EDGE_MARGIN_MM);
      const inObstacle = p.x >= 40 && p.x <= 60 && p.y >= 20 && p.y <= 40;
      expect(inObstacle).toBe(false);
    }
  });

  it('offers no candidate at all when the package cuts the whole top', () => {
    const points = surfaceCandidates({ raster, cut: everyCell(), part: everyCell(), obstacles: [] });
    expect(points).toEqual([]);
  });
});
