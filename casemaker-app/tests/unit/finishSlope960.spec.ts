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
import { FLAT_SURFACE_MAX_SLOPE_DEG } from '../../src/engine/cnc/cam/model/settings';
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
    expect(finishKindFor(region, flatMesh.triangles, FLAT_SURFACE_MAX_SLOPE_DEG)).toBe('flat-raster');
    // 10° everywhere: well past the equal-cusp threshold, so the ball takes it.
    const steepMesh = ramp(10, 50, 10);
    expect(finishKindFor(region, steepMesh.triangles, FLAT_SURFACE_MAX_SLOPE_DEG)).toBe('ball-scallop');
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

  it('coarsens a gentle band to the vendor’s spacing on a straight CL — 0.8 mm from the origin row', () => {
    // A 2° ramp inside a region stated at 25°: the old region-wide step is the 25° one (~0.69 mm)
    // and the band's own scallop step is ~0.80 mm — coarser, and the CL is straight, so the rows
    // ride the vendor spacing, phased from the origin.
    const cos = Math.cos((25 * Math.PI) / 180);
    const oldStep = cos * 2 * Math.sqrt(2 * 3 * 0.027 * cos - (0.027 * cos) ** 2);
    const { rows, notes } = rowsOver(2, [0, 25]);
    const ORIGIN = 0.5 + 1e-4; // the region's bounds min + finish's X_NUDGE_MM
    expect(rows[0]).toBeCloseTo(ORIGIN, 9); // the k = 0 row — the one the rewrite dropped
    const vendorStep = 2 * Math.sqrt(2 * 3 * DEFAULT_FINISH_SCALLOP_MM - DEFAULT_FINISH_SCALLOP_MM ** 2); // ≈ 0.803 mm
    expect(vendorStep).toBeGreaterThan(oldStep);
    // The band's slope is read off the CL surface (1.7° here, a hair off the triangle's 2°), so
    // the spacing lands within 1 % of the closed form at the stated slope.
    for (const gap of rows.slice(1).map((x, i) => x - rows[i]!)) expect(Math.abs(gap / vendorStep - 1)).toBeLessThan(0.01);
    expect(notes).toEqual([]);
  });

  it('cuts an 85° wall band at the radius/10 floor and says so — cut, not skipped', () => {
    // F's review case: a band over WALL_SKIP_DEG keeps rows at the ball's own 0.30 mm floor, the
    // row AT the origin is still first, and the op states the fact in its note.
    const { rows, notes } = rowsOver(85, [0, 85]);
    const ORIGIN = 0.5 + 1e-4;
    expect(rows[0]).toBeCloseTo(ORIGIN, 9);
    for (const gap of rows.slice(1).map((x, i) => x - rows[i]!)) expect(gap).toBeCloseTo(0.3, 6);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('walls steeper than 80°');
    expect(notes[0]).toContain('cut, not skipped');
  });

  it('steps a straight finer band at its own scallop step — the guard only fires on a kinked CL', () => {
    // A 64° band inside a region stated at 25°: the band's closed form is below its radius/10
    // floor (0.3 mm), finer than the old ~0.69 mm step. The CL across a plane is straight, so the
    // band rides its own 0.3 mm rows; the old-row fallback is for the gaps where the CL kinks
    // (a rim), and the wall-band spec below pins that side.
    const { rows, notes } = rowsOver(64, [0, 25]);
    const ORIGIN = 0.5 + 1e-4;
    expect(rows[0]).toBeCloseTo(ORIGIN, 9); // the origin row is cut, always
    for (const gap of rows.slice(1).map((x, i) => x - rows[i]!)) expect(gap).toBeCloseTo(0.3, 6);
    expect(notes).toEqual([]); // 64° is not a wall
  });
});
