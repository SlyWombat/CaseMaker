/**
 * #966 ROUND 3 — MULTI-SETUP POSTING. `generateGoalProgram`'s flag-on path (`USE_MODEL_CAM_ENGINE`)
 * used to refuse by name whenever `planModelCam` returned more than one `SetupPlan` ("this cutover
 * posts a single-setup goal only"). This spec is RED-FIRST for lifting that refusal: a real,
 * analytic two-setup part (a plain box — the SAME geometry `contourFreeingCl965.spec.ts`'s own
 * section C already proves `planModelCam` plans end to end for two setups, driven here through an
 * embedded STL goal mesh instead of a hand-built `ParsedMesh`, so the test exercises the REAL
 * `recogniseFeatures` + `registerSetupOrigin` path, not a stand-in) posts and verifies BOTH
 * setups' programs, and `EngraveGenerated.plan` carries the full two-setup `ModelPlanOutput`.
 *
 * `buildModelPlanInputForGoal`/`generateGoalProgram`'s own `setupsOverride`/`modelSetupsOverride`
 * parameters are a #966 test/e2e-only seam (their own doc comments): no production caller ever
 * passes one, because #898/#914's own flip plan is not wired to a goal job yet (a separate, future
 * piece of work) — this is the stated reason a real goal job cannot reach `planModelCam` with more
 * than one setup today without it.
 *
 * Also proves the registration-refusal path (#965's `registerSetupOrigin`, thrown when a part
 * carries neither a reliable two-hole datum nor a long straight edge) surfaces through this same
 * seam as a clean, named `'cam'`-stage failure — never a raw, unhandled throw.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { setModelCamEnabled } from '@/engine/cnc/cam/model/plan';
// The box fixture (triangles, STL encoding, job/shop building, the two-setup `SetupSpec[]`) is
// factored into a shared helper (#966) so `multiSetupVerify966.spec.ts` drives the SAME geometry
// through `generateGoalProgram` rather than forking a second copy of this logic.
import { boxTarget, jobFor, FLAT3, SHOP, twoSetups } from './helpers/twoSetupBox966';

afterEach(() => {
  clearTargetObjectMeshCache();
  setModelCamEnabled(false);
});

describe('#966 ROUND 3 — generateGoalProgram posts and verifies a real multi-setup plan', () => {
  it('flag off (the default): unaffected by the override — the old heightfield engine still runs, green', async () => {
    const L = 40, W = 30, T = 20;
    const job = jobFor(boxTarget('goal-966-ms-off', L, W, T), L, W, T);
    const result = await generateGoalProgram(job, job.targetObject!, FLAT3, [], null, SHOP, undefined, undefined, twoSetups(T));
    expect(result.errors, result.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.plan ?? null).toBeNull();
  }, 30_000);

  it('flag on: planModelCam plans two setups, every setup\'s programs post and verify, plan carries the full ModelPlanOutput', async () => {
    setModelCamEnabled(true);
    const L = 40, W = 30, T = 20;
    const job = jobFor(boxTarget('goal-966-ms-on', L, W, T), L, W, T);
    const result = await generateGoalProgram(job, job.targetObject!, FLAT3, [], null, SHOP, undefined, undefined, twoSetups(T));

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
  }, 30_000);
});

describe('#966 ROUND 3 — the registration refusal surfaces as a named stage failure, not a crash', () => {
  it('a part with no usable datum (too small for either the hole or the edge strategy) refuses by name', async () => {
    setModelCamEnabled(true);
    // 5 × 5 mm — every edge under `MIN_EDGE_LENGTH_MM` (15) and no through-holes at all
    // (`registration965.spec.ts`'s own "(c) neither feature survives" fixture, reused at goal
    // scale): `registerSetupOrigin` has nothing to anchor setup 1 against setup 0 with.
    const L = 5, W = 5, T = 3;
    const job = jobFor(boxTarget('goal-966-ms-refuse', L, W, T), L, W, T);
    const result = await generateGoalProgram(job, job.targetObject!, FLAT3, [], null, SHOP, undefined, undefined, twoSetups(T));

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('cam');
    expect(result.errors).toHaveLength(1);
    const message = result.errors[0]!.message;
    expect(message).toContain('cam/model seam (#966): planModelCam refused —');
    expect(message).toMatch(/no locating features found for the vise flip \(#965 registration\)/);
    expect(message).not.toMatch(/\n\s+at /); // not a raw stack trace
    // Nothing was planned before the throw (`registerSetupOrigin` runs INSIDE `planModelCam`,
    // before it ever returns an output), so there is no plan to carry here either.
    expect(result.plan ?? null).toBeNull();
  }, 30_000);
});
