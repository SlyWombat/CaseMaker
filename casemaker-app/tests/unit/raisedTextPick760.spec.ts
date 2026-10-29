// #760 — the raised-text gaps reach the pick. A raised cut-away is measured by the narrowest gap
// its letters keep, the same measurement `raised-text-fused` quotes, so a cutter that joins the
// letters is never "the largest cutter that keeps every item intact": a finer one must be found,
// the clearance cutter may stay with a finer REST cutter beside it, and when nothing fits the pick
// says the one plain sentence. These cases are pure — the measurement is handed in as rows.

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { planCutters } from '@/engine/cnc/engrave/cutterPlan';
import { recommendTool } from '@/engine/cnc/engrave/recommendTool';
import type { CutterReach, Reachability } from '@/engine/cnc/engrave/reachability';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { Tool, ToolShape } from '@/engine/cnc/tool';
import type { LabelEngravability, RaisedTextMeasurement } from '@/workers/sim/engraveGeometry';
import type { EngraveJob } from '@/types/engraveJob';

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
const FLAT_1 = entry('flat-1', 'flat', { tipDiameter: 1, diameter: 1, fluteLength: 7 });
const ENGRAVER = entry('engraver', 'engraving', { tipDiameter: 0.3, diameter: 3.175, halfAngle: 15, fluteLength: null });

/** The coin's measured row: "Software" at 3.6 mm with gaps down to 0.278 mm. */
function fused(over: Partial<RaisedTextMeasurement> = {}): RaisedTextMeasurement {
  return {
    cutawayId: 'clear',
    labelId: 'software',
    text: 'Software',
    size: 3.6,
    cutterRadius: 0.5,
    gap: 0.278,
    joined: true,
    counterFilled: false,
    minSize: 13,
    ...over,
  };
}

/** A job that is exactly the raised-text case: a cut-away clearing a field around one label. */
function raisedJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.stock.material = 'pla';
  job.labels = [
    { id: 'software', text: 'Software', font: 'sans-default', weight: 'regular', size: 3.6, position: { x: 50, y: 40 }, rotation: 0, depth: 0.4, enabled: true, construction: true },
  ];
  job.shapes = [
    { id: 'field', kind: 'circle', position: { x: 50, y: 50 }, rotation: 0, depth: 0.4, enabled: true, construction: true, diameter: 26 },
  ];
  job.combined = [
    { id: 'clear', kind: 'cutaway', position: { x: 0, y: 0 }, rotation: 0, depth: 0.4, enabled: true, outer: 'field', islands: ['software'] },
  ];
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

/** Every candidate's area measurement passes, so only the raised rows decide. */
const measureAll = (): LabelEngravability[] => [];

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
    detailQualifies: true,
    raised: [],
    ...over,
  };
}

function table(cutters: CutterReach[], shares: Record<string, number> = {}): Reachability {
  return {
    cutters,
    items: [{ id: 'clear', name: 'the cut-away', depth: 0.4 }],
    recommendation: {
      key: null,
      compromise: false,
      reason: '',
      conditionNote: null,
      catalogueNote: null,
      selectedNote: null,
      candidates: [],
    },
    totalShare: new Map(Object.entries(shares)),
  };
}

