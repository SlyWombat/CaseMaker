/**
 * #434 — the drill-bit pass as its OWN PROGRAM.
 *
 * A drill-shaped cutter is not a milling cutter: `feedsFor` and `cuttingForTrace` refuse it, the
 * region CAM would plunge it with the flat #220 path, and `concatToolpathIR` refuses two tools.
 * So the generator routes a drill's `plan.drills` through `planDrillBit` → `drillBitIR` as a
 * separate `(setup, tool)` program, and the job's drills leave program 1.
 *
 * Real Manifold, plain Node — the same harness `camDrill.spec.ts` uses. The depth checks are pure
 * `validateJob` calls; the split is the one `setupPrograms` already makes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { engraveGenerate, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, pointLength } from '@/engine/cnc/tool';
import { jobTool, setupProgramFindings, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { setupPrograms } from '@/engine/cnc/engrave/programs';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import { setInventoryEntries, resetRegistry } from '@/engine/cnc/toolRegistry';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveDrill, EngraveJob } from '@/types/engraveJob';

const DRILL_KEY = 'inv:drill-3';
const DRILL = flatEndMill(3, {
  name: '3 mm drill',
  typeText: 'Drill',
  shape: 'drill',
  tipDiameter: 3,
  diameter: 3,
  cornerRadius: null,
  angle: null,
  centreCutting: null,
});
const DRILL_ENTRY: ToolLibraryEntry = { key: DRILL_KEY, tool: DRILL, provenance: 'test' };

/** The shop's drill numbers, chosen here so a test can assert the source sentence. */
const SETTINGS = {
  peckDiameters: 1,
  peckClearanceMm: 0.5,
  pointAngleDeg: 118,
  plungeFeed: 120,
  spindleRpm: 9000,
};
const SOURCES = {
  peckDiameters: 'chosen for this test',
  peckClearanceMm: 'chosen for this test',
  pointAngleDeg: 'chosen for this test',
  plungeFeed: 'placeholder for this test',
  spindleRpm: 'placeholder for this test',
};
const SHOP: EngraveShopOpts = { drill: { settings: SETTINGS, sources: SOURCES } };
const SHOP_WITH_DRILL: EngraveShopOpts = { ...SHOP, tools: [DRILL_ENTRY] };

function hole(depth = 2, position = { x: 50, y: 30 }): EngraveDrill {
  return {
    id: `hole-${depth}-${position.x}-${position.y}`,
    kind: 'drill',
    name: `${depth} mm hole`,
    position,
    rotation: 0,
    depth,
    enabled: true,
    through: false,
  };
}

/** A legacy (no `setups[]`) job whose only work is the given drills, cut with the 3 mm drill. */
function drillJob(drills: EngraveDrill[], overrides: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, labels: [], shapes: [], drills, toolKey: DRILL_KEY, tool: DRILL, ...overrides };
}

const POINT = pointLength(3, 118);

describe('a drill bit is its own program (#434)', () => {
  it('posts, verifies, and states the point in the plan and the file', () => {
    const g = generate(tl, drillJob([hole(4)]), null, [], undefined, SHOP);
    expect(g.errors).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);

    // The facts the run sheet and the simulation read travel with the generated program.
    const facts = g.drill;
    expect(facts).not.toBeNull();
    expect(facts!.toolName).toBe('3 mm drill');
    expect(facts!.settings).toEqual(SETTINGS);
    expect(facts!.sources).toEqual(SOURCES);
    expect(facts!.simDrillPoint).toEqual({ deg: 118, source: SOURCES.pointAngleDeg });
    const plan = facts!.plans[0]!;
    expect(plan.id).toBe(hole(4).id);
    expect(plan.name).toBe('Drill "4 mm hole"');
    expect(plan.diameter).toBe(3);
    expect(plan.pointLength).toBeCloseTo(POINT, 3);
    expect(plan.tipDepth).toBeCloseTo(4 + POINT, 3);
    // One operation, the drill's own: the flat #220 CAM is not involved.
    expect(g.cam!.operations).toBe(1);
    // Every move repeats the hole centre: the cut is pure Z (the verifier's rule 9).
    for (const m of plan.moves) {
      expect(m.x).toBe(50);
      expect(m.y).toBe(30);
    }
    // Two pecks of one diameter (3 mm) reach the tip depth; the last feed is the tip, not 4 mm.
    const feeds = plan.moves.filter((m) => m.kind === 'feed');
    expect(feeds).toHaveLength(2);
    expect(feeds.at(-1)!.z).toBeCloseTo(-(4 + POINT), 3);
    // No canned cycle anywhere in the file (#184).
    expect(/\bG8[123]\b/.test(g.nc as string)).toBe(false);
    // The oracle/preview see the drill's discs at the full diameter: the region builder takes the
    // drill's `cuttingDiameter / 2` when `cuttingForTrace` refuses the bit.
    expect(g.predicted.some((p) => p.polygons.length > 0)).toBe(true);
    // The drills are in THIS program; the top-level adapter is this program for a legacy job.
    expect(g.programs).toHaveLength(1);
    expect(g.programs[0]!.drill?.plans).toHaveLength(1);
  }, 30_000);

  it('hands the plan the labelled fallback when the caller sends no drill settings', () => {
    const g = generate(tl, drillJob([hole(2)]));
    expect(g.ok).toBe(true);
    expect(g.drill!.settings.pointAngleDeg).toBe(118);
    expect(g.drill!.sources.pointAngleDeg).toBe('fallback');
    expect(g.drill!.simDrillPoint).toEqual({ deg: 118, source: 'fallback' });
  }, 30_000);
});

