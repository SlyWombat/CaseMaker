/**
 * #869 — A GOAL ROUGHS WITH A FLAT AND FINISHES WITH THE BALL, AS TWO PROGRAMS.
 *
 * The goal path used to hand one cutter to both passes, so a ball — the finishing cutter every
 * real 3D job uses — never reached the adaptive clearing engine (flat end mills only, #846).
 * The split is a PLAN decision, made by the measured search: the goal's ball alone, or the same
 * ball after a flat whose size is nearest the ball's. When the plan names the flat, the goal
 * posts TWO programs — the flat's rough (its own feeds, its own `surfaceCheck`, its own tool
 * change) and the ball's finish (unchanged: the rim laps #862 and the finishing passes) — and the
 * rough leaves the finishing allowance. A goal with no flat is byte-identical to before.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { tl } from './helpers/manifoldExec';

// A localStorage shim, as the store barrel may be pulled in transitively by the dispatch path.
const backing = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
} as Storage;

import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { programHash } from '@/engine/cnc/programHash';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { EngraveProgram } from '@/workers/sim/engraveGenerate';
import type { CandidatePlan, EvalContext } from '@/workers/sim/planEvaluate';
import { evaluatePlan } from '@/workers/sim/planEvaluate';
import { candidatePlans, planKey, rulePlanOf } from '@/engine/cnc/engrave/smartPick';
import { applyCutterPlanToJob } from '@/engine/cnc/engrave/measuredPick';

afterEach(() => clearTargetObjectMeshCache());

type Tri = [[number, number, number], [number, number, number], [number, number, number]];

function binaryStl(tris: Tri[]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return buf;
}

let shaCounter = 0;
function goal(tris: Tri[], over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'goal-1',
    name: 'goal.stl',
    format: 'stl',
    sha256: `test-869-${shaCounter++}`,
    data: Buffer.from(new Uint8Array(binaryStl(tris))).toString('base64'),
    size: { x: 20, y: 20, z: 1 },
    position: { x: 50, y: 30, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

/** A ramp top surface over x,y in [0,20], z = −k·x (k = 0.05 → 1 mm over the run). */
function rampTris(): Tri[] {
  const p = (x: number, y: number): [number, number, number] => [x, y, -0.05 * x];
  return [
    [p(0, 0), p(20, 0), p(20, 20)],
    [p(0, 0), p(20, 20), p(0, 20)],
  ];
}

function entry(key: string, tool: Tool): ToolLibraryEntry {
  return { key, tool: { ...tool, id: key, number: null }, provenance: 'test fixture' };
}

/** The finishing ball, the flat nearest its size (the rule's rough), and two more. */
const BALL = entry('inv:ball-3', flatEndMill(3, { shape: 'ball', typeText: 'Ball End', name: '3 mm ball', fluteLength: 20, shoulderLength: 20 }));
const ROUGH = entry('inv:flat-3', flatEndMill(3, { name: '3 mm flat', fluteLength: 20, shoulderLength: 20 }));
/** A smaller flat in another feeds band — its own row, which is the split's own feeds. */
const SMALL = entry('inv:flat-1.5', flatEndMill(1.5, { name: '1.5 mm flat', fluteLength: 20, shoulderLength: 20 }));
const WIDE = entry('inv:flat-2', flatEndMill(2, { name: '2 mm flat', fluteLength: 20, shoulderLength: 20 }));

function goalJob(over: Partial<EngraveTargetObject> = {}, stockThickness = 12): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    shapes: [],
    stock: { ...base.stock, thickness: stockThickness, material: 'pla' },
    targetObject: goal(rampTris(), over),
    toolKey: BALL.key,
  };
}

const SHOP = { tools: [BALL, ROUGH, SMALL, WIDE] };

