// #766 D — the worker-side run of the measured search. Two things are pinned here that the engine
// tests cannot see: the run YIELDS between plan evaluations (so the preview sharing the worker is
// served mid-search) and it STOPS when `isStale()` says a newer edit has arrived — returning null,
// with the completed verdicts left in slice A's caches for the next run.

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { smartPickKey } from '@/engine/cnc/engrave/measuredPick';
import { runSmartPick, type SmartPickRequest } from '@/workers/sim/smartPickRun';
import type { PlanEvaluation } from '@/workers/sim/planEvaluate';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';
import type { Tool, ToolShape } from '@/engine/cnc/tool';

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

const FLAT_3 = entry('inv:flat-3', 'flat', { tipDiameter: 3, diameter: 3 });
const FLAT_1 = entry('inv:flat-1', 'flat', { tipDiameter: 1, diameter: 1 });
const TOOLS = [FLAT_3, FLAT_1];

/** One job with one label, so the candidate list is small and deterministic. */
function job(text = 'CASE'): EngraveJob {
  const base = defaultEngraveJob();
  base.stock = { length: 40, width: 40, thickness: 5, material: 'pla' };
  base.labels = [
    {
      id: 'one',
      text,
      font: base.labels[0]!.font,
      weight: base.labels[0]!.weight,
      size: 8,
      position: { x: 20, y: 20 },
      rotation: 0,
      depth: 0.5,
      enabled: true,
    },
  ];
  base.shapes = [];
  base.combined = [];
  base.traces = [];
  base.vectors = [];
  base.drills = [];
  base.threads = [];
  base.cutouts = [];
  base.chamfers = [];
  base.primitives = [];
  base.targetObject = undefined;
  base.toolKey = '';
  delete base.sources;
  return base;
}

function request(j: EngraveJob = job()): SmartPickRequest {
  return { job: j, tools: TOOLS, catalogue: [], conditions: null, shop: {}, table: null };
}

function evaluation(ids: readonly string[], over: Partial<PlanEvaluation> = {}): PlanEvaluation {
  return {
    ok: true,
    refusal: null,
    items: ids.map((id) => ({ id, name: id, kind: 'flat', fidelity: 0.9, charsLost: 0, areaMismatchMm2: null, pinches: [] })),
    seconds: 30,
    toolChanges: 0,
    risk: { reachMarginMm: 5, holderClearanceMm: 5, chipLoadRatio: null },
    ...over,
  };
}

describe('#766 D the cancellable worker run', () => {
  it('answers with the chosen plan, its words and the job key the answer is for', async () => {
    const req = request();
    const summary = await runSmartPick(req, () => evaluation(['one']), () => false, async () => {});
    expect(summary).not.toBeNull();
    expect(summary!.jobKey).toBe(smartPickKey(req.job, { tools: TOOLS, catalogue: [], conditions: null, shop: {} }));
    expect(summary!.cutters.length).toBeGreaterThan(0);
    expect(summary!.words.plan).toContain('⌀');
    expect(summary!.words.verdict).toContain('Chosen by simulation');
  });

  it('stops between plan evaluations when a newer edit has arrived, and answers null', async () => {
    let stale = false;
    let evaluations = 0;
    const summary = await runSmartPick(
      request(),
      () => {
        evaluations += 1;
        // The second plan evaluation is "in progress" when the edit lands.
        if (evaluations === 2) stale = true;
        return evaluation(['one']);
      },
      () => stale,
      async () => {},
    );
    expect(summary).toBeNull();
    // The evaluation in progress finished; nothing after it started.
    expect(evaluations).toBe(2);
  });

  it('yields before every evaluation, so the worker can serve the edit that cancels it', async () => {
    const yields: number[] = [];
    await runSmartPick(
      request(),
      () => evaluation(['one']),
      () => false,
      async () => {
        yields.push(1);
      },
    );
    expect(yields.length).toBeGreaterThan(1);
  });

  it('a job with nothing to measure answers null without evaluating anything', async () => {
    const empty = job();
    empty.labels = [];
    const summary = await runSmartPick(
      request(empty),
      () => {
        throw new Error('nothing should be evaluated');
      },
      () => false,
      async () => {},
    );
    expect(summary).toBeNull();
  });
});
