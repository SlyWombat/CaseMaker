/**
 * #1216 (planner v3, slice 3) — THE SELECTOR IN SHADOW.
 *
 * `traceShadowSelection` prices the candidate chains from the fields and writes what it would
 * choose beside what the real planner chose. It changes no decision: with no trace sink it writes
 * nothing, and the plan it runs beside is byte-identical with and without a trace.
 */
import { describe, expect, it } from 'vitest';

import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import type { FeatureTree, PocketNode } from '@/engine/cnc/cam/model/features';
import { planPocketsForTree, type PlanPocketsResult } from '@/engine/cnc/cam/model/plan';
import {
  candidateSequences,
  type ConsideredSequence,
  type CutterCandidates,
  type SequenceDemand,
} from '@/engine/cnc/cam/model/sequence';
import type { CutParams } from '@/engine/cnc/feeds';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { setMemTraceSink } from '@/engine/cnc/memTrace';
import { Z1 } from '@/engine/cnc/machine';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import {
  SHORTLIST_SIZES,
  shortlistReport,
  traceShadowSelection,
  type ShadowInput,
  type ShortlistRow,
} from '@/engine/cnc/cam/fields/shadowSelector';
import type { TraceRow } from '../../tools/plan-counts/summarize';
import { tl } from './helpers/manifoldExec';
import { DEFAULT_RELEASE_TABS } from '@/engine/cnc/cam/model/plan';

function flat(id: string, diameter: number, opts: Partial<Tool> = {}): Tool {
  return flatEndMill(diameter, { id, name: `${diameter} mm flat (${id})`, number: 1, ...opts });
}

const T6 = flat('t6', 6, { fluteLength: 30 });
const T3 = flat('t3', 3.175, { fluteLength: 20 });
const CUTTERS: CutterCandidates = { house: [T6, T3], catalogue: [] };

const DEMAND: SequenceDemand = {
  features: [{ id: 'p1', kind: 'pocket', cornerRadiusMm: 1.5875, minOpeningMm: 7, depthMm: 6 }],
};

/** #1215's dumbbell with a 7.5 mm neck, so the ⌀6 enters: two 10 × 10 squares joined by the bar. */
const NECK75: Polygons = [
  [
    [0, 0], [10, 0], [10, 1.25], [16, 1.25], [16, 0], [26, 0],
    [26, 10], [16, 10], [16, 8.75], [10, 8.75], [10, 10], [0, 10],
  ],
];

const ROW: CutParams = { rpm: 10000, feed: 600, plungeFeed: 300, stepDown: 2, stepOver: 1.5, peck: 0, air: true };

function input(over: Partial<ShadowInput> = {}): ShadowInput {
  return {
    demand: DEMAND,
    cutters: CUTTERS,
    candidateOpts: {},
    regions: new Map([['p1', NECK75]]),
    offset: makeClipperOffset(tl),
    paramsFor: () => ROW,
    changePrice: () => 91.4,
    considered: [],
    chosenSignature: 'pocket:t6',
    // #1225 — the contour's outline length; 0 keeps this fixture's steps contour-free.
    contourPerimeterMm: 0,
    ...over,
  };
}

function capture(run: () => void): TraceRow[] {
  const rows: TraceRow[] = [];
  setMemTraceSink((line) => rows.push(JSON.parse(line) as TraceRow));
  try {
    run();
  } finally {
    setMemTraceSink(null);
  }
  return rows;
}

