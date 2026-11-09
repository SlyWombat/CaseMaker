// #970 — B's link audit, RED-FIRST: a stay-down link is approved by a MATERIAL FIELD, and every
// op's field is a sampled grid. A rise narrow enough to fall between the grid's samples is
// invisible to `linkIsClear`, so the link feeds through standing material at the cut z. The
// three sites B named each get one buried-rise fixture here: the grid says the ground is clear,
// the CL surface itself says it is not, and the op must retract rather than stay down.
//
// The fixtures assert one invariant on the emitted path, the same one the row-end spec uses:
// every LATERAL feed move keeps the exact CL at its own XY at or below its own z.
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import { rough, skin } from '../../src/engine/cnc/cam/model/ops/rough';
import { rest } from '../../src/engine/cnc/cam/model/ops/rest';
import type { ClSurface } from '../../src/engine/cnc/cam/model/clsurface';
import type { RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import type { Box2, RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';
import { flatEndMill } from '../../src/engine/cnc/tool';

const rapid: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const FEEDS = { feedMmPerMin: 900, plungeFeedMmPerMin: 250 };
const flat6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });

/** Walk every lateral feed move and return the worst exact-CL overrun along it. */
function worstLateralOverrun(
  moves: { kind: string; x: number; y: number; z: number }[],
  clAt: (x: number, y: number) => number | null,
): { over: number; x: number; y: number; z: number; cl: number } {
  let worst = { over: -Infinity, x: 0, y: 0, z: 0, cl: 0 };
  let prev: { x: number; y: number } | null = null;
  for (const m of moves) {
    const lateral = prev !== null && (Math.abs(m.x - prev.x) > 1e-9 || Math.abs(m.y - prev.y) > 1e-9);
    if (m.kind === 'feed' && lateral && prev !== null) {
      const len = Math.hypot(m.x - prev.x, m.y - prev.y);
      const steps = Math.max(1, Math.ceil(len / 0.02));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = prev.x + (m.x - prev.x) * t;
        const y = prev.y + (m.y - prev.y) * t;
        const cl = clAt(x, y);
        if (cl !== null && cl - m.z > worst.over) worst = { over: cl - m.z, x, y, z: m.z, cl };
      }
    }
    prev = { x: m.x, y: m.y };
  }
  return worst;
}

