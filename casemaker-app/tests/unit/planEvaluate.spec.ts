/**
 * #766 slice A — THE EVALUATOR, pinned on the coin.
 *
 * The fixture is the demo's j04-coin-disc-faithful job: a ⌀30 × 3 PLA disc, a ⌀26 cutaway field
 * 0.4 mm deep, and the raised labels CNX and “Software” standing in it (size 3.6 mm — the word
 * whose pinch is 0.278 mm). The three plans are the ones the bench found by hand (#765):
 *
 *   ⌀2 + ⌀1         — the word comes out fused
 *   ⌀2 + 0.6 corn   — nearly separated: a touch or two at the tightest pinches
 *   ⌀2 + 0.1 V      — separated, with a hair of edge loss the flank takes (≈0.016 mm a side)
 *
 * What this suite proves is the SCORE, not a new CAM: the fidelity, the pinch list (count and
 * where), and the V's edge loss, from the same geometry the raised-text finding uses. Whether the
 * V plan currently POSTS is the generator's fact, reported in `refusal`, not hidden.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { tl } from './helpers/manifoldExec';
import {
  applyCutterPlan,
  clearPlanEvaluations,
  evaluatePlan,
  type CandidatePlan,
  type EvalContext,
} from '@/workers/sim/planEvaluate';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import type { EngraveJob } from '@/types/engraveJob';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';

/** The coin, verbatim from demo5's j04-coin-disc-faithful.json (the document the bench cut). */
function coinJob(): EngraveJob {
  return {
    ...defaultEngraveJob(),
    name: 'j04 coin',
    stock: { length: 30, width: 30, thickness: 3, material: 'pla', shape: 'disc', diameter: 30 },
    labels: [
      {
        id: 'cnx',
        text: 'CNX',
        font: DEFAULT_FONT_ID,
        weight: 'bold',
        size: 7,
        position: { x: 15, y: 18.5 },
        rotation: 0,
        depth: 0.4,
        enabled: true,
        construction: true,
      },
      {
        id: 'software',
        text: 'Software',
        font: DEFAULT_FONT_ID,
        weight: 'bold',
        size: 3.6,
        position: { x: 15, y: 10.5 },
        rotation: 0,
        depth: 0.4,
        enabled: true,
        construction: true,
      },
    ],
    shapes: [
      {
        id: 'field',
        kind: 'circle',
        position: { x: 15, y: 15 },
        rotation: 0,
        depth: 0.4,
        enabled: true,
        diameter: 26,
        construction: true,
      },
    ],
    combined: [
      {
        id: 'clear',
        kind: 'cutaway',
        position: { x: 15, y: 15 },
        rotation: 0,
        depth: 0.4,
        enabled: true,
        outer: 'field',
        islands: ['cnx', 'software'],
      },
    ],
    toolKey: '',
    setups: undefined,
    targetObject: undefined,
    // The demo document's own mount (demo5's j04): a 3 mm blank standing 1.5 mm proud of the
    // vise's jaws. The shipped default vise refuses it (stockProud is not its 1.5 mm), and the
    // generator's finding is real — the evaluator must judge the job as the bench had it.
    workholding: {
      kind: 'vise',
      vise: {
        stockProud: 1.5,
        seat: 'ledge',
        fixedJawThickness: 10,
        movingJawThickness: 10,
        jawLength: 100,
        jawStartY: -10,
        source: 'default',
        uncertainty: 0.5,
      },
    },
    jawClearance: 1,
    breakthrough: 0.3,
    edgeMargin: 1,
    minFloor: 1,
  };
}

function entry(key: string, tool: Tool): ToolLibraryEntry {
  return { key, tool: { ...tool, id: key, number: 1 }, provenance: 'test fixture' };
}

