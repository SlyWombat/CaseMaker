/**
 * #1134 — THE FOOTPRINT INDEX IS THE SAME PREDICATE, POINT FOR POINT.
 *
 * `clSurface`'s guard (even-odd membership + the boundary distance rule) now runs behind a row
 * index. The ruling asks for byte-identical masks: these tests compare the indexed answers with
 * the raw functions — `pointInPolygons` and a verbatim copy of the pre-#1134 `onBoundary` — over
 * fixtures and a dense query grid that includes vertices, edge midpoints, points level with an
 * edge's endpoints, and points outside the bbox. The last test compares a finish mask computed
 * through the surface against one computed through the raw guard, cell for cell.
 */

import { describe, expect, it } from 'vitest';

import { clSurface } from '../../src/engine/cnc/cam/model/clsurface';
import { dropCutterHeight, profileOf } from '../../src/engine/cnc/cam/model/dropcutter';
import type { FeatureSource, RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import { maskCellsExact } from '../../src/engine/cnc/cam/model/finishMask';
import { footprintIndex } from '../../src/engine/cnc/cam/model/footprintIndex';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';
import { pointInPolygons } from '../../src/engine/cnc/engrave/throughMask';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

/** The PRE-#1134 `onBoundary`, kept verbatim as the reference the index must match. */
function referenceOnBoundary(footprint: Polygons, x: number, y: number, eps = 1e-9): boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of footprint) {
    for (const [px, py] of ring) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  if (x < minX - eps || x > maxX + eps || y < minY - eps || y > maxY + eps) return false;
  for (const ring of footprint) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j]!;
      const [x2, y2] = ring[i]!;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
      if (Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= eps) return true;
    }
  }
  return false;
}

