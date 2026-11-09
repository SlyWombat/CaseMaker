/**
 * #1092 (0f's ruling, 2026-11-09) — THE FLAT DROP-TIP DILATION IS EXACT AND FAST.
 *
 * The tip field is a grey-scale dilation: at cell (i, j) the tool's tip stands at the max of
 * (z − rise) over every grid cell its disc reaches (out-of-grid counts as the stock top). The
 * landed implementation runs the full disc STENCIL at every cell — O(covered × stencil), 853
 * evaluations per cell for a ⌀3.175 flat at 0.1 mm. The organizer's two large rest regions
 * (pocket-15, pocket-16) exceeded the 300 M budget that way and were refused. 0f's ruling: the
 * FLAT dilation is separable by disc ROW — for a row offset dj the reach along the row is one
 * contiguous interval, so each row is a sliding-window maximum (van Herk / Gil-Werman, O(1) per
 * cell per row). The unit becomes GRID CELLS × ROWS IN THE DISC (33 rows, not 853 stencil cells),
 * and the result must be BIT-identical: max is order-independent, and both paths max the same
 * finite set of float32 values.
 *
 * This spec is red-first against the old implementation: the flat budget test hands the field the
 * new unit's count as its budget — the old code computes covered × stencil and refuses — and the
 * equality block compares the shipped field against the brute-force disc scan it must replace
 * (flat AND ball; wrap and no wrap; grids whose disc overhangs the border).
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_FINISH_TIP_OPS,
  DEFAULT_MAX_FINISH_TIP_ROW_OPS,
  discRowCountFor,
  finishTipField,
  maxTipOpsFor,
  stencilCellsFor,
  tipFieldOpsFor,
  type SurfaceTool,
} from '@/engine/cnc/cam/dropTip';
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';

// ── A deterministic heightfield: random z within [minZ, topZ], a random covered mask, a plateau
// and a wall so the disc sees structure, and enough uncovered cells that out-of-grid handling
// cannot hide. ─────────────────────────────────────────────────────────────────────────────────
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function field(seed: number, nx: number, ny: number, pitch: number): GoalHeightfield {
  const r = rng(seed);
  const z = new Float32Array(nx * ny);
  const covered = new Uint8Array(nx * ny);
  let coveredCount = 0;
  const TOP = 0.5;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const c = r() < 0.82 ? 1 : 0;
      covered[k] = c;
      if (c === 1) coveredCount++;
      // A mix of a flat top, a ramp and a bounded random surface.
      const ramp = i < nx / 3 ? TOP : -4 - (i / nx) * 3;
      z[k] = Math.min(TOP, Math.max(-10, ramp + (r() - 0.5) * 0.2));
    }
  }
  // A vertical wall: the right third drops 4 mm.
  for (let j = 0; j < ny; j++) {
    for (let i = Math.floor(nx / 2); i < nx; i++) {
      if (covered[j * nx + i] === 1) z[j * nx + i] = Math.max(-10, (z[j * nx + i] as number) - 4);
    }
  }
  return {
    nx,
    ny,
    x0: 0,
    y0: 0,
    pitch,
    topZ: TOP,
    minZ: -10,
    z,
    covered,
    coveredCount,
    resolutionNote: 'dropTipFast1092',
  };
}

// ── The brute-force reference: the implementation this change replaces, verbatim in method — the
// disc stencil run at every covered cell, with the same out-of-grid rules. ─────────────────────
function cellSquareDistance(dx: number, dy: number, pitch: number): number {
  const ex = Math.max(0, Math.abs(dx) - pitch / 2);
  const ey = Math.max(0, Math.abs(dy) - pitch / 2);
  return Math.hypot(ex, ey);
}

function ballRise(ball: boolean, radius: number, d: number): number {
  if (!ball || radius <= 0) return 0;
  if (d >= radius) return radius;
  return radius - Math.sqrt(radius * radius - d * d);
}

function brute(hf: GoalHeightfield, tool: SurfaceTool, wrapRows: boolean): Float32Array {
  const { nx, ny, z, covered, pitch, topZ } = hf;
  const tip = new Float32Array(nx * ny);
  tip.fill(topZ);
  const span = Math.max(0, Math.ceil(tool.radius / pitch));
  const stencil: { di: number; dj: number; rise: number }[] = [];
  for (let dj = -span; dj <= span; dj++) {
    for (let di = -span; di <= span; di++) {
      const d = cellSquareDistance(di * pitch, dj * pitch, pitch);
      if (d > tool.radius) continue;
      stencil.push({ di, dj, rise: ballRise(tool.ball, tool.radius, d) });
    }
  }
  if (stencil.length === 0) stencil.push({ di: 0, dj: 0, rise: 0 });
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      if (covered[idx] === 0) continue;
      let best = -Infinity;
      for (const s of stencil) {
        const ii = i + s.di;
        const rawJ = j + s.dj;
        if (ii < 0 || ii >= nx) { best = Math.max(best, topZ - s.rise); continue; }
        if (wrapRows) {
          const jj = ((rawJ % ny) + ny) % ny;
          best = Math.max(best, (z[jj * nx + ii] as number) - s.rise);
          continue;
        }
        if (rawJ < 0 || rawJ >= ny) { best = Math.max(best, topZ - s.rise); continue; }
        best = Math.max(best, (z[rawJ * nx + ii] as number) - s.rise);
      }
      tip[idx] = best;
    }
  }
  return tip;
}

function expectBitIdentical(actual: Float32Array, expected: Float32Array, label: string): void {
  expect(actual.length, label).toBe(expected.length);
  let firstBad = -1;
  for (let k = 0; k < expected.length; k++) {
    if (!Object.is(actual[k], expected[k])) { firstBad = k; break; }
  }
  expect(firstBad, `${label}: first differing cell ${firstBad} — actual ${firstBad >= 0 ? actual[firstBad] : ''} vs expected ${firstBad >= 0 ? expected[firstBad] : ''}`).toBe(-1);
}

const CASES: { tool: SurfaceTool; label: string }[] = [
  { tool: { radius: 0.05, ball: false }, label: 'flat r=0.05 (a single cell)' },
  { tool: { radius: 0.4, ball: false }, label: 'flat r=0.4' },
  { tool: { radius: 1.5875, ball: false }, label: 'flat r=1.5875 (⌀3.175)' },
  { tool: { radius: 3, ball: false }, label: 'flat r=3' },
  { tool: { radius: 0.4, ball: true }, label: 'ball r=0.4' },
  { tool: { radius: 1.5875, ball: true }, label: 'ball r=1.5875' },
];

describe('#1092 (0f) — the flat drop-tip dilation is exact and fast', () => {
  for (const wrapRows of [false, true]) {
    for (const { tool, label } of CASES) {
      it(`bit-identical to the brute disc scan: ${label}, wrapRows=${wrapRows}`, () => {
        // A grid small enough for the brute reference to run fast, big enough that the disc
        // overhangs every border in the no-wrap case (radius 3 = 30 cells at this pitch).
        const hf = field(1000 + Math.round(tool.radius * 100) + (wrapRows ? 1 : 0), 61, 47, 0.1);
        const fast = finishTipField(hf, tool, Number.POSITIVE_INFINITY, { wrapRows });
        expectBitIdentical(fast, brute(hf, tool, wrapRows), `${label} wrap=${wrapRows}`);
      });
    }
  }

  it('the flat field fits the budget in the NEW unit (cells × rows): the old covered × stencil count would refuse', () => {
    const hf = field(7, 700, 700, 0.1);
    const tool: SurfaceTool = { radius: 1.5875, ball: false };
    const rows = discRowCountFor(tool.radius, hf.pitch);
    const opsNew = tipFieldOpsFor(tool, hf.nx, hf.ny, hf.coveredCount, hf.pitch);
    expect(rows).toBe(33);
    expect(opsNew).toBe(hf.nx * hf.ny * rows);
    // The old unit refuses this field; the new one plans it (the old implementation threw here).
    expect(hf.coveredCount * stencilCellsFor(tool.radius, hf.pitch)).toBeGreaterThan(DEFAULT_MAX_FINISH_TIP_OPS);
    expect(maxTipOpsFor(tool)).toBe(DEFAULT_MAX_FINISH_TIP_ROW_OPS);
    expect(opsNew).toBeLessThan(maxTipOpsFor(tool));
    const tip = finishTipField(hf, tool, opsNew, { wrapRows: false });
    expect(tip.length).toBe(hf.nx * hf.ny);
  });

  it('the ball keeps the stencil unit until its own fast path lands', () => {
    const hf = field(8, 120, 90, 0.1);
    const tool: SurfaceTool = { radius: 1.5875, ball: true };
    expect(tipFieldOpsFor(tool, hf.nx, hf.ny, hf.coveredCount, hf.pitch)).toBe(hf.coveredCount * stencilCellsFor(tool.radius, hf.pitch));
    expectBitIdentical(finishTipField(hf, tool, Number.POSITIVE_INFINITY), brute(hf, tool, false), 'ball');
  });
});
