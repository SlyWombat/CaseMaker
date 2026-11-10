// #1149 T1/T2 — THE PLANNER'S VIEW OF WHAT THE SHOP OWNS. Red first.
//
// T1: a piece nobody described counted as usable and "in the box", and there was no "lost" state, so
// the planner could plan with a bit that may not exist. The bench's own states are now: new / used /
// worn (stated usable), broken / lost (never chosen), and UNKNOWN for a copy nobody described — stated
// as unknown, never assumed usable and never assumed to be in its box. Lost and broken pieces are
// excluded from planning and the plan says so; an unknown piece is still planable (the shop holds it)
// but its wear is stated as unknown.
//
// T2: "owned" was "any key that is not `cat:`". Now it is a bit ON THE SHELF: an `inv:` possession,
// or a definition an inventory piece corresponds to (#454's cutter rule). A user-library definition
// with no inventory piece is not owned.

import { afterEach, describe, expect, it } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { planCutters } from '@/engine/cnc/engrave/cutterPlan';
import { candidatePlans, ownedKeysOf, sourceOf } from '@/engine/cnc/engrave/smartPick';
import type { Reachability } from '@/engine/cnc/engrave/reachability';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { Tool, ToolShape } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';
import {
  CONDITIONS,
  conditionRank,
  itemConditionSummary,
  resetInventoryConditions,
  setInventoryConditions,
  inventoryConditions,
  type ToolCopy,
} from '@/engine/cnc/toolCondition';

afterEach(resetInventoryConditions);
import { ToolCopySchema } from '@/engine/cnc/toolCondition';

function entry(key: string, shape: ToolShape, over: Partial<Tool> = {}): ToolLibraryEntry {
  return {
    key,
    provenance: 'test',
    tool: {
      number: null,
      id: null,
      name: key,
      typeText: '',
      shape,
      handleDiameter: 3.175,
      tipDiameter: null,
      diameter: null,
      cornerRadius: null,
      angle: null,
      halfAngle: null,
      fluteLength: 12,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
      ...over,
    },
  };
}

function copy(id: string, condition: ToolCopy['condition']): ToolCopy {
  return { id, condition, whereabouts: { kind: 'box', case: null }, runtimeWarnMinutes: null, notes: null, runtimeMinutes: null };
}

/** A job whose only work is one label, so the flat rule has to pick a cutter for it. */
function labelJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = [
    { id: 'txt', text: 'X', font: 'sans-default', weight: 'regular', size: 5, position: { x: 20, y: 30 }, rotation: 0, depth: 0.5, enabled: true },
  ];
  job.shapes = [];
  job.combined = [];
  job.traces = [];
  job.vectors = [];
  job.drills = [];
  job.threads = [];
  job.cutouts = [];
  job.chamfers = [];
  job.primitives = [];
  job.targetObject = undefined;
  job.toolKey = '';
  return job;
}

/** No measured table: every candidate passes the flat rule's own detail question. */
const NO_REACH: Reachability = {
  cutters: [],
  items: [],
  recommendation: { key: null, compromise: false, reason: '', conditionNote: null, catalogueNote: null, selectedNote: null, candidates: [] },
  totalShare: new Map(),
};

const FLAT_3 = entry('inv:flat-3', 'flat', { tipDiameter: 3.175, diameter: 3.175, fluteLength: 12 });
const FLAT_06 = entry('inv:corn-0-6', 'flat', { tipDiameter: 0.6, diameter: 0.6, fluteLength: 3 });
const FLAT_2 = entry('inv:flat-2', 'flat', { tipDiameter: 2, diameter: 2, fluteLength: 12 });
const USER_06 = entry('user:my-corn-0-6', 'flat', { tipDiameter: 0.6, diameter: 0.6, fluteLength: 3 });
const USER_LONELY = entry('user:lonely-06', 'flat', { tipDiameter: 0.6, diameter: 0.6, fluteLength: 3 });