describe('#970 link sites — a buried rise under a stay-down link', () => {
  it("skin(): the pocket link retracts where the design rises between the target grid's samples", () => {
    // The design: a flat island at -1.5 on both sides of a narrow steep ramp (the slope gate keeps
    // the ramp out of the mask, so the two islands are joined by a link, not a cut). The ramp is
    // monotone and the grid's 3x3 max smooths it but keeps its gradient, so cells across it are
    // not gentle. A 0.6 mm ridge at x = 13.2..13.8 sits between the 1 mm lattice points — the
    // target grid never samples it; the CL surface is the design, so the link's exact proof sees
    // it. The skin's level is -1.5; the ridge stands at -0.5, one full millimetre above the link.
    const ISLAND = -1.5;
    const base = (x: number): number => {
      if (x <= 12) return ISLAND;
      if (x >= 17) return ISLAND;
      return ISLAND - 0.2 * (x - 12);
    };
    const RIDGE_LO = 13.2;
    const RIDGE_HI = 13.8;
    const clAt = (x: number, _y: number): number => (x >= RIDGE_LO && x <= RIDGE_HI ? -0.5 : base(x));
    const cl: ClSurface = { dropCutter: clAt, toleranceMm: 0.005, minSpacingMm: 0.005, minSpacingSource: 'derived', minSpacingFromStepOverMm: 0.05, maxSpacingMm: 0.3, sampleCount: 0 };
    const outline: Polygons = [[[0, 0], [40, 0], [40, 20], [0, 20]]];
    const regionRef: RegionRef = {
      id: 'skin-link',
      kind: 'curved',
      bounds: { min: [-6, -6], max: [46, 26] } satisfies Box2,
      topZ: 0,
      bottomZ: -1.5,
      obstacles: [],
      regionClearanceZ: 2,
    };
    const out = skin({
      cutter: flat6,
      regionRef,
      outline,
      clSurface: cl,
      skinMm: 1.5,
      stepDownMm: 1.5,
      maxSlopeDeg: 9,
      gridPitchMm: 1,
      feeds: FEEDS,
      offset: makeClipperOffset(tl),
      safeZMm: 8,
      hopZMm: 3,
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      rapid,
      stockTopZMm: 5,
      // Enter the first (outer) pocket loop at its right edge, so the cross-island join is one
      // short hop rather than a full loop's width.
      startFrom: [10, 10],
    });
    const moves = out.ir.operations.flatMap((op) => op.moves);
    expect(moves.length).toBeGreaterThan(0);
    const worst = worstLateralOverrun(moves, clAt);
    expect(
      worst.over,
      `a lateral feed at (${worst.x.toFixed(2)}, ${worst.y.toFixed(2)}) rides at z ${worst.z} where the design stands ${worst.cl} — ${worst.over.toFixed(3)} mm of cut-into`,
    ).toBeLessThanOrEqual(1e-6);
  });

  it("rest(): the level link retracts where the previous cutter's CL rises between the grid's samples", () => {
    // Two islands the rest must cut at -1 (the previous cutter left -0.5 there), split by a gap
    // its mask leaves alone (the previous cutter's CL stands at -2, below the level). A 0.6 mm
    // ridge of the PREVIOUS cutter's surface at x = 12.2..12.8 stands at -0.5 inside that gap —
    // between the 2 mm grid's samples [even centres, odd corners], so the rest's grid reports
    // -2 there and its material field approves the stay-down; the exact surface says the disc
    // would feed through material standing 0.5 mm above the link. The rest does not cut the gap
    // this level, so the material there still stands: the link must retract.
    const LEV = -1;
    const LEV_GRID = 2; // gridPitchMm
    const PREV_HIGH = -0.5;
    const PREV_LOW = -2;
    const NEXT = -3;
    const RIDGE_LO = 12.2;
    const RIDGE_HI = 12.8;
    const prevClAt = (x: number, _y: number): number => {
      if (x >= RIDGE_LO && x <= RIDGE_HI) return PREV_HIGH;
      return x <= 10 || x >= 16 ? PREV_HIGH : PREV_LOW;
    };
    const prevCl: ClSurface = { dropCutter: prevClAt, toleranceMm: 0.005, minSpacingMm: 0.005, minSpacingSource: 'derived', minSpacingFromStepOverMm: 0.05, maxSpacingMm: 0.3, sampleCount: 0 };
    const nextCl: ClSurface = { dropCutter: () => NEXT, toleranceMm: 0.005, minSpacingMm: 0.005, minSpacingSource: 'derived', minSpacingFromStepOverMm: 0.05, maxSpacingMm: 0.3, sampleCount: 0 };
    const bounds: Box2 = { min: [0, 0], max: [40, 20] };
    const nx = Math.floor((bounds.max[0] - bounds.min[0]) / LEV_GRID) + 1;
    const ny = Math.floor((bounds.max[1] - bounds.min[1]) / LEV_GRID) + 1;
    /** The plan's own mask cell: the value rest() samples (centre + four half-pitch corners). */
    const prevCell = (i: number, j: number): number => {
      const x = bounds.min[0] + i * LEV_GRID;
      const y = bounds.min[1] + j * LEV_GRID;
      const h = LEV_GRID / 2;
      let hi = -Infinity;
      for (const [dx, dy] of [[0, 0], [-h, -h], [h, -h], [-h, h], [h, h]] as const) {
        const v = prevClAt(x + dx, y + dy);
        if (v !== null && v > hi) hi = v;
      }
      return hi;
    };
    const planCutsCell = (x: number, y: number): boolean => {
      const i = Math.round((x - bounds.min[0]) / LEV_GRID);
      const j = Math.round((y - bounds.min[1]) / LEV_GRID);
      if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
      return NEXT + 0.005 < LEV && prevCell(i, j) > LEV;
    };
    // The standing material after this level: the level plane where the PLAN cut, the exact
    // previous surface everywhere else (the plan's own claim read against the real design).
    const standingAt = (x: number, y: number): number => (planCutsCell(x, y) ? LEV : prevClAt(x, y));
    const region: RemainderRegion = {
      id: 'rest-link',
      footprint: [[[0, 0], [40, 0], [40, 20], [0, 20]]],
      area: 800,
      zTop: LEV,
      zBottom: LEV,
      triangles: new Uint32Array(),
      slopeDeg: [0, 45],
      slopeMedianDeg: 20,
      in: 'top',
    };
    const regionRef: RegionRef = { id: 'rest-link', kind: 'curved', bounds, topZ: LEV, bottomZ: LEV, obstacles: [], regionClearanceZ: 2 };
    const out = rest({
      cutter: flat6,
      region,
      regionRef,
      prevClSurface: prevCl,
      clSurface: nextCl,
      stepDownMm: 1,
      gridPitchMm: LEV_GRID,
      feeds: FEEDS,
      offset: makeClipperOffset(tl),
      safeZMm: 8,
      hopZMm: 3,
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      rapid,
      startFrom: [9, 10],
    });
    const moves = out.ir.operations.flatMap((op) => op.moves);
    expect(moves.length).toBeGreaterThan(0);
    const worst = worstLateralOverrun(moves, standingAt);
    expect(
      worst.over,
      `a lateral feed at (${worst.x.toFixed(2)}, ${worst.y.toFixed(2)}) rides at z ${worst.z} where the standing material is ${worst.cl} — ${worst.over.toFixed(3)} mm of cut-into`,
    ).toBeLessThanOrEqual(1e-6);
  });

  it('rough() skim: the join retracts over a one-cell wall the ride test sees and the link disc test misses', () => {
    // A flat band at -1 (the skim's own CL, one shallow level) cut by a one-cell wall standing at
    // +2 at x = 4.875: every skim row stops at the wall and resumes past it, so the runs either
    // side are joined by a 0.5 mm link across it. The ride test samples the join every 0.25 (the
    // grid pitch) and sees the wall; the link's disc test samples every 0.5 from the run's own
    // end (x = 4.625), and the wall's one-cell footprint (4.75..5.0) falls exactly between those
    // columns — so the link approves a stay-down at -1 straight through it. The CL surface says
    // the wall stands 3 mm above the link.
    const BAND = -1;
    const WALL = 2;
    const WALL_X = 4.75;
    // The band is a channel in y (3..9); above and below it the design is deep (out of the skim's
    // band, and thin enough that the level pass's radius offset vanishes). The wall runs the full
    // height, so every channel row is split either side of it.
    const clAt = (x: number, y: number): number => {
      if (Math.abs(x - WALL_X) <= 0.03) return WALL;
      return y >= 3 && y <= 9 ? BAND : -10;
    };
    const cl: ClSurface = { dropCutter: clAt, toleranceMm: 0.005, minSpacingMm: 0.005, minSpacingSource: 'derived', minSpacingFromStepOverMm: 0.05, maxSpacingMm: 0.3, sampleCount: 0 };
    const bounds: Box2 = { min: [0, 0], max: [12, 12] };
    const region: RemainderRegion = {
      id: 'skim-link',
      footprint: [[[0, 0], [12, 0], [12, 12], [0, 12]]],
      area: 144,
      zTop: 0,
      zBottom: BAND,
      triangles: new Uint32Array(),
      slopeDeg: [0, 45],
      slopeMedianDeg: 20,
      in: 'top',
    };
    const regionRef: RegionRef = { id: 'skim-link', kind: 'curved', bounds, topZ: 0, bottomZ: BAND, obstacles: [], regionClearanceZ: 2 };
    const out = rough({
      cutter: flat6,
      region,
      regionRef,
      clSurface: cl,
      stepDownMm: 1.5,
      stockToLeaveMm: 0,
      stepOverMm: 3,
      gridPitchMm: 0.25,
      feeds: FEEDS,
      offset: makeClipperOffset(tl),
      safeZMm: 8,
      hopZMm: 3,
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      rapid,
      startFrom: [-5, 6],
    });
    const moves = out.ir.operations.flatMap((op) => op.moves);
    expect(moves.length).toBeGreaterThan(0);
    // The join exists either way; the fix's shape is WHICH kind crosses the wall: a stay-down feed
    // in the red, the retract's rapid traverse in the green.
    const crossesAt = (kind: 'feed' | 'rapid'): boolean => {
      let prev: { x: number; y: number; z: number; kind: string } | null = null;
      for (const m of moves) {
        if (m.kind === kind && prev !== null && Math.min(prev.x, m.x) < WALL_X - 0.01 && Math.max(prev.x, m.x) > WALL_X + 0.01) return true;
        prev = { x: m.x, y: m.y, z: m.z, kind: m.kind };
      }
      return false;
    };
    expect(crossesAt('rapid'), 'the skim retracts its wall join at the hop plane').toBe(true);
    expect(crossesAt('feed'), 'no stay-down feed crosses the wall').toBe(false);
    const worst = worstLateralOverrun(moves, clAt);
    expect(
      worst.over,
      `a lateral feed at (${worst.x.toFixed(2)}, ${worst.y.toFixed(2)}) rides at z ${worst.z} where the design stands ${worst.cl} — ${worst.over.toFixed(3)} mm of cut-into`,
    ).toBeLessThanOrEqual(1e-6);
  });
});