describe('#1216 traceShadowSelection', () => {
  it('writes one candidate row per chain and one choice row', () => {
    const rows = capture(() => traceShadowSelection(input()));
    const candidates = candidateSequences(DEMAND, CUTTERS, {});
    const candidateRows = rows.filter((r) => r.stage === 'shadow:candidate');
    expect(candidateRows).toHaveLength(candidates.length);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const choice = rows.filter((r) => r.stage === 'shadow:choice');
    expect(choice).toHaveLength(1);
    expect(choice[0]!.candidates).toBe(candidates.length);
    expect(choice[0]!.pockets).toBe(1);
    expect(candidateRows.every((r) => r.realSeconds === -1)).toBe(true);
    expect(candidateRows.every((r) => typeof r.estLeftoverMm2 === 'number' && (r.estLeftoverMm2 as number) >= 0)).toBe(true);
    // #1225 — every candidate row carries its per-cutter estimate, parseable and non-empty.
    for (const r of candidateRows) {
      expect(typeof r.estEntries).toBe('string');
      const parsed = JSON.parse(r.estEntries as string) as unknown[];
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThanOrEqual(1);
    }
    // #1231 — one shadow:shortlist row per size, in SHORTLIST_SIZES order, after the choice row.
    const choiceIndex = rows.findIndex((r) => r.stage === 'shadow:choice');
    const shortlistRows = rows.slice(choiceIndex + 1).filter((r) => r.stage === 'shadow:shortlist');
    expect(shortlistRows.map((r) => r.k)).toEqual([...SHORTLIST_SIZES]);
    expect(rows.filter((r) => r.stage === 'shadow:shortlist')).toHaveLength(SHORTLIST_SIZES.length);
  });

  it('with no trace sink it writes nothing and does not throw', () => {
    setMemTraceSink(null);
    expect(traceShadowSelection(input())).toBeUndefined();
  });

  it('a feed row that throws gives an unpriced step, not an error', () => {
    const rows = capture(() =>
      traceShadowSelection(
        input({
          paramsFor: () => {
            throw new Error('no row');
          },
        }),
      ),
    );
    const candidateRows = rows.filter((r) => r.stage === 'shadow:candidate');
    expect(candidateRows.length).toBeGreaterThanOrEqual(1);
    expect(candidateRows.every((r) => (r.unpriced as number) >= 1)).toBe(true);
    expect(rows.filter((r) => r.stage === 'shadow:choice')).toHaveLength(1);
  });

  it('it matches a real row by signature', () => {
    const first = candidateSequences(DEMAND, CUTTERS, {})[0]!;
    const sig = first.steps.map((s) => `${s.kind}:${s.cutter.key}`).join('+');
    const considered: ConsideredSequence = {
      steps: first.steps.map((s) => ({ kind: s.kind, cutterKey: s.cutter.key })),
      cost: 123.4,
      estimateSeconds: null,
      toolChanges: 0,
      unreachable: 0,
      rank: 1,
      catalogueSteps: 0,
      fallbackSteps: 0,
      leftoverCells: null,
      coveredCells: null,
      restPrice: null,
      leftBehind: 0,
      unplanned: 0,
      reason: '',
    };
    const rows = capture(() => traceShadowSelection(input({ considered: [considered] })));
    const candidateRows = rows.filter((r) => r.stage === 'shadow:candidate');
    const matched = candidateRows.find((r) => r.signature === sig);
    expect(matched, 'no candidate row carried the real chain’s signature').toBeDefined();
    expect(matched!.realSeconds).toBe(123.4);
    for (const row of candidateRows) if (row.signature !== sig) expect(row.realSeconds).toBe(-1);
  });
});

// ── the planner-level test: the shadow is trace-only ──────────────────────────────────────────
const FLAT6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });

/** #943's 40 × 20 plate with one 10 × 10 pocket and 0.8 mm of skin — copied unchanged. */
function facingTree(skinMm: number): FeatureTree {
  const outline: [number, number][][] = [[[0, 0], [40, 0], [40, 20], [0, 20]]];
  const pocketRect: [number, number][][] = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
  const partTop = -skinMm;
  const floorZ = partTop - 3;
  const node: PocketNode = {
    id: 'p', floorZ, mouthZ: partTop, open: false, through: false,
    region: pocketRect, floors: [{ polygons: pocketRect, area: 100 }],
    islands: [], children: [], remainder: [], narrowest: 10,
  };
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop, partBottom: floorZ },
    levels: [floorZ],
    top: { z: partTop, floors: [], area: 0 },
    contour: { outline, area: 800, zTo: floorZ, frees: true, shoulders: [] },
    pockets: [node],
    rims: [],
    remainder: [],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 800, remainderArea: 0, tolerances: {} as never, slivers: [], notes: [] },
  };
}

function planFace(): PlanPocketsResult {
  return planPocketsForTree(facingTree(0.8), {
    tabs: DEFAULT_RELEASE_TABS, offset: makeClipperOffset(tl),
    houseFlats: [FLAT6],
    stepDownMm: 1.0,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid: Z1.rapidEstimate,
    toolChangeSeconds: 12,
    spindleRpm: 12000,
    air: true,
    boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
    facing: 'on',
  });
}

describe('#1216 the planner runs the shadow only with a trace on', () => {
  it('the planner writes shadow rows only when a trace is on, and the plan is identical', () => {
    let withTrace!: PlanPocketsResult;
    const rows = capture(() => {
      withTrace = planFace();
    });
    expect(rows.some((r) => r.stage === 'shadow:choice' || r.stage === 'shadow:error')).toBe(true);
    expect(rows.filter((r) => r.stage === 'shadow:error')).toHaveLength(0);
    // #1225 — the real planner's own per-cutter price rows are in the same trace.
    const priced = rows.filter((r) => r.stage === 'chain:price');
    expect(priced.length).toBeGreaterThanOrEqual(1);
    const entries = JSON.parse(priced[0]!.entries as string) as unknown[];
    expect(Array.isArray(entries)).toBe(true);
    expect((entries[0] as unknown[]).length).toBe(3);
    const without = planFace();
    expect(JSON.stringify(without)).toBe(JSON.stringify(withTrace));
  });
});