const O2 = entry('inv:o-flute-2', flatEndMill(2, { name: '2 mm O-flute', fluteLength: 12, shoulderLength: 20 }));
const F1 = entry('inv:flat-1', flatEndMill(1, { name: '1 mm flat', fluteLength: 12, shoulderLength: 20 }));
const CORN = entry('inv:corn-0.6', flatEndMill(0.6, { name: '0.6 mm corn', fluteLength: 12, shoulderLength: 20 }));
/** The 0.1 mm 30° engraver of #765 (tip 0.1, included angle 30°). */
const V: Tool = {
  number: null,
  id: 'inv:v-30-0.1',
  name: '0.1 mm 30° engraver',
  typeText: 'Engraving',
  shape: 'engraving',
  handleDiameter: 3.175,
  tipDiameter: 0.1,
  diameter: 3.175,
  cornerRadius: 0,
  angle: 30,
  halfAngle: 15,
  fluteLength: 12,
  shoulderLength: 12,
  stickout: null,
  centreCutting: null,
};
const VENTRY = entry('inv:v-30-0.1', V);

const CTX: EvalContext = {
  tl,
  tools: [O2, F1, CORN, VENTRY],
  catalogue: [],
  shop: {},
  calibration: null,
};

/** ⌀2 owns the cutaway; the rest cutter (items []) re-cuts its leftovers — the #410 rest pair. */
function plan(rest?: ToolLibraryEntry): CandidatePlan {
  const cutters = [
    { key: O2.key, items: ['clear'] },
    ...(rest === undefined ? [] : [{ key: rest.key, items: [] as string[] }]),
  ];
  return {
    cutters,
    source: Object.fromEntries(cutters.map((c) => [c.key, 'owned' as const])),
  };
}

function clearRow(out: ReturnType<typeof evaluatePlan>) {
  const row = out.items.find((i) => i.id === 'clear');
  if (row === undefined) throw new Error(`no 'clear' row; items: ${out.items.map((i) => i.id).join(', ')}`);
  return row;
}

beforeEach(() => clearPlanEvaluations());

describe('#766 A — the coin’s three rest choices, scored by what they leave', () => {
  it('the ⌀1 rest leaves Software fused: joined pinches at the tightest gap', () => {
    const out = evaluatePlan(coinJob(), plan(F1), CTX);
    const clear = clearRow(out);
    expect(clear.pinches.length).toBeGreaterThan(0);
    const joined = clear.pinches.filter((p) => !p.separated);
    expect(joined.length).toBeGreaterThan(0);
    // The design's tightest pinch is the 0.278 mm the bench measured.
    expect(Math.min(...clear.pinches.map((p) => p.gapMm))).toBeCloseTo(0.278, 2);
    // The names are glyph characters where the component is one glyph ('S', 'o'), so the sentence
    // can say “between S–o”; a merged pair falls back to its ordinal and is still named.
    expect(joined.some((p) => p.between.some((n) => !n.startsWith('glyph ')))).toBe(true);
    expect(clear.fidelity).toBeLessThan(0.99);
  });

  it('the 0.6 corn reads better: the joined field is smaller than the ⌀1’s', () => {
    const f1 = clearRow(evaluatePlan(coinJob(), plan(F1), CTX));
    const corn = clearRow(evaluatePlan(coinJob(), plan(CORN), CTX));
    const sliver = (row: typeof f1): number => row.pinches.reduce((sum, p) => sum + p.areaMm2, 0);
    expect(sliver(corn)).toBeLessThan(sliver(f1));
    expect(corn.fidelity).toBeGreaterThan(f1.fidelity);
    // It still touches at the tightest pinch — “nearly separated”, not clean.
    expect(corn.pinches.some((p) => !p.separated)).toBe(true);
  });

  it('the 0.1 mm V is separated by its flank, at 0.016 mm a side of edge loss', () => {
    const out = evaluatePlan(coinJob(), plan(VENTRY), CTX);
    const clear = clearRow(out);
    expect(clear.pinches.length).toBeGreaterThan(0);
    const tightest = clear.pinches.reduce((a, b) => (a.gapMm <= b.gapMm ? a : b));
    expect(tightest.gapMm).toBeCloseTo(0.278, 2);
    expect(tightest.edgeLossMm).toBeGreaterThan(0.005);
    expect(tightest.edgeLossMm).toBeLessThan(0.03);
    expect(tightest.separated).toBe(true);
    expect(clear.fidelity).toBeGreaterThan(0.99);
    // COARSE says the plan is evaluable; whether it POSTS is the full level's verdict, and today
    // the #486 rule still refuses a V as a rest cutter (the engine half of #765).
    expect(out.ok).toBe(true);
    const full = evaluatePlan(coinJob(), plan(VENTRY), CTX, { level: 'full' });
    if (!full.ok) expect(full.refusal).toMatch(/V-bit is not a rest cutter/);
  });

  it('the fidelity order the bench found by hand: ⌀1 < 0.6 corn ≤ V', () => {
    const f1 = clearRow(evaluatePlan(coinJob(), plan(F1), CTX)).fidelity;
    const corn = clearRow(evaluatePlan(coinJob(), plan(CORN), CTX)).fidelity;
    const v = clearRow(evaluatePlan(coinJob(), plan(VENTRY), CTX)).fidelity;
    expect(f1).toBeLessThan(corn);
    expect(corn).toBeLessThanOrEqual(v);
  });
});

