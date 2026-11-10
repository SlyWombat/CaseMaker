/**
 * #1146 — THE TWO WALK FILES, PLANNED FOR A JOB (the maintainer's ruling, 2026-11-09).
 *
 * The generator (`cleanWalk.ts`) makes an IR; this module turns a job into the FILES the release
 * step uploads: the sweep's Z from the job's own fixtures (`jobMountObstacles`), the travel-height
 * refusal against the machine's clearance Z in the work frame, `postFor` with the walk's own
 * options, and `verifyProgram` — the same post/verify pair every program goes through. A walk that
 * the post or the verifier refuses is NOT planned: the plan says why, and the release runs without
 * it rather than sending an unchecked file.
 *
 * THE TRAVEL HEIGHT is the machine's clearance Z (`coordinate.clearance_z`, -3 on the Z1) converted
 * by the registration's own `surfaceZ` — the machine Z of work Z0 the operator measured. Without a
 * registration there is no conversion; the walk is still planned and the caller states that the
 * height was not checked (the sweep is below the stock top + clearance by construction, and a
 * machine that cannot reach it refuses the file at the controller — #1146's bench rule is to say
 * so rather than guess).
 *
 * THE ENGINE DOES NOT READ SHOP DEFAULTS: the three numbers and the two switches arrive resolved.
 * The release store owns that read (`readDefault`/`readFlag`), so this module stays a pure function
 * of its arguments and the walk cannot disagree with the panel about which numbers are in force.
 */
import { version as CAM_VERSION } from '../../../../package.json';
import type { EngraveJob } from '@/types/engraveJob';
import type { ShopDefaults } from '@/platform/defaultsClient';
import { jobMachine, type MachineCalibration } from '../calibration';
import { clearanceZOf } from '../machine';
import { postFor, postKey, postOriginFor } from '../post';
import { programHash } from '../programHash';
import { flatEndMill, type Tool } from '../tool';
import { verifyProgram, type VerifyReport } from '../verify';
import { cleanWalkFile, type CleanWalkMode, type CleanWalkSettings } from './cleanWalk';
import { jobMountObstacles, jobTool, toSetup } from './jobSetup';
import { releaseStem } from './runSheet';
import { key8Of } from './packageFiles';

/** One walk as the release step uploads and plays it. */
export interface PlannedCleanWalk {
  mode: CleanWalkMode;
  filename: string;
  nc: string;
  hash: string;
  /** The verifier's report for THIS text — the upload gate's check, like any program's. */
  verify: VerifyReport;
  /** The Z the sweep runs at, work frame. */
  sweepZ: number;
  /** The raster's row count (the air walk states one outline). */
  rows: number;
  /** The file's own cycle estimate, seconds — the term the plan line folds in (#1146 follow-up). */
  estimatedSeconds: number;
}

export interface CleanWalksPlan {
  airwalk: PlannedCleanWalk | null;
  clean: PlannedCleanWalk | null;
  /** Why a wanted walk was not planned, in the operator's words. Empty when both planned. */
  notes: string[];
}

export interface CleanWalkPlanArgs {
  job: EngraveJob;
  /** The location's defaults — `jobMountObstacles` reads the fixture sizes from them. */
  defaults: ShopDefaults | null;
  calibration?: MachineCalibration | null;
  /**
   * The registered stock top in MACHINE Z (a registration's `surfaceZ`), when this session has
   * one. Null: the height check cannot be converted and is skipped, and the caller says so.
   */
  surfaceMachineZ: number | null;
  settings: CleanWalkSettings;
  wanted: { airwalk: boolean; clean: boolean };
}

const WORDS: Record<CleanWalkMode, string> = {
  airwalk: 'air walk',
  clean: 'cleaning pass',
};

/**
 * Plan the wanted walks for a job. Both are independent: one may be refused while the other is
 * planned. A rotary job gets neither — its work frame's Z is a radius from the axis, and a raster
 * over a rectangular footprint has no meaning on a cylinder.
 */
