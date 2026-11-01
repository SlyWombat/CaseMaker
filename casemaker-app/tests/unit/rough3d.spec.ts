// Issue #846 — ADAPTIVE 3D ROUGHING: each roughing level cleared with the 2D
// adaptive engine, chosen per job by simulated time and engagement, stated.
//
// A synthetic heightfield stands in for a sampled goal: a wide bowl reaching
// deep into the stock. The raster and the adaptive rough are both measured on
// it; the deep aluminium case must post an adaptive rough whose engagement
// stays under the cap, the shallow case must keep the raster and say why, and
// the finishing passes must not move.

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_ADAPTIVE_DEPTH_RATIO,
  generateSurface3dIR,
  type GoalHeightfield,
  type SurfaceFeeds,
  type RoughingOptions,
} from '@/engine/cnc/cam/surface3d';
import { roughLevelRegion, roughingAdaptiveMoves, traceMaskLoops } from '@/engine/cnc/cam/rough3d';
import { adaptiveSettings } from '@/engine/cnc/cam/adaptive';
import { cuttingRadiusForSweep, flatEndMill } from '@/engine/cnc/tool';
import type { Tool } from '@/engine/cnc/tool';

/** A square heightfield with a wide, FLAT-BOTTOMED pocket: every level's region
 *  is the same wide disc, so the cutter can always enter it. */
async function bowlHeightfield(depthMm: number, pitch = 0.5, cells = 60): Promise<GoalHeightfield> {
  const z = new Float32Array(cells * cells);
  const covered = new Uint8Array(cells * cells);
  const centre = ((cells - 1) * pitch) / 2;
  const bowlR = cells * pitch * 0.3;
  let minZ = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const k = j * cells + i;
      const x = i * pitch - centre;
      const y = j * pitch - centre;
      const r = await Math.hypot(x, y);
      covered[k] = 1;
      z[k] = r <= bowlR ? -depthMm : 0;
      if (z[k]! < minZ) minZ = z[k]!;
    }
  }
  return { nx: cells, ny: cells, x0: 0, y0: 0, pitch, topZ: 0, minZ, z, covered, coveredCount: cells * cells, resolutionNote: 'fixture' };
}

const FEEDS: SurfaceFeeds = {
  feed: 600,
  plungeFeed: 200,
  stepDown: 2,
  roughStepOver: 1.2,
  finishStepOver: 0.8,
};

const MILL: Tool = flatEndMill(3);
const SURFACE_TOOL = { radius: 1.5, ball: false };
const RAPID = { xyMmPerMin: 5000, zMmPerMin: 2500, accelMmPerS2: 1000, source: 'fixture' };

/** The same square with a CONE: the surface falls from the rim to the centre, so
 *  a deeper layer's region is genuinely smaller (the region test's shape). */
async function coneHeightfield(depthMm: number, pitch = 0.5, cells = 60): Promise<GoalHeightfield> {
  const hf = await bowlHeightfield(depthMm, pitch, cells);
  const centre = ((cells - 1) * pitch) / 2;
  const bowlR = cells * pitch * 0.3;
  let minZ = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const k = j * cells + i;
      const r = Math.hypot(i * pitch - centre, j * pitch - centre);
      hf.z[k] = r <= bowlR ? -depthMm * (1 - r / bowlR) : 0;
      if (hf.z[k]! < minZ) minZ = hf.z[k]!;
    }
  }
  hf.minZ = minZ;
  return hf;
}

describe('#846 — the layer region follows the heightfield', () => {
  it('traces one loop for a block, and an inner loop for a hole', () => {
    const block = new Uint8Array(4 * 4);
    for (const [i, j] of [[1, 1], [2, 1], [1, 2], [2, 2]] as const) block[j * 4 + i] = 1;
    expect(traceMaskLoops(block, 4, 4)).toHaveLength(1);

    const holed = new Uint8Array(16).fill(1);
    for (const [i, j] of [[1, 1], [2, 1], [1, 2], [2, 2]] as const) holed[j * 4 + i] = 0;
    const loops = traceMaskLoops(holed, 4, 4);
    expect(loops).toHaveLength(2);
  });

  it('a shallow layer skips the bowl; the deepest layer includes it', async () => {
    const hf = await coneHeightfield(8);
    const allowance = 0.3;
    const shallow = roughLevelRegion(hf, -1, allowance);
    const mid = roughLevelRegion(hf, -5, allowance);
    // The signed shoelace area: outer loops positive, the bowl's own hole
    // negative (the tracer orients them), so this is the region's real area.
    const area = (polys: [number, number][][]): number => {
      let a = 0;
      for (const loop of polys) {
        for (let i = 0; i < loop.length; i++) {
          const [x0, y0] = loop[i]!;
          const [x1, y1] = loop[(i + 1) % loop.length]!;
          a += x0 * y1 - x1 * y0;
        }
      }
      return a / 2;
    };
    // Every layer clears the rim; a deeper layer's region shrinks toward it as
    // the bowl's walls fall below the cut.
    expect(shallow.length).toBeGreaterThan(0);
    expect(mid.length).toBeGreaterThan(0);
    // A deeper layer faces the bowl's core only: its region is smaller.
    expect(area(shallow)).toBeGreaterThan(area(mid) + 1);
  });
});

