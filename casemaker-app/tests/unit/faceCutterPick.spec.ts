// #834 — THE CUTTER FOR A JOB WHOSE WORK IS ON THE FACES. Seen in #241 slice 2's hex screenshot:
// a hex face is about 10 mm wide on ⌀20, and the rule handed back the ⌀1 mm flat end — 1 h 28 min
// of passes. Any fitting flat end leaves the SAME face, so the pick is the widest one, and the
// measured search ranks the candidates by the time their programs really take.

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { getTools } from '@/engine/cnc/toolRegistry';
import { recommendTool } from '@/engine/cnc/engrave/recommendTool';
import { planCutters, faceCutterPick, faceWorkOf } from '@/engine/cnc/engrave/cutterPlan';
import { smartPick, candidatePlans } from '@/engine/cnc/engrave/smartPick';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { clearPlanEvaluations, evaluatePlan, type EvalContext } from '@/workers/sim/planEvaluate';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveFaceOp, EngraveJob } from '@/types/engraveJob';

// The shop's own wood/plastic flat ends: the built-in ⌀3.175 is Makera's (Metal) line, which the
// material rule refuses on a wooden blank — a real shop reaches for its own bits here.
const LIB: ToolLibraryEntry[] = [
  { key: 'inv:flat-6', provenance: 'test', tool: flatEndMill(6, { name: '6 mm flat end', fluteLength: 20, shoulderLength: 20 }) },
  { key: 'inv:flat-3.175', provenance: 'test', tool: flatEndMill(3.175, { name: '3.175 mm flat end', fluteLength: 20, shoulderLength: 20 }) },
  { key: 'inv:flat-1', provenance: 'test', tool: flatEndMill(1, { name: '1 mm flat end' }) },
];
const thinTool = LIB[2]!.tool;
const wideTool = LIB[1]!.tool;

function faceJob(faces: EngraveFaceOp[], over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'faces on a rod',
    stock: { length: 100, width: 20, thickness: 20, material: 'softwood', shape: 'cylinder', diameter: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' },
    },
    labels: [],
    shapes: [],
    toolKey: '',
    faces,
    ...over,
  };
}

const hex: EngraveFaceOp = { id: 'hex', kind: 'faces-all-round', a: 0, count: 6, acrossFlats: 17.321 };

describe('#834 the face work and the cutters that fit it', () => {
  it('reads the narrowest face chord and the hole sizes from the job', () => {
    const facts = faceWorkOf(faceJob([hex, { id: 'h', kind: 'cross-hole', a: 90, diameter: 3.175 }]))!;
    expect(facts.chordMm).toBeCloseTo(10, 2); // the hexagon's side on ⌀20
    expect(facts.faceCount).toBe(6);
    expect(facts.holesMm).toEqual([3.175]);
    expect(facts.deepestMm).toBeCloseTo(1.3395, 3);
  });

  it('picks the WIDEST fitting flat end for the hex — not the ⌀1 mm engraver', () => {
    const job = faceJob([hex]);
    const rec = recommendTool(job, LIB, [], () => []);
    expect(rec.key).toBe('inv:flat-3.175');
    expect(rec.reason).toContain('10 mm faces');
    const plan = planCutters(job, null, LIB, []);
    expect(plan.cutters.map((c) => c.key)).toEqual(['inv:flat-3.175']);
    expect(plan.cutters[0]!.items).toEqual([]);
  });

  it('a cross-hole picks the cutter that drills its diameter, and says so', () => {
    const job = faceJob([{ id: 'h', kind: 'cross-hole', a: 90, diameter: 3.175 }]);
    const pick = faceCutterPick(job, LIB, [])!;
    expect(pick.entry.key).toBe('inv:flat-3.175');
    expect(pick.matchedHoles).toBe(true);
    expect(pick.reason).toContain('drills the ⌀3.175 mm cross-hole');
  });

  it('when no cutter matches the hole, it picks for the face and says what the hole comes out at', () => {
    const job = faceJob([{ id: 'h', kind: 'cross-hole', a: 90, diameter: 2 }]);
    const pick = faceCutterPick(job, LIB, [])!;
    expect(pick.matchedHoles).toBe(false);
    expect(pick.reason).toContain('No cutter in the shop matches ⌀2 mm');
    expect(pick.reason).toContain('⌀3.175 mm');
  });

  it('the ⌀3.175 program is several times faster than the ⌀1 one, and both cut the same faces', () => {
    const job = faceJob([hex]);
    job.workholding = { kind: 'rotary-chuck', rotary: { stickout: 40, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' } };
    const thin = engraveGenerate(tl, job, thinTool, [], null);
    const wide = engraveGenerate(tl, job, wideTool, [], null);
    expect(thin.ok).toBe(true);
    expect(wide.ok).toBe(true);
    const tThin = thin.cam!.estimatedSeconds;
    const tWide = wide.cam!.estimatedSeconds;
    expect(tWide).toBeGreaterThan(0);
    expect(tThin / tWide).toBeGreaterThan(2);
  }, 240_000);

  it('a metal-line cutter on wood is refused by the face program too', () => {
    const job = faceJob([hex]);
    job.workholding = { kind: 'rotary-chuck', rotary: { stickout: 40, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' } };
    const metal = getTools().find((t) => t.key === 'flat-3.175x12-metal')!.tool;
    const g = engraveGenerate(tl, job, metal, [], null);
    expect(g.ok).toBe(false);
    expect(g.findings.some((f) => f.code === 'tool-metal-line' && f.severity === 'error')).toBe(true);
  });

  it('a full evaluation of a face plan posts and prices the program', () => {
    clearPlanEvaluations();
    const job = faceJob([hex]);
    job.workholding = { kind: 'rotary-chuck', rotary: { stickout: 40, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' } };
    const ctx: EvalContext = { tl, tools: LIB, catalogue: [], shop: {}, calibration: null };
    const plan = { cutters: [{ key: 'inv:flat-3.175', items: [] }], source: { 'inv:flat-3.175': 'owned' as const } };
    const out = evaluatePlan(job, plan, ctx, { level: 'full' });
    expect(out.ok, out.refusal ?? '').toBe(true);
    expect(out.items).toEqual([]);
    expect(out.seconds).toBeGreaterThan(0);
  }, 240_000);

  it('the search measures every fitting cutter and chooses the fastest at equal fidelity', async () => {
    const job = faceJob([hex]);
    const plans = candidatePlans(job, LIB, []);
    // The ⌀6 has no feeds row for softwood, so it is not a candidate; the widest priced flat wins.
    expect(plans.map((p) => p.cutters[0]!.key)).toEqual(['inv:flat-3.175', 'inv:flat-1']);
    // A fake evaluator: the faces are exact for both, and the wide cutter's program is faster.
    const evaluate = (plan: { cutters: readonly { key: string }[] }) => ({
      ok: true,
      refusal: null,
      items: [],
      seconds: plan.cutters[0]!.key === 'inv:flat-1' ? 120 : 40,
      toolChanges: 0,
      risk: { reachMarginMm: null, holderClearanceMm: null, chipLoadRatio: null },
    });
    const pick = await smartPick(job, LIB, [], evaluate as never);
    expect(pick.chosen.plan.cutters[0]!.key).toBe('inv:flat-3.175');
    expect(pick.chosen.worstFidelity).toBe(1);
  });
});