describe('the drill geometry in validateJob (#434)', () => {
  const point = { deg: 118, source: 'test' };

  it('holds the TIP against the blank’s floor, not the full-diameter depth', () => {
    // 12 mm stock, 1 mm minimum floor → at most 11 mm. A 10.5 mm blind hole is legal for a flat
    // cutter; the drill's tip is a point length lower, at 11.401 mm, and is refused.
    const job = drillJob([hole(10.5)]);
    const finding = validateJob(job, point).find((f) => f.code === 'depth-exceeds-stock');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('point');
  });

  it('checks the hole rim with the FULL diameter', () => {
    // A 3 mm drill at x = 1.4 runs off the left edge (1.4 − 1.5 < 0); a 2 mm flat at the same
    // centre (1.4 − 1 = 0.4) does not.
    expect(validateJob(drillJob([hole(2, { x: 1.4, y: 30 })]), point).map((f) => f.code)).toContain(
      'drill-outside-stock',
    );
    const flat = drillJob([hole(2, { x: 1.4, y: 30 })], {
      toolKey: 'flat-1.0',
      tool: flatEndMill(2, { fluteLength: 12, name: '2 mm flat' }),
    });
    expect(validateJob(flat).map((f) => f.code)).not.toContain('drill-outside-stock');
  });

  it('needs flute for the whole tip depth', () => {
    const short = { ...DRILL, fluteLength: 10 };
    const job = drillJob([hole(9.5)], { tool: short });
    // 9.5 + 0.901 = 10.401 mm past the 10 mm flute.
    const finding = validateJob(job, point).find((f) => f.code === 'drill-too-deep');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('point');
  });

  it('does not warn that a drill bit is unproven centre-cutting', () => {
    expect(validateJob(drillJob([hole(2)]), point).map((f) => f.code)).not.toContain('plunge-unproven');
  });

  it('gates a through hole on the under-board and the flute (#218)', () => {
    const through = { ...(hole(2) as Extract<EngraveDrill, { kind: 'drill' }>), through: true };

    // The shipped job has no under-board, so the cut would reach the vise.
    const bare = validateJob(drillJob([through]), point).map((f) => f.code);
    expect(bare).toContain('through-needs-board');

    // A board satisfies the board gate; the through depth is 12.3 mm, so 10 mm of flute is short.
    const short = { ...DRILL, fluteLength: 10 };
    const reach = validateJob(
      drillJob([through], { sacrificial: presetPartOnBoard(), tool: short }),
      point,
    ).map((f) => f.code);
    expect(reach).not.toContain('through-needs-board');
    expect(reach).toContain('through-tool-reach');
  });

  it('drills a through hole into the board and verifies clean (#218)', () => {
    const long = flatEndMill(3, {
      name: '3 mm drill',
      typeText: 'Drill',
      shape: 'drill',
      tipDiameter: 3,
      diameter: 3,
      cornerRadius: null,
      angle: null,
      centreCutting: null,
      fluteLength: 20,
      shoulderLength: 20,
    });
    const through = { ...(hole(2) as Extract<EngraveDrill, { kind: 'drill' }>), through: true };
    const job = drillJob([through], { sacrificial: presetPartOnBoard(), tool: long });

    const g = generate(tl, job, null, [], undefined, SHOP);
    expect(g.errors).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    // The FULL DIAMETER clears the underside by the breakthrough; the point goes deeper still.
    const plan = g.drill!.plans[0]!;
    expect(plan.tipDepth).toBeCloseTo(12 + 0.3 + plan.pointLength, 3);
  });

  it('refuses a legacy job that pairs the drill with engraving work', () => {
    const base = defaultEngraveJob();
    const job = drillJob([hole(2)], { labels: [base.labels[0]!] });
    const finding = validateJob(job, point).find((f) => f.code === 'drill-mixed-tools');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('drill bit');
  });

  it('stops a mixed legacy job at findings, before any program is posted', () => {
    const base = defaultEngraveJob();
    const g = generate(tl, drillJob([hole(2)], { labels: [base.labels[0]!] }), null, [], undefined, SHOP);
    expect(g.ok).toBe(false);
    expect(g.stage).toBe('findings');
    expect(g.nc).toBeNull();
  }, 30_000);
});

