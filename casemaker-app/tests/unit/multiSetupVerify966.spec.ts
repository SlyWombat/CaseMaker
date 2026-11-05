/**
 * #966 — STANDALONE REGRESSION SPEC: every program a multi-setup goal posts passes the REAL
 * verifier, end to end, with zero findings at the established bar. `multiSetup966.spec.ts`
 * already checks this inline, folded into its own broader "the plan carries the full
 * `ModelPlanOutput`" assertions; this file pulls that one claim out on its own so a future change
 * to the verifier (`src/engine/cnc/verify.ts`), to `postFor`, or to the multi-setup posting loop
 * in `generateGoalProgram` (`src/workers/sim/engraveGenerate.ts`) is caught here specifically,
 * not only as a side effect of a bigger spec's failure.
 *
 * WHAT "casemaker verify" ACTUALLY IS. There is no `casemaker verify` subcommand — `dispatch.ts`'s
 * own `USAGE` lists `cut`/`export`/`location`/`readback`/`machine` and nothing named `verify`. The
 * real verifier is `verifyProgram` (`src/engine/cnc/verify.ts`), and the codebase has exactly one
 * convention for calling it on a posted program: `postFor(mill)(ir, ctx, vacuum)` immediately
 * followed by `verifyProgram(posted.text, verifyCtx)` — the SAME pairing `facingProgram`,
 * `generateOneProgram`, `scripts/lib/casemaker/verifiedProgram.ts`'s `prepareVerifiedProgram`
 * (the body of `casemaker machine upload`'s own gate, #395), and `machineCommand.ts`'s receipt
 * printer all use. `generateGoalProgram`'s multi-setup posting loop (#966, this round) already
 * calls that SAME pairing for every one of its `SetupPlan.programs[]` entries and attaches the
 * resulting `VerifyReport` to `EngraveProgram.verify` — so reading `result.programs[i].verify`
 * here IS reading the real verifier's report on the real posted text, not a stand-in.
 *
 * There is, deliberately, no deeper CLI-level call to make instead: `casemaker cut`'s own
 * `engraveGenerate` → `generateGoalProgram` call never passes `modelSetupsOverride` (no production
 * caller does — see `multiSetup966.spec.ts`'s own header note), so a multi-setup goal cannot be
 * reached through the CLI today at all. This spec drives the exact same test-only seam
 * `multiSetup966.spec.ts` uses, because that is the only way to reach `planModelCam` with more
 * than one setup until #966-goal-setups lands `buildModelPlanInputForGoal`'s real setup decision.
 *
 * THE ZERO-FINDINGS BAR, STATED EXPLICITLY. `966-green`'s own bar (`camModelSeam966.spec.ts`,
 * both ROUND 1 and ROUND 2) is "zero ERROR-severity findings", not "zero findings of any
 * severity" — `verify.ts`'s own `VerifyReport.ok` is defined exactly that way
 * (`findings.every(f => f.severity !== 'error')`; the only two severities `VerifyFinding` has are
 * `'error'` and `'warning'`). This spec matches that SAME bar, not a stricter one: it asserts
 * `program.verify.ok === true` (equivalent to "no error-severity finding") for every posted
 * program, exactly as `multiSetup966.spec.ts`'s own ROUND 3 case already does by filtering on
 * `severity === 'error'`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { setModelCamEnabled } from '@/engine/cnc/cam/model/plan';
// The box fixture is `multiSetup966.spec.ts`'s own — factored into a shared helper so this spec
// drives the SAME geometry instead of forking a second copy of the fixture logic.
import { boxTarget, jobFor, FLAT3, SHOP, twoSetups } from './helpers/twoSetupBox966';

afterEach(() => {
  clearTargetObjectMeshCache();
  setModelCamEnabled(false);
});

describe('#966 — every program a multi-setup goal posts passes the real verifier end to end', () => {
  it('two-setup box: every posted program, both setups, carries a VerifyReport with zero error-severity findings', async () => {
    setModelCamEnabled(true);
    const L = 40, W = 30, T = 20;
    const job = jobFor(boxTarget('goal-966-verify-box', L, W, T), L, W, T);
    const result = await generateGoalProgram(job, job.targetObject!, FLAT3, [], null, SHOP, undefined, undefined, twoSetups(T));

    expect(result.errors, result.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stage).toBe('done');

    // Non-vacuous: both setups actually posted programs — otherwise the loop below would pass
    // trivially on a single-setup run and this spec would not be proving what it claims to.
    expect(result.programs.length).toBeGreaterThan(0);
    const setupIndexes = [...new Set(result.programs.map((p) => p.setupIndex))].sort();
    expect(setupIndexes).toEqual([1, 2]);

    // THE ACTUAL ASSERTION. Every posted program, across BOTH setups, has an `nc` body and a
    // `VerifyReport` (never null — #535's "null only on a surface program", which this multi-setup
    // 2.5D path never produces), and that report's own `ok` says "no error-severity finding" —
    // the SAME bar #966-green established, stated here as `verify.ok`, not re-derived differently.
    for (const program of result.programs) {
      const label = `setup ${program.setupIndex}/${program.toolKey}`;
      expect(program.nc, `${label}: no posted text`).toBeTruthy();
      expect(program.verify, `${label}: no verify report`).not.toBeNull();
      const errors = program.verify!.findings.filter((f) => f.severity === 'error');
      expect(errors, `${label}: ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
      expect(program.verify!.ok, `${label}: verify.ok should agree with "no error-severity finding"`).toBe(true);
    }
  }, 30_000);

  // TODO(#966): a sphere goal (a second, distinct analytic shape, alongside the box above) is the
  // Manager's own next step for THIS spec — but `buildModelPlanInputForGoal` does not yet decide
  // setups for a real goal job on its own; only the `setupsOverride`/`modelSetupsOverride` test
  // seam reaches `planModelCam` with more than one setup today. `966-goal-setups` (a separate,
  // parallel session) is mid-change on exactly that function right now. Enable this case once
  // 966-goal-setups lands buildModelPlanInputForGoal's real setup decision (#966) — do not
  // implement it before then; the fixture and assertions above are its own pattern to follow.
  it.skip('two-setup SPHERE goal: every posted program, both setups, carries a VerifyReport with zero error-severity findings', () => {
    // Intentionally left unimplemented — see the TODO above.
  });
});
