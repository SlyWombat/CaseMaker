// #961 — THE CUTTER SEQUENCE, CHOSEN BY COST (red-first).
//
// The tray's reference is the bar: Makera runs 4 cutters (⌀6 flat, ⌀3.175 flat, ⌀6 ball, 90°
// chamfer) in 47.6 min. This slice chooses the sequence; the ops that build each step's moves are
// #959/#960's, so the tests price with a stand-in `planStep` whose IR size stands for an op's work.
// The cost arithmetic is the real one: #927's terms on the posted moves + the shop's
// `toolChange.seconds` per change after the loaded first cutter (#858's model).
import { describe, expect, it } from 'vitest';

import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import {
  estimateCycleTerms,
  type CamMove,
  type RapidEstimate,
  type ToolpathIR,
} from '@/engine/cnc/cam/ir';
import {
  candidateSequences,
  chooseSequence,
  cutterKeyOf,
  priceSequence,
  type SequenceDemand,
  type SequenceOptions,
  type SequenceStep,
} from '@/engine/cnc/cam/model/sequence';

const RAPID: RapidEstimate = {
  xyMmPerMin: 1200,
  zMmPerMin: 600,
  accelMmPerS2: 150,
  spinUpSeconds: 12,
  source: 'test',
};

const TOOL_CHANGE_SECONDS = 91.4;

// --- cutters ---------------------------------------------------------------------------------

function flat(id: string, diameter: number, opts: Partial<Tool> = {}): Tool {
  return flatEndMill(diameter, { id, name: `${diameter} mm flat (${id})`, number: 1, ...opts });
}

function ball(id: string, diameter: number, opts: Partial<Tool> = {}): Tool {
  return flatEndMill(diameter, {
    id,
    name: `${diameter} mm ball (${id})`,
    number: 1,
    shape: 'ball',
    typeText: 'Ball End',
    ...opts,
  });
}

function chamfer(id: string, diameter: number, angle: number, opts: Partial<Tool> = {}): Tool {
  return flatEndMill(diameter, {
    id,
    name: `${angle}° chamfer (${id})`,
    number: 1,
    shape: 'chamfer',
    typeText: 'Chamfer',
    angle,
    halfAngle: angle / 2,
    ...opts,
  });
}

const VENDOR = {
  flat6: flat('t6', 6, { fluteLength: 30 }),
  flat3: flat('t3', 3.175, { fluteLength: 20 }),
  ball6: ball('b6', 6, { fluteLength: 30 }),
  chamfer: chamfer('c90', 3.175, 90, { tipDiameter: 0.1 }),
};

/** The tray's demand as the feature tree will hand it over: slots with a 3.175 corner and a 7 mm
 *  opening, a scoop curved at 30 mm, and the rim the chamfer breaks. */
const TRAY: SequenceDemand = {
  features: [
    { id: 'slots', kind: 'pocket', cornerRadiusMm: 1.5875, minOpeningMm: 7, depthMm: 10 },
    { id: 'scoop', kind: 'curved', curvatureRadiusMm: 30, depthMm: 27 },
    { id: 'rim', kind: 'rim', depthMm: 0 },
  ],
  scallopMm: 0.05,
};

// --- a stand-in op planner -------------------------------------------------------------------

/** A program whose size stands for an op's work: N feed moves along X, 10 mm apart. */
function ir(tool: Tool, moves: number): ToolpathIR {
  const list: CamMove[] = [{ kind: 'feed', x: 0, y: 0, z: -1, f: 600 }];
  for (let i = 1; i <= moves; i++) list.push({ kind: 'feed', x: i * 10, y: 0, z: -1, f: 600 });
  return {
    frame: 'flat',
    tool,
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    safeZ: 5,
    hopZ: 2,
    operations: [
      { number: 1, name: tool.name, labelId: 'op', depth: 1, moves: list, estimatedSeconds: 0 },
    ],
  };
}

const WORK: Record<string, number> = {
  'pocket:t6': 30,
  'rest:t3': 20,
  'finish:b6': 10,
  'chamfer:c90': 5,
  // A ball roughing what a flat should cut, a too-small cutter finishing, and so on: dearer.
  'pocket:b6': 100,
  'rough:b6': 100,
  'finish:b3': 60,
};

function standIn(step: SequenceStep): ToolpathIR {
  return ir(step.cutter.tool, WORK[`${step.kind}:${step.cutter.key}`] ?? 50);
}