describe('the drill is one more (setup, tool) entry (#434 × #472)', () => {
  const ORIENTATION = {
    top: 'top',
    bottom: 'bottom',
    left: 'left',
    right: 'right',
    front: 'front',
    back: 'back',
  } as const;

  it('splits an engrave + drill setup into two programs, and the drills leave program 1', () => {
    const base = defaultEngraveJob();
    base.toolKey = 'flat-1.0'; // #516 item 5 — the default job no longer seeds a cutter
    const label = { ...base.labels[0]!, id: 'title' };
    const port = hole(2);
    const job: EngraveJob = {
      ...base,
      labels: [label],
      shapes: [],
      drills: [port],
      setups: [
        {
          id: 'setup-1',
          orientation: { ...ORIENTATION },
          mount: { kind: 'vise' },
          itemIds: [label.id, port.id],
          tools: [base.toolKey, DRILL_KEY],
          toolItems: { [base.toolKey]: [label.id], [DRILL_KEY]: [port.id] },
        },
      ],
    };

    // The J23 split already says two refs, each with its cutter's own items — the drill is one of
    // them, through `setupTools`/`toolItemsFor` and nothing parallel.
    expect(setupPrograms(job).map((r) => [r.toolKey, r.itemIds])).toEqual([
      [base.toolKey, [label.id]],
      [DRILL_KEY, [port.id]],
    ]);

    const g = engraveGenerate(tl, job, jobTool(job), [], null, undefined, SHOP_WITH_DRILL);
    expect(g.errors).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.programs).toHaveLength(2);
    expect(g.programs.map((p) => p.toolKey)).toEqual([base.toolKey, DRILL_KEY]);

    // Program 1 is the engraving: its own file, one operation, and no drill facts.
    const [engrave, drill] = g.programs;
    expect(engrave!.drill).toBeNull();
    expect(engrave!.cam!.operations).toBe(1);
    // Program 2 is the drill: one operation, its own `.nc`, and the plan facts carried on it.
    expect(drill!.drill?.plans[0]?.id).toBe(port.id);
    expect(drill!.cam!.operations).toBe(1);
    expect(drill!.nc).not.toBe(engrave!.nc);
    // The drill's tip depth is in the drill's file and not the engraving's.
    const tip = -(2 + POINT);
    expect(drill!.nc).toContain(`Z${tip.toFixed(3)}`);
    expect(engrave!.nc).not.toContain(`Z${tip.toFixed(3)}`);
    // The top-level adapter is program 1, so it carries no drill facts for this run.
    expect(g.drill).toBeNull();
  }, 60_000);
});

describe('the panel-side assignment check (#434)', () => {
  beforeEach(() => {
    setInventoryEntries([DRILL_ENTRY]);
  });
  afterEach(() => {
    resetRegistry();
  });

  it('refuses a drill bit assigned a region in its setup', () => {
    const base = defaultEngraveJob();
    const label = { ...base.labels[0]!, id: 'title' };
    const port = hole(2);
    const job: EngraveJob = {
      ...base,
      labels: [label],
      shapes: [],
      drills: [port],
      setups: [
        {
          id: 'setup-1',
          orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
          mount: { kind: 'vise' },
          itemIds: [label.id, port.id],
          tools: [DRILL_KEY],
          toolItems: { [DRILL_KEY]: [label.id, port.id] },
        },
      ],
    };
    const finding = setupProgramFindings(job).find((f) => f.code === 'drill-mixed-tools');
    expect(finding?.severity).toBe('error');
    expect(finding?.labelId).toBe(label.id);
    expect(finding?.message).toContain('drilled holes only');
  });

  it('accepts a drill bit assigned only the setup’s holes', () => {
    const base = defaultEngraveJob();
    const port = hole(2);
    const job: EngraveJob = {
      ...base,
      labels: [],
      shapes: [],
      drills: [port],
      setups: [
        {
          id: 'setup-1',
          orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
          mount: { kind: 'vise' },
          itemIds: [port.id],
          tools: [DRILL_KEY],
          toolItems: { [DRILL_KEY]: [port.id] },
        },
      ],
    };
    expect(setupProgramFindings(job).map((f) => f.code)).not.toContain('drill-mixed-tools');
  });
});

// #786 slice 1 part 2 — a hole whose rim crosses an edge cuts air there. The sentence names the
// edge and the overhang, and the drill's own program still posts and verifies.
describe('#786 slice 1 part 2 — a hole off the edge informs and still drills', () => {
  beforeEach(() => setInventoryEntries([DRILL_ENTRY]));
  afterEach(() => resetRegistry());

  it('names the edge and the overhang, and the drill program verifies', () => {
    // A 3 mm drill at x = 1: the rim reaches 0.5 mm past the left edge.
    const job = drillJob([hole(2, { x: 1, y: 30 })]);
    const outside = validateJob(job).find((f) => f.code === 'drill-outside-stock');
    expect(outside).toBeDefined();
    expect(outside!.severity).toBe('warning');
    expect(outside!.message).toContain('0.5 mm past the stock’s left edge');
    expect(outside!.message).toContain('Generate cuts it as it is');

    const g = engraveGenerate(tl, job, jobTool(job), [], null, undefined, SHOP_WITH_DRILL);
    expect(g.errors).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.programs).toHaveLength(1);
    expect(g.programs[0]!.verify!.ok).toBe(true);
    expect(g.programs[0]!.verify!.findings.filter((f) => f.code === 'cut-outside-stock')).toEqual([]);
  }, 60_000);
});