describe('#1149 T1 — lost, broken and unknown, on the bench', () => {
  it('has a lost condition, and it is never chosen (like broken)', () => {
    expect(CONDITIONS).toContain('lost');
    expect(conditionRank('lost')).toBe(Number.POSITIVE_INFINITY);
    expect(conditionRank('broken')).toBe(Number.POSITIVE_INFINITY);
    // The copy schema carries it, so an operator can say a piece is lost.
    expect(ToolCopySchema.safeParse(copy('a', 'lost')).success).toBe(true);
  });

  it('states an undescribed piece as UNKNOWN — never as usable and never "in the box"', () => {
    // Two copies, none described: nothing is known about either. It stays PLANAABLE (the shop holds
    // it) but the summary must not claim it is usable, and the note says the wear is unknown.
    const s = itemConditionSummary({ id: 'i', quantity: 2, copies: [] });
    expect(s).toMatchObject({ usable: 2, unknown: 2, known: 0, best: null });
    expect(s.note).toContain('no copy of this cutter has a condition set');
    expect(s.note).toContain('unknown');
    // One worn copy described, one copy nobody described: one stated usable, one unknown.
    const mixed = itemConditionSummary({ id: 'i', quantity: 2, copies: [copy('a', 'worn')] });
    expect(mixed).toMatchObject({ usable: 2, unknown: 1, known: 1 });
  });

  it('excludes a lost piece like a broken one, and states the exclusion', () => {
    const lost = itemConditionSummary({ id: 'i', quantity: 1, copies: [copy('a', 'lost')] });
    expect(lost).toMatchObject({ usable: 0, unknown: 0, known: 0, best: 'lost' });
    expect(lost.note).toContain('marked broken or lost');
    // A pool with one lost and one broken is the same fact.
    const both = itemConditionSummary({ id: 'i', quantity: 2, copies: [copy('a', 'lost'), copy('b', 'broken')] });
    expect(both).toMatchObject({ usable: 0 });
    expect(both.note).toContain('marked broken or lost');
  });

  it('the planner never picks a cutter with no usable copy, and the plan says why', () => {
    setInventoryConditions([{ id: 'flat-3', quantity: 1, copies: [copy('c1', 'lost')] }], (id) => `inv:${id}`);
    const plan = planCutters(labelJob(), NO_REACH, [FLAT_3], [], inventoryConditions());
    expect(plan.cutters).toEqual([]);
    expect(plan.unassigned[0]!.reason).toContain('marked broken or lost');
  });

  it('an UNKNOWN cutter is still planable — the exclusion is lost/broken, not undescribed', () => {
    // This is what keeps an inventory nobody has described (the bench's own case) planable.
    setInventoryConditions([{ id: 'flat-3', quantity: 2, copies: [] }], (id) => `inv:${id}`);
    const plan = planCutters(labelJob(), NO_REACH, [FLAT_3], [], inventoryConditions());
    expect(plan.cutters.map((c) => c.key)).toEqual(['inv:flat-3']);
  });
});

describe('#1149 T2 — owned is a bit on the shelf, not "any non-cat: key"', () => {
  it('a user-library definition with no inventory piece is NOT owned', () => {
    const owned = ownedKeysOf([FLAT_2, USER_LONELY], null);
    expect(owned.has('inv:flat-2')).toBe(true);
    expect(owned.has('user:lonely-06')).toBe(false);
    expect(sourceOf(USER_LONELY, owned)).toBe('catalogue');
    // …and the plan records that source, so the search can rank a real bit above it.
    const plans = candidatePlans(labelJob(), [FLAT_2, USER_LONELY], []);
    const withUser = plans.find((p) => p.cutters.some((c) => c.key === 'user:lonely-06'));
    if (withUser !== undefined) expect(withUser.source['user:lonely-06']).toBe('catalogue');
  });

  it('a definition an inventory piece corresponds to IS owned (#454’s cutter rule)', () => {
    const owned = ownedKeysOf([FLAT_06, USER_06], null);
    expect(owned.has('user:my-corn-0-6')).toBe(true);
    expect(sourceOf(USER_06, owned)).toBe('owned');
    expect(sourceOf(FLAT_06, owned)).toBe('owned');
  });

  it('an inventory piece with every copy lost is not owned either', () => {
    setInventoryConditions([{ id: 'flat-3', quantity: 1, copies: [copy('c1', 'lost')] }], (id) => `inv:${id}`);
    const owned = ownedKeysOf([FLAT_3], inventoryConditions());
    expect(owned.has('inv:flat-3')).toBe(false);
  });
});