describe('#846 — the adaptive rough holds the engagement cap', () => {
  it('a deep goal plans under the cap, with entries that descend', async () => {
    const hf = await bowlHeightfield(8);
    const settings = adaptiveSettings(null).settings;
    const r = await roughingAdaptiveMoves(hf, FEEDS, 0.3, {
      tool: MILL,
      adaptive: settings,
      safeZ: 6,
      hopZ: 2,
    });
    if (!r.ok) throw new Error(r.reason);

    const flat = cuttingRadiusForSweep(MILL);
    const cap = flat.ok ? settings.engagementFraction * 2 * flat.radius : 0;
    expect(r.result.capMm).toBeCloseTo(cap, 6);
    expect(r.result.maxEngagementMm).toBeLessThanOrEqual(cap + 1e-9);
    expect(r.result.layers).toBeGreaterThan(1);
    // At least one move descends below the stock top: an entry, not a traverse.
    expect(r.result.moves.some((m) => m.kind === 'feed' && m.z < -1)).toBe(true);
  });
});

describe('#846 — the choice, stated', () => {
  const run = async (hf: GoalHeightfield, roughing: RoughingOptions) => {
    const r = await generateSurface3dIR({
      heightfield: hf,
      tool: SURFACE_TOOL,
      toolObj: MILL,
      toolNumber: 1,
      spindleRpm: 12000,
      air: false,
      feeds: FEEDS,
      rapid: RAPID,
      labelId: 'goal',
      opts: { stockToLeaveMm: 0.3, roughing },
    });
    return r;
  };

  it('a deep aluminium goal posts an adaptive rough, and the note measures both', async () => {
    const r = await run(await bowlHeightfield(8), {
      mode: 'auto',
      material: 'aluminium-6061',
      adaptive: adaptiveSettings(null).settings,
    });
    const rough = r.ir.operations[0]!;
    expect(rough.name).toContain('(adaptive)');
    const note = r.notes.find((n) => n.includes('roughing chosen'));

    expect(note).toBeDefined();
    expect(note!).toMatch(/max engagement .* mm under the .* mm cap/);
    expect(note!).toContain('both were measured');
  });

  it('a shallow wooden goal keeps the raster and says why', async () => {
    const r = await run(await bowlHeightfield(1), {
      mode: 'auto',
      material: 'pla',
      // Force the rule path so the wording is the rule's.
      cellBudget: 100,
      adaptive: adaptiveSettings(null).settings,
    });
    expect(r.ir.operations[0]!.name).not.toContain('(adaptive)');
    const note = r.notes.find((n) => n.includes('Raster roughing chosen by rule'));
    expect(note).toBeDefined();
    expect(note!).toContain('skipped above 100 cells');
  });

  it('a legacy plan (no roughing option) is the raster, with no new note', async () => {
    const hf = await bowlHeightfield(8);
    const plain = await generateSurface3dIR({
      heightfield: hf,
      tool: SURFACE_TOOL,
      toolObj: MILL,
      toolNumber: 1,
      spindleRpm: 12000,
      air: false,
      feeds: FEEDS,
      rapid: RAPID,
      labelId: 'goal',
      opts: { stockToLeaveMm: 0.3 },
    });
    expect(plain.ir.operations[0]!.name).not.toContain('(adaptive)');
    expect(plain.notes.some((n) => n.includes('roughing chosen'))).toBe(false);
  });

  it('the finishing passes are the same moves either way', async () => {
    const hf = await bowlHeightfield(8);
    const adaptive = await run(hf, { mode: 'adaptive', material: 'pla', adaptive: adaptiveSettings(null).settings });
    const raster = await run(hf, { mode: 'raster' });
    const finishing = (ir: Awaited<ReturnType<typeof run>>['ir']) =>
      ir.operations.slice(1).map((op) => ({ name: op.name, moves: op.moves }));
    expect(finishing(adaptive.ir)).toEqual(finishing(raster.ir));
  });

  it('the default ratio is the shop default’s fallback', () => {
    expect(DEFAULT_ADAPTIVE_DEPTH_RATIO).toBe(1.5);
  });
});
