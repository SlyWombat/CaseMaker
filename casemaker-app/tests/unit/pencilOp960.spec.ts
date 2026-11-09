/**
 * #960 — THE PENCIL OP, RED-FIRST: one pass along a concave crease.
 *
 * The fixture models the tray scoop's floor-to-wall line as a V-groove: the ball's CL height is
 * `|x| + r√2`, a valley along x = 0 — exactly the floor-to-wall junction's crease. A convex edge
 * is the mirror image (`−|x| + C`, a CL ridge) and must produce NO pass: the op is creases only,
 * not a general rest pass (§8's scope line).
 */

import { describe, expect, it } from 'vitest';

import { pencil } from '../../src/engine/cnc/cam/model/ops/pencil';
import type { ClSurface } from '../../src/engine/cnc/cam/model/clsurface';
import type { RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import type { Box2, RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const FEEDS = { feedMmPerMin: 900, plungeFeedMmPerMin: 250 };
const R = 1.5;
const CREASE = R * Math.SQRT2; // the ball's CL height on the groove's bisector
const HALF = 10;

function surfaceOf(f: (x: number) => number): ClSurface {
  return {
    dropCutter: (x, y) => (Math.abs(x) > HALF || Math.abs(y) > HALF ? null : f(x)),
    toleranceMm: 0.01,
    minSpacingMm: 0.1,
    minSpacingSource: 'derived',
    minSpacingFromStepOverMm: 1,
    maxSpacingMm: 0.5,
    sampleCount: 0,
  };
}

const ball: Tool = { ...flatEndMill(3, { number: 1, id: 'ball-3', name: 'ball-3' }), shape: 'ball' };

function regionOf(): { region: RemainderRegion; regionRef: RegionRef } {
  const footprint: [number, number][][] = [[[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF]]];
  const bounds: Box2 = { min: [-HALF, -HALF], max: [HALF, HALF] };
  return {
    region: { id: 'scoop', footprint, area: (2 * HALF) ** 2, zTop: 3, zBottom: 0, triangles: new Uint32Array(), slopeDeg: [30, 60], slopeMedianDeg: 45, in: 'top' },
    regionRef: { id: 'scoop', kind: 'curved', bounds, topZ: 3, bottomZ: 0, obstacles: [], regionClearanceZ: 8 },
  };
}

function opts(clSurface: ClSurface) {
  const { region, regionRef } = regionOf();
  return {
    cutter: ball, region, regionRef, clSurface,
    gridPitchMm: 0.5,
    feeds: FEEDS, safeZMm: 8, hopZMm: 3, toolNumber: 1, spindleRpm: 12000, air: true, rapid: RAPID,
  };
}

describe('#960 pencil — creases only', () => {
  it('a concave crease gets ONE pass along it, at the CL height, nowhere else', () => {
    const out = pencil(opts(surfaceOf((x) => Math.abs(x) + CREASE)));
    expect(out.passes).toHaveLength(1);
    const feeds = out.ir.operations[0]!.moves.filter((m) => m.kind === 'feed');
    expect(feeds.length).toBeGreaterThan(1);
    for (const m of feeds) {
      expect(Math.abs(m.x)).toBeLessThan(1e-9); // the crease line x = 0, and nowhere else
      expect(m.z).toBeCloseTo(CREASE, 6);
    }
    const pass = out.passes[0]!;
    // One pass along the whole line: from one end of the footprint to the other.
    // Detected where both cross-section neighbours exist: the ends sit one grid pitch inside.
    expect(Math.abs(Math.min(pass.entry[1], pass.exit[1]) - -HALF)).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(Math.abs(Math.max(pass.entry[1], pass.exit[1]) - HALF)).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('a second crease chain is entered from ABOVE the hop plane, never diagonally from the last cut', () => {
    // Two parallel valleys (x = ±3): two chains. The manager's review finding on pencil.ts:151-152 —
    // the next chain began with ONE rapid from the previous chain's cut depth to (start, hopZ), a
    // 3-D move a G0 posts as a straight line: a diagonal drag through material. Every move that
    // changes XY must start from a position already lifted to at least the hop plane.
    const out = pencil(opts(surfaceOf((x) => Math.min(Math.abs(x - 3), Math.abs(x + 3)) + CREASE)));
    expect(out.passes.length).toBeGreaterThanOrEqual(2);
    const moves = out.ir.operations[0]!.moves;
    for (let i = 1; i < moves.length; i++) {
      const prev = moves[i - 1]!;
      const m = moves[i]!;
      if (m.kind !== 'rapid') continue;
      const travels = Math.abs(m.x - prev.x) > 1e-9 || Math.abs(m.y - prev.y) > 1e-9;
      if (!travels) continue;
      expect(
        prev.z,
        `move ${i} travels to (${m.x}, ${m.y}) from (${prev.x}, ${prev.y}, ${prev.z}) — below the hop plane ${3}`,
      ).toBeGreaterThanOrEqual(3 - 1e-9);
    }
  });

  it('a convex edge is not a crease: no pass at all', () => {
    const out = pencil(opts(surfaceOf((x) => -Math.abs(x) + 4)));
    expect(out.passes).toHaveLength(0);
    expect(out.ir.operations[0]!.moves).toHaveLength(0);
  });
});