describe('#766 A — the plan is a document change, and the verdict is cached', () => {
  it('applyCutterPlan writes the CLI’s shape: toolKey, then one setup with tools + toolItems', () => {
    const applied = applyCutterPlan(coinJob(), plan(CORN));
    expect(applied.toolKey).toBe(O2.key);
    expect(applied.setups).toHaveLength(1);
    expect(applied.setups![0]!.tools).toEqual([O2.key, CORN.key]);
    expect(applied.setups![0]!.toolItems).toEqual({ [O2.key]: ['clear'], [CORN.key]: [] });
    // One cutter is still written through the setup path — a house `inv:` key has no built-in
    // registry entry, and the setup path resolves it from the caller's list. It is still one file.
    const single = applyCutterPlan(coinJob(), plan());
    expect(single.setups).toHaveLength(1);
    expect(single.setups![0]!.tools).toEqual([O2.key]);
    // The source job is untouched — the evaluator never edits the caller's document.
    expect(coinJob().toolKey).toBe('');
  });

  it('a repeated call returns the memoised verdict; clearing re-evaluates', () => {
    // One document, evaluated twice: the key is the job's CONTENT hash, so two freshly minted
    // jobs (different ids) are deliberately different keys.
    const job = coinJob();
    const a = evaluatePlan(job, plan(F1), CTX);
    const b = evaluatePlan(job, plan(F1), CTX);
    expect(b).toBe(a);
    clearPlanEvaluations();
    const c = evaluatePlan(job, plan(F1), CTX);
    expect(c).not.toBe(a);
  });

  it('a plan naming a cutter outside the list is refused, not thrown', () => {
    const bad: CandidatePlan = {
      cutters: [{ key: 'inv:not-there', items: ['clear'] }],
      source: { 'inv:not-there': 'owned' },
    };
    const out = evaluatePlan(coinJob(), bad, CTX);
    expect(out.ok).toBe(false);
    expect(out.refusal).toContain('not in the tool list');
  });

  it('the coarse level is measure-only: no run time; full adds the CAM and its time', () => {
    const job = coinJob();
    const coarse = evaluatePlan(job, plan(CORN), CTX);
    expect(coarse.toolChanges).toBe(1);
    expect(coarse.seconds).toBeNull();
    expect(coarse.risk.reachMarginMm).not.toBeNull();
    expect(coarse.risk.holderClearanceMm).toBe(coarse.risk.reachMarginMm);
    expect(coarse.risk.chipLoadRatio).toBeNull();
    const full = evaluatePlan(job, plan(CORN), CTX, { level: 'full' });
    expect(full.ok).toBe(true);
    expect(full.seconds).toBeGreaterThan(0);
    // Every program was seeded on the stock the last one left, so the run has a swept verdict.
    expect(full.sweep?.worstUnderMm2).toBeGreaterThanOrEqual(0);
    expect(full.sweep?.worstOverMm2).toBeGreaterThanOrEqual(0);
    expect(full.sweep?.bandMm).toBeGreaterThan(0);
  });

  it('a plan that does not post says so at full, while its measures still stand', () => {
    const out = evaluatePlan(coinJob(), plan(VENTRY), CTX, { level: 'full' });
    // Today's generator refuses the V rest (#486); the measured fidelity is still returned.
    expect(out.ok).toBe(false);
    expect(out.refusal).toBeTruthy();
    expect(clearRow(out).pinches.length).toBeGreaterThan(0);
    expect(out.sweep).toBeNull();
  });
});
