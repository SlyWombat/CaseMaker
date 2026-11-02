// Issue #908 — THE BANDED, CAPPED DISTANCE FIELD.
//
// `planAdaptive`'s measuring arrays were whole-grid Float64Arrays; the largest level's transform
// transients are most of a planner's peak memory (#881 measured 81–128 MB per planner on a
// 1.9 M-cell level). The transform is now computed in bands with a `ceil(cap / h) + 1` halo and a
// cap: a feature outside a cell's padded band is farther than the cap from it, so every value
// within the cap is exact, and every consumer compares against a threshold ≤ its cap. These tests
// pin that equality against the whole-grid reference, and pin the guard that refuses a comparison
// made at a threshold the cap cannot answer.

import { describe, expect, it } from 'vitest';

import {
  ArrayByteMeter,
  MaterialGrid,
  RegionGeometry,
  bandRowsFor,
  distanceBand,
  distanceField,
  forEachDistanceBand,
} from '@/engine/cnc/cam/adaptiveGrid';
import { adaptiveSettings, planAdaptive } from '@/engine/cnc/cam/adaptive';
import { flatEndMill } from '@/engine/cnc/tool';

const MI = 4;

/** A patterned feature mask: a border ring plus two blocks, on an nx × ny grid. */
function pattern(nx: number, ny: number): Uint8Array {
  const f = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (i === 1 || j === 2 || i === nx - 3) f[k] = 1;
      if (i > 8 && i < 12 && j > 6 && j < 9) f[k] = 1;
      if ((i * 7 + j * 3) % 29 === 0) f[k] = 1;
    }
  }
  return f;
}
describe('#908 — the banded distance field', () => {
  it('is exact within the cap, on every cell, for several band sizes', () => {
    const nx = 37;
    const ny = 23;
    const h = 0.05;
    const feature = pattern(nx, ny);
    const full = distanceField(feature, nx, ny, h);
    const cap = 0.31;
    for (const bandRows of [1, 3, 7, ny, 64]) {
      const seen = new Uint8Array(nx * ny);
      forEachDistanceBand(feature, nx, ny, h, cap, bandRows, (band) => {
        for (let j = band.row0; j < band.row1; j++) {
          for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            expect(seen[k], 'each cell is visited once').toBe(0);
            seen[k] = 1;
            const truth = full[k]!;
            if (truth <= cap) {
              // Inside the cap the banded value is the whole-grid value, exactly.
              expect(band.distance(k)).toBe(truth);
              for (const t of [0, MI * h, cap / 2, cap]) {
                if (truth <= t) expect(band.within(k, t)).toBe(true);
              }
              if (truth > 0) expect(band.within(k, 0)).toBe(false);
            } else {
              // Past the cap the band knows only that it is farther: a threshold within the cap
              // reads "not reached", and asking for the number is refused.
              expect(band.within(k, cap)).toBe(false);
              expect(() => band.distance(k)).toThrow(/past the band's .* cap/);
            }
          }
        }
      });
      expect(seen.every((v) => v === 1), `every cell seen with bandRows=${String(bandRows)}`).toBe(true);
    }
  });

  it('is exact at every threshold within the cap — the comparison, not just the value', () => {
    const nx = 29;
    const ny = 31;
    const h = 0.08;
    const feature = pattern(nx, ny);
    const full = distanceField(feature, nx, ny, h);
    const cap = 0.5;
    for (const bandRows of [2, 6, 64]) {
      forEachDistanceBand(feature, nx, ny, h, cap, bandRows, (band) => {
        for (let j = band.row0; j < band.row1; j++) {
          for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            for (const t of [h / 2, 3 * h, cap]) {
              expect(band.within(k, t)).toBe(full[k]! <= t);
            }
          }
        }
      });
    }
  });

  it('refuses a comparison the cap cannot answer, and a cell outside the band', () => {
    const nx = 11;
    const ny = 9;
    const h = 0.1;
    const feature = pattern(nx, ny);
    // A deliberately tight cap: the field is exact only up to here, so a larger question is a bug.
    const band = distanceBand(feature, nx, ny, h, 0.2, 2, 5);
    expect(() => band.within(2 * nx + 2, 0.21)).toThrow(/only exact within its cap/);
    expect(() => band.within(2 * nx + 2, 5)).toThrow(/only exact within its cap/);
    expect(() => band.within(2 * nx + 2, 0.1)).not.toThrow();
    // A cell from another band is a caller bug too.
    expect(() => band.within(8 * nx, 0.1)).toThrow(/outside the band/);
    expect(() => distanceBand(feature, nx, ny, h, -1, 0, 2)).toThrow(/cap/);
    expect(() => distanceBand(feature, nx, ny, h, Number.POSITIVE_INFINITY, 0, 2)).toThrow(/cap/);
  });

  it('keeps a band’s memory to its rows plus the halo, whatever the grid height', () => {
    const nx = 40;
    const ny = 4000;
    const h = 0.05;
    const feature = pattern(nx, ny);
    const cap = 0.4; // halo = ceil(0.4 / 0.05) + 1 = 9 rows
    const bandRows = bandRowsFor(9);
    expect(bandRows).toBe(64);
    let visited = 0;
    forEachDistanceBand(feature, nx, ny, h, cap, bandRows, (band) => {
      // Every band is at most its own rows plus the halo on each side — never the whole grid.
      expect(band.row1 - band.row0).toBeLessThanOrEqual(bandRows);
      visited += band.row1 - band.row0;
    });
    expect(visited).toBe(ny);
  });
});

