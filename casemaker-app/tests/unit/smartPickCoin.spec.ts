// #765 folded into #766 B — THE COIN IS THE FIRST TEST CASE. The maintainer proved on the bench
// that "Software" reads when a 0.6 mm corn is the rest cutter (or a 0.1 mm V), and that a ⌀1 rest
// fuses it. The old pick judged the raised text by the single tightest gap and stopped at ⌀1; the
// search must choose a plan that actually separates the word, and it must POST. Real Manifold,
// real generator — one job, a handful of candidates, so this is the fixture's own small run.

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { smartPick } from '@/engine/cnc/engrave/smartPick';
import { evaluatePlan, type CandidatePlan, type PlanEvaluation } from '@/workers/sim/planEvaluate';
import type { EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { Tool, ToolShape } from '@/engine/cnc/tool';
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

const FLAT_2 = entry('inv:flat-2', 'flat', { tipDiameter: 2, diameter: 2, fluteLength: 12 });
const FLAT_1 = entry('inv:flat-1', 'flat', { tipDiameter: 1, diameter: 1, fluteLength: 7 });
const CORN_06 = entry('inv:corn-0-6', 'flat', { tipDiameter: 0.6, diameter: 0.6, fluteLength: 3 });
const TOOLS = [FLAT_2, FLAT_1, CORN_06];

/** The coin's shape: a ⌀30 disc clearing a field around a construction label. */
function coin(): EngraveJob {
  const job = defaultEngraveJob();
  job.name = 'coin raised text';
  job.stock = { length: 30, width: 30, thickness: 3, material: 'pla', shape: 'disc', diameter: 30 };
  // The demo coin stands 1.5 mm proud of the jaws; the default 4 mm on a 3 mm blank leaves nothing
  // in them (`vise-grip-shallow` would refuse every plan).
  if (job.workholding.kind === 'vise') {
    job.workholding = { ...job.workholding, vise: { ...job.workholding.vise, stockProud: 1.5 } };
  }
  job.labels = [
    { id: 'software', text: 'Software', font: 'sans-default', weight: 'regular', size: 3.6, position: { x: 15, y: 8.5 }, rotation: 0, depth: 0.4, enabled: true, construction: true },
  ];
  job.shapes = [
    { id: 'field', kind: 'circle', position: { x: 15, y: 15 }, rotation: 0, depth: 0.4, enabled: true, construction: true, diameter: 26 },
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

const shop: EngraveShopOpts = { tools: TOOLS };

describe('#765/#766 the coin’s raised "Software"', () => {
  it('the search chooses a posting plan that separates the word better than a ⌀1 rest', { timeout: 240_000 }, () => {
    const job = coin();
    const evaluate = (plan: CandidatePlan, level: 'coarse' | 'full'): PlanEvaluation =>
      evaluatePlan(job, plan, { tl, tools: TOOLS, catalogue: [], shop, calibration: null }, { level });
    const pick = smartPick(job, TOOLS, [], evaluate, { maxCandidates: 8, fullFinalists: 2 });

    expect(pick.runnable, 'a posting plan is handed over').not.toBeNull();
    const run = pick.runnable!;
    const software = run.evaluation.items.find((i) => i.id === 'clear');
    expect(software?.pinches.length, 'the coin keeps its pinches').toBeGreaterThan(0);

    // The 0.6 corn is the finest cutter the old rule stopped before: the chosen plan must use it,
    // alone or as the rest, and it must leave fewer pinches joined than the ⌀1-only plan.
    const joined = software!.pinches.filter((p) => !p.separated).length;
    const oneMillimetre = evaluate({ cutters: [{ key: FLAT_1.key, items: ['clear'] }], source: { [FLAT_1.key]: 'owned' } }, 'coarse');
    const oneJoined = oneMillimetre.items.find((i) => i.id === 'clear')!.pinches.filter((p) => !p.separated).length;
    expect(run.plan.cutters.some((c) => c.key === CORN_06.key), 'the 0.6 mm corn is in the chosen plan').toBe(true);
    expect(joined, 'fewer pinches stay joined than with a ⌀1 cutter').toBeLessThan(oneJoined);
    expect(pick.chosen.worstFidelity).toBeGreaterThan(0.7);
  });
});
