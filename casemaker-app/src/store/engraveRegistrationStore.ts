/**
 * #494 — THE JOB'S FIRST REGISTRATION, in app state.
 *
 * #473's post-facing executor needs the job's FIRST `RegistrationOutcome`: the surface/edge readings
 * a registration produces, whose `surfaceZ` is the measured top the facing pass is posted against.
 * The app had no place to keep one — the registration UI (#430) does not exist yet — so this store is
 * the smallest honest seam: a registration step writes what it measured, and the release step reads
 * it after the face program's confirmed bit change.
 *
 * WHY THE PLAN IS KEPT BESIDE THE OUTCOME. `retouchAndCorrectAfterFacing` takes the approved
 * choreography as well as the reading: the re-touch uses the plan's surface point, seek height and
 * settings. A plan re-derived later could differ from the one the operator approved (a shop default
 * may have moved). Storing the plan with the outcome keeps one registration, as it was run.
 *
 * THIS IS SESSION STATE, NOT JOB DATA. The outcome is a measurement on ONE machine, in its machine
 * coordinates; it is deliberately not written into the job document and not persisted. A reload
 * forgets it, and the release gate then refuses a faced job until it is registered again — the
 * honest answer, because nobody can claim the old reading still describes the stock on the table.
 *
 * WHAT REMAINS FOR THE UI. The registration step itself: a surface that calls `runRegistration`
 * (`engine/cnc/registration/execute.ts`) with a plan from the setup and, on success, calls
 * `record(job.id, target, plan, outcome)`. Until that exists in the shipped app, only tests and
 * scripts populate this store; the release step names the gap rather than guessing a measurement.
 */

import { create } from 'zustand';
import type { SurfaceSpreadAssessment } from '@/engine/cnc/engrave/surfaceSpread';
import type { RegistrationOutcome } from '@/engine/cnc/registration/outcome';
import type { RegistrationPlan } from '@/engine/cnc/registration/plan';

export interface FirstRegistration {
  jobId: string;
  /** Where it was measured. A reading on another machine is not this machine's stock. */
  target: { host: string; port: number };
  /** The approved plan the registration ran, kept so the re-touch uses the same choreography. */
  plan: RegistrationPlan;
  /** What the touches measured. */
  outcome: RegistrationOutcome;
  /**
   * When the record was made, ISO 8601 (#457). The measured surface also lives in machine Z on
   * `outcome.surfaceZ`, but a machine coordinate with no date cannot say whether it still describes
   * the blank on the table; the laser's panel prints this so the operator sees how old the reading is.
   */
  measuredAt: string;
}

/**
 * #475 — the cut-extent surface measurement from the registration run, kept even when no origin was
 * written (a refused blank still has a measured spread, and the run sheet prints that refusal).
 * Session state for the same reason the outcome is: it describes one blank on one machine.
 */
export interface SurfaceSpreadMeasurement {
  jobId: string;
  target: { host: string; port: number };
  assessment: SurfaceSpreadAssessment;
}

interface EngraveRegistrationState {
  records: Record<string, FirstRegistration>;
  surfaces: Record<string, SurfaceSpreadMeasurement>;
  record: (
    jobId: string,
    target: { host: string; port: number },
    plan: RegistrationPlan,
    outcome: RegistrationOutcome,
  ) => void;
  /** #475 — remember what the cut-extent touches measured, independent of whether an origin was written. */
  measureSurface: (
    jobId: string,
    target: { host: string; port: number },
    assessment: SurfaceSpreadAssessment,
  ) => void;
  clear: (jobId: string) => void;
}

export const useEngraveRegistrationStore = create<EngraveRegistrationState>((set) => ({
  records: {},
  surfaces: {},

  record: (jobId, target, plan, outcome) =>
    set((s) => ({
      records: {
        ...s.records,
        [jobId]: {
          jobId,
          target: { host: target.host, port: target.port },
          plan,
          outcome,
          measuredAt: new Date().toISOString(),
        },
      },
    })),

  measureSurface: (jobId, target, assessment) =>
    set((s) => ({
      surfaces: {
        ...s.surfaces,
        [jobId]: { jobId, target: { host: target.host, port: target.port }, assessment },
      },
    })),

  clear: (jobId) =>
    set((s) => {
      const records = { ...s.records };
      delete records[jobId];
      const surfaces = { ...s.surfaces };
      delete surfaces[jobId];
      return { records, surfaces };
    }),
}));

/**
 * The job's first registration for THIS machine, or null. A record measured on another machine is
 * not returned: its machine-Z readings do not describe this controller's frame.
 */
export function firstRegistrationFor(
  jobId: string,
  target: { host: string; port: number },
): FirstRegistration | null {
  return matching(useEngraveRegistrationStore.getState().records[jobId], target);
}

/** The same question as a render subscription, so a registration recorded later unlocks the panel. */
export function useFirstRegistration(
  jobId: string,
  target: { host: string; port: number } | null,
): FirstRegistration | null {
  return useEngraveRegistrationStore((s) => (target === null ? null : matching(s.records[jobId], target)));
}

function matching(
  rec: FirstRegistration | undefined,
  target: { host: string; port: number },
): FirstRegistration | null {
  if (rec === undefined) return null;
  return rec.target.host === target.host && rec.target.port === target.port ? rec : null;
}

/**
 * #475 — the cut-extent measurement for THIS job on THIS machine, or null. The run sheet reads it
 * to print the measured spread and the landing range; a measurement from another machine's frame
 * is not this blank's.
 */
export function surfaceSpreadFor(
  jobId: string,
  target: { host: string; port: number },
): SurfaceSpreadMeasurement | null {
  return matchingSurface(useEngraveRegistrationStore.getState().surfaces[jobId], target);
}

/** The same question as a render subscription, so a later registration updates the sheet. */
export function useSurfaceSpread(
  jobId: string,
  target: { host: string; port: number } | null,
): SurfaceSpreadMeasurement | null {
  return useEngraveRegistrationStore((s) => (target === null ? null : matchingSurface(s.surfaces[jobId], target)));
}

function matchingSurface(
  rec: SurfaceSpreadMeasurement | undefined,
  target: { host: string; port: number },
): SurfaceSpreadMeasurement | null {
  if (rec === undefined) return null;
  return rec.target.host === target.host && rec.target.port === target.port ? rec : null;
}

/** Test seam: forget every registration and every cut-extent measurement. */
export function resetEngraveRegistrationStore(): void {
  useEngraveRegistrationStore.setState({ records: {}, surfaces: {} });
}