describe('#908 — the consumers’ equality with the whole-grid reference', () => {
  it('setTargetsBanded marks exactly the cells setTargets marks', () => {
    // A square region; the material mask is overwritten with a pattern so the target set is not
    // trivial. `setTargetsBanded` builds its field in bands; the reference is the whole-grid call.
    const region: [number, number][][] = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    ];
    const geom = new RegionGeometry(region);
    for (const h of [0.1, 0.05]) {
      const gridRef = new MaterialGrid(geom, h);
      const gridBand = new MaterialGrid(geom, h);
      const { nx, ny } = gridRef;
      // A deterministic pattern of standing cells (the region's own mask, thinned by a stride).
      const material = new Uint8Array(nx * ny);
      for (let k = 0; k < material.length; k++) if ((k * 13) % 17 !== 0) material[k] = 1;
      gridRef.material.set(material);
      gridBand.material.set(material);
      const allowed = new Uint8Array(nx * ny);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          if (i > 3 && i < nx - 4 && j > 2 && j < ny - 3 && (i + j) % 5 !== 0) allowed[k] = 1;
        }
      }
      gridRef.setTargets(distanceField(allowed, nx, ny, h), 0.4);
      gridBand.setTargetsBanded(allowed, 0.4);
      expect(gridBand.target).toEqual(gridRef.target);
      expect(gridBand.totalTargets).toBe(gridRef.totalTargets);
      expect(gridBand.remainingTargets).toBe(gridRef.remainingTargets);
    }
  });
});

describe('#908 — the planner’s self-reported high-water mark', () => {
  it('meters live, peak and scoped allocations exactly', () => {
    const m = new ArrayByteMeter();
    m.add(100);
    m.add(50);
    expect(m.live).toBe(150);
    expect(m.peak).toBe(150);
    m.release(50);
    m.during(80, () => {
      expect(m.live).toBe(180);
      m.release(0);
    });
    expect(m.live).toBe(100);
    expect(m.peak).toBe(180);
    m.release(100);
    expect(m.live).toBe(0);
  });

  it('reports one level’s typed arrays, and the banding keeps the peak far below the whole grid', () => {
    const region: [number, number][][] = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    ];
    const out = planAdaptive({
      tool: flatEndMill(2),
      region,
      depth: 1,
      settings: adaptiveSettings(null).settings,
    });
    if (!out.ok) throw new Error(out.reason);
    const { gridCells, peakArrayBytes } = out.plan.stats;
    expect(gridCells).toBeGreaterThan(50_000);
    // The persistent arrays alone are ~16 bytes a cell (material, target, allowed, clearance,
    // label, stuck). The whole-grid fields this replaced added ~32 more (two live distance fields
    // plus the transform's transients); the banded planner stays well under that.
    expect(peakArrayBytes).toBeGreaterThan(16 * gridCells);
    expect(peakArrayBytes).toBeLessThan(40 * gridCells);
  });
});
