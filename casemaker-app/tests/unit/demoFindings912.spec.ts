// Issue #912 — the demo findings that are code decisions.
//
// 1. A rest pass is chosen by its OUTCOME — what it takes, the seconds it spends taking it, and
//    what the leftover would show — not by the residual alone. A pass past the absurd rate (the
//    demo wolf: 6 h 53 min to take 803 mm³ to 717 mm³) is skipped and its numbers are stated.
// 2. The cutter pick RESPECTS THE PLUG'S CONE: a male inlay half was built for the female's V, so
//    a cone of another angle is set aside by name instead of being picked and then warned about
//    (the demo j11: a 20° engraver picked for a 30° plug).

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { planCutters } from '@/engine/cnc/engrave/cutterPlan';
import { recommendTool } from '@/engine/cnc/engrave/recommendTool';
import {
  restOutcome,
  restOutcomeAbsurd,
  restOutcomeBetter,
  REST_ABSURD_SECONDS_PER_MM3,
} from '@/engine/cnc/engrave/restSettings';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { Tool, ToolShape } from '@/engine/cnc/tool';
import type { EngraveCombinedShape, EngraveJob } from '@/types/engraveJob';

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
      fluteLength: 20,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
      ...over,
    },
  };
}

/** A 20° engraver (half-angle 10°) and a 30° one (half-angle 15°) — the demo's mismatch. */
const ENGRAVER_20 = entry('engraver-20', 'engraving', { tipDiameter: 0.5, diameter: 3.175, halfAngle: 10 });
const ENGRAVER_30 = entry('engraver-30', 'engraving', { tipDiameter: 0.5, diameter: 3.175, halfAngle: 15 });
const CHAMFER_90 = entry('chamfer-90', 'chamfer', { tipDiameter: 0.1, diameter: 3.175, angle: 90 });

const TAN_15 = Math.tan((15 * Math.PI) / 180);
const TAN_45 = Math.tan((45 * Math.PI) / 180);

function maleJob(tanHalf: number, depth = 3.5): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    shapes: [],
    traces: [],
    vectors: [],
    drills: [],
    threads: [],
    cutouts: [],
    chamfers: [],
    primitives: [],
    targetObject: undefined,
    toolKey: '',
    stock: { ...base.stock, length: 60, width: 40, thickness: 6, material: 'pla' },
    combined: [
      {
        id: 'inlay-male-1',
        kind: 'cutaway',
        position: { x: 30, y: 20 },
        rotation: 0,
        depth,
        enabled: true,
        outer: 'ff',
        islands: [],
        inlay: {
          role: 'male',
          glueGapMm: 1.3,
          pocketDepthMm: 4.8,
          tanHalf,
          islandInsetMm: 4.8 * tanHalf,
        },
      } as EngraveCombinedShape,
    ],
  };
}

describe('#912 — the cutter pick respects the plug’s cone', () => {
  it('picks the pair’s 30° bit, and sets the 20° one aside by name', () => {
    const job = maleJob(TAN_15);
    const plan = planCutters(job, null, [ENGRAVER_20, ENGRAVER_30], [], null);
    expect(plan.cutters).toHaveLength(1);
    expect(plan.cutters[0]!.key).toBe('engraver-30');
    expect(plan.unassigned).toHaveLength(0);
  });

  it('the recommendation excludes the wrong cone with the pair’s angle in its own words', () => {
    const job = maleJob(TAN_15);
    const rec = recommendTool(job, [ENGRAVER_20, ENGRAVER_30], [], null, () => []);
    expect(rec.key).toBe('engraver-30');
    const wrong = rec.candidates.find((c) => c.key === 'engraver-20');
    expect(wrong?.qualifies).toBe(false);
    expect(wrong?.excluded).toBe('inlay-cone');
    expect(wrong?.refusal).toContain('30°');
    expect(wrong?.refusal).toContain('20°');
  });

  it('says the pair’s cone when the list holds none that matches', () => {
    const job = maleJob(TAN_15);
    const plan = planCutters(job, null, [ENGRAVER_20], [], null);
    expect(plan.cutters).toHaveLength(0);
    expect(plan.unassigned[0]?.reason).toContain('built for a 30° V');
    const rec = recommendTool(job, [ENGRAVER_20], [], null, () => []);
    expect(rec.key).toBeNull();
  });

  it('a 90° male pair takes the 90° cone, not the engraver', () => {
    // The plug is 1.2 mm deep: inside the 3.175 mm chamfer bit's 1.54 mm cone (a deeper plug is
    // the over-deep V the depth rule refuses, #741 — not this test's question).
    const job = maleJob(TAN_45, 1.2);
    const plan = planCutters(job, null, [ENGRAVER_30, CHAMFER_90], [], null);
    expect(plan.cutters[0]!.key).toBe('chamfer-90');
  });

  it('leaves jobs with no male mark alone: the cone pick is unchanged', () => {
    const job = maleJob(TAN_15);
    job.combined = [];
    // A variable V-carve (not an inlay pair) still takes a cone — any engraver.
    job.labels = [
      {
        id: 'l1',
        kind: 'text',
        text: 'V',
        font: 'sans',
        size: 10,
        position: { x: 30, y: 20 },
        rotation: 0,
        depth: 1,
        enabled: true,
        vCarveDepth: 'variable',
      } as unknown as EngraveJob['labels'][number],
    ];
    const plan = planCutters(job, null, [ENGRAVER_20, ENGRAVER_30], [], null);
    expect(plan.cutters).toHaveLength(1);
    expect(['engraver-20', 'engraver-30']).toContain(plan.cutters[0]!.key);
  });
});

describe('#912 — a rest pass is chosen by its outcome', () => {
  it('rates a pass by the seconds it spends for each mm³ it takes', () => {
    // The demo wolf's pass: 86.2 mm³ in 24,784 s — absurd.
    const wolf = restOutcome(86.2, 716.8, 24_784, true);
    expect(wolf.secondsPerMm3).toBeCloseTo(287.5, 1);
    expect(restOutcomeAbsurd(wolf)).toBe(true);
    expect(REST_ABSURD_SECONDS_PER_MM3).toBe(60);
    // The demo photo relief's: 875.5 mm³ in 7,485 s — worth running.
    const photo = restOutcome(875.5, 316.8, 7_485, false);
    expect(photo.secondsPerMm3).toBeCloseTo(8.55, 1);
    expect(restOutcomeAbsurd(photo)).toBe(false);
  });

  it('prefers the pass that hides the leftover, then the better outcome, then the smaller residual', () => {
    const hidesSlow = restOutcome(500, 0, 30_000, false); // 60 s/mm³, hides it
    const leavesFast = restOutcome(100, 400, 100, true); // 1 s/mm³, still visible
    // What the leftover would show comes first.
    expect(restOutcomeBetter(hidesSlow, leavesFast)).toBe(true);
    expect(restOutcomeBetter(leavesFast, hidesSlow)).toBe(false);
    // Among passes that leave the same picture, the outcome decides.
    const quick = restOutcome(200, 300, 600, true); // 3 s/mm³
    const slow = restOutcome(200, 300, 1_200, true); // 6 s/mm³
    expect(restOutcomeBetter(quick, slow)).toBe(true);
    expect(restOutcomeBetter(slow, quick)).toBe(false);
    // At equal outcomes, the lower residual, then the lower time.
    const low = restOutcome(200, 100, 600, true);
    const high = restOutcome(200, 300, 600, true);
    expect(restOutcomeBetter(low, high)).toBe(true);
    expect(restOutcomeBetter(high, low)).toBe(false);
    expect(restOutcomeBetter(low, null)).toBe(true);
  });
});
