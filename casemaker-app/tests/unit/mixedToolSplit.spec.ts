/**
 * #786 slice 4c/4b — A NAMED DRILL BIT OR THREAD MILL WITH OTHER WORK IS SPLIT, AND THE SPLIT IS SAID.
 *
 * The document names one cutter — a drill bit (or a thread mill) — and also asks for a pocket, a
 * trace or a thread. No single cutter can do both, and the app must not quietly replace the cutter
 * the operator named. The measured search therefore offers ONE family of plans: the named cutter
 * for its own holes/threads, and a flat (or the kind plan's other cutters) for the rest. Applying
 * the plan writes one setup with the cut order, `setupPrograms` makes one program per cutter, the
 * legacy `drill-mixed-tools` refusal has nothing left to refuse, and a `setup-programs-split` info
 * states the programs and the work each can do.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, pointLength, type Tool } from '@/engine/cnc/tool';
import { candidatePlans } from '@/engine/cnc/engrave/smartPick';
import { applyCutterPlanToJob } from '@/engine/cnc/engrave/measuredPick';
import { setupProgramFindings, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { setupPrograms } from '@/engine/cnc/engrave/programs';
import { resetRegistry, setInventoryEntries } from '@/engine/cnc/toolRegistry';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveThreadItem } from '@/types/engraveJob';
import type { EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import type { ShopDefaults } from '@/platform/defaultsClient';

const DRILL_KEY = 'inv:drill-3';
const DRILL: Tool = flatEndMill(3, {
  name: '3 mm drill',
  typeText: 'Drill',
  shape: 'drill',
  tipDiameter: 3,
  diameter: 3,
  cornerRadius: null,
  angle: 118,
  fluteLength: 20,
});
const DRILL_ENTRY: ToolLibraryEntry = { key: DRILL_KEY, tool: DRILL, provenance: 'test' };

const FLAT_KEY = 'inv:flat-2';
const FLAT: Tool = flatEndMill(2, { name: '2 mm flat', fluteLength: 20 });
const FLAT_ENTRY: ToolLibraryEntry = { key: FLAT_KEY, tool: FLAT, provenance: 'test' };

const THREAD_KEY = 'inv:thread-4';
const THREAD_MILL: Tool = flatEndMill(4, {
  name: '4 mm thread mill',
  typeText: 'Thread Mill',
  shape: 'thread',
  tipDiameter: 4,
  diameter: 4,
  fluteLength: 20,
});
const THREAD_ENTRY: ToolLibraryEntry = { key: THREAD_KEY, tool: THREAD_MILL, provenance: 'test' };

const POCKET = {
  kind: 'circle' as const,
  id: 'pocket',
  name: 'pocket',
  position: { x: 40, y: 25 },
  rotation: 0,
  depth: 2,
  enabled: true,
  diameter: 10,
};
const HOLE = {
  kind: 'drill' as const,
  id: 'hole',
  position: { x: 20, y: 20 },
  rotation: 0,
  depth: 2,
  enabled: true,
  through: false,
};
const THREAD: EngraveThreadItem = {
  kind: 'thread',
  id: 'thr-1',
  position: { x: 50, y: 30 },
  enabled: true,
  size: 'M5',
  standard: 'metric',
  classFit: '6H',
  depth: 5,
  through: false,
};

/** The shop's thread numbers (the seeded placeholders the thread specs use). */
const THREAD_DEFAULTS = {
  'thread.radialStepoverMm': { value: 0.2, source: 'seeded' },
  'thread.entryRampMm': { value: 0.5, source: 'seeded' },
  'thread.bottomClearancePitches': { value: 1, source: 'seeded' },
  'thread.pilotTipClearanceMm': { value: 0.5, source: 'seeded' },
  'thread.feed': { value: 300, source: 'seeded' },
  'thread.plungeFeed': { value: 100, source: 'seeded' },
  'thread.spindleRpm': { value: 10000, source: 'seeded' },
  'thread.chordToleranceMm': { value: 0.01, source: 'seeded' },
} as unknown as ShopDefaults;

/** The shop's drill numbers, so a drill's own program needs no bench record. */
const SHOP: EngraveShopOpts = {
  drill: {
    settings: { peckDiameters: 1, peckClearanceMm: 0.5, pointAngleDeg: 118, plungeFeed: 120, spindleRpm: 9000 },
    sources: {
      peckDiameters: 'chosen for this test',
      peckClearanceMm: 'chosen for this test',
      pointAngleDeg: 'chosen for this test',
      plungeFeed: 'placeholder for this test',
      spindleRpm: 'placeholder for this test',
    },
  },
  tools: [DRILL_ENTRY, FLAT_ENTRY],
};

/** A legacy job: the operator named the drill, and also drew a pocket. */
function mixedDrillJob(): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [POCKET],
    drills: [HOLE],
    threads: [],
    toolKey: DRILL_KEY,
    tool: DRILL,
    sources: { tool: 'user' },
  };
}

/** A legacy job: the operator named the thread mill, and also drew a pocket. */
function mixedThreadJob(): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [POCKET],
    drills: [],
    threads: [THREAD],
    toolKey: THREAD_KEY,
    tool: THREAD_MILL,
    sources: { tool: 'user' },
  };
}

