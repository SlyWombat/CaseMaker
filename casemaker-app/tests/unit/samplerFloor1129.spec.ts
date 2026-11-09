/**
 * #1129 — THE ROW SAMPLER'S FLOOR, RED-FIRST.
 *
 * Before this, `clSurface()` handed the row dropper the CHORD TOLERANCE (0.005 mm) as its minimum
 * spacing: an acceptance number used as a sampling floor. A finish row then subdivided to 5 µm at
 * every kink — the #1129 profile measured 1.72 M drop-cutter queries and 1.42 B edge-search
 * evaluations in 72 s on a 59 mm plate, and the plate did not plan in an hour.
 *
 * The floor is now a sampling spacing: `min(step-over / 10, 0.05 mm)`, never below the chord
 * tolerance, and a job may state `surface.minSpacingMm`. These tests are COUNTER-BASED (no wall
 * clock): a row over a fine-toothed rim fixture is walked at the derived floor and at the old
 * 0.005 mm floor, and the drop-cutter query counts are compared — the old floor costs > 3× the
 * queries on the same row, which is the defect this pins.
 */

import { describe, expect, it } from 'vitest';

import { MIN_SAMPLE_SPACING_CAP_MM, clSurface, minSampleSpacingFor } from '../../src/engine/cnc/cam/model/clsurface';
import { dropRow } from '../../src/engine/cnc/cam/model/rowDropper';
import { ARC_CHORD_TOLERANCE_MM } from '../../src/engine/compiler/arcResolution';
import type { FeatureSource, RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

const MESH_MARGIN_MM = 10;

/** A row of rims: alternating ridge/valley columns every `period` mm (a fine-toothed plate). */
function sawtooth(length: number, half: number, period: number, amplitude: number): FeatureSource {
  const x0 = -MESH_MARGIN_MM;
  const x1 = length + MESH_MARGIN_MM;
  const y0 = -half - MESH_MARGIN_MM;
  const y1 = half + MESH_MARGIN_MM;
  const cols: number[] = [];
  for (let x = x0; x <= x1 + 1e-9; x += period) cols.push(x);
  const positions: number[] = [];
  for (let i = 0; i < cols.length; i++) {
    const x = cols[i]!;
    const z = i % 2 === 0 ? 0 : -amplitude;
    positions.push(x, y0, z, x, y1, z);
  }
  const indices: number[] = [];
  for (let i = 0; i < cols.length - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, b, c, b, d, c);
  }
  const zs = positions.filter((_, k) => k % 3 === 2);
  return {
    triangles: {
      positions: Float32Array.from(positions),
      indices: Uint32Array.from(indices),
      triangleCount: indices.length / 3,
      bbox: { min: [x0, y0, Math.min(...zs)], max: [x1, y1, Math.max(...zs)] },
    },
  };
}

function region(half: number, length: number): RemainderRegion {
  const pad = 0.5;
  return {
    id: 'rimmed-row',
    footprint: [[[-pad, -half - pad], [length + pad, -half - pad], [length + pad, half + pad], [-pad, half + pad]]],
    area: length * 2 * half,
    zTop: 0,
    zBottom: -100,
    triangles: new Uint32Array(),
    slopeDeg: [0, 90],
    slopeMedianDeg: 45,
    in: 'top',
  };
}

const toothBall: Tool = { ...flatEndMill(0.5, { number: 1, id: 'tooth-ball', name: 'tooth-ball' }), shape: 'ball' };

describe('#1129 the derived sample floor', () => {
  it('derives min(step-over / 10, 0.05 mm), floored at the chord tolerance', () => {
    // A 1 mm raster pitch: a tenth of it is 0.1 mm, capped at the stated 0.05 mm.
    expect(minSampleSpacingFor(1)).toEqual({ mm: MIN_SAMPLE_SPACING_CAP_MM, source: 'derived', fromStepOverMm: 1 });
    // A 0.2 mm pitch: a tenth (0.02 mm) is below the cap and above the tolerance — used as is.
    expect(minSampleSpacingFor(0.2).mm).toBeCloseTo(0.02, 12);
    // A very fine pitch never goes below the chord tolerance.
    expect(minSampleSpacingFor(0.02).mm).toBeCloseTo(ARC_CHORD_TOLERANCE_MM, 12);
    // A stated value wins, still floored at the tolerance.
    expect(minSampleSpacingFor(1, 0.5)).toEqual({ mm: 0.5, source: 'stated', fromStepOverMm: 1 });
    expect(minSampleSpacingFor(1, 0.001).mm).toBeCloseTo(ARC_CHORD_TOLERANCE_MM, 12);
  });

  it('bounds the drop-cutter queries on a rimmed row — the old 0.005 mm floor costs > 3× the same row', () => {
    const geometry = sawtooth(20, 4, 0.2, 0.3);
    const reg = region(4, 20);
    // The plan's own surface for a 1 mm step-over: the derived floor.
    const derived = clSurface(geometry, reg, toothBall, 1);
    expect(derived.minSpacingMm).toBeCloseTo(MIN_SAMPLE_SPACING_CAP_MM, 12);
    expect(derived.minSpacingSource).toBe('derived');
    dropRow(derived, [0, 0], [20, 0]);
    const derivedQueries = derived.sampleCount;
    // The SAME row with the old floor stated explicitly (0.005 mm = the chord tolerance): the
    // defect #1129 measured, reproduced in a counter rather than a stopwatch.
    const oldFloor = clSurface(geometry, reg, toothBall, 1, ARC_CHORD_TOLERANCE_MM);
    expect(oldFloor.minSpacingSource).toBe('stated');
    dropRow(oldFloor, [0, 0], [20, 0]);
    const oldQueries = oldFloor.sampleCount;
    expect(derivedQueries).toBeLessThanOrEqual(1200);
    expect(oldQueries).toBeGreaterThan(3000);
    expect(oldQueries).toBeGreaterThan(derivedQueries * 3);
  });

  it('a stated surface.minSpacingMm overrides the derivation', () => {
    const surface = clSurface(sawtooth(10, 4, 0.2, 0.3), region(4, 10), toothBall, 1, 0.03);
    expect(surface.minSpacingMm).toBeCloseTo(0.03, 12);
    expect(surface.minSpacingSource).toBe('stated');
    expect(surface.minSpacingFromStepOverMm).toBe(1);
  });
});
