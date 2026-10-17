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
}

interface EngraveRegistrationState {
  records: Record<string, FirstRegistration>;
  record: (
    jobId: string,
    target: { host: string; port: number },
    plan: RegistrationPlan,
    outcome: RegistrationOutcome,
  ) => void;
  clear: (jobId: string) => void;
}

export const useEngraveRegistrationStore = create<EngraveRegistrationState>((set) => ({
  records: {},

  record: (jobId, target, plan, outcome) =>
    set((s) => ({
      records: {
        ...s.records,
        [jobId]: { jobId, target: { host: target.host, port: target.port }, plan, outcome },
      },
    })),

  clear: (jobId) =>
    set((s) => {
      const records = { ...s.records };
      delete records[jobId];
      return { records };
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

/** Test seam: forget every registration. */
export function resetEngraveRegistrationStore(): void {
  useEngraveRegistrationStore.setState({ records: {} });
}