describe('#786 4c — a named drill bit with other work is ONE split plan', () => {
  it('offers the drill for the hole and a flat for the pocket, and nothing that replaces the drill', () => {
    const plans = candidatePlans(mixedDrillJob(), [DRILL_ENTRY, FLAT_ENTRY], []);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      // Every plan keeps the named drill FIRST and gives it the holes only.
      expect(plan.cutters[0]?.key).toBe(DRILL_KEY);
      expect(plan.cutters[0]?.items).toEqual([HOLE.id]);
      expect(plan.cutters.length).toBeGreaterThan(1);
      const owners = plan.cutters.slice(1).flatMap((c) => c.items);
      expect(owners).toEqual([POCKET.id]);
    }
    // The flat chosen is the library's only flat, not a rest or a phantom.
    expect(new Set(plans.flatMap((p) => p.cutters.map((c) => c.key)))).toEqual(new Set([DRILL_KEY, FLAT_KEY]));
  });

  it('a named thread mill with other work splits the same way, and the thread item is cut once', () => {
    const plans = candidatePlans(mixedThreadJob(), [THREAD_ENTRY, FLAT_ENTRY], []);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(plan.cutters[0]?.key).toBe(THREAD_KEY);
      expect(plan.cutters[0]?.items).toEqual([THREAD.id]);
      // The kind plan's own thread cutter is NOT added beside it: one item, one cutter.
      const keys = plan.cutters.map((c) => c.key);
      expect(keys.filter((k) => k === THREAD_KEY)).toHaveLength(1);
      expect(keys).toContain(FLAT_KEY);
      const owners = plan.cutters.slice(1).flatMap((c) => c.items);
      expect(owners).toEqual([POCKET.id]);
    }
  });
});

describe('#786 4b — the applied split posts two programs, and the sentence says so', () => {
  beforeEach(() => setInventoryEntries([DRILL_ENTRY, FLAT_ENTRY, THREAD_ENTRY]));
  afterEach(() => resetRegistry());

  it('the drill job: no mixed refusal, two program refs, and the split sentence', () => {
    const job = mixedDrillJob();
    // Before the plan, the legacy document is refused: the bit cannot cut the pocket.
    expect(validateJob(job).some((f) => f.code === 'drill-mixed-tools')).toBe(true);

    const plan = candidatePlans(job, [DRILL_ENTRY, FLAT_ENTRY], [])[0]!;
    const applied = applyCutterPlanToJob(job, plan);

    // The refusal is gone, and the setup is the split.
    expect(validateJob(applied).some((f) => f.code === 'drill-mixed-tools')).toBe(false);
    expect(setupPrograms(applied).map((r) => [r.toolKey, r.itemIds])).toEqual([
      [DRILL_KEY, [HOLE.id]],
      [FLAT_KEY, [POCKET.id]],
    ]);

    // And one line states it.
    const split = setupProgramFindings(applied).find((f) => f.code === 'setup-programs-split');
    expect(split?.severity).toBe('info');
    expect(split?.message).toBe(
      'Split into 2 programs: the drill for the hole, the ⌀ 2 mm flat end for pocket.',
    );
  });

  it('the drill job generates and verifies BOTH programs, each with its own cutter', () => {
    const job = mixedDrillJob();
    const plan = candidatePlans(job, [DRILL_ENTRY, FLAT_ENTRY], [])[0]!;
    const applied = applyCutterPlanToJob(job, plan);

    const g = generate(tl, applied, null, [], undefined, SHOP);
    expect(g.errors).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.programs).toHaveLength(2);
    expect(g.programs.map((p) => p.toolKey)).toEqual([DRILL_KEY, FLAT_KEY]);
    for (const program of g.programs) {
      expect(program.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    }
    // The drill's file carries the hole's tip depth; the flat's does not.
    const tip = -(HOLE.depth + pointLength(3, 118));
    expect(g.programs[0]!.nc).toContain(`Z${tip.toFixed(3)}`);
    expect(g.programs[1]!.nc).not.toContain(`Z${tip.toFixed(3)}`);
    // The top-level adapter is program 1 (the drill's own).
    expect(g.drill?.plans[0]?.id).toBe(HOLE.id);
  }, 60_000);

  it('the thread job generates and verifies BOTH programs, each with its own cutter', () => {
    const job = mixedThreadJob();
    const plan = candidatePlans(job, [THREAD_ENTRY, FLAT_ENTRY], [])[0]!;
    const applied = applyCutterPlanToJob(job, plan);
    const g = generate(tl, applied, null, [], undefined, { ...SHOP, defaults: THREAD_DEFAULTS });
    expect(g.errors).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.programs.map((p) => p.toolKey)).toEqual([THREAD_KEY, FLAT_KEY]);
    for (const program of g.programs) {
      expect(program.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    }
  }, 60_000);

  it('the thread job: no mixed refusal, two program refs, and the sentence', () => {
    const job = mixedThreadJob();
    expect(validateJob(job).some((f) => f.code === 'thread-mixed-tools')).toBe(true);

    const plan = candidatePlans(job, [THREAD_ENTRY, FLAT_ENTRY], [])[0]!;
    const applied = applyCutterPlanToJob(job, plan);
    expect(validateJob(applied).some((f) => f.code === 'thread-mixed-tools')).toBe(false);
    expect(setupPrograms(applied).map((r) => [r.toolKey, r.itemIds])).toEqual([
      [THREAD_KEY, [THREAD.id]],
      [FLAT_KEY, [POCKET.id]],
    ]);
    const split = setupProgramFindings(applied).find((f) => f.code === 'setup-programs-split');
    expect(split?.message).toBe(
      'Split into 2 programs: the thread mill for the thread, the ⌀ 2 mm flat end for pocket.',
    );
  });

  it('a normal job keeps its one cutter and says nothing about a split', () => {
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      labels: [],
      shapes: [POCKET],
      drills: [],
      toolKey: FLAT_KEY,
      tool: FLAT,
      sources: { tool: 'user' },
    };
    const plans = candidatePlans(job, [FLAT_ENTRY], []);
    expect(plans[0]?.cutters.map((c) => c.key)).toEqual([FLAT_KEY]);
    expect(setupProgramFindings(job).some((f) => f.code === 'setup-programs-split')).toBe(false);
  });
});
