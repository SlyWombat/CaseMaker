/**
 * #1070 — A BED-HELD JOB'S IMPLICIT SETUP.
 *
 * The Cut step's proposal used to need a SAVED setup (the wizard walked, `job.setups[]` written).
 * A bed-held job does not: its setup IS the job — the stock as stated, the mount as stated, one
 * setup up. This derives that setup (the engine's `Setup`) from the document, and the stored
 * `JobSetup` row that APPROVAL materialises with the registration attached, so an unapproved plan
 * writes nothing and nothing has to be walked first.
 */

import { jobMount } from '@/engine/cnc/engrave/jobSetup';
import { orient } from '@/engine/cnc/setups/orient';
import type { MountSpec, Setup } from '@/engine/cnc/setups';
import { newId } from '@/utils/id';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';
import type { RegistrationPlan } from './plan';

/** The mount a bed-held job runs as: the bracket or the tape, with its board stated by the job. */
export function implicitMountFor(job: EngraveJob): MountSpec {
  return { kind: jobMount(job) === 'tape' ? 'tape' : 'bracket', board: job.sacrificial.under !== null };
}

/** The stock's box in the work frame, as one setup's state. */
function stockState(job: EngraveJob): Setup['stockBefore'] {
  const bounds = {
    min: [0, 0, -job.stock.thickness] as [number, number, number],
    max: [job.stock.length, job.stock.width, 0] as [number, number, number],
  };
  return { bounds, cuts: [] };
}

/**
 * The engine's setup for a bed-held job with no saved setups — the same shape the setups engine
 * would derive for one up. Null for a vise job (its saved-setup prerequisite is unchanged) and
 * for a job that already saves its setups.
 */
export function implicitSetupFor(job: EngraveJob): Setup | null {
  if (job.setups !== undefined && job.setups.length > 0) return null;
  const mount = jobMount(job);
  if (mount === 'vise') return null;
  const size = { x: job.stock.length, y: job.stock.width, z: job.stock.thickness };
  const oriented = orient('top', implicitMountFor(job), size);
  if (!oriented.ok) return null;
  return {
    index: 0,
    faceUp: 'top',
    mount: implicitMountFor(job),
    rotation: oriented.matrix as Setup['rotation'],
    orientation: oriented.orientation,
    itemIds: [],
    stockBefore: stockState(job),
    stockAfter: stockState(job),
    remount: null,
    findings: [],
  } as unknown as Setup;
}

/** The stored row APPROVAL writes: the derived first setup, with the registration on it. */
export function implicitJobSetup(
  job: EngraveJob,
  registration?: JobSetup['registration'],
): JobSetup {
  const mount = implicitMountFor(job);
  const oriented = orient('top', mount, { x: job.stock.length, y: job.stock.width, z: job.stock.thickness });
  if (!oriented.ok) throw new Error(oriented.reason);
  return {
    id: newId('setup'),
    orientation: oriented.orientation,
    mount,
    itemIds: [],
    tools: [],
    ...(registration === undefined ? {} : { registration }),
  };
}

/** The registration an approved attempt stores on the implicit setup. */
export function registrationOf(attempt: { method: Setup['mount']['kind']; plan: RegistrationPlan; expected: string }): JobSetup['registration'] {
  return { method: attempt.method, plan: attempt.plan, expected: attempt.expected };
}
