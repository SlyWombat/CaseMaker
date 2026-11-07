/**
 * #1051 — THE PANEL'S ADVISORY FOLLOWS THE ENGINE'S TWO RULES.
 *
 * `planCutters` ranks over whatever tools it is handed, and the panel hands it the WHOLE registry
 * (`getTools()`: built-ins, the house's `cat:` rows, `inv:` records). Two engine rules landed after
 * this advisory was written and it saw neither:
 *
 *   - #1041 — OWNED FIRST: a shop with inventory or user records plans from those records (plus
 *     the job's chosen cutter); the catalogue's `cat:` rows are the ideal's, and the built-in tier
 *     is the registry's stand-in. The advisory kept naming the catalogue `6*1*30.5mm` ball for a
 *     shop whose plan used the owned ⌀3.175 × 22 — a cutter the bench does not hold.
 *   - #1037 — THE BALL IS JUDGED PER FEATURE, not by the goal's whole depth. The advisory's
 *     "largest that reaches 26 mm" was true of a depth the ball never cuts.
 *
 * RED at 72fd1e329: the mesh-goal case picks the `cat:` ball and the sentence claims "reaches
 * 26 mm"; the PNG case below is the behaviour that must not move.
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { planCutters } from '@/engine/cnc/engrave/cutterPlan';
import type { Reachability } from '@/engine/cnc/engrave/reachability';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { Tool, ToolShape } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

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

/** No measured table: the reach/pick rules are pinned on their own terms. */
const NO_REACH: Reachability = {
  cutters: [],
  items: [],
  recommendation: {
    key: null,
    compromise: false,
    reason: '',
    conditionNote: null,
    catalogueNote: null,
    selectedNote: null,
    candidates: [],
  },
  totalShare: new Map(),
};

/** A goal-only job (no item work), 26 mm deep in the mesh case. */
function goalJob(over: Partial<EngraveTargetObject> = {}, stockThickness = 12): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = [];
  job.shapes = [];
  job.combined = [];
  job.traces = [];
  job.vectors = [];
  job.drills = [];
  job.threads = [];
  job.cutouts = [];
  job.chamfers = [];
  job.primitives = [];
  job.toolKey = '';
  job.stock = { ...job.stock, thickness: stockThickness };
  job.targetObject = {
    id: 'g1',
    name: 'clamp.stl',
    format: 'stl',
    sha256: 'abc',
    size: { x: 20, y: 20, z: 26 },
    position: { x: 50, y: 50, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
  return job;
}

// The catalogue's only ball that "reaches 26 mm" (the one the panel named on the tray), the
// shop's own long-reach ball, and the shop's smaller one — all balls, so the ball rule decides.
const CAT_BALL_30 = entry('cat:019c049a-ball-1-305', 'ball', { tipDiameter: 1, diameter: 1, fluteLength: 30.5 });
const OWNED_BALL_22 = entry('inv:kz-ball-nose-3-175-22', 'ball', { tipDiameter: 3.175, diameter: 3.175, fluteLength: 22 });
const OWNED_BALL_12 = entry('inv:kz-ball-nose-2-12', 'ball', { tipDiameter: 2, diameter: 2, fluteLength: 12 });

describe('#1051 the panel advises from the shop, and a mesh goal makes no reach claim', () => {
  it('RED: a mesh goal picks the owned ball, and the sentence names no whole-goal reach', () => {
    const plan = planCutters(goalJob(), NO_REACH, [CAT_BALL_30, OWNED_BALL_22], []);
    expect(plan.cutters[0]!.key).toBe('inv:kz-ball-nose-3-175-22');
    const reason = plan.cutters[0]!.reason;
    expect(reason).toContain("the engine measures the finishing ball among the shop's balls");
    expect(reason).toContain('⌀3.175 mm × 22 mm flute');
    expect(reason).not.toMatch(/reaches/);
    // The catalogue ball is not even named as a candidate: the shop's records are the advisory.
    expect(reason).not.toContain('30.5');
  });

  it('a PNG relief keeps the reach rule — its engine has no per-feature judge', () => {
    const plan = planCutters(goalJob({ format: 'png' }, 26), NO_REACH, [CAT_BALL_30, OWNED_BALL_22], []);
    expect(plan.cutters[0]!.key).toBe('cat:019c049a-ball-1-305');
    expect(plan.cutters[0]!.reason).toContain('reaches');
  });

  it('a shop with no records falls back to the registry, and the sentence says so', () => {
    const plan = planCutters(goalJob(), NO_REACH, [CAT_BALL_30, OWNED_BALL_12], []);
    // OWNED_BALL_12 is an `inv:` record, so this shop DOES have records; the fallback case is a
    // tools list of catalogue/built-in entries only.
    expect(plan.cutters[0]!.key).toBe('inv:kz-ball-nose-2-12');
    const fallback = planCutters(goalJob(), NO_REACH, [CAT_BALL_30], []);
    expect(fallback.cutters[0]!.key).toBe('cat:019c049a-ball-1-305');
    expect(fallback.cutters[0]!.reason).toContain('no inventory recorded, so the registry stands in');
  });

  // A/6b's round (#1051): the no-ball branch kept the same whole-goal reach claim item 2 removes.
  it('a mesh goal with no ball in the shop says so without a whole-goal reach number', () => {
    const OWNED_FLAT = entry('inv:kz-o-flute-3-175-25', 'flat', { tipDiameter: 3.175, diameter: 3.175, fluteLength: 25 });
    const plan = planCutters(goalJob(), NO_REACH, [OWNED_FLAT], []);
    expect(plan.cutters).toHaveLength(0);
    const reason = plan.unassigned[0]!.reason;
    expect(reason).toBe(
      "no ball end mill in the shop's records — the engine finishes the curved surfaces with a flat (#982) unless a ball is added to the inventory",
    );
    expect(reason).not.toMatch(/needs .* mm of reach/);
    // The same shop with no records at all falls back to the registry and says WHICH registry.
    const fallback = planCutters(goalJob(), NO_REACH, [entry('cat:019c-flat-3', 'flat', { tipDiameter: 3, diameter: 3, fluteLength: 12 })], []);
    expect(fallback.unassigned[0]!.reason).toContain('no ball end mill in the registry');
    expect(fallback.unassigned[0]!.reason).not.toMatch(/needs .* mm of reach/);
  });
});
