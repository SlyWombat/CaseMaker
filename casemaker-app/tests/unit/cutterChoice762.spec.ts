// #762 — the pick asks what each item IS before it asks how much area a cutter reaches.
//
// Every row of the issue is one case below: a goal takes a ball, a through cut-out takes a flute
// that reaches through, a bore takes a cutter narrower than the hole, a chamfer takes a cone, a
// thread takes a thread mill, text that no flat keeps takes a V-carve, and a rest region cannot be
// deeper than the blank. The tools and the reach table are hand-built so each rule is pinned on
// its own terms; the full library's own answers are the demo set's runs, not a fixture.

import { describe, expect, it } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { kindedWork, planCutters } from '@/engine/cnc/engrave/cutterPlan';
import { restJobFor } from '@/engine/cnc/engrave/restPass';
import { recommendTool } from '@/engine/cnc/engrave/recommendTool';
import type { Reachability, CutterReach } from '@/engine/cnc/engrave/reachability';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { Tool, ToolShape } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';

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

const FLAT_3 = entry('flat-3', 'flat', { tipDiameter: 3.175, diameter: 3.175, fluteLength: 12 });
const FLAT_SHORT = entry('flat-short', 'flat', { tipDiameter: 3.175, diameter: 3.175, fluteLength: 12 });
const FLAT_LONG = entry('flat-long', 'flat', { tipDiameter: 3.175, diameter: 3.175, fluteLength: 25 });
const FLAT_2 = entry('flat-2', 'flat', { tipDiameter: 2, diameter: 2, fluteLength: 7 });
const BALL_2 = entry('ball-2', 'ball', { tipDiameter: 2, diameter: 2, fluteLength: 12 });
const CHAMFER_90 = entry('chamfer-90', 'chamfer', { tipDiameter: 0.1, diameter: 3.175, angle: 90, fluteLength: null });
const THREAD_M5 = entry('thread-m5', 'thread', { tipDiameter: 4, diameter: 3.175, fluteLength: 15 });
const ENGRAVER = entry('engraver', 'engraving', { tipDiameter: 0.5, diameter: 3.175, halfAngle: 15, fluteLength: null });
const ENGRAVER_6_SHALLOW = entry('engraver-6-shallow', 'engraving', { tipDiameter: 0.5, diameter: 6, halfAngle: 10, fluteLength: null });

/** No measured table: every candidate's detail is assumed OK (the flat rule's own tests supply one). */
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

function reachRow(key: string, shape: ToolShape, over: Partial<CutterReach> = {}): CutterReach {
  return {
    key,
    name: key,
    diameter: 0,
    shape,
    vTrace: shape === 'engraving',
    vCarve: false,
    excluded: null,
    excludedNote: null,
    rows: [],
    bestRatio: 0,
    worstRatio: 0,
    qualifies: true,
    ...over,
  };
}

/** A job with every list cleared, so each case states only the work it is about. */
function base(): EngraveJob {
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
  job.targetObject = undefined;
  job.toolKey = '';
  return job;
}

