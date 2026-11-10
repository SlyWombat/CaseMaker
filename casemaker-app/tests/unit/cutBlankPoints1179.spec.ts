// #1179 slice B — TOUCH POINTS ON A BLANK THAT HAS BEEN CUT (the maintainer's restated rule).
//
// No assumption of material outside a waste band: candidates are points whose DEPTH IS KNOWN — the
// uncut top (d = 0) or a flat floor whose depth the FINISHED programs' moves give (deepest cutting
// move within the cutter radius; flat when every move within cutter radius + tip + 1 mm is at that
// depth ± 0.02). A reading + d is the implied top. With no finished program of the package
// recorded, the set is "outside today's footprint", d = 0, and the caller says the earlier cuts are
// unknown.
import { describe, expect, it } from 'vitest';
import {
  CUT_BLANK_EDGE_MARGIN_MM,
  CUT_BLANK_MAX_POINTS,
  cutBlankCandidates,
  cutFootprintMask,
  depthRaster,
  flatFloorMask,
  stockRaster,
} from '@/engine/cnc/registration/cutBlank';

const STOCK = { xMin: 0, yMin: 0, xMax: 100, yMax: 60 };
const RASTER = stockRaster(STOCK);
const TIP_R = 0.7;

/** A serpentine fill: parallel G1 lines across x from y0 to y1 at `step`, at Z −depth. */
function fillNc(x0: number, x1: number, y0: number, y1: number, step: number, depth: number): string {
  const lines = ['G90', 'G0 Z5', `G0 X${x0} Y${y0}`, `G1 Z${-depth} F100`];
  let y = y0;
  for (let i = 0; y <= y1 + 1e-9; i++, y += step) {
    lines.push(`G1 X${i % 2 === 0 ? x1 : x0} Y${y} F300`);
  }
  lines.push('G0 Z5');
  return lines.join('\n');
}

const at = (raster: typeof RASTER, x: number, y: number): number =>
  Math.floor((y - STOCK.yMin) / raster.pitchMm) * raster.nx + Math.floor((x - STOCK.xMin) / raster.pitchMm);

describe('#1179 the depth of a finished program’s floor', () => {
  it('gives the deepest cutting move within the cutter radius, and 0 where nothing cut', () => {
    const program = { nc: fillNc(20, 80, 30, 30, 10, 2), cutterRadiusMm: 2, finished: true };
    const depth = depthRaster(RASTER, [program], 2);
    expect(depth[at(RASTER, 50, 30)]).toBeCloseTo(2, 6);
    // One radius and a hair away from the line: still the floor; well away: untouched.
    expect(depth[at(RASTER, 50, 31)]).toBeCloseTo(2, 6);
    expect(depth[at(RASTER, 50, 20)]).toBe(0);
  });

  it('marks a floor flat only where every nearby cutting move is at that depth', () => {
    // Two lines within one cutter radius of each other at different depths: the neighbourhood sees
    // both depths, so it is not a flat floor.
    const uneven = {
      nc: fillNc(20, 80, 20, 20, 10, 2) + '\n' + fillNc(20, 80, 22, 22, 10, 3),
      cutterRadiusMm: 2,
      finished: true,
    };
    const depthUneven = depthRaster(RASTER, [uneven], 2);
    const flatUneven = flatFloorMask(RASTER, [uneven], 2, { tipRadiusMm: TIP_R, tipLengthMm: 10 }, depthUneven);
    expect(flatUneven[at(RASTER, 50, 20)]).toBe(0);
    // One uniform fill is flat across its floor.
    const even = { nc: fillNc(20, 80, 20, 40, 1, 2), cutterRadiusMm: 2, finished: true };
    const depthEven = depthRaster(RASTER, [even], 2);
    const flatEven = flatFloorMask(RASTER, [even], 2, { tipRadiusMm: TIP_R, tipLengthMm: 10 }, depthEven);
    expect(flatEven[at(RASTER, 50, 30)]).toBe(1);
    expect(depthEven[at(RASTER, 50, 30)]).toBeCloseTo(2, 6);
  });

  it('a finished program’s floor is known; an unfinished one’s is not', () => {
    const program = { nc: fillNc(20, 80, 20, 40, 1, 2), cutterRadiusMm: 2, finished: false };
    const depth = depthRaster(RASTER, [program], 2);
    expect(depth[at(RASTER, 50, 30)]).toBe(0);
  });
});

