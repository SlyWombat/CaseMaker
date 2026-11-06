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
  it('#999 an ABSENT roughToolKey lets the ENGINE choose: the flat rough, then the ball (the old path keeps its pinned one-cutter file)', async () => {
    const job = goalJob();
    const out = await generateGoalProgram(job, job.targetObject!, BALL.tool, null, { shop: SHOP });
    expect(out.ok).toBe(true);
    if (USE_MODEL_CAM_ENGINE) {
      // #999 — absent is not "ball alone" on the seam: the plan's sequence chooses the house
      // flat (the largest, ⌀3 here) and the ball finishes.
      expect(out.programs).toHaveLength(2);
      expect(out.programs[0]!.toolKey).toBe(ROUGH.key);
      expect(out.programs[1]!.toolKey).toBe(BALL.key);
      expect(out.surface3d?.rough ?? null).toBeNull();
      return;
    }
    // The OLD heightfield path's own reading is unchanged (its bytes are pinned): absent = one cutter.
    expect(out.programs).toHaveLength(1);
    expect(out.programs[0]!.toolKey).toBe(BALL.key);
    expect(out.surface3d?.rough ?? null).toBeNull();
    // The promise that a goal without a rough is untouched: the posted file's hash. #987 makes a
    // skirt-closed relief's outline synthetic, so no freeing contour op is demanded against it:
    // this fixture (a 2-triangle open ramp, always closed with a skirt) went from 2 posted
    // programs (a flat contour + the ball finish) to the 1 this test already asserts above, and
    // the posted bytes changed with it — re-pinned for #987. The old heightfield engine's own,
    // unrelated pin for this same byte (`c03b471f`, #889/#909/#927/#945's history) went with it
    // when that engine was removed (#966).
    expect(programHash(out.nc!)).toBe('8275a038');
  });

  it('a roughToolKey posts the flat’s rough first and the ball’s finish second', async () => {
    const job = goalJob({ roughToolKey: ROUGH.key });
    const out = await generateGoalProgram(job, job.targetObject!, BALL.tool, null, { shop: SHOP });
    expect(out.ok).toBe(true);
    expect(out.programs).toHaveLength(2);
    const [rough, finish] = out.programs as [EngraveProgram, EngraveProgram];

    // TWO CUTTERS, IN CUT ORDER: the flat roughs, the ball finishes.
    expect(rough.toolKey).toBe(ROUGH.key);
    expect(finish.toolKey).toBe(BALL.key);
    // Each file names its own cutter in the post's TOOL record and changes to it — the SAME
    // postFor/verifyProgram pair both engines post through.
    expect(rough.nc).toContain(';@CM|TOOL|key=inv:flat-3');
    expect(finish.nc).toContain(';@CM|TOOL|key=inv:ball-3');
    expect(rough.nc).toMatch(/T\d+ ?M6/);
    expect(finish.nc).toMatch(/T\d+ ?M6/);

    // #987/#966 — the model-cam path has no `surfaceCheck`/"3D rough" vocabulary (surface3d.ts's
    // own op naming, never ported — and surface3d.ts is gone): the rough's existence and cutter
    // are read from the plan's own ops instead, which the model-cam path does carry.
    const ops = out.plan?.perSetup[0]?.ops ?? [];
    const roughOps = ops.filter((o) => o.kind === 'rough');
    const finishOps = ops.filter((o) => o.kind === 'finish');
    expect(roughOps).toHaveLength(1);
    expect(roughOps[0]!.outcome.cutter).toBe(ROUGH.key);
    expect(finishOps).toHaveLength(1);
    expect(finishOps[0]!.outcome.cutter).toBe(BALL.key);
    expect(ops.indexOf(roughOps[0]!)).toBeLessThan(ops.indexOf(finishOps[0]!));
  });

  it('the rough’s step-down is its own row’s, and the rim laps keep the finish’s', async () => {
    // ⌀1.5 is the 0.8–1.6 PLA band (step-down 0.3); the ⌀3 ball is the 1.6–3.2 band (0.5).
    const job = goalJob({ roughToolKey: SMALL.key });
    const out = await generateGoalProgram(job, job.targetObject!, BALL.tool, null, { shop: SHOP });
    expect(out.ok).toBe(true);
    expect(out.programs).toHaveLength(2);
    // #987 — `out.surface3d` carries no facts on this path (no GoalSurfaceFacts wiring exists
    // for the model-cam engine); the plan's own ops carry the equivalent step instead
    // (`CamOperation.passStepMm`). #990 fixed the rough's own row: it no longer inherits
    // `primary`'s step-down (0.5 mm, the pockets' own ⌀3 flat's PLA band) — the ⌀1.5
    // `curvedRoughTool`'s OWN 0.8–1.6 mm band reads 0.3.
    //
    // The finish ball's own 1.6–3.2 mm band (0.5) has no equivalent to assert here: the old
    // engine's `finishStepDownMm` is the RIM LAPS' spacing (#862, runSheet.ts's own doc — "the
    // rim laps ride the FINISHING cutter, so their spacing is ITS step-down"), which the
    // model-cam path does not plan at all for this fixture. Ahead of a rough, the model-cam
    // ball runs exactly ONE level over the whole remainder region's depth (#965 ruling, this
    // title's own "the rim laps keep the finish's" — unaffected by #990, out of its scope:
    // the `Math.max(opts.stepDownMm, span)` floor is always dominated by the span here) —
    // asserted as that, not as a feeds-row number it does not use.
    const ops = out.plan?.perSetup[0]?.ops ?? [];
    const roughOps = ops.filter((o) => o.kind === 'rough').flatMap((o) => o.outcome.ir.operations);
    const finishOps = ops.filter((o) => o.kind === 'finish').flatMap((o) => o.outcome.ir.operations);
    expect(roughOps.some((op) => op.passStepMm === 0.3)).toBe(true);
    expect(finishOps.some((op) => op.depthPasses === 1)).toBe(true);
  });

  it('#999 a rough the library does not hold falls back to the engine’s choice, and says which', async () => {
    const job = goalJob({ roughToolKey: 'inv:gone' });
    const out = await generateGoalProgram(job, job.targetObject!, BALL.tool, null, { shop: SHOP });
    expect(out.ok).toBe(true);
    // The seam lets the engine choose (two programs); the old path keeps its one-cutter reading.
    expect(out.programs).toHaveLength(USE_MODEL_CAM_ENGINE ? 2 : 1);
    if (USE_MODEL_CAM_ENGINE) expect(out.programs[0]!.toolKey).toBe(ROUGH.key);
    const finding = out.findings.find((f) => f.code === 'goal-rough-no-cutter');
    expect(finding).toBeDefined();
    expect(finding!.message).toContain('not in the tool library');
  });

  it('#999 an explicit null is the operator’s ball alone, stated in the findings', async () => {
    const job = goalJob({ roughToolKey: null });
    const out = await generateGoalProgram(job, job.targetObject!, BALL.tool, [], null, SHOP);
    expect(out.ok).toBe(true);
    expect(out.programs).toHaveLength(1);
    expect(out.programs[0]!.toolKey).toBe(BALL.key);
    const stated = out.findings.find((f) => f.code === 'goal-rough-ball-alone');
    expect(stated?.severity).toBe('info');
    expect(stated?.message).toContain('ball alone');
  });

  it('a ball named as the rough is refused by name, and the goal still posts', async () => {
    const job = goalJob({ roughToolKey: BALL.key });
    const out = await generateGoalProgram(job, job.targetObject!, BALL.tool, null, { shop: SHOP });
    expect(out.ok).toBe(true);
    expect(out.programs).toHaveLength(1);
    const finding = out.findings.find((f) => f.code === 'goal-rough-no-cutter');
    expect(finding?.message).toContain('must be a flat end mill');
  });

  // #987/#966 — "the run sheet states both cutters, the change, and which rough ran" is deleted
  // here, not fixed: both of its lines came from runSheet.ts's `surfaceSteps(facts:
  // GoalSurfaceFacts)`, fed only by `out.surface3d` — undefined on the model-cam path, and the
  // old heightfield engine that fed it is gone. The model-cam path's own run-sheet section is
  // #976 (parked, M2) — nothing to pin here until that lands.
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

  it('#999 applying a plan writes the rough key, and a plan without one writes null (ball alone)', async () => {
    const job = goalJob();
    const withRough = applyCutterPlanToJob(job, {
      cutters: [{ key: BALL.key, items: [job.targetObject!.id] }],
      goalRoughKey: ROUGH.key,
    });
    expect(withRough.targetObject?.roughToolKey).toBe(ROUGH.key);
    const without = applyCutterPlanToJob(withRough, { cutters: [{ key: BALL.key, items: [job.targetObject!.id] }] });
    // #999 — NEVER a delete: absent now means the engine chooses, so a ball-alone plan that
    // deleted the key would generate a rough the verdict never measured.
    expect(without.targetObject?.roughToolKey).toBeNull();
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
