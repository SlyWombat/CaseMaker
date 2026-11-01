// Issue #862 — THE CLEAR BAND'S WALL IS FINISHED BY A RIM PASS.
//
// A goal cut with a clear ring (#764) is a plateau out of the stock; its outer edge is a wall
// between the band floor and the stock top. The roughing's raster meets that wall only with its
// row ends (vertical ridges at its step-over, ball bites along the top edge). The rim pass laps
// the covered boundary from the stock top down to the band floor, so the wall is a contour cut.
//
// The fixture is the band geometry itself: a square of covered cells at a uniform depth, with the
// stock top around it — the same shape `sampleGoalHeightfield`'s ring leaves behind.

import { describe, expect, it } from 'vitest';

import {
  generateSurface3dIR,
  type GoalHeightfield,
  type SurfaceFeeds,
  type SurfaceTool,
} from '@/engine/cnc/cam/surface3d';
import { HOP_Z, SAFE_Z } from '@/engine/cnc/cam/ir';
import { flatEndMill } from '@/engine/cnc/tool';
import type { Tool } from '@/engine/cnc/tool';
import type { RapidEstimate } from '@/engine/cnc/cam/ir';

/** A covered square at `floorZ` inside the stock top: the clear band's own shape. */
function bandHeightfield(floorZ: number, cells = 40, pitch = 0.5): GoalHeightfield {
  const z = new Float32Array(cells * cells);
  const covered = new Uint8Array(cells * cells);
  covered.fill(1);
  z.fill(floorZ);
  return {
    nx: cells,
    ny: cells,
    x0: 0,
    y0: 0,
    pitch,
    topZ: 0,
    minZ: floorZ,
    z,
    covered,
    coveredCount: cells * cells,
    resolutionNote: 'fixture',
  };
}

const FEEDS: SurfaceFeeds = {
  feed: 600,
  plungeFeed: 200,
  stepDown: 0.5,
  roughStepOver: 1.429,
  finishStepOver: 0.3,
};

const MILL: Tool = flatEndMill(3);
const SURFACE_TOOL: SurfaceTool = { radius: 1.5, ball: true };
const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'fixture' };

function run(hf: GoalHeightfield, rim: { floorZ: number } | undefined) {
  return generateSurface3dIR({
    heightfield: hf,
    tool: SURFACE_TOOL,
    toolObj: MILL,
    toolNumber: 1,
    spindleRpm: 12000,
    air: false,
    feeds: FEEDS,
    rapid: RAPID,
    labelId: 'goal',
    opts: { stockToLeaveMm: 0.3, ...(rim === undefined ? {} : { rim }) },
  });
}

describe('#862 — the rim pass finishes the band wall', () => {
  it('laps the covered boundary from the stock top to the band floor', () => {
    const hf = bandHeightfield(-5);
    const r = run(hf, { floorZ: -5 });
    expect(r.rim).not.toBeNull();
    // One lap per step-down, from the first layer below the stock top down to the floor.
    expect(r.rim!.laps).toBe(10);
    expect(r.rim!.floorZ).toBe(-5);
    expect(r.notes.some((n) => n.includes('rim lap'))).toBe(true);

    // The laps are the finishing operation's opening moves, each at its own Z.
    const rimMoves = r.finishing.moves.slice(0, 40);
    expect(rimMoves[0]!.kind).toBe('rapid');
    const feedZs = new Set<number>();
    for (const m of r.finishing.moves) {
      if (m.kind === 'feed') feedZs.add(Math.round(m.z * 1000) / 1000);
      if (m.kind === 'feed' && m.z <= -5 - 1e-9) break;
    }
    // The first lap is at the first layer below the stock top; the floor lap is the depth.
    expect(feedZs.has(-0.5)).toBe(true);
    expect(feedZs.has(-5)).toBe(true);
    const rimPrefix = r.finishing.moves.filter((m) => m.kind === 'feed' && m.z <= -5 + 1e-9);
    expect(rimPrefix.length).toBeGreaterThan(0);
  });

  it('keeps the finishing raster byte for byte when no band is stated', () => {
    const hf = bandHeightfield(-5);
    const plain = run(hf, undefined);
    expect(plain.rim).toBeNull();
    const withRim = run(hf, { floorZ: -5 });
    // The raster rides the floor after the laps: the tail is exactly the plain finish.
    const tail = withRim.finishing.moves.slice(withRim.finishing.moves.length - plain.finishing.moves.length);
    expect(tail).toEqual(plain.finishing.moves);
  });

  it('does not gouge a boundary cell whose own surface stands above the lap', () => {
    const hf = bandHeightfield(-5);
    // A part's own rim at the stock edge: one boundary cell is a surface at -1, not the band floor.
    const raised = 20 * hf.nx + 0; // cell (i=0, j=20), its centre at (0, 10)
    hf.z[raised] = -1;
    const r = run(hf, { floorZ: -5 });
    const near = r.finishing.moves.filter(
      (m) => m.kind === 'feed' && Math.hypot(m.x - 0, m.y - 10) <= 0.4,
    );
    // The laps cut at -1 there, and never below the surface they stand beside.
    expect(near.some((m) => Math.abs(m.z + 1) <= 1e-9)).toBe(true);
    expect(near.every((m) => m.z >= -1 - 1e-9)).toBe(true);
  });

  it('the wall stays on the covered boundary and the passes retract clear', () => {
    const hf = bandHeightfield(-5);
    const r = run(hf, { floorZ: -5 });
    const rimEnd = r.finishing.moves.findIndex(
      (m, i) => i > 0 && m.kind === 'rapid' && Math.abs(m.z - SAFE_Z) <= 1e-9,
    );
    const rimMoves = rimEnd < 0 ? r.finishing.moves : r.finishing.moves.slice(0, rimEnd + 1);
    const feeds = rimMoves.filter((m) => m.kind === 'feed');
    expect(feeds.length).toBeGreaterThan(0);
    for (const m of feeds) {
      // The covered square is 0 .. 19.5 in both axes; the wall is its own edge.
      expect(m.x).toBeGreaterThanOrEqual(-1e-9);
      expect(m.x).toBeLessThanOrEqual(19.5 + 1e-9);
      expect(m.y).toBeGreaterThanOrEqual(-1e-9);
      expect(m.y).toBeLessThanOrEqual(19.5 + 1e-9);
    }
    // Every retract is at the hop, and the pass ends at the safe height.
    const last = r.finishing.moves[r.finishing.moves.length - 1]!;
    expect(last.kind).toBe('rapid');
    expect(last.z).toBe(SAFE_Z);
    expect(rimMoves.some((m) => m.kind === 'rapid' && Math.abs(m.z - HOP_Z) <= 1e-9)).toBe(true);
  });
});