describe('#1179 candidate points on a cut blank', () => {
  it('with finished programs: the uncut top first, then flat floors (depth carried)', () => {
    // A finished fill across the middle; the top remains at both ends.
    const program = { nc: fillNc(20, 80, 10, 50, 1, 2), cutterRadiusMm: 2, finished: true };
    const known = cutBlankCandidates({ raster: RASTER, programs: [program], probe: { tipRadiusMm: TIP_R, tipLengthMm: 10 }, fallbackRadiusMm: 2, obstacles: [] });
    expect(known.earlierCutsKnown).toBe(true);
    expect(known.points.length).toBeGreaterThanOrEqual(2);
    // Every top point is outside the filled RECTANGLE grown by the cutter radius; floors carry 2 mm.
    for (const p of known.points) {
      if (p.depthMm === 0) {
        const insideFilled = p.x > 20 - 2 && p.x < 80 + 2 && p.y > 10 - 2 && p.y < 50 + 2;
        expect(insideFilled).toBe(false);
      } else {
        expect(p.depthMm).toBeCloseTo(2, 6);
      }
    }
    expect(known.points[0]!.depthMm).toBe(0);
  });

  it('with nothing recorded: outside today’s footprint, d = 0, and earlier cuts unknown', () => {
    const program = { nc: fillNc(30, 70, 10, 50, 1, 2), cutterRadiusMm: 2, finished: false };
    const unknown = cutBlankCandidates({
      raster: RASTER,
      programs: [program],
      probe: { tipRadiusMm: TIP_R, tipLengthMm: 10 },
      fallbackRadiusMm: 2,
      obstacles: [],
    });
    expect(unknown.earlierCutsKnown).toBe(false);
    expect(unknown.points.length).toBeGreaterThanOrEqual(2);
    for (const p of unknown.points) {
      expect(p.depthMm).toBe(0);
      // Outside the filled band grown by the cutter radius + 1.
      const insideBand = p.x > 30 - 3 && p.x < 70 + 3 && p.y > 10 - 3 && p.y < 50 + 3;
      expect(insideBand).toBe(false);
    }
  });

  it('keeps the 3 mm edge margin and the mount obstacles clear, and spreads the points', () => {
    const points = cutBlankCandidates({
      raster: RASTER,
      programs: [],
      probe: { tipRadiusMm: TIP_R, tipLengthMm: 10 },
      fallbackRadiusMm: 2,
      obstacles: [{ min: [40, 20], max: [60, 40] }],
    }).points;
    expect(points.length).toBeGreaterThanOrEqual(2);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(STOCK.xMin + CUT_BLANK_EDGE_MARGIN_MM);
      expect(p.x).toBeLessThanOrEqual(STOCK.xMax - CUT_BLANK_EDGE_MARGIN_MM);
      expect(p.y).toBeGreaterThanOrEqual(STOCK.yMin + CUT_BLANK_EDGE_MARGIN_MM);
      expect(p.y).toBeLessThanOrEqual(STOCK.yMax - CUT_BLANK_EDGE_MARGIN_MM);
      expect(p.x >= 40 && p.x <= 60 && p.y >= 20 && p.y <= 40).toBe(false);
    }
    // The spread: no two points share a cell, and the list is capped.
    const keys = new Set(points.map((p) => `${p.x},${p.y}`));
    expect(keys.size).toBe(points.length);
    expect(points.length).toBeLessThanOrEqual(CUT_BLANK_MAX_POINTS);
  });

  it('a floor deeper than the tip needs the probe’s body: without it the uncut top only, with a note', () => {
    // The whole top is a 2 mm floor; the probe's tip sticks out 1 mm, so the body enters.
    const deep = { nc: fillNc(0, 100, 0, 60, 1, 2), cutterRadiusMm: 2, finished: true };
    const noBody = cutBlankCandidates({
      raster: RASTER,
      programs: [deep],
      probe: { tipRadiusMm: TIP_R, tipLengthMm: 1 },
      fallbackRadiusMm: 2,
      obstacles: [],
    });
    expect(noBody.points).toEqual([]);
    expect(noBody.floorsRestricted).toContain('body diameter is not recorded');
    const withBody = cutBlankCandidates({
      raster: RASTER,
      programs: [deep],
      probe: { tipRadiusMm: TIP_R, tipLengthMm: 1, bodyDiameterMm: 4 },
      fallbackRadiusMm: 2,
      obstacles: [],
    });
    expect(withBody.points.length).toBeGreaterThanOrEqual(2);
    expect(withBody.points[0]!.depthMm).toBeCloseTo(2, 6);
  });

  it('offers no candidate when the mount’s obstacles leave nothing', () => {
    const points = cutBlankCandidates({
      raster: RASTER,
      programs: [],
      probe: { tipRadiusMm: TIP_R, tipLengthMm: 10 },
      fallbackRadiusMm: 2,
      obstacles: [{ min: [0, 0], max: [100, 60] }],
    }).points;
    expect(points).toEqual([]);
  });
});

describe('#1179 the unknown-cuts footprint', () => {
  it('grows each program by its cutter radius + 1', () => {
    const program = { nc: fillNc(20, 80, 30, 30, 10, 2), cutterRadiusMm: 2, finished: false };
    const mask = cutFootprintMask(RASTER, [program], 2);
    expect(mask[at(RASTER, 50, 30)]).toBe(1);
    expect(mask[at(RASTER, 50, 32.5)]).toBe(1);
    expect(mask[at(RASTER, 50, 40)]).toBe(0);
  });
});