function opts(over: Partial<SequenceOptions> = {}): SequenceOptions {
  return {
    rapid: RAPID,
    toolChangeSeconds: TOOL_CHANGE_SECONDS,
    planStep: standIn,
    ...over,
  };
}

describe('#961 candidate sequences', () => {
  it('builds the vendor-shaped family: largest flat, rest flat, ball, chamfer', () => {
    const candidates = candidateSequences(TRAY, { house: Object.values(VENDOR), catalogue: [] });
    const keys = candidates.map((c) => c.steps.map((s) => s.cutter.key).join('+'));
    expect(keys).toContain('t6+t6+t3+b6+c90');
  });

  it('prunes a flat wider than the opening, and one too short to reach the floor', () => {
    const wide = flat('too-wide', 8, { fluteLength: 30 }); // 8 > the 7 mm opening
    const short = flat('too-short', 3, { fluteLength: 5 }); // 5 < the 10 mm pocket
    const candidates = candidateSequences(TRAY, {
      house: [VENDOR.flat6, wide, short, VENDOR.flat3, VENDOR.ball6, VENDOR.chamfer],
      catalogue: [],
    });
    const used = new Set(candidates.flatMap((c) => c.steps.map((s) => s.cutter.key)));
    expect(used.has('too-wide')).toBe(false);
    expect(used.has('too-short')).toBe(false);
  });

  it('never uses a rest flat wider than the pocket corner', () => {
    const candidates = candidateSequences(TRAY, { house: Object.values(VENDOR), catalogue: [] });
    for (const c of candidates) {
      for (const step of c.steps) {
        if (step.kind === 'rest') {
          expect((step.cutter.tool.tipDiameter ?? 0) / 2).toBeLessThanOrEqual(1.5875 + 1e-9);
        }
      }
    }
  });

  it('never puts a ball in a roughing step when a flat fits', () => {
    const candidates = candidateSequences(TRAY, { house: Object.values(VENDOR), catalogue: [] });
    for (const c of candidates) {
      for (const step of c.steps) {
        if (step.kind === 'pocket' || step.kind === 'rough' || step.kind === 'rest') {
          expect(step.cutter.tool.shape).toBe('flat');
        }
      }
    }
  });
});

