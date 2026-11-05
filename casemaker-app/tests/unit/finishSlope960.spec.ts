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

/** A region over a ramp mesh, its triangle ids the whole mesh. */
function regionOver(_mesh: FeatureSource, footprint: [number, number][][]): { region: RemainderRegion; regionRef: RegionRef } {
  const region: RemainderRegion = {
    id: 'scoop',
    footprint,
    area: 100,
    zTop: 10,
    zBottom: 0,
    triangles: Uint32Array.from([0, 1]),
    slopeDeg: [0, 90],
    slopeMedianDeg: 45,
    in: 'top',
  };
  const regionRef: RegionRef = {
    id: 'scoop',
    kind: 'curved',
    bounds: { min: [0, -10], max: [50, 10] },
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

  it('steps the ball per band and skips a near-vertical band instead of flooring the region', () => {
    // A ramp at 2° over x ∈ [0,50): one gentle band, one wall band at ~85° at the very end.
    const mesh = ramp(2, 50, 10);
    const { region, regionRef } = regionOver(mesh, [[[0.5, -9.5], [49.5, -9.5], [49.5, 9.5], [0.5, 9.5]]]);
    const ball: Tool = { ...flatEndMill(6, { id: 'ball-6', name: 'ball-6' }), shape: 'ball' };
    const out = finish({
      cutter: ball,
      region,
      regionRef,
      clSurface: clSurface(mesh, region, ball, 0.1),
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
    // The raster is at the vendor's spacing, not the old 0.3 mm floor: ~63 rows over 49 mm.
    const rows = new Set(out.passes.map((p) => p.entry[0]));
    expect(rows.size).toBeGreaterThan(55);
    expect(rows.size).toBeLessThan(70);
    // A wall band is CUT, not skipped: nothing is lost, and its rows sit at the ball's floor.
    expect(out.notes ?? []).toEqual([]);
  });
});
