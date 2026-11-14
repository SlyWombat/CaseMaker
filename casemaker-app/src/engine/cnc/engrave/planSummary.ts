/**
 * #1126 slice 2 — THE PLAN THE PAGE HOLDS, AND THE VERIFIER'S CONTEXT BESIDE EACH PROGRAM.
 *
 * ONE RESULT SHAPE FROM BOTH DOORS. The house CLI (`resultDocument`) and the in-page worker
 * (`trimGenerated`) both build each plan they return with {@link planSummary}: an ALLOWLIST of
 * named fields, each with the reader that needs it. `ModelPlanOutput` also holds every setup's
 * posted ToolpathIR (`perSetup[].programs`, 223 MB on the tray) and the sampled CL surfaces; a
 * field the engine adds tomorrow cannot reach a result unless it is named here.
 *
 * The readers (file:line as of this commit; `houseResultTrim1126.spec.ts` pins the list):
 *   outcome                      src/store/engraveRunStore.ts:1129,1467 (goal input), engine/cnc/engrave/runCycle.ts:37
 *   perSetup[].notes             src/testing/windowApi.ts:774 (QA window)
 *   tabChoiceApplied             src/components/panels/EngraveTabChoice.tsx:54, useTabChoiceSuffix.ts:14
 *   tabChoiceNeeded / Stale      src/components/panels/EngraveTabChoice.tsx:52,55
 *   perSetup[].ops[].kind        src/components/panels/GoalFreeingTabs.tsx:61
 *   ..ops[].outcome.tabCounts    src/components/panels/GoalFreeingTabs.tsx:62
 * (`EngravePanel.tsx:5338` tests only that a plan exists; `restoredRun.ts` tests that a plan has an
 * entry for each program's setup.) `throughKerf` is NOT listed: its only reader is the re-check,
 * which reads {@link ProgramVerifyContext}.
 */
import type { ModelPlanOutput, PlanOutcome } from '@/engine/cnc/cam/model/plan';
import type { PlannedOpKind } from '@/engine/cnc/cam/model/sequence';
import type { StoredDepthLimit } from '@/engine/cnc/engrave/storedDepthLimit';
import type { SetupRecordDeps, VerifyPerProgram } from '@/engine/cnc/setups/setupRecord';

type TabCounts = NonNullable<ModelPlanOutput['perSetup'][number]['ops'][number]['outcome']['tabCounts']>;
type ThroughKerf = NonNullable<ModelPlanOutput['perSetup'][number]['ops'][number]['outcome']['throughKerf']>;

export interface PlanSummary {
  outcome?: PlanOutcome | null;
  tabChoiceApplied?: NonNullable<ModelPlanOutput['tabChoiceApplied']>;
  tabChoiceNeeded?: NonNullable<ModelPlanOutput['tabChoiceNeeded']>;
  tabChoiceStale?: true;
  perSetup: {
    setupIndex: number;
    notes: string[];
    ops: { kind: PlannedOpKind; outcome: { tabCounts?: TabCounts } }[];
  }[];
}

/** Anything a plan summary can be built from: a whole plan, or a summary already. */
export function planSummary(plan: PlanSummary | null | undefined): PlanSummary | null {
  if (plan === null || plan === undefined) return null;
  return {
    outcome: plan.outcome ?? null,
    ...(plan.tabChoiceApplied === undefined ? {} : { tabChoiceApplied: plan.tabChoiceApplied }),
    ...(plan.tabChoiceNeeded === undefined ? {} : { tabChoiceNeeded: plan.tabChoiceNeeded }),
    ...(plan.tabChoiceStale === true ? { tabChoiceStale: true as const } : {}),
    perSetup: plan.perSetup.map((setup) => ({
      setupIndex: setup.setupIndex,
      notes: setup.notes.filter((n) => typeof n === 'string'),
      ops: setup.ops.map((op) => ({
        kind: op.kind,
        outcome: op.outcome.tabCounts === undefined ? {} : { tabCounts: op.outcome.tabCounts },
      })),
    })),
  };
}

/**
 * THE CONTEXT A PROGRAM WAS VERIFIED WITH, as plain data beside it (#1191). The posting path that
 * built the program states the very inputs its first verification used (`verifyContextOfFacts`
 * takes the facts object that path handed to `verifyContextFrom`); `recheckStoredPrograms` reads
 * this and nothing of the plan.
 *
 * `depthLimit` is the one thing a function cannot carry, so it carries what the function was
 * composed from (see `StoredDepthLimit`: the boundary margin, the wasteboard, the through mask's
 * GEOMETRY and the layer stack's sliced solid — all plain numbers, rebuilt exactly, nothing
 * sampled). It is ABSENT only on a path whose limit the record composes itself from `throughKerf`
 * (the model plan), and on a program no verifier ran on (a surface program).
 */
export interface ProgramVerifyContext {
  minRapidZ: number;
  /** Posted toolpath number → the op's outside allowance, mm. Empty when the program states none. */
  outsideAllowancesMm: [number, number][];
  throughKerf: ThroughKerf[];
  depthLimit?: StoredDepthLimit;
  /** The fitted top's lift the mount's boxes were grown by (#727), when the path stated one. */
  topLiftMm?: number;
  itemProgram?: boolean;
}

export function verifyContextOfFacts(
  facts: Pick<VerifyPerProgram, 'minRapidZ' | 'outsideAllowancesMm' | 'itemProgram'> &
    Pick<SetupRecordDeps, 'throughKerf' | 'topLiftMm'>,
  depthLimit?: StoredDepthLimit,
): ProgramVerifyContext {
  return {
    minRapidZ: facts.minRapidZ,
    outsideAllowancesMm: [...(facts.outsideAllowancesMm ?? new Map<number, number>())],
    throughKerf: [...(facts.throughKerf ?? [])],
    ...(depthLimit === undefined ? {} : { depthLimit }),
    ...(facts.topLiftMm === undefined ? {} : { topLiftMm: facts.topLiftMm }),
    ...(facts.itemProgram === undefined ? {} : { itemProgram: facts.itemProgram }),
  };
}
