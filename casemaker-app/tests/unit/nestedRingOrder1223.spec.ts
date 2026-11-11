/**
 * #1223 (planner v3 A4) — FINISH ONE LOBE OF A POCKET BEFORE THE NEXT. The ordering function's
 * eight orders are the issue's, run against the real `tourNearest`; never edited. The planner-level
 * case cuts a dumbbell once and counts the rapids the old step-by-step order paid for.
 */
import { describe, expect, it } from 'vitest';
import { nestedRingOrder, pocket, type PocketOpOptions } from '@/engine/cnc/cam/model/ops/pocket';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import type { PocketNode } from '@/engine/cnc/cam/model/features';
import type { RegionRef } from '@/engine/cnc/cam/model/plan';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { RapidEstimate } from '@/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { tl } from './helpers/manifoldExec';

/** An axis-aligned square ring from (x0, y0) to (x1, y1), first vertex at (x0, y0). */
const sq = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const BIG = sq(0, 0, 40, 20);
const A1 = sq(2, 2, 18, 18);
const B1 = sq(22, 2, 38, 18);
const A2 = sq(4, 4, 16, 16);
const B2 = sq(24, 4, 36, 16);
const A3 = sq(6, 6, 14, 14);
const names = new Map<unknown, string>([[BIG, 'BIG'], [A1, 'A1'], [B1, 'B1'], [A2, 'A2'], [B2, 'B2'], [A3, 'A3']]);
const order = (steps: [number, number][][][], from: [number, number]): string[] => nestedRingOrder(steps, from).map((r) => names.get(r.loop)!);

describe('#1223 — nestedRingOrder', () => {
  it('A: one lobe is finished before the next', () => {
    expect(order([[BIG], [A1, B1], [A2, B2]], [0, 0])).toEqual(['BIG', 'A1', 'A2', 'B1', 'B2']);
  });

  it('B: the walk continues from BIG’s own first vertex, not from the start point', () => {
    expect(order([[BIG], [A1, B1], [A2, B2]], [40, 0])).toEqual(['BIG', 'A1', 'A2', 'B1', 'B2']);
  });

  it('C: a deeper lobe is still finished first', () => {
    expect(order([[BIG], [A1, B1], [A2, B2], [A3]], [0, 0])).toEqual(['BIG', 'A1', 'A2', 'A3', 'B1', 'B2']);
  });

  it('D: two separate pockets at the outer step — the nearer one first', () => {
    expect(order([[A1, B1], [A2, B2]], [39, 0])).toEqual(['B1', 'B2', 'A1', 'A2']);
  });

  it('E: one ring per step keeps the step order', () => {
    expect(order([[BIG], [A1], [A2], [A3]], [0, 0])).toEqual(['BIG', 'A1', 'A2', 'A3']);
  });

  it('F: the step index travels with the ring', () => {
    expect(nestedRingOrder([[BIG], [A1, B1], [A2, B2]], [0, 0]).map((r) => r.stepIndex)).toEqual([0, 1, 2, 1, 2]);
  });

  it('G: every ring appears exactly once', () => {
    const rings = nestedRingOrder([[BIG], [A1, B1], [A2, B2], [A3]], [0, 0]);
    expect(rings).toHaveLength(6);
    expect(new Set(rings.map((r) => names.get(r.loop))).size).toBe(6);
  });

  it('H: nothing in, nothing out', () => {
    expect(nestedRingOrder([], [0, 0])).toEqual([]);
    expect(nestedRingOrder([[]], [0, 0])).toEqual([]);
  });
});

describe('#1223 — a split pocket has fewer retracts', () => {
  it('the dumbbell’s rapids are at most 12', () => {
    // Two 20 × 20 squares joined by a 30 mm long, 6 mm wide neck; ⌀3.175 flat, 0.8 mm step-over,
    // one level. The rings split into two lobes as they move inward.
    const dumbbell: Polygons = [[
      [0, 5], [20, 5], [20, 12], [50, 12], [50, 5], [70, 5], [70, 25], [50, 25], [50, 18], [20, 18], [20, 25], [0, 25],
    ]];
    const cutter: Tool = flatEndMill(3.175, { number: 1, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 20 });
    const node: PocketNode = {
      id: 'dumbbell', floorZ: -2, mouthZ: 0, open: false,
      region: dumbbell, floors: [], islands: [], children: [], remainder: [], narrowest: 6, through: false,
    };
    const region: RegionRef = {
      id: 'dumbbell', kind: 'pocket', bounds: { min: [0, 5], max: [70, 25] }, topZ: 0, bottomZ: -2,
      obstacles: [], regionClearanceZ: 5,
    };
    const rapid: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
    const opts: PocketOpOptions = {
      cutter, node, region, stepOverMm: 0.8, stepDownMm: 5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      offset: makeClipperOffset(tl), safeZMm: 10, hopZMm: 3,
      toolNumber: 1, spindleRpm: 12000, air: true, rapid,
    };
    const out = pocket(opts);
    const moves = out.ir.operations[0]!.moves;
    const rapids = moves.filter((m) => m.kind === 'rapid');
    expect(rapids.length, `rapid moves: ${rapids.length}`).toBeLessThanOrEqual(12);
  }, 60_000);
});
