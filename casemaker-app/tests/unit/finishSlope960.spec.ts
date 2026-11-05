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

  it('steps a gentle region at the scallop spacing its own slope asks for', () => {
    // 2° everywhere, and the region states it: the old step is already 0.8 mm (the vendor's),
    // so no subdivision and no wall — ~61 rows over 49 mm, not the old 0.3 mm floor's 163.
    const { rows, notes } = rowsOver(2, [0, 2]);
    expect(rows.length).toBeGreaterThan(55);
    expect(rows.length).toBeLessThan(70);
    expect(notes).toEqual([]);
  });

  it('keeps every old row and only ADDS rows — a band is the old step divided by a whole number', () => {
    // A 64° band inside a region whose stated range tops out at 25° — the tray's centre-slot
    // shape: the region's own triangles are gentle, the ball bridges the mouth and the CL reads
    // vertical there. The old region-wide step is the 25° one (~0.69 mm); the band asks for the
    // 0.3 mm floor, so the old step is split in three — every old row keeps its exact phase, the
    // finer rows only go BETWEEN them (the manager's no-coverage-loss rule of 2026-11-05).
    const cos = Math.cos((25 * Math.PI) / 180);
    const OLD = cos * 2 * Math.sqrt(2 * 3 * 0.027 * cos - (0.027 * cos) ** 2); // the old step
    expect(OLD).toBeGreaterThan(0.3);
    const { rows, notes } = rowsOver(64, [0, 25]);
    const ORIGIN = 1e-4; // region bounds min x (0) + finish's X_NUDGE_MM
    for (let k = 0; ORIGIN + k * OLD <= 49.5; k++) {
      if (ORIGIN + k * OLD < 0.5) continue; // no footprint interval before the first row
      expect(rows.some((x) => Math.abs(x - (ORIGIN + k * OLD)) < 1e-9), `old row ${k} at ${(ORIGIN + k * OLD).toFixed(4)}`).toBe(true);
    }
    const gaps = rows.slice(1).map((x, i) => x - rows[i]!);
    for (const gap of gaps) {
      const n = OLD / gap;
      expect(Math.abs(n - Math.round(n)), `gap ${gap.toFixed(6)} is not oldStep/whole`).toBeLessThan(1e-6);
    }
    expect(Math.min(...gaps)).toBeLessThan(OLD - 1e-9); // a finer band really did add rows
    expect(notes).toEqual([]); // 64° is not a wall
  });
});
