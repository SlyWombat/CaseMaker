/**
 * #959 review item (8), RED-FIRST: the curved pipeline's ball and V must cut at THEIR OWN
 * resolved feeds/RPM, not the primary flat's.
 *
 * `planCurvedForTree` took one `feeds`/`spindleRpm` pair for rough (the flat), rest (a smaller
 * flat), finish and pencil (the ball) and chamfer (the V) alike — `planModelCam` resolves that
 * pair from the catalogue for the PRIMARY FLAT ONLY (`resolvedCutParams(input, primary)`) and
 * reuses it for every other tool in the job. A ball nose and a V cut at their own diameters and
 * have their own catalogue rows; this fixture gives each tool a visibly different feed/RPM
 * through `cutParamsFor` and checks the posted programs carry the RIGHT one each.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import { planCurvedForTree } from '../../src/engine/cnc/cam/model/plan';
import type { FeatureTree } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { CutParams } from '../../src/engine/cnc/feeds';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const X0 = 2;
const X1 = 42;
const Y0 = -12;
const Y1 = 12;
const FLAT_Z = 0;
// The remainder region's own zTop..zBottom span, above the flat design surface — wider than
// stepDownMm so `depthPasses` gives rough a level ABOVE the leave-band's target to actually cut
// (a span no wider than one step collapses to a single, final level that is always deeper than
// the target and therefore empty by rough's own mask rule).
const STOCK_ABOVE = 3;

const flat: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const ball: Tool = { ...flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose' };
const vbit: Tool = flatEndMill(3.175, { number: 3, id: 'v90', name: '90 chamfer', shape: 'chamfer', typeText: 'Chamfer', angle: 90, halfAngle: 45, tipDiameter: 0.1 });

const FLAT_PARAMS: CutParams = { rpm: 12000, feed: 900, plungeFeed: 250, stepDown: 1.5, stepOver: 3, peck: 0, air: true };
const BALL_PARAMS: CutParams = { rpm: 18000, feed: 600, plungeFeed: 150, stepDown: 1.5, stepOver: 3, peck: 0, air: true };
const VBIT_PARAMS: CutParams = { rpm: 20000, feed: 400, plungeFeed: 120, stepDown: 1.5, stepOver: 3, peck: 0, air: true };

/** A flat plane with one rim, at the stock top — the per-tool feeds, not the Z datum, is this
 * fixture's own point, so it is kept flat and at stockTop = 0 rather than reusing a ramp. */
function flatPlaneWithRim(): { tree: FeatureTree; geometry: { triangles: { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } } } {
  const MX0 = X0 - 10, MX1 = X1 + 10, MY0 = Y0 - 10, MY1 = Y1 + 10;
  const geometry = {
    triangles: {
      positions: Float32Array.from([
        MX0, MY0, FLAT_Z, MX1, MY0, FLAT_Z, MX1, MY1, FLAT_Z,
        MX0, MY0, FLAT_Z, MX1, MY1, FLAT_Z, MX0, MY1, FLAT_Z,
      ]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      triangleCount: 2,
      bbox: { min: [MX0, MY0, FLAT_Z] as [number, number, number], max: [MX1, MY1, FLAT_Z] as [number, number, number] },
    },
  };
  const footprint: Polygons = [[[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]]];
  const rim = {
    id: 'rim-0',
    polyline: [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1], [X0, Y0]] as [number, number][],
    z: FLAT_Z + STOCK_ABOVE, of: 'contour' as const, kind: 'sharp' as const,
  };
  const tree: FeatureTree = {
    frame: { up: [0, 0, 1], stockTop: FLAT_Z + STOCK_ABOVE, partTop: FLAT_Z + STOCK_ABOVE, partBottom: FLAT_Z },
    levels: [FLAT_Z],
    top: { z: FLAT_Z + STOCK_ABOVE, floors: [], area: 0 },
    contour: { outline: footprint, area: (X1 - X0) * (Y1 - Y0), zTo: FLAT_Z, frees: true, shoulders: [] },
    pockets: [],
    rims: [rim],
    remainder: [{
      // A REMAINDER STANDING ABOVE a flat Z = 0 design surface: rough has STOCK_ABOVE's worth of
      // real material to clear down toward CL (0) + the band, which a perfectly flat target at
      // zTop = zBottom would give it none of (rough's own mask test, `target < levelZ`, is never
      // true against a target that sits above every level the region spans).
      id: 'plane', footprint, area: (X1 - X0) * (Y1 - Y0), zTop: FLAT_Z + STOCK_ABOVE, zBottom: FLAT_Z,
      triangles: new Uint32Array(), slopeDeg: [0, 0], slopeMedianDeg: 0, in: 'top',
    }],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: (X1 - X0) * (Y1 - Y0), remainderArea: (X1 - X0) * (Y1 - Y0), tolerances: {} as never, slivers: [], notes: [] },
  };
  return { tree, geometry };
}

