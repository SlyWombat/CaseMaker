/**
 * #1191 — THIS BUILD CHECKS A STORED RUN'S BYTES, WITHOUT RE-PLANNING.
 *
 * A stored run belongs to the JOB, not the build: a hotfix publish in the middle of a multi-day
 * cut must not throw away the plan the blank was started on. What a new build cannot assume is
 * that its own VERIFIER reads the same bytes the same way. So on a cross-build restore the stored
 * programs are put through `verifyProgram` again — the checks, never the planner: the `.nc` texts
 * and their hashes are untouched, and the result keeps the same programs.
 *
 * WHAT THE CONTEXT IS REBUILT FROM. Each program carries its own `verifyContext` (#1126), written
 * at posting where the IR exists: its hop height, its ops' outside allowances and its setup's
 * through kerfs. No result carries a plan's IR, so none is read here. The job and the location
 * supply the setup, the machine, the cutter and the mount's obstacles, exactly as the run store's
 * sweep resolves them. A program with no `verifyContext` is not re-checked from guesswork: the
 * result says `regenerate` and the run is planned again.
 *
 * A program whose cutter this build cannot resolve is left with its stored report and reported as
 * unresolved: the sweep will refuse it by name, which is a finding the operator can read, rather
 * than a silent pass from an older report.
 */

import { depthLimitFromStored } from '@/engine/cnc/engrave/storedDepthLimit';
import { setupRecordFor, verifyContextFrom, type SetupRecordDeps, type VerifyPerProgram } from '@/engine/cnc/setups/setupRecord';
import { jobFootprint, setupFootprint, type FootprintShape } from '@/engine/cnc/footprint';
import { jobForSetup } from '@/engine/cnc/engrave/programs';
import { postKey } from '@/engine/cnc/post';
import { verifyProgram, type VerifyFinding, type VerifyReport } from '@/engine/cnc/verify';
import type { PlanStatement } from '@/engine/cnc/cam/model/types';
import type { Setup } from '@/engine/cnc/setup';
import type { Mill } from '@/engine/cnc/machine';
import type { Tool } from '@/engine/cnc/tool';
import type { MountObstacles } from '@/engine/cnc/mounts/bracket';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { stockForSetup } from '@/engine/cnc/setups/perSetupStock';
import type { EngraveJob } from '@/types/engraveJob';
import { benchCutterFor } from '@/engine/cnc/toolRegistry';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';

export interface StoredProgramRecheckInput {
  job: EngraveJob;
  generated: EngraveGenerated;
  machine: Mill;
  /** The mount's boxes this run was swept against, or null in the vise. */
  mount: MountObstacles | null;
  /** The verifier context's setup — `toSetup(job, machine, mount?.fixture, bed)`. */
  setup: Setup;
  /**
   * #1277 — the shop's settings map, REQUIRED: the caller's own (the store's `shopDefaults`); `null` =
   * a caller with no location (the recommendations). It reaches the rotary frame the verifier is
   * told (`rotaryMapOf`), and the per-setup Setups this module builds (`toSetup`).
   */
  defaults: ShopDefaults | null;
}

export interface StoredProgramRecheck {
  /** The result with THIS build's reports in place of the stored ones. Programs are unchanged. */
  generated: EngraveGenerated;
  /** Every verifier error the new reports carry. Empty means the bytes still pass this build. */
  errors: { programIndex: number; frame: boolean; finding: VerifyFinding }[];
  /** Programs whose cutter this build could not resolve (left with their stored report). */
  unresolved: { programIndex: number; toolKey: string }[];
  /**
   * True when a program carries no `verifyContext`: the result predates it and is not re-checked
   * (greenfield: no tolerant reader). The caller plans the job again. `generated` is then unchanged.
   */
  regenerate: boolean;
}

/**
 * Re-run this build's verifier over every stored program (and its frame file). Pure: no worker,
 * no store, no wasm.
 */
