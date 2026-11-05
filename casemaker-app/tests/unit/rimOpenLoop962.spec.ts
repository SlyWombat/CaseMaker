/**
 * #962 — RED-FIRST, THE ORGANIZER'S 77 mm GROOVE.
 *
 * E's render set found the organizer posting a 77.2 mm lateral FEED at a constant chamfer depth,
 * `G1` from (26.465, 88.947, −1.300) to (81.053, 143.535, −1.300) — dx = dy = 54.588 mm. It is not
 * a `link()` defect: `link()` never emits a lateral feed (its horizontal leg is always a rapid;
 * only its vertical legs feed). It is `findRims`' own edge-chaining (`features/rims.ts`'s `chain`)
 * leaving a complex rim's loop OPEN — a branch point in the sharp floor|wall graph took the wrong
 * one of several unused edges — and `cam/model/ops/chamfer.ts`'s `closedRing()` not knowing the
 * difference: it closes ANY polyline whose own first and last point do not already coincide with
 * one more straight point, bridging whatever lies between them. Confirmed on the real organizer
 * mesh (`_diagRimDump962.spec.ts`, not committed): rim `rim-5`'s own closing segment is
 * `(-3.911, 58.500) -> (-58.500, 3.911)`, length 77.20 mm, dx = dy = 54.59 — the same move, same
 * numbers, in the recognition frame.
 *
 * This fixture reproduces it directly: a POCKET rim (the real rim-5 is `of: "pocket-16"`, not the
 * contour) whose polyline is intentionally OPEN by 77.2 mm (`chain()`'s own real gap), fed through
 * `planCurvedForTree`'s rim loop exactly as the organizer's rim would be. RED (before the fix): the
 * posted chamfer program contains that 77.2 mm lateral feed at depth. GREEN (after): the rim is
 * refused with a stated note, no moves posted for it, and the SET of posted chamfer feeds move no
 * more than a few mm laterally, the real bevel's own width.
 *
 * THE GUARD IS SCOPED TO POCKET RIMS. A pocket encloses a cavity, so its rim must close; the
 * CONTOUR (the outer silhouette) may legitimately run open to the stock's own edge — confirmed on
 * `buildRandomPart`'s own fixture (`#962 property`, below): EVERY synthetic kind and seed carries
 * a genuine 8 mm open contour rim, the "shoulder open to the +X edge" cut, (20, −4) → (20, 4). A
 * contour rim is left to `closedRing()`'s existing bridge either way: closing a short, already-
 * on-its-own-line segment like that one retraces real geometry, it does not cross open ground.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import { planCurvedForTree } from '../../src/engine/cnc/cam/model/plan';
import type { FeatureTree, Rim } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';
import { buildRandomPart, type PartKind } from '../tools/randomParts';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const flat: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const ball: Tool = { ...flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose' };
const vbit: Tool = flatEndMill(3.175, { number: 3, id: 'v90', name: '90 chamfer', shape: 'chamfer', typeText: 'Chamfer', angle: 90, halfAngle: 45, tipDiameter: 0.1 });

// The exact proven exposure fixture (`planZRebase959.spec.ts`'s `rampAtStockTop`): a ramp from the
// rim's own Z down to a low floor, margin past the footprint held at the SAME low floor rather
// than continuing the slope — the fix that fixture itself needed to read as genuinely exposed.
const STOCK_TOP = 10;
const X0 = 2, X1 = 42, Y0 = -12, Y1 = 12;
const Z_LOW = -10;

function rampTree(rims: Rim[]): { tree: FeatureTree; geometry: { triangles: { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } } } {
  const MX0 = -10, MX1 = 50, MY0 = -20, MY1 = 20;
  const footprint: Polygons = [[[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]]];
  const geometry = {
    triangles: {
      positions: Float32Array.from([
        MX0, MY0, Z_LOW, MX1, MY0, Z_LOW, MX1, MY1, Z_LOW,
        MX0, MY0, Z_LOW, MX1, MY1, Z_LOW, MX0, MY1, Z_LOW,
      ]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      triangleCount: 2,
      bbox: { min: [MX0, MY0, Z_LOW] as [number, number, number], max: [MX1, MY1, STOCK_TOP] as [number, number, number] },
    },
  };
  const tree: FeatureTree = {
    frame: { up: [0, 0, 1], stockTop: STOCK_TOP, partTop: STOCK_TOP, partBottom: Z_LOW },
    levels: [Z_LOW],
    top: { z: STOCK_TOP, floors: [], area: 0 },
    contour: { outline: footprint, area: (X1 - X0) * (Y1 - Y0), zTo: Z_LOW, frees: true, shoulders: [] },
    pockets: [],
    rims,
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: (X1 - X0) * (Y1 - Y0), remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
  return { tree, geometry };
}

// The organizer's own rim-5 rectangle corners, plus the EXACT gap its own closing segment left:
// dx = dy = 54.588 mm, 77.20 mm direct. Both rims below share these same four real corners
// (a valid rim on the ramp's own footprint, proven exposed by `rampAtStockTop`'s own fixture) —
// they differ only in whether the polyline's own last point returns home or strays by that gap.
const CORNERS: [number, number][] = [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]];
const GAP_XY = 54.588;

describe('#962 — an open rim loop is refused, never bridged with a straight phantom cut', () => {
  it('a rim 77.2 mm open (the organizer\'s own gap) posts no chamfer moves, and is named in the notes', () => {
    const openRim: Rim = {
      id: 'rim-5',
      // The organizer's own failure mode: the chain never returns to its own start, so the last
      // point is NOT a closing duplicate — it is 77.2 mm away, dx = dy, same as the real gap.
      polyline: [...CORNERS, [X0 + GAP_XY, Y0 + GAP_XY]],
      z: STOCK_TOP,
      // The real rim-5 belongs to a POCKET ("pocket-16"), not the contour — the guard is scoped
      // to pocket rims exactly because a pocket encloses a cavity and must close; a contour may
      // legitimately run open to the stock edge (the property test below, on `buildRandomPart`'s
      // own "shoulder open to +X" rim).
      of: 'pocket-16',
      kind: 'sharp',
    };
    const first = openRim.polyline[0]!;
    const last = openRim.polyline[openRim.polyline.length - 1]!;
    const openGap = Math.hypot(first[0] - last[0], first[1] - last[1]);
    expect(openGap, 'the fixture must actually be open, by the organizer\'s own measured amount').toBeCloseTo(77.2, 1);

    const { tree, geometry } = rampTree([openRim]);
    const result = planCurvedForTree(tree, {
      geometry, offset: makeClipperOffset(tl), flat, ball, vbit,
      stepDownMm: 1.5, bandMm: 0.3, feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
      rapid: RAPID, spindleRpm: 12000, air: true, safeZMm: 5, hopZMm: 1,
      edgeBreak: { legMm: 0.5 }, toolNumberFor: (t) => t.number ?? 1,
    });

    const chamferOps = result.ops.filter((op) => op.kind === 'chamfer');
    expect(chamferOps, 'an open rim must post no chamfer op at all').toHaveLength(0);
    expect(result.notes.some((n) => n.includes('rim-5') && n.includes('not closed')), `notes: ${result.notes.join(' | ')}`).toBe(true);

    // The universal, real-program form of the same check (the manager's #962 ask): no FEED in
    // ANY posted chamfer op travels anywhere near the organizer's own 77 mm bridge.
    const chamferFeeds = chamferOps.flatMap((op) => op.outcome.ir.operations.flatMap((o) => o.moves)).filter((m) => m.kind === 'feed');
    for (let i = 1; i < chamferFeeds.length; i++) {
      const a = chamferFeeds[i - 1]!, b = chamferFeeds[i]!;
      const lateral = Math.hypot(b.x - a.x, b.y - a.y);
      expect(lateral, `chamfer feed ${i}: ${lateral.toFixed(2)} mm lateral, from (${a.x}, ${a.y}) to (${b.x}, ${b.y})`).toBeLessThan(10);
    }
  });

  it('a genuinely closed rim (first === last) is unaffected: it still posts a chamfer', () => {
    const closedRim: Rim = {
      id: 'rim-closed',
      polyline: [...CORNERS, CORNERS[0]!],
      z: STOCK_TOP,
      of: 'contour',
      kind: 'sharp',
    };
    const { tree, geometry } = rampTree([closedRim]);
    const result = planCurvedForTree(tree, {
      geometry, offset: makeClipperOffset(tl), flat, ball, vbit,
      stepDownMm: 1.5, bandMm: 0.3, feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
      rapid: RAPID, spindleRpm: 12000, air: true, safeZMm: 5, hopZMm: 1,
      edgeBreak: { legMm: 0.5 }, toolNumberFor: (t) => t.number ?? 1,
    });
    const chamferOps = result.ops.filter((op) => op.kind === 'chamfer');
    expect(chamferOps, `notes: ${result.notes.join(' | ')}`).toHaveLength(1);
    const feeds = chamferOps[0]!.outcome.ir.operations.flatMap((o) => o.moves).filter((m) => m.kind === 'feed');
    expect(feeds.length).toBeGreaterThan(0);
  });
});

// A property check on the real Manifold kernel's own rim recognition: every rim `findRims`
// returns on a genuinely closed solid must itself already be closed, within float noise of the
// mesh — not "closed, so my own guard is a no-op" by assumption, but asserted directly, seed by
// seed, so a future regression in `chain()`'s own stitching shows up here before it reaches a
// real part. `rectilinear`/`filleted` are the kinds with real rims (a flat contour plus pockets).
const RIM_KINDS: PartKind[] = ['rectilinear', 'filleted'];
const RIM_SEEDS = [1, 2, 3, 4, 5];

describe('#962 property — every recognised POCKET rim on a real random part is already closed', () => {
  for (const kind of RIM_KINDS) {
    for (const seed of RIM_SEEDS) {
      it(`${kind} seed ${seed}: every pocket rim's own first and last point already coincide`, () => {
        const part = buildRandomPart(seed, kind, tl);
        expect(part.tree.rims.length, `${kind} seed ${seed}: the fixture must actually carry rims`).toBeGreaterThan(0);
        // CONTOUR rims are exempt (see plan.ts's own comment): the outer silhouette can
        // legitimately run open to the stock's own edge — `buildRandomPart`'s own "shoulder open
        // to +X" fixture is exactly this, on every kind and seed, not a chain() defect.
        const pocketRims = part.tree.rims.filter((r) => r.of !== 'contour');
        expect(pocketRims.length, `${kind} seed ${seed}: the fixture must actually carry pocket rims`).toBeGreaterThan(0);
        for (const rim of pocketRims) {
          const first = rim.polyline[0]!;
          const last = rim.polyline[rim.polyline.length - 1]!;
          const gap = Math.hypot(first[0] - last[0], first[1] - last[1]);
          expect(gap, `${kind} seed ${seed}: pocket rim "${rim.id}" is open by ${gap.toFixed(4)} mm`).toBeLessThan(0.01);
        }
      });
    }
  }
});