describe('#760 recommendTool reads the raised gaps', () => {
  it('never picks a flat that joins the letters when a smaller one keeps them', () => {
    const rec = recommendTool(
      raisedJob(),
      [FLAT_3, FLAT_1],
      [],
      measureAll,
      null,
      null,
      undefined,
      (key) => (key === 'flat-3' ? [fused()] : []),
    );
    expect(rec.key).toBe('flat-1');
    expect(rec.compromise).toBe(false);
    expect(rec.reason).toContain('keeps every item intact');
  });

  it('says the plain gap sentence when nothing keeps them', () => {
    const rec = recommendTool(
      raisedJob(),
      [FLAT_3, FLAT_1],
      [],
      measureAll,
      null,
      null,
      undefined,
      () => [fused()],
    );
    expect(rec.compromise).toBe(true);
    expect(rec.reason).toContain('no cutter fits the 0.278 mm gaps; make the text larger or V-carve it');
  });

  it('prefers the smallest cutter that KEEPS the raised text over a smaller one that joins it', () => {
    // Both lose the area bar, so neither qualifies; the compromise must not be the smaller cutter
    // when that one is the only one that joins the letters.
    const losing = (): LabelEngravability[] => [
      { labelId: 'clear', glyphArea: 100, openedArea: 10, ratio: 0.1, emptyChars: [], outsideArea: 0, polygons: [] },
    ];
    const rec = recommendTool(
      raisedJob(),
      [FLAT_3, FLAT_1],
      [],
      losing,
      null,
      null,
      undefined,
      (key) => (key === 'flat-1' ? [fused()] : []),
    );
    expect(rec.compromise).toBe(true);
    expect(rec.key, 'flat-3 keeps the gaps; flat-1 would join them').toBe('flat-3');
    expect(rec.reason).not.toContain('no cutter fits');
  });
});

describe('#760 planCutters gives raised text a cutter that fits, or a rest cutter', () => {
  it('keeps the clearance flat and adds the finer rest cutter that meets the gaps', () => {
    const reach = table(
      [
        reachRow('flat-3', 'flat', { diameter: 3.175, qualifies: false, raised: [fused({ cutterRadius: 1.5875 })] }),
        reachRow('flat-1', 'flat', { diameter: 1, raised: [] }),
      ],
      { 'flat-3': 0.98, 'flat-1': 1 },
    );
    const plan = planCutters(raisedJob(), reach, [FLAT_3, FLAT_1], []);
    expect(plan.unassigned).toEqual([]);
    expect(plan.cutters.map((c) => c.key)).toEqual(['flat-3', 'flat-1']);
    // The clearance cutter owns the cut-away; the rest pass owns no items and re-cuts its leftovers.
    expect(plan.cutters[0]!.items).toEqual(['clear']);
    expect(plan.cutters[1]!.items).toEqual([]);
    expect(plan.notes.join('\n')).not.toContain('no cutter fits');
  });

  it('says the plain sentence when even the finest rest cutter joins the gaps', () => {
    const reach = table(
      [
        reachRow('flat-3', 'flat', { diameter: 3.175, qualifies: false, raised: [fused({ cutterRadius: 1.5875 })] }),
        reachRow('flat-1', 'flat', { diameter: 1, qualifies: false, raised: [fused()] }),
      ],
      { 'flat-3': 0.96, 'flat-1': 0.98 },
    );
    const plan = planCutters(raisedJob(), reach, [FLAT_3, FLAT_1], []);
    expect(plan.notes.join('\n')).toContain(
      'no cutter fits the 0.278 mm gaps; make the text larger or V-carve it',
    );
    // It still cuts: the cut-away stays on a flat, with the sentence as the record of what it will look like.
    expect(plan.cutters.length).toBeGreaterThan(0);
    expect(plan.unassigned).toEqual([]);
  });

  it('gives the cut-away to a cone when only a cone keeps the gaps', () => {
    const reach = table(
      [
        reachRow('flat-3', 'flat', { diameter: 3.175, qualifies: false, raised: [fused({ cutterRadius: 1.5875 })] }),
        reachRow('flat-1', 'flat', { diameter: 1, qualifies: false, raised: [fused()] }),
        reachRow('engraver', 'engraving', { diameter: 0.3, vCarve: true, qualifies: true }),
      ],
      { 'flat-3': 0.96, 'flat-1': 0.98 },
    );
    const plan = planCutters(raisedJob(), reach, [FLAT_3, FLAT_1, ENGRAVER], []);
    expect(plan.unassigned).toEqual([]);
    expect(plan.cutters.map((c) => c.key)).toEqual(['engraver']);
    expect(plan.cutters[0]!.items).toEqual(['clear']);
    expect(plan.notes.join('\n')).not.toContain('no cutter fits');
  });
});
