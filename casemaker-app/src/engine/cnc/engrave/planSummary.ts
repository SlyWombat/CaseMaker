/**
 * #1126 slice 2 — THE PLAN THE PAGE HOLDS, AND THE VERIFIER'S CONTEXT BESIDE EACH PROGRAM.
 *
 * ONE RESULT SHAPE FROM BOTH DOORS. The house CLI (`resultDocument`) and the in-page worker
 * (`sim.worker.ts`) both build each plan they return with {@link planSummary}: an ALLOWLIST of
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
 * (`EngravePanel.tsx:5338` and `restoredRun.ts` test only that a plan exists.)
 * `throughKerf` is NOT listed: its only reader is the re-check, which reads {@link ProgramVerifyContext}.
 */
import type { ModelPlanOutput, PlanOutcome } from '@/engine/cnc/cam/model/plan';
import type { PlannedOpKind } from '@/engine/cnc/cam/model/sequence';
import { HOP_Z, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { outsideAllowancesOf } from '@/engine/cnc/footprint';

type TabChoiceNeeded = NonNullable<ModelPlanOutput['tabChoiceNeeded']>;
type TabCounts = NonNullable<ModelPlanOutput['perSetup'][number]['ops'][number]['outcome']['tabCounts']>;
type ThroughKerf = NonNullable<ModelPlanOutput['perSetup'][number]['ops'][number]['outcome']['throughKerf']>;

export interface PlanSummary {
  outcome?: PlanOutcome | null;
  tabChoiceApplied?: NonNullable<ModelPlanOutput['tabChoiceApplied']>;
  tabChoiceNeeded?: TabChoiceNeeded;
  tabChoiceStale?: true;
  perSetup: {
    setupIndex: number;
    notes: string[];
    ops: { kind: PlannedOpKind; outcome: { tabCounts?: TabCounts } }[];
  }[];
}

export function planSummary(plan: ModelPlanOutput | null | undefined): PlanSummary | null {
  if (plan === null || plan === undefined) return null;
  const record = plan as Partial<ModelPlanOutput>;
  const perSetup = Array.isArray(record.perSetup)
    ? record.perSetup.map((setup) => {
        const fields = (setup ?? {}) as Partial<ModelPlanOutput['perSetup'][number]>;
        return {
          setupIndex: typeof fields.setupIndex === 'number' ? fields.setupIndex : 0,
          notes: Array.isArray(fields.notes) ? fields.notes.filter((n): n is string => typeof n === 'string') : [],
          ops: Array.isArray(fields.ops)
            ? fields.ops.map((op) => ({
                kind: op.kind,
                outcome: op.outcome?.tabCounts === undefined ? {} : { tabCounts: op.outcome.tabCounts },
              }))
            : [],
        };
      })
    : [];
  return {
    outcome: record.outcome ?? null,
    ...(record.tabChoiceApplied === undefined ? {} : { tabChoiceApplied: record.tabChoiceApplied }),
    ...(record.tabChoiceNeeded === undefined ? {} : { tabChoiceNeeded: record.tabChoiceNeeded }),
    ...(record.tabChoiceStale === true ? { tabChoiceStale: true as const } : {}),
    perSetup,
  };
}

/**
 * THE RE-CHECK'S CONTEXT, as plain data beside each program (#1191). Computed where the IR exists,
 * at posting, on whichever side planned; `recheckStoredPrograms` reads this and nothing of the
 * plan. It carries the three things the verifier takes from a plan: the program's hop height, its
 * ops' outside allowances (posted toolpath number, mm) and its setup's through kerfs.
 */
export interface ProgramVerifyContext {
  minRapidZ: number;
  outsideAllowancesMm: [number, number][];
  throughKerf: ThroughKerf[];
}

export function verifyContextOf(ir: ToolpathIR, throughKerf: readonly ThroughKerf[]): ProgramVerifyContext {
  return {
    minRapidZ: ir.hopZ,
    outsideAllowancesMm: [...(outsideAllowancesOf(ir) ?? new Map<number, number>())],
    throughKerf: [...throughKerf],
  };
}

/**
 * A program that no model plan made (the item pipeline's, the surface relief's, the facing skim) is
 * checked at the standard hop with no outside allowances and no through kerf: the context it was
 * always re-checked with, now stated beside it instead of implied by the absence of a plan.
 */
export function planlessVerifyContext(): ProgramVerifyContext {
  return { minRapidZ: HOP_Z, outsideAllowancesMm: [], throughKerf: [] };
}