function run(cutParamsFor?: (tool: Tool) => CutParams): ReturnType<typeof planCurvedForTree> {
  const { tree, geometry } = flatPlaneWithRim();
  return planCurvedForTree(tree, {
    geometry, offset: makeClipperOffset(tl), flat, ball, vbit,
    stepDownMm: 1.5, bandMm: 0.3,
    feeds: { feedMmPerMin: FLAT_PARAMS.feed, plungeFeedMmPerMin: FLAT_PARAMS.plungeFeed },
    ...(cutParamsFor === undefined ? {} : { cutParamsFor }),
    rapid: RAPID, spindleRpm: FLAT_PARAMS.rpm, air: true, safeZMm: 5, hopZMm: 1,
    edgeBreak: { legMm: 0.5 }, toolNumberFor: (t) => t.number ?? 1,
  });
}

describe('#959 review — the curved pipeline resolves each cutter\'s OWN feeds, not the flat\'s', () => {
  it('without cutParamsFor, every tool still runs at the flat\'s own numbers (unchanged default)', () => {
    const result = run();
    const finishOp = result.ops.find((op) => op.kind === 'finish')!;
    const chamferOp = result.ops.find((op) => op.kind === 'chamfer')!;
    expect(finishOp.outcome.ir.spindleRpm).toBe(FLAT_PARAMS.rpm);
    expect(chamferOp.outcome.ir.spindleRpm).toBe(FLAT_PARAMS.rpm);
  });

  it('with cutParamsFor, the finish/pencil (ball) and chamfer (V) programs carry THEIR OWN rpm and feed, not the flat\'s', () => {
    const cutParamsFor = (tool: Tool): CutParams => {
      if (tool === ball) return BALL_PARAMS;
      if (tool === vbit) return VBIT_PARAMS;
      return FLAT_PARAMS;
    };
    const result = run(cutParamsFor);

    const roughOp = result.ops.find((op) => op.kind === 'rough')!;
    expect(roughOp.outcome.ir.spindleRpm, 'the rough stage is the flat\'s own and must be unaffected').toBe(FLAT_PARAMS.rpm);

    const finishOp = result.ops.find((op) => op.kind === 'finish')!;
    expect(finishOp.outcome.ir.spindleRpm, 'finish (the ball) must run at the BALL\'s own rpm').toBe(BALL_PARAMS.rpm);
    const finishFeeds = finishOp.outcome.ir.operations.flatMap((o) => o.moves).filter((m) => m.kind === 'feed');
    expect(finishFeeds.some((m) => m.f === BALL_PARAMS.feed), 'no finish feed ran at the ball\'s own cutting rate').toBe(true);

    const pencilOp = result.ops.find((op) => op.kind === 'pencil');
    if (pencilOp !== undefined) expect(pencilOp.outcome.ir.spindleRpm, 'pencil (the ball) must run at the BALL\'s own rpm').toBe(BALL_PARAMS.rpm);

    const chamferOp = result.ops.find((op) => op.kind === 'chamfer')!;
    expect(chamferOp.outcome.ir.spindleRpm, 'chamfer (the V) must run at the V\'s own rpm').toBe(VBIT_PARAMS.rpm);
    const chamferFeeds = chamferOp.outcome.ir.operations.flatMap((o) => o.moves).filter((m) => m.kind === 'feed');
    expect(chamferFeeds.some((m) => m.f === VBIT_PARAMS.feed), 'no chamfer feed ran at the V\'s own cutting rate').toBe(true);
  }, 30_000);
});
