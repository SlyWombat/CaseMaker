/**
 * #1242 (planner v3 C3) — THE SHORTLIST: the K best-estimated chains get a real plan.
 *
 * `shortlistOf` applies the estimate's own order (leftover to a hundredth of a mm², then seconds,
 * then signature) and keeps the first K; a chain the estimate could not price is always kept,
 * because the estimate has no opinion on it. Order of the result = order of the input. `k <= 0`
 * keeps everything (the setting off).
 */
import { describe, expect, it } from 'vitest';

import { shortlistOf } from '@/engine/cnc/cam/fields/shortlist';

const C = ['A', 'B', 'C', 'D', 'E', 'F'].map((signature) => ({ signature }));
const EST = new Map([
  ['A', { leftoverMm2: 10, totalSeconds: 100, unpriced: 0 }],
  ['B', { leftoverMm2: 10, totalSeconds: 90, unpriced: 0 }],
  ['C', { leftoverMm2: 10.004, totalSeconds: 50, unpriced: 0 }],
  ['D', { leftoverMm2: 20, totalSeconds: 10, unpriced: 0 }],
  ['E', { leftoverMm2: 5, totalSeconds: 500, unpriced: 0 }],
  ['F', { leftoverMm2: 1, totalSeconds: 1, unpriced: 2 }],
]);
const signs = (list: readonly { signature: string }[]): string[] => list.map((c) => c.signature);