/**
 * The footprint a program was first verified against, derived again. The two posting conventions
 * are kept exactly as they were:
 *  - a MODEL-PLAN program is judged against its setup's footprint on the whole job (`setupFootprint`);
 *  - an ITEM-PIPELINE program (and its frame trace and facing skim) was posted from the sub-job
 *    `jobForSetup` builds, and judged against `jobFootprint` OF THAT SUB-JOB — the setup's own stated
 *    box, with the job's sacrificial pieces still placed around it. The re-check builds the same
 *    sub-job and asks the same function.
 * (A model-plan result carries a plan; an item-pipeline result does not.)
 */
function footprintOf(job: EngraveJob, program: EngraveProgram, planned: boolean): FootprintShape[] {
  if (!planned) {
    return jobFootprint(jobForSetup(job, { setupIndex: program.setupIndex, setupId: program.setupId, toolKey: program.toolKey, itemIds: [] }));
  }
  return setupFootprint(job, program.setupIndex - 1);
}

export function recheckStoredPrograms(input: StoredProgramRecheckInput): StoredProgramRecheck {
  const { job, generated, machine, mount, setup, defaults } = input;
  // GREENFIELD: no tolerant reader. A plan that exists but has no entry for a program's setup is not
  // re-checked from a guess: the run is planned again. (A stored run with no contexts never gets
  // here: `carriesVerifyContexts` refuses it where the JSON is read.)
  const plan = generated.plan;
  if (plan !== undefined && plan !== null && generated.programs.some((program) => plan.perSetup[program.setupIndex - 1] === undefined)) {
    return { generated, errors: [], unresolved: [], regenerate: true };
  }
  // #1247 — THE VERIFIER'S BODY IS THE SETUP'S OWN (#1082). A job that states per-setup stocks
  // gets a body per setup; a job with none keeps the caller's job-wide setup exactly. The bed is
  // not re-read here: the verifier reads the body's part and work origin, not its sacrificial.
  const setupFor = (setupIndex: number): Setup =>
    job.setups === undefined ? setup : toSetup(job, machine, mount?.fixture ?? undefined, null, stockForSetup(job, setupIndex), defaults);

  // #1246 slice 2 pair (c) — A RESTORED RUN WITH NO STORED PLAN SAYS WHAT IT WAS CHECKED
  // AGAINST. The fallback to the job's limit stays; the run's sheet statements gain one line.
  const noStoredPlan = generated.plan === undefined || generated.plan === null;
  const planStatements: PlanStatement[] | null | undefined = noStoredPlan
    ? [
        ...(generated.planStatements ?? []),
        {
          severity: 'sheet' as const,
          code: 'plan-run' as const,
          text: "This restored run has no stored plan; it was checked against the job's limits, not the setup's own.",
        },
      ]
    : generated.planStatements;

  const errors: StoredProgramRecheck['errors'] = [];
  const unresolved: StoredProgramRecheck['unresolved'] = [];
  const programs: EngraveProgram[] = generated.programs.map((program, index) => {
    const tool: Tool | null = program.toolKey === job.toolKey ? jobTool(job) : benchCutterFor(program.toolKey);
    if (tool === null) {
      unresolved.push({ programIndex: index, toolKey: program.toolKey });
      return program;
    }
    // #1235 (second ruling) / #1126 — the program's own stored context: its hop, its outside
    // allowances (posted toolpath number → mm) and its setup's through kerfs.
    const stored = program.verifyContext;
    const outsideAllowancesMm = stored.outsideAllowancesMm.length === 0 ? undefined : new Map(stored.outsideAllowancesMm);
    // #1246 slice 1 — the context comes from the setup record. The record's limit is the setup's
    // own (#1082/#943), composed from the through kerfs and boundary margin the posting path stored.
    const setupIndex = program.setupIndex - 1;
    const body = setupFor(setupIndex);
    const limitFrom = stored.depthLimit === undefined ? undefined : depthLimitFromStored(job, stored.depthLimit);
    const facts: SetupRecordDeps & VerifyPerProgram = {
      setup: body,
      machine,
      dialect: postKey(machine),
      tool,
      minRapidZ: stored.minRapidZ,
      throughKerf: stored.throughKerf,
      // The limit the first verification ran under, rebuilt from what it was composed from; absent
      // only where the record composes it from the through kerfs (the model plan).
      ...(limitFrom === undefined ? {} : { depthLimit: limitFrom.limit }),
      ...(limitFrom?.limitReasonAt === undefined ? {} : { limitReasonAt: limitFrom.limitReasonAt }),
      ...(stored.topLiftMm === undefined ? {} : { topLiftMm: stored.topLiftMm }),
      ...(stored.itemProgram === undefined ? {} : { itemProgram: stored.itemProgram }),
      // #1235 stage 2 — DERIVED FROM THE JOB, never stored, by the very function the program's first
      // verification asked (see `footprintOf`).
      footprint: footprintOf(job, program, !noStoredPlan),
      outsideAllowancesMm,
      mount,
      clearanceMm: job.jawClearance,
      // #1277 — A ROTARY JOB IS RE-CHECKED IN ITS OWN FRAME. Without this the verifier read every
      // program as flat and refused the A words as foreign (`not-our-dialect`); a flat job's map is
      // null and states none, exactly as before. The limits it carries are the shop's.
      rotary: rotaryMapOf(job, defaults),
    };
    const ctx = verifyContextFrom(setupRecordFor(job, setupIndex, facts), facts);
    const verify = verifyProgram(program.nc, ctx);
    for (const finding of verify.findings) {
      if (finding.severity === 'error') errors.push({ programIndex: index, frame: false, finding });
    }
    let frameVerify: VerifyReport | null = program.frameVerify;
    if (program.frameNc !== null && program.frameVerifyContext !== null) {
      // The frame trace's own context: its hop and the facts ITS first verification used.
      const traced = program.frameVerifyContext;
      const tracedLimit = traced.depthLimit === undefined ? undefined : depthLimitFromStored(job, traced.depthLimit);
      // The trace states what ITS verification stated: not the program's item flag, reason words or rotary frame.
      const { limitReasonAt: _words, itemProgram: _item, rotary: _rotary, depthLimit: _limit, ...shared } = facts;
      const frameFacts: SetupRecordDeps & VerifyPerProgram = {
        ...shared,
        minRapidZ: traced.minRapidZ,
        throughKerf: traced.throughKerf,
        outsideAllowancesMm: traced.outsideAllowancesMm.length === 0 ? undefined : new Map(traced.outsideAllowancesMm),
        ...(tracedLimit === undefined ? {} : { depthLimit: tracedLimit.limit }),
        ...(traced.topLiftMm === undefined ? {} : { topLiftMm: traced.topLiftMm }),
      };
      frameVerify = verifyProgram(program.frameNc, verifyContextFrom(setupRecordFor(job, setupIndex, frameFacts), frameFacts));
      for (const finding of frameVerify.findings) {
        if (finding.severity === 'error') errors.push({ programIndex: index, frame: true, finding });
      }
    }
    return { ...program, verify, frameVerify };
  });

  // The top-level report describes program 1, the same adapter shape the Generate returned.
  const first = programs[0];
  return {
    generated: {
      ...generated,
      programs,
      planStatements,
      ...(first === undefined ? {} : { verify: first.verify, frameVerify: first.frameVerify, frameNc: first.frameNc }),
    },
    errors,
    unresolved,
    regenerate: false,
  };
}

/**
 * Where stored JSON is read (a restored run, the house's assembled result): does every program
 * carry the context its first verification used, and its frame's when one was verified? The type
 * says it always does; a run written before the contexts existed does not, and it is planned again
 * rather than re-checked from a guess.
 */
export function carriesVerifyContexts(generated: EngraveGenerated): boolean {
  const record = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value);
  return generated.programs.every(
    (program) =>
      record(program.verifyContext) &&
      (program.frameVerifyContext === null || record(program.frameVerifyContext)) &&
      (program.frameVerify === null || program.frameVerifyContext !== undefined),
  );
}