describe('#961 choose by cost', () => {
  it("picks the tray's vendor set in order, ≤ vendor + 1 cutters", () => {
    const choice = chooseSequence(TRAY, { house: Object.values(VENDOR), catalogue: [] }, opts());
    const cutters = [...new Set(choice.steps.map((s) => s.cutter.key))];
    expect(cutters).toEqual(['t6', 't3', 'b6', 'c90']);
    expect(choice.steps.map((s) => s.kind)).toEqual(['pocket', 'rough', 'rest', 'finish', 'chamfer']);
    expect(cutters.length).toBeLessThanOrEqual(4 + 1);
    expect(choice.steps.every((s) => s.cutter.house)).toBe(true);
  });

  it('cost = #927 terms on the posted moves + toolChange.seconds per change after the first', () => {
    const candidates = candidateSequences(TRAY, { house: Object.values(VENDOR), catalogue: [] });
    const vendor = candidates.find((c) => c.steps.map((s) => s.cutter.key).join('+') === 't6+t6+t3+b6+c90')!;
    const cost = priceSequence(vendor, opts());
    expect(cost).not.toBeNull();
    const terms = vendor.steps.map((s) => estimateCycleTerms(standIn(s), RAPID).totalSeconds);
    expect(cost!.toolChanges).toBe(3); // the first cutter is loaded; three swaps
    expect(cost!.totalSeconds).toBeCloseTo(
      terms.reduce((a, b) => a + b, 0) + 3 * TOOL_CHANGE_SECONDS,
      6,
    );
  });

  it('prices every candidate the same way and returns the cheapest that posts', () => {
    const ball3 = ball('b3', 3, { fluteLength: 30 });
    const choice = chooseSequence(
      TRAY,
      { house: [...Object.values(VENDOR), ball3], catalogue: [] },
      opts(),
    );
    const costs = choice.considered
      .map((c) => c.cost)
      .filter((c): c is number => c !== null);
    expect(costs.length).toBeGreaterThan(1);
    expect(Math.min(...costs)).toBeCloseTo(choice.cost.totalSeconds, 6);
  });

  it('prefers a house cutter over a cheaper catalogue one', () => {
    const cheapCatalogue = flat('cat6', 6, { fluteLength: 25 });
    const choice = chooseSequence(
      TRAY,
      { house: Object.values(VENDOR), catalogue: [cheapCatalogue] },
      opts({
        planStep: (step) =>
          ir(step.cutter.tool, step.cutter.house ? WORK[`${step.kind}:${step.cutter.key}`] ?? 50 : 1),
      }),
    );
    // The catalogue cutter would be nearly free, but the shop owns the set it is cutting with.
    expect(choice.steps.every((s) => s.cutter.house)).toBe(true);
  });

  it('falls to the catalogue when no house cutter can do the work', () => {
    const houseWide = flat('t6-wide', 8, { fluteLength: 30 }); // cannot pass the 7 mm opening
    const choice = chooseSequence(
      TRAY,
      { house: [houseWide, VENDOR.ball6], catalogue: [VENDOR.flat3, VENDOR.flat6, VENDOR.chamfer] },
      opts(),
    );
    expect(choice.steps.some((s) => !s.cutter.house)).toBe(true);
  });

  it('ranks a rowed-feed cutter before a fallback-fed one at equal work', () => {
    const rowed = flat('t6-row', 6, { fluteLength: 30 });
    const fallback = flat('t6-fallback', 6, { fluteLength: 30 });
    const choice = chooseSequence(
      TRAY,
      { house: [rowed, fallback, VENDOR.flat3, VENDOR.ball6, VENDOR.chamfer], catalogue: [] },
      opts({ feedsKind: (tool) => (tool.id === 't6-fallback' ? 'fallback' : 'row') }),
    );
    expect(choice.steps[0]!.cutter.key).toBe('t6-row');
    expect(choice.steps[0]!.cutter.feeds).toBe('row');
  });

  it('honours a pinned cutter key and labels it pinned', () => {
    const ball3 = ball('b3', 3, { fluteLength: 30 });
    const choice = chooseSequence(
      TRAY,
      {
        house: [VENDOR.flat6, VENDOR.flat3, VENDOR.ball6, ball3, VENDOR.chamfer],
        catalogue: [],
        pinned: { finish: 'b3' },
      },
      opts(),
    );
    const finish = choice.steps.find((s) => s.kind === 'finish')!;
    expect(finish.cutter.key).toBe('b3');
    expect(finish.cutter.pinned).toBe(true);
  });

  it('calls planStep only for candidates that survived the geometry prune', () => {
    const planned: string[] = [];
    chooseSequence(
      TRAY,
      {
        house: [VENDOR.flat6, VENDOR.flat3, VENDOR.ball6, VENDOR.chamfer,
          flat('too-wide', 8, { fluteLength: 30 }), flat('too-short', 3, { fluteLength: 5 })],
        catalogue: [],
      },
      opts({
        planStep: (step) => {
          planned.push(step.cutter.key);
          return standIn(step);
        },
      }),
    );
    expect(planned).not.toContain('too-wide');
    expect(planned).not.toContain('too-short');
  });

  it('skips a candidate whose op cannot be planned, and refuses when none can', () => {
    const ball3 = ball('b3', 3, { fluteLength: 30 });
    const choice = chooseSequence(
      TRAY,
      { house: [VENDOR.flat6, VENDOR.flat3, VENDOR.ball6, ball3, VENDOR.chamfer], catalogue: [] },
      opts({
        planStep: (step) => (step.cutter.key === 'b6' ? null : standIn(step)),
      }),
    );
    expect(choice.steps.some((s) => s.cutter.key === 'b6')).toBe(false);
    expect(choice.steps.find((s) => s.kind === 'finish')!.cutter.key).toBe('b3');

    expect(() =>
      chooseSequence(TRAY, { house: Object.values(VENDOR), catalogue: [] }, opts({ planStep: () => null })),
    ).toThrow(/no cutter sequence can be planned/);
  });

  it('refuses when the demand has a rim but no chamfer cutter is usable', () => {
    expect(() =>
      chooseSequence(
        TRAY,
        { house: [VENDOR.flat6, VENDOR.flat3, VENDOR.ball6], catalogue: [] },
        opts(),
      ),
    ).toThrow(/no cutter sequence can be planned|no .*chamfer/i);
  });
});

describe('#961 keys', () => {
  it('keys a cutter by its id, falling back to its name', () => {
    expect(cutterKeyOf(VENDOR.flat6)).toBe('t6');
    expect(cutterKeyOf(flatEndMill(2))).toContain('2');
  });
});
