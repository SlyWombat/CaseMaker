/**
 * #1191 — THIS BUILD CHECKS A STORED RUN'S BYTES, WITHOUT RE-PLANNING.
 *
 * A stored run belongs to the JOB, not the build: a hotfix publish in the middle of a multi-day
 * cut must not throw away the plan the blank was started on. What a new build cannot assume is
 * that its own VERIFIER reads the same bytes the same way. So on a cross-build restore the stored
 * programs are put through `verifyProgram` again — the checks, never the planner: the `.nc` texts
 * and their hashes are untouched, and the result keeps the same programs.
 *
 * WHAT THE CONTEXT IS REBUILT FROM. Everything the worker had at posting time survives on the
 * result: the plan outcome carries each setup's ops (the through kerf that widens the depth limit,
 * and each program's IR — its `hopZ`). The job and the location supply the setup, the machine, the
 * cutter and the mount's obstacles, exactly as the run store's sweep resolves them.
 *
 * A program whose cutter this build cannot resolve is left with its stored report and reported as
 * unresolved: the sweep will refuse it by name, which is a finding the operator can read, rather
 * than a silent pass from an older report.
 */

import { HOP_Z, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { jobDepthLimit } from '@/engine/cnc/engrave/partPlan';
import { buildThroughMask } from '@/engine/cnc/engrave/throughMask';
import { stockForSetup } from '@/engine/cnc/setups/perSetupStock';
import { outsideAllowancesOf, setupFootprint } from '@/engine/cnc/footprint';
import { postKey } from '@/engine/cnc/post';
import { verifyProgram, type VerifyFinding, type VerifyReport } from '@/engine/cnc/verify';
import type { Setup } from '@/engine/cnc/setup';
import type { Mill } from '@/engine/cnc/machine';
import type { Tool } from '@/engine/cnc/tool';
import type { MountObstacles } from '@/engine/cnc/mounts/bracket';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveJob } from '@/types/engraveJob';
import { benchCutterFor } from '@/engine/cnc/toolRegistry';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';

export interface StoredProgramRecheckInput {
  job: EngraveJob;
  generated: EngraveGenerated;
  machine: Mill;
  /** The mount's boxes this run was swept against, or null in the vise. */
  mount: MountObstacles | null;
  /** The verifier context's setup — `toSetup(job, machine, mount?.fixture, bed)`. */
  setup: Setup;
}

export interface StoredProgramRecheck {
  /** The result with THIS build's reports in place of the stored ones. Programs are unchanged. */
  generated: EngraveGenerated;
  /** Every verifier error the new reports carry. Empty means the bytes still pass this build. */
  errors: { programIndex: number; frame: boolean; finding: VerifyFinding }[];
  /** Programs whose cutter this build could not resolve (left with their stored report). */
  unresolved: { programIndex: number; toolKey: string }[];
}

/** The mount context `verify.ts` takes (#442/#710) — the model path's shape. */
function mountCtx(mount: MountObstacles | null, clearanceMm: number): {
  mountObstacles?: { obstacles: MountObstacles['obstacles']; uncertainty: number; clearance: number; topLift: number };
} {
  return mount
    ? {
        mountObstacles: {
          obstacles: mount.obstacles,
          uncertainty: mount.uncertainty,
          clearance: clearanceMm,
          topLift: 0,
        },
      }
    : {};
}

/** The IRs in posting order — the plan's per-setup program lists, flattened as the worker posted them. */
function planIrs(generated: EngraveGenerated): readonly ToolpathIR[] {
  return generated.plan?.perSetup.flatMap((setup) => setup.programs) ?? [];
}

/**
 * Re-run this build's verifier over every stored program (and its frame file). Pure: no worker,
 * no store, no wasm.
 */
export function recheckStoredPrograms(input: StoredProgramRecheckInput): StoredProgramRecheck {
  const { job, generated, machine, mount, setup } = input;
  const depthLimits = generated.plan?.perSetup.map((plan, i) => {
    const thickness = stockForSetup(job, i).thickness;
    const cutouts = plan.ops.flatMap((op) =>
      op.kind === 'contour' && op.outcome.throughKerf !== undefined ? [op.outcome.throughKerf] : [],
    );
    if (cutouts.length === 0) return jobDepthLimit(job, undefined, undefined, undefined, thickness);
    const mask = buildThroughMask({ thickness, breakthrough: job.breakthrough, cutouts });
    return mask === null
      ? jobDepthLimit(job, undefined, undefined, undefined, thickness)
      : jobDepthLimit(job, undefined, mask, undefined, thickness);
  }) ?? [];
  const irs = planIrs(generated);
  const baseCtx = {
    setup,
    machine,
    dialect: postKey(machine),
    ...mountCtx(mount, job.jawClearance),
  };

  const errors: StoredProgramRecheck['errors'] = [];
  const unresolved: StoredProgramRecheck['unresolved'] = [];
  const programs: EngraveProgram[] = generated.programs.map((program, index) => {
    const tool: Tool | null = program.toolKey === job.toolKey ? jobTool(job) : benchCutterFor(program.toolKey);
    if (tool === null) {
      unresolved.push({ programIndex: index, toolKey: program.toolKey });
      return program;
    }
    // #1235 (second ruling) — the stored plan's own op records state the outside allowances; a
    // stored plan that predates the field states none and every move gets 0.
    const outsideAllowancesMm = irs[index] === undefined ? undefined : outsideAllowancesOf(irs[index]!);
    const ctx = {
      ...baseCtx,
      tool,
      depthLimit: depthLimits[program.setupIndex - 1] ?? jobDepthLimit(job),
      minRapidZ: irs[index]?.hopZ ?? HOP_Z,
      // #1235 stage 2 — the program's own setup footprint, from the same stock the depth limit
      // above describes (#1082): a flipped setup's stated box, else the job's blank.
      footprint: setupFootprint(job, program.setupIndex - 1),
      ...(outsideAllowancesMm === undefined ? {} : { outsideAllowancesMm }),
    };
    const verify = verifyProgram(program.nc, ctx);
    for (const finding of verify.findings) {
      if (finding.severity === 'error') errors.push({ programIndex: index, frame: false, finding });
    }
    let frameVerify: VerifyReport | null = program.frameVerify;
    if (program.frameNc !== null) {
      // A frame is traced from the same run but its own IR's hop is not stored; the standard hop
      // is the safe reading (a frame that trip this build shows it, which is the point).
      frameVerify = verifyProgram(program.frameNc, { ...ctx, minRapidZ: HOP_Z });
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
      ...(first === undefined ? {} : { verify: first.verify, frameVerify: first.frameVerify, frameNc: first.frameNc }),
    },
    errors,
    unresolved,
  };
}
