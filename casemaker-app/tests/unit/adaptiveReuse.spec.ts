// Issue #868 — EXACT-REGION REUSE ACROSS ROUGHING LEVELS.
//
// A level whose region mask is byte-identical to the level above's gets the level above's plan,
// shifted to the new Z, instead of a second walk. `planAdaptive` is a pure function of the region
// and the layer's thickness, so the reuse must be BYTE-IDENTICAL to planning afresh — these tests
// build the serial reference (one planAdaptive per level, exactly what the code did before the
// reuse) and compare the whole move list, on a goal where every level repeats and on one where
// they do not.

import { describe, expect, it } from 'vitest';

import {
  polygonalizeMask,
  roughingAdaptiveMoves,
  roughLevelMask,
  roughLevelRegion,
} from '@/engine/cnc/cam/rough3d';
import { adaptiveSettings, planAdaptive } from '@/engine/cnc/cam/adaptive';
import { HOP_Z, SAFE_Z, type CamMove } from '@/engine/cnc/cam/ir';
import { cuttingRadiusForSweep, flatEndMill } from '@/engine/cnc/tool';
import type { Tool } from '@/engine/cnc/tool';
import type { GoalHeightfield, SurfaceFeeds } from '@/engine/cnc/cam/surface3d';

const FEEDS: SurfaceFeeds = { feed: 900, plungeFeed: 300, stepDown: 0.5, roughStepOver: 1.429, finishStepOver: 0.3 };
const MILL: Tool = flatEndMill(3.175);
const EPS = 1e-6;

/** A flat plateau: every covered cell at `floorZ`, so every level clears the same cells. */
function plateau(cells = 24, pitch = 0.5, floorZ = -2.5): GoalHeightfield {
  const z = new Float32Array(cells * cells).fill(floorZ);
  return {
    nx: cells,
    ny: cells,
    x0: 0,
    y0: 0,
    pitch,
    topZ: 0,
    minZ: floorZ,
    z,
    covered: new Uint8Array(cells * cells).fill(1),
    coveredCount: cells * cells,
    resolutionNote: 'fixture',
  };
}

/** A two-step staircase: an upper terrace at −1 over the left half, a lower one at −5 over the
 *  right. The upper terrace is in every level's region from −1 down; the lower one only joins at
 *  the floor — so most levels repeat, the last does not. */
function staircase(cells = 40, pitch = 0.5): GoalHeightfield {
  const z = new Float32Array(cells * cells);
  const covered = new Uint8Array(cells * cells).fill(1);
  let minZ = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const v = i < cells / 2 ? -1 : -5;
      z[j * cells + i] = v;
      if (v < minZ) minZ = v;
    }
  }
  return { nx: cells, ny: cells, x0: 0, y0: 0, pitch, topZ: 0, minZ, z, covered, coveredCount: cells * cells, resolutionNote: 'fixture' };
}

/**
 * The serial reference: one `planAdaptive` per level and the same Z shift, exactly what
 * `roughingAdaptiveMoves` did before #868's reuse. This is the definition of "byte-identical".
 */
function serialReference(hf: GoalHeightfield, allowance: number): CamMove[] {
  const { topZ, minZ } = hf;
  const deepest = minZ + allowance;
  const levels: number[] = [];
  for (let L = topZ - FEEDS.stepDown; L > deepest + 1e-9; L -= FEEDS.stepDown) levels.push(L);
  levels.push(deepest);
  const settings = adaptiveSettings(null).settings;
  const moves: CamMove[] = [];
  let lastLevel = levels[0] ?? topZ;
  for (const [index, L] of levels.entries()) {
    const region = roughLevelRegion(hf, L, allowance);
    if (region.length === 0) continue;
    const thickness = index === 0 ? topZ - L : lastLevel - L;
    lastLevel = L;
    const depth = Math.max(thickness, 0.01);
    const planned = planAdaptive({
      tool: MILL,
      region,
      depth,
      settings: { ...settings, stepDownMm: depth, cutFeed: FEEDS.feed, entryFeed: FEEDS.plungeFeed },
    });
    if (!planned.ok) throw new Error(planned.reason);
    const shift = L + thickness;
    for (const m of planned.plan.moves) {
      moves.push(m.kind === 'rapid' && m.z >= HOP_Z - EPS ? { ...m, z: m.z >= SAFE_Z - EPS ? SAFE_Z : HOP_Z } : { ...m, z: m.z + shift });
    }
  }
  if (moves.length > 0) {
    const last = moves[moves.length - 1]!;
    moves.push({ kind: 'rapid', x: last.x, y: last.y, z: SAFE_Z });
  }
  return moves;
}

function adaptive(hf: GoalHeightfield, allowance = 0.3) {
  const r = roughingAdaptiveMoves(hf, FEEDS, allowance, { tool: MILL, adaptive: adaptiveSettings(null).settings, safeZ: SAFE_Z, hopZ: HOP_Z });
  if (!r.ok) throw new Error(r.reason);
  return r.result;
}

describe('#868 — a repeated region reuses the level above’s plan', () => {
  it('a plateau reuses every level and is byte-identical to planning each one', () => {
    const hf = plateau();
    const result = adaptive(hf);
    // Five layers: four at the 0.5 mm step and the floor layer riding the allowance at a 0.2 mm
    // thickness. The first three that repeat the step reuse (the floor plans afresh, its thickness
    // differs — the same region at a different depth is a different plan).
    expect(result.layers).toBe(5);
    expect(result.reusedLevels).toBe(3);
    expect(result.moves).toEqual(serialReference(hf, 0.3));
  });

  it('a staircase mixes both, and the plan is still exactly the serial one', () => {
    const hf = staircase();
    const result = adaptive(hf);
    // The upper terrace is the same region from −1 down to −4.5, so those levels repeat; the floor
    // level adds the lower terrace and plans afresh.
    expect(result.reusedLevels).toBeGreaterThan(0);
    expect(result.reusedLevels).toBeLessThan(result.layers - 1 + 1);
    expect(result.moves).toEqual(serialReference(hf, 0.3));
  });

  it('the mask is what decides: the same cells, the same polygons', () => {
    const hf = plateau();
    const a = roughLevelMask(hf, -0.5, 0.3)!;
    const b = roughLevelMask(hf, -2.0, 0.3)!;
    expect(a).toEqual(b);
    expect(polygonalizeMask(hf, a)).toEqual(polygonalizeMask(hf, b));
    // And a staircase's top level (both terraces still to clear) differs from the levels below
    // it (only the lower one: the upper terrace's own 1 mm has been taken).
    const stairHf = staircase();
    const top = roughLevelMask(stairHf, -0.5, 0.3)!;
    const below = roughLevelMask(stairHf, -2, 0.3)!;
    expect(top).not.toEqual(below);
  });

  it('the reuse keeps the engagement cap it was planned under', () => {
    const hf = plateau();
    const result = adaptive(hf);
    const flat = cuttingRadiusForSweep(MILL);
    const cap = flat.ok ? adaptiveSettings(null).settings.engagementFraction * 2 * flat.radius : 0;
    expect(result.capMm).toBeCloseTo(cap, 9);
    expect(result.maxEngagementMm).toBeLessThanOrEqual(cap + 1e-9);
  });
});
