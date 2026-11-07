/**
 * #960 — THE CHAMFER OP, RED-FIRST: a sharp-rim box.
 *
 * A square box's rim (z = 0, the stock top) chamfered with a 90° V by the job's stated edge break
 * (leg 0.5 mm): the tip plane must be at −0.5 (the bevel's bottom), the tool's centre one TIP
 * RADIUS outside the box's outline, and no feed below the stated depth. A MODELLED-chamfer rim is
 * cut by the same job figure, and a non-cone cutter is refused by name.
 */

import { describe, expect, it } from 'vitest';

import { chamfer } from '../../src/engine/cnc/cam/model/ops/chamfer';
import type { Rim } from '../../src/engine/cnc/cam/model/features';
import type { RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import type { OffsetFn, Polygons } from '../../src/engine/cnc/cam/pocket';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import { tl } from './helpers/manifoldExec';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const PARAMS = { rpm: 12000, feed: 900, plungeFeed: 250, stepDown: 1, stepOver: 0.5, peck: 0, air: true };
const V90: Tool = flatEndMill(3.175, {
  number: 1, id: 'v90', name: '90° chamfer', shape: 'chamfer', typeText: 'Chamfer',
  angle: 90, halfAngle: 45, tipDiameter: 0.1, diameter: 3.175,
});
const TIP_RADIUS = 0.05;
const HALF = 10;

const ring: [number, number][] = [
  [-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF], [-HALF, -HALF],
];

function rimOf(kind: Rim['kind']): Rim {
  return {
    id: kind === 'sharp' ? 'box-rim' : 'box-rim-modelled',
    polyline: ring,
    z: 0,
    of: 'contour',
    kind,
    ...(kind === 'modelledChamfer' ? { legs: [0.5, 0.5] as [number, number] } : {}),
  };
}

const regionRef: RegionRef = {
  id: 'contour', kind: 'contour',
  bounds: { min: [-HALF, -HALF], max: [HALF, HALF] },
  topZ: 0, bottomZ: -5, obstacles: [], regionClearanceZ: 5,
};

describe('#960 chamfer — the sharp-rim box', () => {
  it('cuts the stated leg at the bevel’s bottom, one tip radius off the edge on the air side', () => {
    for (const kind of ['sharp', 'modelledChamfer'] as const) {
      const out = chamfer({
        cutter: V90,
        rim: rimOf(kind),
        region: regionRef,
        edgeBreak: { legMm: 0.5 },
        offset: makeClipperOffset(tl),
        params: PARAMS,
        rapid: RAPID,
      });
      const moves = out.ir.operations[0]!.moves;
      expect(moves.length).toBeGreaterThan(0);
      const feeds = moves.filter((m) => m.kind === 'feed');
      expect(feeds.length).toBeGreaterThan(4);
      for (const m of feeds) {
        // The tip plane is the bevel's bottom: -leg, and never deeper.
        expect(m.z).toBeCloseTo(-0.5, 6);
        // The path is one TIP RADIUS outside the box outline on the air side: the sides at
        // HALF + tipRadius, the (round-join) corners on a circle of that radius about the corner.
        const edge = Math.max(Math.abs(m.x), Math.abs(m.y));
        expect(edge).toBeLessThanOrEqual(HALF + TIP_RADIUS + 1e-6);
        expect(edge).toBeGreaterThanOrEqual(HALF + TIP_RADIUS * Math.SQRT1_2 - 1e-6);
      }
    }
  });

  it('caps the leg at the cone’s own reach and refuses a non-cone cutter', () => {
    // A leg deeper than the cone's own flank reaches is cut to the cone's leg:
    // (outerRadius − tipRadius) / tan(halfAngle) = (1.5875 − 0.05) / 1 = 1.5375 mm.
    const out = chamfer({
      cutter: V90, rim: rimOf('sharp'), region: regionRef,
      edgeBreak: { legMm: 5 }, offset: makeClipperOffset(tl), params: PARAMS, rapid: RAPID,
    });
    const zs = out.ir.operations[0]!.moves.filter((m) => m.kind === 'feed').map((m) => m.z);
    expect(Math.min(...zs)).toBeCloseTo(-1.5375, 6);
    expect(() =>
      chamfer({
        cutter: flatEndMill(3, { id: 'flat-3', name: 'flat-3' }), rim: rimOf('sharp'), region: regionRef,
        edgeBreak: { legMm: 0.5 }, offset: makeClipperOffset(tl), params: PARAMS, rapid: RAPID,
      }),
    ).toThrow(/not a cone/);
  });
});

describe('#959 review — chamfer() falls back only to the point-tipped path, never the material side', () => {
  it('when the air-side offset empties, the path is the raw ring — never an offset taken on the material side', () => {
    // THE REAL RIMS FOUND THIS (9187f41a): a rim whose own width is under the tip radius offsets
    // EMPTY on the air side. The first fix tried the OTHER side next — the MATERIAL side, where
    // the tool's centre runs INTO the part, a gouge up to one tip radius deep. This fake offset
    // simulates exactly that: empty on the air side (positive delta, `airSign` is +1 for a
    // 'contour' rim), a detectable (and clearly WRONG) shape on the material side (negative).
    const materialSideShape: Polygons = [[[0, 0], [1, 0], [1, 1], [0, 1]]];
    const fallbackProneOffset: OffsetFn = (_region, delta) => (delta > 0 ? [] : materialSideShape);
    const out = chamfer({
      cutter: V90, rim: rimOf('sharp'), region: regionRef,
      edgeBreak: { legMm: 0.5 }, offset: fallbackProneOffset, params: PARAMS, rapid: RAPID,
    });
    const feeds = out.ir.operations[0]!.moves.filter((m) => m.kind === 'feed');
    expect(feeds.length).toBeGreaterThan(0);
    // The ring's own vertices sit at ±HALF (10); the fake material-side shape's sit at 0/1 — easy
    // to tell apart. The point-tipped path is the ring ITSELF (no offset at all).
    for (const m of feeds) {
      const edge = Math.max(Math.abs(m.x), Math.abs(m.y));
      expect(edge, `(${m.x}, ${m.y}) looks like the material-side fallback shape, not the point-tipped ring`).toBeCloseTo(HALF, 6);
    }
  });
});
