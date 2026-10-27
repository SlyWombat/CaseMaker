/**
 * #419 §3 — THE CUT SCREEN'S ONE RUN PLAN, built from the FROZEN package.
 *
 * The Cut surface shows the plan three times — the phase table (`RunPlanView`), the machine
 * feature strip (`MachineStrip`), and the release step's collapsed list — and all three read THIS
 * value. That is the slice's rule: one plan, not three that can disagree.
 *
 * WHAT COUNTS AS INPUT. The programs are `pkg.programs`: their order, their texts, and their FNV
 * keys were approved together, so the plan describes the run that was approved even if the
 * document has since changed. The setups are `pkg.setups` for the same reason. Two facts are not
 * in the package and are handed in:
 *
 *  - `finishedHashes` — this machine's cleanly finished programs (`finishedProgramsFor(target)`),
 *    which is Q14's air-run default. It is a property of the machine's record, not of the package.
 *  - `defaults` — the shop's time settings, which are a property of the shop.
 *
 * `shallowestCutMm` stays null: the package does not carry the job's depth summary, and guessing it
 * from the cutter or the labels would be a second derivation of a number the plan only uses to
 * describe the auto-level rule (which is locked until #176 anyway). Null leaves the rule unstated
 * rather than wrong.
 *
 * The registration plans are null for the same reason the package stores intent rather than
 * planner geometry (#419 §5.4): `planRun` then states its "no registration plan was made" info
 * finding and uses the shop's re-registration estimate, which is honest about what the package
 * holds. The saved `JobSetupRegistration` is a different type (`PlanResult` is the planner's
 * recomputed geometry), so reusing it here would be a false claim about provenance.
 */

import type { EngraveJob, FrozenPackage } from '@/types/engraveJob';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { StockFlatness } from '@/platform/stockClient';
import { jobMachine } from '@/engine/cnc/calibration';
import { jobMount } from '@/engine/cnc/engrave/jobSetup';
import { getTools } from '@/engine/cnc/toolRegistry';
import { planRun, type FeatureOverrides, type RunPlan } from '@/engine/cnc/plan';

/** Everything the Cut screen's plan needs; every fact is the package's or the caller's, never re-derived. */
export interface CutPlanInput {
  /** The document as it is now — read for the machine, the mount, the stock state and the facing flag. */
  job: EngraveJob;
  /** The approved package: the programs and setups the run is made of. */
  pkg: FrozenPackage;
  /** `finishedProgramsFor(target)` — the machine's cleanly finished program keys (Q14). */
  finishedHashes: readonly string[];
  /** The shop's time settings. */
  defaults: ShopDefaults | null;
  /** The operator's machine-strip switches, when any were pressed. */
  overrides?: FeatureOverrides;
  /** Last run's phase clocks, when this job has a record. */
  lastRun?: { at: string; seconds: Readonly<Record<string, number>> } | null;
}

/** The cutter's name as the operator reads it; a key the registry does not know stays the key. */
function toolName(toolKey: string): string {
  return getTools().find((entry) => entry.key === toolKey)?.tool.name ?? toolKey;
}

/** The one plan every Cut surface reads. */
export function cutPlan(input: CutPlanInput): RunPlan {
  const { job, pkg } = input;
  const flatness: StockFlatness =
    job.stock.flatness === undefined
      ? 'unknown'
      : Math.max(job.stock.flatness.xMm, job.stock.flatness.yMm) > 0
        ? 'domed'
        : 'flat';
  return planRun({
    setups: pkg.setups.map((setup, i) => ({
      index: i + 1,
      // The directed remount is what makes a setup a step; every setup after the first has one even
      // when the document predates storing the instruction (the runner still moves the stock).
      mountStep: i > 0 || setup.remount !== undefined,
      // #473 — the face program is the first setup's skim; no later setup is faced.
      faced: i === 0 && job.facing?.enabled === true,
      registration: null,
    })),
    programs: pkg.programs.map((program, i) => ({
      id: `p${i + 1}`,
      setupIndex: program.setupIndex,
      label: toolName(program.toolKey),
      hash: program.hash,
    })),
    machine: jobMachine(job),
    // #240 — a rotary-held job runs in the flat vise frame until slice 2/3 (`jobMount`).
    mount: jobMount(job),
    stock: { flatness },
    shallowestCutMm: null,
    finishedHashes: input.finishedHashes,
    defaults: input.defaults,
    overrides: input.overrides,
    lastRun: input.lastRun ?? null,
  });
}
