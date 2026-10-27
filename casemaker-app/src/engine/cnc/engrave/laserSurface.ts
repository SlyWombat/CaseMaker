/**
 * #457 — WHAT THE LASER'S LIFT MUST CLEAR, from the surface this job REGISTERED.
 *
 * A laser lift (the frame's traverse and point-to-origin's hoist) is a machine-Z height: the
 * resolved machine's `toolChange.clearanceZ`, fixed. Until now the only bound it carried was the
 * machine's own soft endstop, because the panel held no surface in machine Z — the measured one is
 * the registration step's OUTCOME (#495), which lives in `engraveRegistrationStore` for this job on
 * this machine. With a registration recorded, the bound becomes real:
 *
 *   - the registered top itself (machine Z), and
 *   - anything on the mount standing ABOVE that top, from the same obstacle model the verifier
 *     checks a toolpath against (#442/#488): the vise's jaws when the blank sits below their tops
 *     (`work Z = −stockProud`), and the bracket's arms and top clamps when the job is on the
 *     bracket (`topZ`, work frame, per `mounts/bracket.ts`).
 *
 * The machine-Z conversion is `registration/plan.ts`'s: a work-frame `topZ` sits at
 * `surfaceZ + topZ`, because the registered surface is work Z0. The obstacle's fit uncertainty is
 * NOT added: the registration's own machine bound leaves it out for the same reason — it is an XY
 * fit of the stock in the bracket, and adding it here would move the bound with a number that
 * describes where the stock is, not how high anything is.
 *
 * The result is ONE height, because `LaserLift.stockTopMachineZ` is one number: the higher of the
 * surface and every obstacle. The surface and the offending obstacle stay separate in the record so
 * the panel can say WHICH one the lift is up against, in physical words (#457's panel requirement).
 */

import type { ShopDefaults } from '@/platform/defaultsClient';
import type { LaserLift } from '@/platform/machineLaser';
import type { EngraveJob } from '@/types/engraveJob';
import { jobMachine } from '@/engine/cnc/calibration';
import { jobVise } from '@/engine/cnc/fixture';
import { bracketMount } from '@/engine/cnc/mounts/bracket';
import { jobMount } from './jobSetup';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface LaserObstacleTop {
  /** In landmark words, as the mount's own obstacle model names it. */
  label: string;
  /** Its top, machine Z. */
  machineZ: number;
}

export interface LaserSurfaceBound {
  /** The registered top, machine Z — work Z0. */
  surfaceMachineZ: number;
  /** The mount's highest thing standing above that top, or null when nothing does. */
  obstacle: LaserObstacleTop | null;
  /** What the lift must be above: the higher of the surface and the obstacle. */
  topMachineZ: number;
}

/**
 * The bound a laser lift clears for this job, given the surface its registration measured and the
 * shop defaults the bracket's sizes come from. `setupIndex` names the held position the lift happens
 * in — setup 0 is the one the Cut surface runs.
 */
export function laserSurfaceBound(
  job: EngraveJob,
  surfaceMachineZ: number,
  defaults: ShopDefaults | null,
  setupIndex = 0,
): LaserSurfaceBound {
  const candidates: LaserObstacleTop[] = [];
  if (jobMount(job, setupIndex) === 'vise') {
    candidates.push({
      label: 'the vise jaws',
      // Jaw tops sit `stockProud` below the blank's top, so ABOVE it when the stock is seated low
      // (a negative stockProud). Work Z `−stockProud` → machine Z `surfaceZ − stockProud`.
      machineZ: r3(surfaceMachineZ - jobVise(job).stockProud),
    });
  } else {
    const mount = bracketMount(
      { x: job.stock.length, y: job.stock.width, z: job.stock.thickness },
      jobMount(job, setupIndex),
      defaults,
      job.sacrificial.under?.thickness ?? 0,
    );
    for (const o of mount?.obstacles ?? []) {
      candidates.push({ label: o.label, machineZ: r3(surfaceMachineZ + o.topZ) });
    }
  }
  const above = candidates
    .filter((o) => o.machineZ > surfaceMachineZ)
    .sort((a, b) => b.machineZ - a.machineZ);
  const obstacle = above[0] ?? null;
  return {
    surfaceMachineZ,
    obstacle,
    topMachineZ: obstacle?.machineZ ?? surfaceMachineZ,
  };
}

/** The registration reading the lift's bound needs, in the store's own terms. */
export interface RegisteredSurface {
  /** The measured top, machine Z (`RegistrationOutcome.surfaceZ`). */
  surfaceMachineZ: number;
  /** ISO time the registration was recorded. */
  measuredAt: string;
}

/**
 * The {@link LaserLift} both laser panels pass their motions (#457): the resolved machine's own
 * clearance and soft-endstop floor, plus — only when this job has a registration on this machine —
 * the surface it measured and the obstacle above it. With no registration the lift keeps its fixed
 * height and carries no top at all, so the panels say the stock's top was not checked rather than
 * lending a measurement that does not exist.
 */
export function laserLiftFor(
  job: EngraveJob,
  registration: RegisteredSurface | null,
  defaults: ShopDefaults | null,
  setupIndex = 0,
): LaserLift {
  const resolved = jobMachine(job);
  const base: LaserLift = {
    zMachine: resolved.toolChange.clearanceZ,
    zFloorMachine: resolved.softEndstop.zMin,
  };
  if (registration === null) return base;
  const bound = laserSurfaceBound(job, registration.surfaceMachineZ, defaults, setupIndex);
  return {
    ...base,
    stockTopMachineZ: bound.topMachineZ,
    stockTop: {
      surfaceMachineZ: bound.surfaceMachineZ,
      measuredAt: registration.measuredAt,
      obstacle: bound.obstacle,
    },
  };
}