export function planCleanWalks(args: CleanWalkPlanArgs): CleanWalksPlan {
  const plan: CleanWalksPlan = { airwalk: null, clean: null, notes: [] };
  if (!args.wanted.airwalk && !args.wanted.clean) return plan;
  const { job } = args;
  if (job.workholding.kind === 'rotary-chuck') {
    plan.notes.push('The cleaning pass and the air walk are not planned for a rotary job: its work frame has no stock top to sweep above.');
    return plan;
  }
  const machine = jobMachine(job, args.calibration ?? null);
  const clearanceZ = clearanceZOf(machine);
  const travelWorkZMm =
    clearanceZ !== null && args.surfaceMachineZ !== null ? clearanceZ - args.surfaceMachineZ : null;
  const mount = jobMountObstacles(job, args.defaults);
  const obstacles = mount?.obstacles ?? [];
  const tool: Tool = jobTool(job) ?? flatEndMill(1);
  const ctx = {
    jobName: job.name,
    stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
    materialName: job.stock.material,
    zDatum: 'probed-top-face' as const,
    origin: postOriginFor(machine),
    camVersion: CAM_VERSION,
    toolKey: job.toolKey,
  };
  for (const mode of ['airwalk', 'clean'] as const) {
    if (!args.wanted[mode]) continue;
    const what = WORDS[mode];
    const made = cleanWalkFile(
      {
        stock: { length: job.stock.length, width: job.stock.width },
        obstacles,
        travelWorkZMm,
        settings: args.settings,
        tool,
        rapid: machine.rapidEstimate,
      },
      mode,
    );
    if (!made.ok) {
      plan.notes.push(`The ${what} was not planned: ${made.reason}.`);
      continue;
    }
    // The file carries the direct spindle air for the cleaning pass (`M811`/`M812`) and no spindle;
    // the air walk carries no accessory word at all (a Z1 has no laser — its dot is the probe's).
    const posted = postFor(machine)(made.ir, ctx, {
      vacuum: 'none',
      directAir: mode === 'clean',
      noSpindle: true,
      // One file serves every program of a multi-cutter job: it must not demand a tool change.
      noToolChange: true,
    });
    if (!posted.ok) {
      plan.notes.push(`The ${what} was not planned: the post refused it (${posted.errors.join('; ')}).`);
      continue;
    }
    const verify = verifyProgram(posted.text, {
      setup: toSetup(job, machine),
      machine,
      tool,
      // The pass never cuts: no depth to judge, and every XY rapid runs at or above the sweep Z the
      // generator proved against the fixtures.
      depthLimit: () => Number.POSITIVE_INFINITY,
      minRapidZ: made.sweepZ,
      dialect: postKey(machine),
    });
    if (!verify.ok) {
      const first = verify.findings.find((f) => f.severity === 'error');
      plan.notes.push(`The ${what} was not planned: the verifier refused its own text (${first?.message ?? 'an error'}).`);
      continue;
    }
    plan[mode] = {
      mode,
      // #1179 C — the walk belongs to the package: its name carries the key with the programs'.
      filename: `${releaseStem(job.name)}${key8Of(job.package?.hash ?? null) === null ? '' : `-${key8Of(job.package?.hash ?? null)}`}-${mode === 'clean' ? 'clean' : 'airwalk'}.nc`,
      nc: posted.text,
      hash: programHash(posted.text),
      verify,
      sweepZ: made.sweepZ,
      rows: made.rows,
      estimatedSeconds: made.estimatedSeconds,
    };
  }
  return plan;
}

/**
 * #1146 (the manager's ruling, 2026-11-10) — THE WALKS' SHARE OF THE PLAN'S TIME. The cleaning
 * pass runs after every finished program; the air walk once before the first cut. The release
 * step adds this to the plan's own `totalSeconds` and prints the walks as their own term, so the
 * figure is the machine time the operator is actually committing to. A walk the plan refused (or
 * a switch turned off) contributes nothing.
 */
export function cleanWalkPlanSeconds(
  programs: number,
  walks: { airwalk: { estimatedSeconds: number } | null; clean: { estimatedSeconds: number } | null },
  switches: { airWalk: boolean; cleanAfter: boolean },
): number {
  const clean = switches.cleanAfter && walks.clean !== null ? Math.max(0, programs) * walks.clean.estimatedSeconds : 0;
  const air = switches.airWalk && walks.airwalk !== null ? walks.airwalk.estimatedSeconds : 0;
  return clean + air;
}

/** The walks' term as the plan line prints it: `~3 min`, or `~45 s` under a minute. */
export function cleanWalkPlanWords(seconds: number): string {
  return seconds >= 60 ? `~${Math.round(seconds / 60)} min` : `~${Math.max(1, Math.round(seconds))} s`;
}