describe('#1242 shortlistOf', () => {
  it('k = 2 keeps E and C by the estimate’s order and F because it is unpriced, in input order', () => {
    expect(signs(shortlistOf(C, EST, 2))).toEqual(['C', 'E', 'F']);
  });

  it('k = 3 adds B', () => {
    expect(signs(shortlistOf(C, EST, 3))).toEqual(['B', 'C', 'E', 'F']);
  });

  it('k = 0 keeps all six; k = 6 and k = 50 keep all six too', () => {
    expect(signs(shortlistOf(C, EST, 0))).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(signs(shortlistOf(C, EST, 6))).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(signs(shortlistOf(C, EST, 50))).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('a candidate with no estimate is kept', () => {
    const withoutD = new Map([...EST].filter(([key]) => key !== 'D'));
    expect(signs(shortlistOf(C, withoutD, 1))).toEqual(['D', 'E', 'F']);
  });

  it('the input array is not reordered', () => {
    const before = signs(C);
    shortlistOf(C, EST, 2);
    expect(signs(C)).toEqual(before);
  });

  it('equal rounded leftovers are ordered by seconds, then signature', () => {
    // A, B and C round to the same hundredth; E is the least leftover, so the first four are
    // E, C (50 s), B (90 s), A (100 s) — and D, the last by leftover, is the one dropped.
    expect(signs(shortlistOf(C, EST, 4))).toEqual(['A', 'B', 'C', 'E', 'F']);
  });
});

// #1242 — THE ESTIMATE IS ITS OWN PURE FUNCTION. The shortlist reads it before any chain is
// planned for real; the tracing wrapper must write exactly the rows it wrote before the split.
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import type { CutterCandidates, SequenceDemand } from '@/engine/cnc/cam/model/sequence';
import type { CutParams } from '@/engine/cnc/feeds';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { setMemTraceSink } from '@/engine/cnc/memTrace';
import { estimateCandidates, traceShadowSelection, type ShadowInput } from '@/engine/cnc/cam/fields/shadowSelector';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { TraceRow } from '../../tools/plan-counts/summarize';
import { tl } from './helpers/manifoldExec';

function flatTool(id: string, diameter: number): Tool {
  return flatEndMill(diameter, { id, name: `${diameter} mm flat (${id})`, number: 1, fluteLength: 30 });
}

const F_CUTTERS: CutterCandidates = { house: [flatTool('t6', 6), flatTool('t3', 3.175)], catalogue: [] };
const F_DEMAND: SequenceDemand = {
  features: [{ id: 'p1', kind: 'pocket', cornerRadiusMm: 1.5875, minOpeningMm: 7, depthMm: 6 }],
};
const F_NECK: Polygons = [
  [
    [0, 0], [10, 0], [10, 1.25], [16, 1.25], [16, 0], [26, 0],
    [26, 10], [16, 10], [16, 8.75], [10, 8.75], [10, 10], [0, 10],
  ],
];
const F_ROW: CutParams = { rpm: 10000, feed: 600, plungeFeed: 300, stepDown: 2, stepOver: 1.5, peck: 0, air: true };

function fixture(over: Partial<ShadowInput> = {}): ShadowInput {
  return {
    demand: F_DEMAND,
    cutters: F_CUTTERS,
    candidateOpts: {},
    regions: new Map([['p1', F_NECK]]),
    offset: makeClipperOffset(tl),
    paramsFor: () => F_ROW,
    changePrice: () => 91.4,
    considered: [],
    chosenSignature: 'pocket:t6',
    contourPerimeterMm: 0,
    ...over,
  };
}

function captureRows(run: () => void): TraceRow[] {
  const rows: TraceRow[] = [];
  setMemTraceSink((line) => rows.push(JSON.parse(line) as TraceRow));
  try {
    run();
  } finally {
    setMemTraceSink(null);
  }
  return rows;
}

describe('#1242 estimateCandidates', () => {
  it('returns one estimate per candidate, with the numbers the shadow:candidate rows carry', () => {
    const input = fixture();
    const computed = estimateCandidates(input);
    expect(computed.estimates.length).toBe(computed.candidates.length);
    expect(computed.estimates.length).toBeGreaterThanOrEqual(1);
    expect(computed.pockets).toBe(1);
    const rows = captureRows(() => traceShadowSelection(input));
    for (const { signature, est } of computed.estimates) {
      const row = rows.find((r) => r.stage === 'shadow:candidate' && r.signature === signature);
      expect(row, `no shadow:candidate row for ${signature}`).toBeDefined();
      const round3 = (v: number): number => Math.round(v * 1000) / 1000;
      expect(row!.estSeconds).toBe(round3(est.totalSeconds));
      expect(row!.estCutSeconds).toBe(round3(est.cutSeconds));
      expect(row!.estChanges).toBe(est.changes);
      expect(row!.estLeftoverMm2).toBe(round3(est.leftoverMm2));
      expect(row!.unpriced).toBe(est.unpriced);
    }
  });

  it('a caller-supplied estimate writes the same rows as one computed inside the wrapper', () => {
    const computed = estimateCandidates(fixture());
    const without = captureRows(() => traceShadowSelection(fixture()));
    const withEstimates = captureRows(() => traceShadowSelection(fixture({ estimates: computed })));
    // Timing and memory fields are the only things that may differ between two runs.
    const SEMANTIC = [
      'stage', 'signature', 'estSeconds', 'estCutSeconds', 'estChanges', 'estLeftoverMm2',
      'unpriced', 'realSeconds', 'realEstimateSeconds', 'realLeftoverCells', 'realRank',
      'estEntries', 'shadow', 'real', 'agree', 'candidates', 'pockets',
    ] as const;
    const strip = (rows: TraceRow[]): unknown[] =>
      rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const key of SEMANTIC) if (key in row) out[key] = row[key];
        return out;
      });
    expect(strip(withEstimates)).toEqual(strip(without));
  });
});

import { shortlistNote, shortlistOf as shortlistAgain } from '@/engine/cnc/cam/fields/shortlist';

describe('#1242 shortlistNote', () => {
  it('names what was worked out when the shortlist dropped anything', () => {
    expect(shortlistNote({ candidates: 23, kept: 8 })).toBe(
      'The planner worked out 8 of 23 possible sets of cutters in full, the most promising by estimate (a shop setting).',
    );
  });

  it('is absent when nothing was dropped', () => {
    expect(shortlistNote({ candidates: 8, kept: 8 })).toBeNull();
    expect(shortlistNote({ candidates: 3, kept: 8 })).toBeNull();
  });

  it('the module still exports the selection', () => {
    expect(typeof shortlistAgain).toBe('function');
  });
});