describe('shortlistReport (#1231)', () => {
  const rows: ShortlistRow[] = [
    { signature: 'A', estLeftoverMm2: 10, estSeconds: 100, realRank: 3, realSeconds: 130 },
    { signature: 'B', estLeftoverMm2: 10, estSeconds: 90, realRank: 2, realSeconds: 120 },
    { signature: 'C', estLeftoverMm2: 10.004, estSeconds: 50, realRank: 4, realSeconds: 80 },
    { signature: 'D', estLeftoverMm2: 20, estSeconds: 10, realRank: 1, realSeconds: 60 },
    { signature: 'E', estLeftoverMm2: 5, estSeconds: 500, realRank: -1, realSeconds: -1 },
  ];

  it('orders by leftover, then time', () => {
    expect(shortlistReport(rows, [1, 2, 3, 5, 8])).toEqual([
      { k: 1, holdsRealPick: 0, bestRealRank: -1, bestRealSeconds: -1 },
      { k: 2, holdsRealPick: 0, bestRealRank: 4, bestRealSeconds: 80 },
      { k: 3, holdsRealPick: 0, bestRealRank: 2, bestRealSeconds: 120 },
      { k: 5, holdsRealPick: 1, bestRealRank: 1, bestRealSeconds: 60 },
      { k: 8, holdsRealPick: 1, bestRealRank: 1, bestRealSeconds: 60 },
    ]);
  });

  it('no rows', () => {
    expect(shortlistReport([], [1, 3])).toEqual([
      { k: 1, holdsRealPick: 0, bestRealRank: -1, bestRealSeconds: -1 },
      { k: 3, holdsRealPick: 0, bestRealRank: -1, bestRealSeconds: -1 },
    ]);
  });

  it('the input is not reordered', () => {
    shortlistReport(rows, [1, 2, 3, 5, 8]);
    expect(rows.map((r) => r.signature)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});

describe('#1249 stage 2a — the shadow:step row and the band', () => {
  const RECT20x10: Polygons = [[[0, 0], [20, 0], [20, 10], [0, 10]]];

  it('one row per pocket/rest step; the rest carries the band, the pocket zeros', () => {
    const rows = capture(() =>
      traceShadowSelection(
        input({
          demand: { features: [{ id: 'p1', kind: 'pocket', cornerRadiusMm: 1.5875, minOpeningMm: 7, depthMm: 6 }] },
          cutters: { house: [flat('t6', 6, { fluteLength: 30 }), flat('t2', 2, { fluteLength: 20 })], catalogue: [] },
          regions: new Map([['p1', RECT20x10]]),
          paramsFor: () => ROW,
          subtract: makeClipperSubtract(tl),
        }),
      ),
    );
    const steps = rows.filter((r) => r.stage === 'shadow:step');
    expect(steps.length).toBeGreaterThanOrEqual(2);
    const pocket = steps.find((r) => r.kind === 'pocket')!;
    expect(pocket.bandAreaMm2).toBe(0);
    expect(pocket.bandContourLengthMm).toBe(0);
    expect(pocket.bandPatches).toBe(0);
    expect(pocket.restSeconds).toBe(0);
    const rest = steps.find((r) => r.kind === 'rest')!;
    expect(rest.diameterMm).toBe(2);
    expect(rest.prevDiameterMm).toBe(6);
    expect(rest.bandPatches).toBe(4);
    expect(rest.bandAreaMm2 as number).toBeCloseTo(6.9064, 2);
    expect(rest.bandContourLengthMm as number).toBeCloseTo(41.1128, 1);
    // No plan rates on this input: the rest step keeps the area term.
    expect(rest.restSeconds).toBe(0);
  });

  it('stage 2b: with the plan’s rates the row carries the band term', () => {
    const rows = capture(() =>
      traceShadowSelection(
        input({
          demand: { features: [{ id: 'p1', kind: 'pocket', cornerRadiusMm: 1.5875, minOpeningMm: 7, depthMm: 6 }] },
          cutters: { house: [flat('t6', 6, { fluteLength: 30 }), flat('t2', 2, { fluteLength: 20 })], catalogue: [] },
          regions: new Map([['p1', RECT20x10]]),
          paramsFor: () => ROW,
          subtract: makeClipperSubtract(tl),
          rapid: { xyMmPerMin: 1200, zMmPerMin: 600 },
          hopClearanceMm: 1,
        }),
      ),
    );
    const rest = rows.filter((r) => r.stage === 'shadow:step').find((r) => r.kind === 'rest')!;
    expect(rest.restSeconds as number).toBeGreaterThan(0);
    // What the estimate charged the step is the band term.
    expect(rest.restSeconds).toBe(rest.cutSeconds);
  });
});