const square: Polygons = [
  [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
];
const holed: Polygons = [
  [
    [0, 0],
    [20, 0],
    [20, 12],
    [0, 12],
  ],
  [
    [5, 3],
    [15, 3],
    [15, 9],
    [5, 9],
  ],
];
const triangle: Polygons = [
  [
    [-2, -1],
    [7, 0.5],
    [3, 9],
  ],
];
/** A staircase like `cellPolygons` emits: many short vertical/horizontal edges. */
const staircase: Polygons = (() => {
  const ring: [number, number][] = [];
  const pitch = 0.5;
  for (let i = 0; i < 20; i++) ring.push([i * pitch, (i % 3) * pitch]);
  for (let i = 20; i >= 0; i--) ring.push([i * pitch, (i % 3) * pitch + 2]);
  return [ring];
})();

const fixtures: [string, Polygons][] = [
  ['square', square],
  ['holed', holed],
  ['triangle', triangle],
  ['staircase', staircase],
];

/** A grid that lands on vertices, edge midpoints and level with edge endpoints, plus far points. */
function queryPoints(): [number, number][] {
  const points: [number, number][] = [];
  for (let x = -3; x <= 23; x += 0.5) for (let y = -3; y <= 14; y += 0.5) points.push([x, y]);
  points.push(
    [0, 0], [10, 0], [10, 10], [0, 10],       // vertices
    [5, 0], [10, 5], [5, 10], [0, 5],         // edge midpoints
    [0, 1], [1, 0], [10, 9], [9, 10],         // level with endpoints, inside/outside the run
    [-1e-9, 5], [10 + 1e-9, 5], [5, -1e-9], [5, 10 + 1e-9], // a hair outside the bbox
  );
  return points;
}

describe('#1134 the footprint index', () => {
  it('answers the SAME membership and boundary rule as the raw scan, point for point', () => {
    for (const [name, fixture] of fixtures) {
      const index = footprintIndex(fixture);
      for (const [x, y] of queryPoints()) {
        expect(index.contains(x, y), `${name} contains (${x}, ${y})`).toBe(pointInPolygons(fixture, x, y));
        expect(index.within(x, y), `${name} within (${x}, ${y})`).toBe(referenceOnBoundary(fixture, x, y));
      }
    }
  });

  it('matches the raw rule for explicit eps values too', () => {
    const index = footprintIndex(square);
    for (const eps of [0, 1e-6, 0.01]) {
      for (const [x, y] of queryPoints()) {
        expect(index.within(x, y, eps), `eps ${eps} at (${x}, ${y})`).toBe(referenceOnBoundary(square, x, y, eps));
      }
    }
  });
});

const MESH_MARGIN_MM = 5;

/** A ridged plate: the CL varies across the fixture so the mask has both sides of a band. */
function ridgeMesh(length: number, width: number): FeatureSource {
  const x0 = -MESH_MARGIN_MM;
  const x1 = length + MESH_MARGIN_MM;
  const y0 = -MESH_MARGIN_MM;
  const y1 = width + MESH_MARGIN_MM;
  const columns: number[] = [];
  for (let x = x0; x <= x1 + 1e-9; x += 0.5) columns.push(x);
  const positions: number[] = [];
  for (let i = 0; i < columns.length; i++) {
    const x = columns[i]!;
    const z = i % 4 === 0 ? 0 : -0.8;
    positions.push(x, y0, z, x, y1, z);
  }
  const indices: number[] = [];
  for (let i = 0; i < columns.length - 1; i++) {
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

function plateRegion(length: number, width: number): RemainderRegion {
  return {
    id: 'ridged-plate',
    footprint: [
      [
        [1, 1],
        [length - 1, 1],
        [length - 1, width - 1],
        [1, width - 1],
      ],
    ],
    area: (length - 2) * (width - 2),
    zTop: 0,
    zBottom: -10,
    triangles: new Uint32Array(),
    slopeDeg: [0, 90],
    slopeMedianDeg: 20,
    in: 'top',
  };
}

const ridgeBall: Tool = { ...flatEndMill(2, { number: 1, id: 'ridge-ball', name: 'ridge-ball' }), shape: 'ball' };

describe('#1134 the mask through the indexed surface', () => {
  it('equals the mask through the raw guard, cell for cell', () => {
    const geometry = ridgeMesh(24, 12);
    const region = plateRegion(24, 12);
    const surface = clSurface(geometry, region, ridgeBall, 1);
    const mesh = geometry.triangles;
    const profile = profileOf(ridgeBall)!;
    // The PRE-#1134 guard, verbatim: membership under `pointInPolygons`, boundary under the
    // reference rule, then the same drop-cutter height.
    const rawDrop = (x: number, y: number): number | null =>
      pointInPolygons(region.footprint, x, y) || referenceOnBoundary(region.footprint, x, y)
        ? dropCutterHeight(profile, mesh, x, y)
        : null;
    const ring: [number, number][] = [];
    for (let d = 0; d < 8; d++) {
      const a = (d * Math.PI) / 4;
      ring.push([Math.cos(a) * 1, Math.sin(a) * 1]);
    }
    const leftoverFrom = (drop: (x: number, y: number) => number | null) => (x: number, y: number): boolean => {
      const cl = drop(x, y);
      return cl !== null && cl < -0.4;
    };
    const indexedLeftover = leftoverFrom((x, y) => surface.dropCutter(x, y));
    const rawLeftover = leftoverFrom(rawDrop);
    let checked = 0;
    for (let x = 0; x <= 24; x += 0.25) {
      for (let y = 0; y <= 12; y += 0.25) {
        expect(surface.dropCutter(x, y), `CL at (${x}, ${y})`).toBe(rawDrop(x, y));
        expect(maskCellsExact(indexedLeftover, ring, x, y), `mask at (${x}, ${y})`).toBe(
          maskCellsExact(rawLeftover, ring, x, y),
        );
        checked += 1;
      }
    }
    // The grid must actually exercise both answers, or "equal" would be vacuous.
    expect(checked).toBe(97 * 49);
  });
});