describe('#869 the goal’s split, generated', () => {
  it('a goal with no flat rough is ONE program, byte-identical (pinned)', async () => {
    const job = goalJob();
    const out = await generateGoalProgram(job, job.targetObject!, BALL.tool, [], null, SHOP);
    expect(out.ok).toBe(true);
    expect(out.programs).toHaveLength(1);
    expect(out.programs[0]!.toolKey).toBe(BALL.key);
    expect(out.surface3d?.rough ?? null).toBeNull();
    // The promise that a goal without a rough is untouched: the posted file's hash. #889 changed
    // goal POSTS on purpose (packed moves, merged collinear feeds, the chunked body), so the pin
    // is the post-#889 value; the split-vs-one-cutter difference is asserted below. Re-pinned when
    // #889 merged only LEVEL lines (a merged slope sweeps high in the column engine). Re-pinned
    // by #909: the single-cutter plan's rough is clamped over its ball's footprint. Re-pinned by
    // #927: only the `;@MKR|TIME` line moved (266 s → 280 s). Re-pinned by #945's cut-into fix:
    // the finish raster now steps a steep column pair instead of posting it as one diagonal move
    // — this fixture's ramp has at least one such pair. Re-pinned AGAIN by #945's coverage fix:
    // the ball's own default finish step-over is now DERIVED from its radius and the shop's
    // leftover-visible band (`finishStepOverForCusp`, surface3d.ts) rather than reused from the
    // 2.5D pocketing row — for this 3 mm ball (r 1.5 mm) against the fallback 0.1 mm band at the
    // fallback 0.1 mm grid, that derives 1.0 mm, tighter than the pre-fix ~1.35 mm 2.5D default
    // (the compiled PLA row's 0.45 fraction of the 3 mm proxy), so the finish raster's row count —
    // and the posted file — changed. Verified against a clean revert: this job states no
    // `surface.finishStepOverMm`, and the old pin (`da7e66c7`) is exactly what `git stash` here
    // reproduces.
    expect(programHash(out.nc!)).toBe('c03b471f');
  });

  it('a roughToolKey posts the flat’s rough first and the ball’s finish second', async () => {
    const job = goalJob({ roughToolKey: ROUGH.key });
    const out = await generateGoalProgram(job, job.targetObject!, BALL.tool, [], null, SHOP);
    expect(out.ok).toBe(true);
    expect(out.programs).toHaveLength(2);
    const [rough, finish] = out.programs as [EngraveProgram, EngraveProgram];

    // TWO CUTTERS, IN CUT ORDER: the flat roughs, the ball finishes.
    expect(rough.toolKey).toBe(ROUGH.key);
    expect(finish.toolKey).toBe(BALL.key);
    expect(rough.nc).toContain('3D rough');
    expect(rough.nc).not.toContain('3D finish');
    expect(finish.nc).toContain('3D finish');
    expect(finish.nc).not.toContain('3D rough');
    // Each file names its own cutter in the post's TOOL record and changes to it.
    expect(rough.nc).toContain(';@CM|TOOL|key=inv:flat-3');
    expect(finish.nc).toContain(';@CM|TOOL|key=inv:ball-3');
    expect(rough.nc).toMatch(/T\d+ ?M6/);
    expect(finish.nc).toMatch(/T\d+ ?M6/);

    // EACH PROGRAM CARRIES ITS OWN CHECK (#535/#844) — the rough is a judged file, not a prefix.
    const roughPasses = rough.surfaceCheck?.passes ?? [];
    const finishPasses = finish.surfaceCheck?.passes ?? [];
    expect(rough.surfaceCheck?.kind).toBe('surface');
    expect(roughPasses).toHaveLength(1);
    expect(roughPasses[0] ?? '').toContain('3D rough');
    expect(rough.surfaceCheck?.roughingLayers).toBeGreaterThan(0);
    expect(finish.surfaceCheck?.kind).toBe('surface');
    expect(finishPasses.every((p) => !p.includes('3D rough'))).toBe(true);
    expect(finish.surfaceCheck?.roughingLayers).toBe(0);
    expect(rough.surfaceCheck?.bbox).not.toEqual(finish.surfaceCheck?.bbox);

    // THE ALLOWANCE IS THE ROUGH'S, and both cutters are stated (the row carries the cutter's
    // display form, as every operator-facing sentence names a cutter).
    expect(rough.nc).toContain('mm to leave');
    expect(out.surface3d?.rough?.tool).toContain('flat end');
    expect(out.surface3d?.rough?.kind).toMatch(/^(raster|adaptive)$/);
  });

  it('the rough’s step-down is its own row’s, and the rim laps keep the finish’s', async () => {
    // ⌀1.5 is the 0.8–1.6 PLA band (step-down 0.3); the ⌀3 ball is the 1.6–3.2 band (0.5).
    const job = goalJob({ roughToolKey: SMALL.key });
    const out = await generateGoalProgram(job, job.targetObject!, BALL.tool, [], null, SHOP);
    expect(out.ok).toBe(true);
    expect(out.programs).toHaveLength(2);
    expect(out.surface3d?.stepDownMm).toBeCloseTo(0.3, 6);
    expect(out.surface3d?.finishStepDownMm).toBeCloseTo(0.5, 6);
  });

  it('a rough the library does not hold leaves one program and says which', async () => {
    const job = goalJob({ roughToolKey: 'inv:gone' });
    const out = await generateGoalProgram(job, job.targetObject!, BALL.tool, [], null, SHOP);
    expect(out.ok).toBe(true);
    expect(out.programs).toHaveLength(1);
    const finding = out.findings.find((f) => f.code === 'goal-rough-no-cutter');
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('not in the tool library');
  });

  it('a ball named as the rough is refused by name, and the goal still posts', async () => {
    const job = goalJob({ roughToolKey: BALL.key });
    const out = await generateGoalProgram(job, job.targetObject!, BALL.tool, [], null, SHOP);
    expect(out.ok).toBe(true);
    expect(out.programs).toHaveLength(1);
    const finding = out.findings.find((f) => f.code === 'goal-rough-no-cutter');
    expect(finding?.message).toContain('must be a flat end mill');
  });

  it('the run sheet states both cutters, the change, and which rough ran', async () => {
    const job = goalJob({ roughToolKey: ROUGH.key });
    const out = await generateGoalProgram(job, job.targetObject!, BALL.tool, [], null, SHOP);
    const texts = buildRunSheet(job, out, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    const split = texts.find((t) => t.includes('Two programs, two cutters'));
    expect(split).toBeDefined();
    expect(split).toContain('3 mm flat');
    expect(split).toContain('change to the ball');
    const surface = texts.find((t) => t.includes('Surface a mesh'));
    expect(surface).toBeDefined();
    expect(surface).toContain('Roughing in');
  });
});

describe('#869 the goal’s split, chosen by the search', () => {
  it('the candidate plans offer the ball alone AND the ball after a flat', async () => {
    const job = goalJob();
    const plans = candidatePlans(job, SHOP.tools, []);
    const splits = plans.filter((p) => p.goalRoughKey !== undefined);
    const alone = plans.filter((p) => p.goalRoughKey === undefined);
    expect(splits.length).toBeGreaterThan(0);
    expect(alone.length).toBeGreaterThan(0);
    // Every plan surfaces with the ball; the rough never becomes the job's cutter.
    for (const plan of plans) expect(plan.cutters[0]?.key).toBe(BALL.key);
    // The rule sizes the rough against the ball: ⌀4 is the nearest flat to ⌀3.
    expect(splits.some((p) => p.goalRoughKey === ROUGH.key)).toBe(true);
    // The two plans are different plans, not the same one twice.
    expect(planKey(splits[0]!)).not.toBe(planKey(alone[0]!));
  });

  it('the rule’s plan names a flat rough when the shop owns one', async () => {
    const plan = rulePlanOf(goalJob(), SHOP.tools, []);
    expect(plan?.goalRoughKey).toBe(ROUGH.key);
  });

  it('applying a plan writes the rough key, and a plan without one clears it', async () => {
    const job = goalJob();
    const withRough = applyCutterPlanToJob(job, {
      cutters: [{ key: BALL.key, items: [job.targetObject!.id] }],
      goalRoughKey: ROUGH.key,
    });
    expect(withRough.targetObject?.roughToolKey).toBe(ROUGH.key);
    const without = applyCutterPlanToJob(withRough, { cutters: [{ key: BALL.key, items: [job.targetObject!.id] }] });
    expect(without.targetObject?.roughToolKey).toBeUndefined();
  });

  it('the split charges one more tool change to the measured cost', async () => {
    const job = goalJob();
    const ctx: EvalContext = { tl, tools: [BALL, ROUGH, WIDE], catalogue: [], shop: {}, calibration: null };
    const one: CandidatePlan = { cutters: [{ key: BALL.key, items: [job.targetObject!.id] }], source: { [BALL.key]: 'owned' } };
    const two: CandidatePlan = { ...one, goalRoughKey: ROUGH.key, source: { [BALL.key]: 'owned', [ROUGH.key]: 'owned' } };
    expect((await evaluatePlan(job, one, ctx)).toolChanges).toBe(0);
    expect((await evaluatePlan(job, two, ctx)).toolChanges).toBe(1);
  });
});
