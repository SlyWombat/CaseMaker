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
  /**
   * #1088 — THE SETUP THIS REGISTRATION MEASURED. Absent on a record written by an older caller
   * (and on the job-keyed `records[jobId]` entry, which is the job's FIRST setup by definition).
   * Side 2 of a flip job records under its own setup id, so side 1's readers keep reading side 1.
   */
  setupId?: string | null;
  /** Where it was measured. A reading on another machine is not this machine's stock. */
  target: { host: string; port: number };
  /** The approved plan the registration ran, kept so the re-touch uses the same choreography. */
  plan: RegistrationPlan;
  /** What the touches measured. */
  outcome: RegistrationOutcome;
  /**
   * #608 — the fitted surface plane the origin was written from, and the reference Z0, when the
   * registration measured a TILT. Null (or absent) when the fit is flat — a flat top posts the same
   * flat program as before. This is what the Cut step re-posts against and what the release gate
   * compares the frozen package's `surface` to.
   */
  surface?: { plane: { offset: number; slopeX: number; slopeY: number }; z0: number } | null;
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
  /**
   * THE JOB'S FIRST SETUP, keyed by job — the entry every existing reader means by "the
   * registration" (`firstRegistrationFor`, the release gate, the post-facing re-touch, the bed's
   * mount-tap readers). #1088 writes this entry from the first setup and never from a later one.
   */
  records: Record<string, FirstRegistration>;
  /**
   * #1088 — EVERY SETUP'S REGISTRATION, keyed by job AND setup (`registrationKey`). A flip job's
   * side 2 lands here (and its side 1 lands here too, beside the job-keyed entry), so a per-setup
   * reader — the Register card's done state, the release gate on a later setup's program — asks a
   * question that has one setup as its answer.
   */
  bySetup: Record<string, FirstRegistration>;
  surfaces: Record<string, SurfaceSpreadMeasurement>;
  record: (
    jobId: string,
    target: { host: string; port: number },
    plan: RegistrationPlan,
    outcome: RegistrationOutcome,
    surface?: { plane: { offset: number; slopeX: number; slopeY: number }; z0: number } | null,
    /** The setup this registration measured; given, the record is also filed under it. */
    setupId?: string | null,
  ) => void;
  /** #1088 — file a LATER setup's registration (side 2's) without touching the job-keyed entry. */
  recordSetup: (
    jobId: string,
    setupId: string,
    target: { host: string; port: number },
    plan: RegistrationPlan,
    outcome: RegistrationOutcome,
    surface?: { plane: { offset: number; slopeX: number; slopeY: number }; z0: number } | null,
  ) => void;
  /** #475 — remember what the cut-extent touches measured, independent of whether an origin was written. */
  measureSurface: (
    jobId: string,
    target: { host: string; port: number },
    assessment: SurfaceSpreadAssessment,
  ) => void;
  clear: (jobId: string) => void;
}

/** #1088 — the per-setup key: a job id and a setup id cannot collide with a job id alone. */
export const registrationKey = (jobId: string, setupId: string): string => `${jobId}::${setupId}`;

export const useEngraveRegistrationStore = create<EngraveRegistrationState>((set) => ({
  records: {},
  bySetup: {},
  surfaces: {},

  record: (jobId, target, plan, outcome, surface = null, setupId = null) =>
    set((s) => {
      const rec: FirstRegistration = {
        jobId,
        ...(setupId === null ? {} : { setupId }),
        target: { host: target.host, port: target.port },
        plan,
        outcome,
        surface: surface === null ? null : { plane: { ...surface.plane }, z0: surface.z0 },
        measuredAt: new Date().toISOString(),
      };
      return {
        records: { ...s.records, [jobId]: rec },
        ...(setupId === null ? {} : { bySetup: { ...s.bySetup, [registrationKey(jobId, setupId)]: rec } }),
      };
    }),

  recordSetup: (jobId, setupId, target, plan, outcome, surface = null) =>
    set((s) => ({
      bySetup: {
        ...s.bySetup,
        [registrationKey(jobId, setupId)]: {
          jobId,
          setupId,
          target: { host: target.host, port: target.port },
          plan,
          outcome,
          surface: surface === null ? null : { plane: { ...surface.plane }, z0: surface.z0 },
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
      const prefix = `${jobId}::`;
      const bySetup = Object.fromEntries(Object.entries(s.bySetup).filter(([key]) => !key.startsWith(prefix)));
      const surfaces = { ...s.surfaces };
      delete surfaces[jobId];
      return { records, bySetup, surfaces };
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

/**
 * #1088 — ONE SETUP'S REGISTRATION for this machine, or null: the per-setup question the Register
 * card and the release gate's setup check ask. Setup 1's record is also in `records[jobId]`, so
 * this and `firstRegistrationFor` answer the same thing for setup 1.
 */
export function setupRegistrationFor(
  jobId: string,
  setupId: string,
  target: { host: string; port: number },
): FirstRegistration | null {
  return matching(useEngraveRegistrationStore.getState().bySetup[registrationKey(jobId, setupId)], target);
}

/** The same question as a render subscription, so a later registration updates the card. */
export function useSetupRegistration(
  jobId: string,
  setupId: string | null,
  target: { host: string; port: number } | null,
): FirstRegistration | null {
  return useEngraveRegistrationStore((s) =>
    setupId === null || target === null ? null : matching(s.bySetup[registrationKey(jobId, setupId)], target),
  );
}

/** Test seam: forget every registration and every cut-extent measurement. */
export function resetEngraveRegistrationStore(): void {
  useEngraveRegistrationStore.setState({ records: {}, bySetup: {}, surfaces: {} });
}