describe('#762 the picker reads the item kind first', () => {
  it('sends a 3D goal to a ball, not the largest flat', () => {
    const job = base();
    job.targetObject = {
      id: 'g1',
      name: 'relief.stl',
      format: 'stl',
      sha256: 'abc',
      size: { x: 20, y: 20, z: 3 },
      position: { x: 50, y: 50, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
    };
    const plan = planCutters(job, NO_REACH, [FLAT_3, BALL_2], []);
    expect(plan.cutters).toHaveLength(1);
    expect(plan.cutters[0]!.shape).toBe('ball');
    expect(plan.cutters[0]!.key).toBe('ball-2');
  });

  it('gives a through cut-out a flute that reaches THROUGH the stock', () => {
    const job = base();
    job.stock.thickness = 20;
    job.shapes = [{ id: 'part', kind: 'rect', position: { x: 50, y: 30 }, rotation: 0, depth: 4, enabled: true, construction: true, width: 80, height: 40, cornerRadius: 0 }];
    job.cutouts = [{ kind: 'cutout', id: 'cut', enabled: true, of: 'part', side: 'outside', inset: 0, tabs: { count: 0, width: 0, height: 0 } }];
    const plan = planCutters(job, NO_REACH, [FLAT_SHORT, FLAT_LONG], []);
    expect(plan.cutters[0]!.key).toBe('flat-long');
  });

  it('gives a bore a cutter narrower than the hole', () => {
    const job = base();
    job.drills = [{ id: 'b', kind: 'drill', position: { x: 20, y: 20 }, rotation: 0, depth: 5, enabled: true, mode: 'bore', diameter: 2.6, through: false }];
    const plan = planCutters(job, NO_REACH, [FLAT_3, FLAT_2], []);
    expect(plan.cutters[0]!.diameter).toBe(2);
  });

  it('gives a chamfer a cone, and the chamfer bit when the list has one', () => {
    const job = base();
    job.shapes = [{ id: 'part', kind: 'rect', position: { x: 35, y: 25 }, rotation: 0, depth: 6, enabled: true, construction: true, width: 50, height: 30, cornerRadius: 4 }];
    job.chamfers = [{ kind: 'chamfer', id: 'bev', enabled: true, of: 'part', side: 'outside', width: 1 }];
    const plan = planCutters(job, NO_REACH, [FLAT_3, ENGRAVER, CHAMFER_90], []);
    expect(plan.cutters[0]!.key).toBe('chamfer-90');
  });

  it('refuses a shallow cone whose bevel would cut past a pocket floor (j21)', () => {
    const job = base();
    job.stock.material = 'pla';
    job.shapes = [{ id: 'pocket', kind: 'rect', position: { x: 55, y: 45 }, rotation: 0, depth: 5, enabled: true, width: 60, height: 40, cornerRadius: 0 }];
    job.chamfers = [{ kind: 'chamfer', id: 'rim', enabled: true, of: 'pocket', side: 'inside', width: 1.5 }];
    // The 10° half-angle cone reaches the 1.5 mm width but would tip 8.5 mm down, past the 5 mm
    // pocket floor; the 90° bit tips 1.5 mm down and reaches the width — `chamfer-too-deep`'s
    // rule, in the pick.
    const plan = planCutters(job, NO_REACH, [FLAT_LONG, ENGRAVER_6_SHALLOW, CHAMFER_90], []);
    const cone = plan.cutters.find((c) => c.shape === 'chamfer' || c.shape === 'engraving');
    expect(cone?.key).toBe('chamfer-90');
  });

  it('gives a thread a thread mill that fits its pilot', () => {
    const job = base();
    job.threads = [{ kind: 'thread', id: 't', position: { x: 20, y: 20 }, enabled: true, size: 'M5', standard: 'metric', classFit: '6H', depth: 5, through: false }];
    const plan = planCutters(job, NO_REACH, [FLAT_3, THREAD_M5], []);
    expect(plan.cutters[0]!.key).toBe('thread-m5');
  });

  it('cuts text at the colour plane when no flat keeps it, but keeps a qualifying flat', () => {
    const job = base();
    // The starting table's V rows are for the plastics, so this job is PLA like the demos.
    job.stock.material = 'pla';
    job.labels = [{ id: 'txt', text: 'Ruth', font: 'sans-default', weight: 'regular', size: 7, position: { x: 50, y: 30 }, rotation: 0, depth: 0.8, enabled: true }];
    const reach: Reachability = {
      ...NO_REACH,
      cutters: [
        reachRow('flat-3', 'flat', { qualifies: false }),
        reachRow('engraver', 'engraving', { vCarve: true, qualifies: true }),
      ],
    };
    const plan = planCutters(job, reach, [FLAT_3, ENGRAVER], []);
    expect(plan.cutters[0]!.shape).toBe('engraving');
    // The same flat, when it DOES keep the text, wins on its larger stated diameter.
    const keeps: Reachability = { ...NO_REACH, cutters: [reachRow('flat-3', 'flat', { qualifies: true }), reachRow('engraver', 'engraving', { vCarve: true })] };
    const flatPlan = planCutters(job, keeps, [FLAT_3, ENGRAVER], []);
    expect(flatPlan.cutters[0]!.key).toBe('flat-3');
  });

  it('reads a variable-depth V-carve as cone work', () => {
    const job = base();
    job.shapes = [{ id: 'v', kind: 'circle', position: { x: 50, y: 30 }, rotation: 0, depth: 4, enabled: true, diameter: 10, vCarveDepth: 'variable' }];
    expect(kindedWork(job)[0]!.kind).toBe('cone');
  });

  it('reads a cut-out as work for a flat, at the through depth, in kindedWork', () => {
    const job = base();
    job.stock.thickness = 18;
    job.breakthrough = 0.3;
    job.shapes = [{ id: 'part', kind: 'rect', position: { x: 50, y: 30 }, rotation: 0, depth: 4, enabled: true, construction: true, width: 80, height: 40, cornerRadius: 0 }];
    job.cutouts = [{ kind: 'cutout', id: 'cut', enabled: true, of: 'part', side: 'outside', inset: 0, tabs: { count: 0, width: 0, height: 0 } }];
    const cut = kindedWork(job).find((w) => w.id === 'cut')!;
    expect(cut.kind).toBe('flat');
    expect(cut.reachMm).toBe(18.3);
  });

  it('says why when no cutter passes the material gate', () => {
    const job = base();
    job.labels = [{ id: 'txt', text: 'X', font: 'sans-default', weight: 'regular', size: 5, position: { x: 50, y: 30 }, rotation: 0, depth: 0.5, enabled: true }];
    const conditions = new Map<string, ConditionSummary>([['flat-3', { usable: 0, note: 'every copy is broken', best: null } as unknown as ConditionSummary]]);
    const plan = planCutters(job, NO_REACH, [FLAT_3], [], conditions);
    expect(plan.cutters).toEqual([]);
    expect(plan.unassigned[0]!.reason).toContain('marked broken');
  });
});

describe('#762 the reach filter is the generator’s own', () => {
  it('refuses a compromise cutter that cannot reach the deepest cut', () => {
    const job = base();
    job.stock.thickness = 20;
    job.shapes = [{ id: 'part', kind: 'rect', position: { x: 50, y: 30 }, rotation: 0, depth: 4, enabled: true, construction: true, width: 80, height: 40, cornerRadius: 0 }];
    job.cutouts = [{ kind: 'cutout', id: 'cut', enabled: true, of: 'part', side: 'outside', inset: 0, tabs: { count: 0, width: 0, height: 0 } }];
    const rec = recommendTool(job, [FLAT_SHORT], [], () => []);
    expect(rec.key).toBeNull();
    expect(rec.reason).toContain('reaches this job’s deepest cut');
  });

  it('keeps a rest region inside the blank (j17: 3.3 mm in a 3 mm stock)', () => {
    const job = base();
    job.stock.thickness = 3;
    job.minFloor = 1;
    const rest = restJobFor(job, [{ id: 'pocket', name: 'Pocket', depth: 3.3, polygons: [] }], 'flat-2');
    expect(rest.vectors![0]!.depth).toBe(2);
  });
});
