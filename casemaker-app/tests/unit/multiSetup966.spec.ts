/**
 * #966 ROUND 3 — MULTI-SETUP POSTING. `generateGoalProgram`'s model-cam path used to refuse by
 * name whenever `planModelCam` returned more than one `SetupPlan` ("this cutover posts a
 * single-setup goal only"). This spec is RED-FIRST for lifting that refusal: a real,
 * analytic two-setup part (a plain box — the SAME geometry `contourFreeingCl965.spec.ts`'s own
 * section C already proves `planModelCam` plans end to end for two setups, driven here through an
 * embedded STL goal mesh instead of a hand-built `ParsedMesh`, so the test exercises the REAL
 * `recogniseFeatures` + `registerSetupOrigin` path, not a stand-in) posts and verifies BOTH
 * setups' programs, and `EngraveGenerated.plan` carries the full two-setup `ModelPlanOutput`.
 *
 * #1004 — THE SETUP LIST IS EDITED, NOT OVERRIDDEN. The old test-only seam
 * (`setupsOverride`/`modelSetupsOverride`) is retired: this spec builds the input with
 * `buildModelPlanInputForGoal`, replaces `input.setups` with its own two-setup list, plans with
 * `planModelCam`, then posts and verifies through the extracted `postModelPlan` — the literal
 * production steps, in order, with no option that can bypass the real `buildSetupSpecs` decision.
 *
 * Also proves the registration-refusal path (#965's `registerSetupOrigin`, thrown when a part
 * carries neither a reliable two-hole datum nor a long straight edge) is a named throw — never a
 * raw, unhandled crash.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { buildModelPlanInputForGoal, postModelPlan } from '@/workers/sim/engraveGenerate';
import { planModelCam } from '@/engine/cnc/cam/model/plan';
// The box fixture (triangles, STL encoding, job/shop building, the two-setup `SetupSpec[]`) is
// factored into a shared helper (#966) so `multiSetupVerify966.spec.ts` drives the SAME geometry
// through `generateGoalProgram` rather than forking a second copy of this logic.
import { boxTarget, jobFor, FLAT3, SHOP, twoSetups } from './helpers/twoSetupBox966';

/** The pre-plan findings the head computes; these cases exercise posting, not those verdicts. */
const NO_PLAN_FINDINGS = { goalFindings: [], reachFindings: [], coverageFindings: [], modelRoughFindings: [], chamferFindings: [] };

afterEach(() => {
  clearTargetObjectMeshCache();
});

describe('#966 ROUND 3 — generateGoalProgram posts and verifies a real multi-setup plan', () => {
  it('planModelCam plans two setups, every setup\'s programs post and verify, plan carries the full ModelPlanOutput', async () => {
    const L = 40, W = 30, T = 20;
    const job = jobFor(boxTarget('goal-966-ms-on', L, W, T), L, W, T);
    // #1004 — THE LITERAL PRODUCTION STEPS, WITH THIS SPEC'S OWN SETUP LIST: build, edit
    // `input.setups`, plan, post-and-verify through the SAME tail `generateGoalProgram` uses.
    const input = await buildModelPlanInputForGoal(job, job.targetObject!, FLAT3, SHOP);
    input.setups = twoSetups(T);
    const output = await planModelCam(input);
    const result = await postModelPlan(job, job.targetObject!, FLAT3, null, SHOP, output, NO_PLAN_FINDINGS);

    expect(result.errors, result.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stage).toBe('done');

    // The actual #966 ROUND 3 assertion: every posted program, across BOTH setups, passes
    // `verifyProgram` with zero error-severity findings — not just "didn't throw".
    expect(result.programs.length).toBeGreaterThan(0);
    for (const program of result.programs) {
      expect(program.nc, `setup ${program.setupIndex}/${program.toolKey}: no posted text`).toBeTruthy();
      expect(program.verify, `setup ${program.setupIndex}/${program.toolKey}: no verify report`).not.toBeNull();
      const errors = program.verify!.findings.filter((f) => f.severity === 'error');
      expect(errors, `setup ${program.setupIndex}/${program.toolKey}: ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
    }

    // Both setups are actually represented — setupIndex is 1-based (`EngraveProgram`'s own doc),
    // in posting order, and the two setups' own ids differ (the turn-over boundary's only
    // representation in the flat `programs` list — see `engraveGenerate.ts`'s own #966 note).
    const setupIndexes = [...new Set(result.programs.map((p) => p.setupIndex))].sort();
    expect(setupIndexes).toEqual([1, 2]);
    const setup1Ids = new Set(result.programs.filter((p) => p.setupIndex === 1).map((p) => p.setupId));
    const setup2Ids = new Set(result.programs.filter((p) => p.setupIndex === 2).map((p) => p.setupId));
    expect(setup1Ids.size).toBe(1);
    expect(setup2Ids.size).toBe(1);
    expect([...setup1Ids][0]).not.toBe([...setup2Ids][0]);

    // D's ask #1 — `EngraveGenerated.plan` carries the FULL two-setup `ModelPlanOutput`.
    expect(result.plan).not.toBeNull();
    expect(result.plan!.perSetup).toHaveLength(2);
    expect(result.plan!.perSetup.map((p) => p.setupIndex)).toEqual([0, 1]);
    expect(result.plan!.perSetup.every((p) => p.programs.length > 0)).toBe(true);
    // Setup 1 (the last, the vise flip) registered against setup 0 and states so in its notes —
    // #965 registration actually ran, not a nominal/skipped offset.
    expect(result.plan!.perSetup[1]!.notes.some((n) => n.includes('#965 registration'))).toBe(true);
  }, 90_000);
});

describe('#966 ROUND 3 — the registration refusal surfaces as a named stage failure, not a crash', () => {
  it('a part with no usable datum (too small for either the hole or the edge strategy) refuses by name', async () => {
    // 5 × 5 mm — every edge under `MIN_EDGE_LENGTH_MM` (15) and no through-holes at all
    // (`registration965.spec.ts`'s own "(c) neither feature survives" fixture, reused at goal
    // scale): `registerSetupOrigin` has nothing to anchor setup 1 against setup 0 with.
    const L = 5, W = 5, T = 3;
    const job = jobFor(boxTarget('goal-966-ms-refuse', L, W, T), L, W, T);
    const input = await buildModelPlanInputForGoal(job, job.targetObject!, FLAT3, SHOP);
    input.setups = twoSetups(T);
    // #1004 — the refusal is `planModelCam`'s own named throw; the seam's 'cam'-stage wrapping is
    // covered by the real-decision path (goalSetups966.spec.ts).
    await expect(planModelCam(input)).rejects.toThrow(/no locating features found for the vise flip \(#965 registration\)/);
  }, 90_000);
});
