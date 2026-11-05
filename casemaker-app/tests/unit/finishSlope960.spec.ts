/**
 * #960 — THE TWO LEVERS, RED-FIRST.
 *
 * 1. Flat vs ball is chosen by the REGION'S OWN SLOPE against a stated threshold (a parameter),
 *    not by the sequence slot — `finishKindFor`.
 * 2. The ball's step-over comes from the scallop height (0.027 mm, the vendor's 0.8 mm step-over
 *    on the same ⌀6 ball), evaluated PER BAND from that band's own slope; one near-vertical facet
 *    no longer floors the whole region, and a wall band is skipped with a stated note.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_FINISH_SCALLOP_MM, finish, finishKindFor } from '../../src/engine/cnc/cam/model/ops/finish';
import { flatSurfaceMaxSlopeDeg } from '../../src/engine/cnc/cam/model/settings';
import { clSurface } from '../../src/engine/cnc/cam/model/clsurface';
import type { FeatureSource, RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import type { RegionRef } from '../../src/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

/** Two flat triangles over [0,len]×[-h,h] with the slope `deg` (a plane). */
function ramp(deg: number, len: number, half: number): FeatureSource {
  const s = Math.tan((deg * Math.PI) / 180);
  const x1 = len;
  const z1 = s * x1;
  return {
    triangles: {
      positions: Float32Array.from([0, -half, 0, x1, -half, z1, x1, half, z1, 0, -half, 0, x1, half, z1, 0, half, 0]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      triangleCount: 2,
      bbox: { min: [0, -half, 0], max: [x1, half, z1] },
    },
  };
}

/** A region over a ramp mesh, its triangle ids the whole mesh; `slopeDeg` is the region's own
 * [gentlest, steepest] reading, which the old region-wide raster step comes from. */
function regionOver(_mesh: FeatureSource, footprint: [number, number][][], slopeDeg: [number, number] = [0, 90]): { region: RemainderRegion; regionRef: RegionRef } {
  const region: RemainderRegion = {
    id: 'scoop',
    footprint,
    area: 100,
    zTop: 10,
    zBottom: 0,
    triangles: Uint32Array.from([0, 1]),
    slopeDeg,
    slopeMedianDeg: 45,
    in: 'top',
  };
  const regionRef: RegionRef = {
    id: 'scoop',
    kind: 'curved',
    bounds: { min: [0.5, -10], max: [49.5, 10] },
    topZ: 10,
    bottomZ: 0,
    obstacles: [],
    regionClearanceZ: 12,
  };
  return { region, regionRef };
}

describe('#960 finishing by slope — the two levers', () => {
  it('measures the vendor’s own number: a ⌀6 ball at a 0.027 mm scallop steps 0.8 mm', () => {
    expect(DEFAULT_FINISH_SCALLOP_MM).toBe(0.027);
    // s = 2·√(2Rh − h²) at R = 3 mm: 0.7998… — Makera's own 0.8 mm step-over.
    const step = 2 * Math.sqrt(2 * 3 * 0.027 - 0.027 * 0.027);
    expect(step).toBeCloseTo(0.8, 2);
  });

  it('chooses the flat by AREA under the threshold, not by the sequence slot', () => {
    const flatMesh = ramp(1, 50, 10); // 1° everywhere
    const { region } = regionOver(flatMesh, [[[0, -10], [50, -10], [50, 10], [0, 10]]]);
    expect(finishKindFor(region, flatMesh.triangles, flatSurfaceMaxSlopeDeg())).toBe('flat-raster');
    // 10° everywhere: well past the equal-cusp threshold, so the ball takes it.
    const steepMesh = ramp(10, 50, 10);
    expect(finishKindFor(region, steepMesh.triangles, flatSurfaceMaxSlopeDeg())).toBe('ball-scallop');
    // The threshold is a PARAMETER: at 12° the same 10° region admits the flat.
    expect(finishKindFor(region, steepMesh.triangles, 12)).toBe('flat-raster');
  });

  const BALL: Tool = { ...flatEndMill(6, { id: 'ball-6', name: 'ball-6' }), shape: 'ball' };
  const FOOTPRINT: [number, number][][] = [[[0.5, -9.5], [49.5, -9.5], [49.5, 9.5], [0.5, 9.5]]];

  /** Every raster row's x over a `deg` ramp whose region carries `slopeDeg`. */
  function rowsOver(deg: number, slopeDeg: [number, number]): { rows: number[]; notes: string[] } {
    const mesh = ramp(deg, 50, 10);
    const { region, regionRef } = regionOver(mesh, FOOTPRINT, slopeDeg);
    const out = finish({
      cutter: BALL,
      region,
      regionRef,
      clSurface: clSurface(mesh, region, BALL, 0.1),
      kind: 'ball-scallop',
      mesh: mesh.triangles,
      scallopMm: DEFAULT_FINISH_SCALLOP_MM,
      stepDownMm: 10,
      feeds: { feedMmPerMin: 600, plungeFeedMmPerMin: 200 },
      safeZMm: 12,
      hopZMm: 11,
      toolNumber: 1,
      spindleRpm: 10000,
      air: true,
      rapid: { xyMmPerMin: 3000, zMmPerMin: 1200, accelMmPerS2: 1000 } as never,
    });
    return {
      rows: [...new Set(out.passes.map((p) => p.entry[0]))].sort((a, b) => a - b),
      notes: out.notes ?? [],
    };
  }

  it('steps a gentle region at the vendor’s spacing — 0.8 mm, from the origin row', () => {
    // 2° everywhere: the band's own scallop step at the 0.027 mm target is the vendor's 0.8 mm.
    const { rows, notes } = rowsOver(2, [0, 2]);
    const ORIGIN = 0.5 + 1e-4; // the region's bounds min + finish's X_NUDGE_MM
    expect(rows[0]).toBeCloseTo(ORIGIN, 9); // the k = 0 row — the one the rewrite dropped
    expect(rows.length).toBeGreaterThan(55);
    expect(rows.length).toBeLessThan(70);
    const vendorStep = 2 * Math.sqrt(2 * 3 * DEFAULT_FINISH_SCALLOP_MM - DEFAULT_FINISH_SCALLOP_MM ** 2); // ≈ 0.803 mm
    // The band's slope is read off the CL surface (1.7° here, a hair off the triangle's 2°), so
    // the spacing lands within 1 % of the closed form at the stated slope.
    for (const gap of rows.slice(1).map((x, i) => x - rows[i]!)) expect(Math.abs(gap / vendorStep - 1)).toBeLessThan(0.01);
    expect(notes).toEqual([]);
  });

  it('steps each band by its own scallop step, phased from the origin — nothing is skipped', () => {
    // A 64° band inside a region stated at 25°: the ball's closed form is below its radius/10
    // floor there, so every row after the origin one advances by that floor (0.3 mm).
    const { rows, notes } = rowsOver(64, [0, 25]);
    const ORIGIN = 0.5 + 1e-4;
    expect(rows[0]).toBeCloseTo(ORIGIN, 9); // the origin row is cut, always
    for (const gap of rows.slice(1).map((x, i) => x - rows[i]!)) expect(gap).toBeCloseTo(0.3, 6);
    expect(notes).toEqual([]); // 64° is not a wall
  });
});
