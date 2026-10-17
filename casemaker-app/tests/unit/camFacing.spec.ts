// Facing (#432): the raster that skims the stock's top. Its own program, posted against the probed
// top — the engraving program is never shifted (slice 2's rework; the re-touch re-zeros Z between
// the two files instead).
//
// Pure — no Manifold, no wasm harness: the region is the stock rectangle, so every assertion below
// is a closed form on the moves rather than a second run of the generator.

import { describe, it, expect } from 'vitest';
import { facingRasterLines, generateFacing, FACING_EDGE_CLEARANCE_MM } from '@/engine/cnc/cam/facing';
import { HOP_Z, SAFE_Z } from '@/engine/cnc/cam/ir';
import type { CutParams } from '@/engine/cnc/feeds';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';

const R = 1.5875; // half of the 3.175 mm shank — the radius of `flatEndMill(3.175)`
const TOOL = flatEndMill(3.175);
const PARAMS: CutParams = { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.4, stepOver: 1.0, peck: 1, air: true };
const STOCK = { length: 76.2, width: 38.1 };
const RAPID = Z1.rapidEstimate;

describe('#432 facingRasterLines', () => {
  it('keeps the cutter’s EDGE on the stock’s boundary, never its centre', () => {
    const lines = facingRasterLines(STOCK, 1.0, R);
    // The verifier's `cut-outside-stock` reads the disc, so the centre is a radius in and the
    // edge lands on the stock's own edge: faced to the boundary, with no move cutting air.
    const first = lines[0]!;
    const last = lines[lines.length - 1]!;
    expect(first.start[0] - R).toBe(0);
    expect(first.start[1] - R).toBe(0);
    // The last line runs back (serpentine), so its far corner is its START.
    expect(last.start[0] + R).toBe(STOCK.length);
    expect(last.end[1] + R).toBe(STOCK.width);
  });

  it('rasters down the longer side, at one Y per line, with no gap wider than the step-over', () => {
    const lines = facingRasterLines(STOCK, 1.0, R);
    const runLo = R;
    const runHi = STOCK.length - R;
    for (const line of lines) {
      expect(Math.min(line.start[0], line.end[0]), 'every line runs the full length').toBe(runLo);
      expect(Math.max(line.start[0], line.end[0])).toBe(runHi);
      expect(line.start[1], 'lines sit at a single Y').toBe(line.end[1]);
    }
    const ys = lines.map((l) => l.start[1]);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeLessThanOrEqual(1.0 + 1e-9);
    expect(ys[0]).toBe(R);
    expect(ys[ys.length - 1]).toBe(STOCK.width - R);
  });

  it('bails every other line, so the next pass starts where this one ended', () => {
    const lines = facingRasterLines(STOCK, 1.0, R);
    expect(lines[0]!.end[0]).toBe(STOCK.length - R);
    expect(lines[1]!.start[0]).toBe(STOCK.length - R);
    expect(lines[1]!.end[0]).toBe(R);
    expect(lines[2]!.start[0]).toBe(R);
  });

  it('rasters down Y when the stock is taller than it is long', () => {
    const lines = facingRasterLines({ length: 20, width: 30 }, 1.0, 0.5);
    expect(lines[0]).toEqual({ start: [0.5, 0.5], end: [0.5, 29.5] });
    const xs = lines.map((l) => l.start[0]);
    expect(xs[0]).toBe(0.5);
    expect(xs[xs.length - 1]).toBe(19.5);
  });

  it('puts ONE line down the middle of a stock narrower than the cutter', () => {
    // Holding the centre a radius in from both sides is impossible here; the disc covers the
    // direction whole, so the middle is the only honest line.
    const lines = facingRasterLines({ length: 10, width: 0.4 }, 1.0, 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.start[1]).toBe(0.2);
    expect(lines[0]!.start[0]).toBe(1);
    expect(lines[0]!.end[0]).toBe(9);
  });

  it('refuses a stock with no size, a step-over of zero, and a negative inset', () => {
    expect(() => facingRasterLines({ length: 0, width: 10 }, 1)).toThrow(/positive length and width/);
    expect(() => facingRasterLines(STOCK, 0)).toThrow(/stepOver must be > 0/);
    expect(() => facingRasterLines(STOCK, 1, -0.1)).toThrow(/inset must be >= 0/);
  });
});

describe('#432 generateFacing', () => {
  it('makes one operation, at the cutter’s own step-down, reaching exactly the total depth', () => {
    const ir = generateFacing(STOCK, TOOL, PARAMS, RAPID, 0.5);
    expect(ir.frame).toBe('flat');
    expect(ir.operations).toHaveLength(1);
    const op = ir.operations[0]!;
    expect(op.name).toBe('[T1]Face stock top 0.5mm');
    expect(op.depth).toBe(0.5);
    expect(op.labelId).toBe('');
    // stepDown 0.4 over a 0.5 mm removal: two passes, the shallowest first, the last on the floor.
    const zs = [...new Set(op.moves.filter((m) => m.kind === 'feed').map((m) => m.z))];
    expect(zs).toEqual([-0.4, -0.5]);
  });

  it('hopped to every line and retracted to the safe height at the end', () => {
    const ir = generateFacing(STOCK, TOOL, PARAMS, RAPID, 0.5);
    const moves = ir.operations[0]!.moves;
    // `generateFacing` holds the centre a micron further in than the radius, so the POSTED edge
    // stays inside the stock (see FACING_EDGE_CLEARANCE_MM).
    const lines = facingRasterLines(STOCK, PARAMS.stepOver, R + FACING_EDGE_CLEARANCE_MM);
    // Each pass begins with an XY rapid at the hop height and ends at the safe height exactly once.
    for (const z of [-0.4, -0.5]) {
      const firstFeed = moves.findIndex((m) => m.kind === 'feed' && m.z === z);
      expect(moves[firstFeed - 1]).toMatchObject({ kind: 'rapid', x: lines[0]!.start[0], y: lines[0]!.start[1], z: HOP_Z });
    }
    expect(moves[moves.length - 1]).toMatchObject({ kind: 'rapid', z: SAFE_Z });
    expect(moves[moves.length - 2]!.kind).toBe('rapid');
  });

  it('refuses a depth of zero, a non-flat cutter, and a step-over past the diameter', () => {
    expect(() => generateFacing(STOCK, TOOL, PARAMS, RAPID, 0)).toThrow(/depth must be > 0/);
    const vb = flatEndMill(3.175, { shape: 'engraving', typeText: 'V-Bit', halfAngle: 30 });
    expect(() => generateFacing(STOCK, vb, PARAMS, RAPID, 0.5)).toThrow(/flat end mill only/);
    // A raster covers the face only while the cutter's discs overlap: past a diameter they do not.
    expect(() => generateFacing(STOCK, flatEndMill(1), { ...PARAMS, stepOver: 1.1 }, RAPID, 0.5)).toThrow(/uncut ridge/);
    // Just inside the diameter is accepted.
    expect(() => generateFacing(STOCK, flatEndMill(1), { ...PARAMS, stepOver: 1.0 }, RAPID, 0.5)).not.toThrow();
  });
});
