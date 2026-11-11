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
import { traceShadowSelection, type ShadowInput } from '@/engine/cnc/cam/fields/shadowSelector';
import type { TraceRow } from '../../tools/plan-counts/summarize';
import { tl } from './helpers/manifoldExec';

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
    offset: makeClipperOffset(tl),
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
    const without = planFace();
    expect(JSON.stringify(without)).toBe(JSON.stringify(withTrace));
  });
});
