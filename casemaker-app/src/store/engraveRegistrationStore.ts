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
 * THIS IS SESSION STATE, AND THE HOUSE KEEPS A COPY (#1123-40). The outcome is a measurement on ONE
 * machine, in its machine coordinates; it is never written into the job document. Since #1123-40 the
 * registration step also files a MEMO on the house's machine record (`machines[].registrations`,
 * keyed by job + setup), carrying the G54 X/Y its origin write left in the controller. A reload
 * restores the record only while the machine's live G54 X/Y still matches that memo; when it does
 * not, nothing is restored and the card says both pairs — the honest answer, because a moved origin
 * or a different blank must be measured again, not remembered.
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
import type { EngraveJob } from '@/types/engraveJob';
import { jobHold } from '@/engine/cnc/engrave/stockHold';

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
  /**
   * #1286 — WHAT THIS REGISTRATION WAS MEASURED ON. The blank (the machine's `currentBlank` id for the
   * job at that moment, or null when the job had none) and the HOLD (`holdKeyOf(job)`: how the piece
   * was seated). The run gate compares both with now: a re-seated or new stick, or a changed seat, is
   * not what was measured. Absent on a record that came back from the house's memo, which stamps
   * neither — such a record never satisfies the gate.
   */
  stamp?: { blankId: string | null; holdKey: string };
  /**
   * #1123-40 — how this record got here, when it did not come from a run in THIS session: the memo
   * on the house's machine record was restored after the machine's live G54 X/Y was checked against
   * the G54 its origin write left. `g54` is that live reading, `checkedAt` the clock at the check.
   * Absent on a record a run made in this session.
   */
  restored?: {
    checkedAt: string;
    g54: { x: number; y: number };
    setupIndex: number;
  };
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
  /**
   * #1189 — the probe's M491 at the run that measured this spread. The assessment's Z values are
   * raw machine Z in that seating; the flip's carried top is derived from them, so the reference
   * travels here too (absent on a measurement restored or written without one).
   */
  probeRefZ?: number | null;
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
    /** #1286 — the blank and the hold this was measured on. */
    stamp?: { blankId: string | null; holdKey: string },
  ) => void;
  /** #1088 — file a LATER setup's registration (side 2's) without touching the job-keyed entry. */
  recordSetup: (
    jobId: string,
    setupId: string,
    target: { host: string; port: number },
    plan: RegistrationPlan,
    outcome: RegistrationOutcome,
    surface?: { plane: { offset: number; slopeX: number; slopeY: number }; z0: number } | null,
    /** #1286 — the blank and the hold this was measured on. */
    stamp?: { blankId: string | null; holdKey: string },
  ) => void;
  /**
   * #1286 — THE LATEST ORIGIN WRITTEN ON EACH MACHINE (key `host:port`): which job and setup wrote
   * the controller's G54 last. Only that registration describes the origin the machine holds now;
   * job A, then job B on the same machine, back to A → A's origin is gone.
   */
  latest: Record<string, { jobId: string; setupKey: string }>;
  /**
   * #1286 — THE MOMENT A REGISTRATION STARTS WRITING THE ORIGIN, the machine's G54 stops being the previous
   * job's, whether or not the write then succeeds, is stopped or fails. Called before the first G10 goes out.
   */
  markWriting: (target: { host: string; port: number }, jobId: string, setupKey: string | null) => void;
  /**
   * #1123-40 — put a side-1 record back from the house's memo, EXACTLY as it was measured (its own
   * `measuredAt`, not now). When the record names its setup it is filed there too, as `record` does.
   */
  restoreJob: (rec: FirstRegistration) => void;
  /** #1123-40 — put a later setup's (side 2's) record back; side 1's job-keyed entry is untouched. */
  restoreSetup: (rec: FirstRegistration) => void;
  /** #475 — remember what the cut-extent touches measured, independent of whether an origin was written. */
  measureSurface: (
    jobId: string,
    target: { host: string; port: number },
    assessment: SurfaceSpreadAssessment,
    /** #1189 — the run's M491, the seating the assessment's Z values belong to. */
    probeRefZ?: number | null,
  ) => void;
  clear: (jobId: string) => void;
}

/** #1088 — the per-setup key: a job id and a setup id cannot collide with a job id alone. */
export const registrationKey = (jobId: string, setupId: string): string => `${jobId}::${setupId}`;

const machineKeyOf = (t: { host: string; port: number }): string => `${t.host}:${t.port}`;
/** The `latest` key of a job's first setup when the record names no setup id. */
const FIRST_SETUP = '(first setup)';
/** The `latest` owner after its job's records were cleared: nobody's origin. */
const CLEARED = '(cleared)';

export const useEngraveRegistrationStore = create<EngraveRegistrationState>((set) => ({
  records: {},
  bySetup: {},
  surfaces: {},

  latest: {},

  markWriting: (target, jobId, setupKey) =>
    set((s) => ({ latest: { ...s.latest, [machineKeyOf(target)]: { jobId, setupKey: setupKey ?? FIRST_SETUP } } })),

  record: (jobId, target, plan, outcome, surface = null, setupId = null, stamp) =>
    set((s) => {
      const rec: FirstRegistration = {
        jobId,
        ...(setupId === null ? {} : { setupId }),
        ...(stamp === undefined ? {} : { stamp }),
        target: { host: target.host, port: target.port },
        plan,
        outcome,
        surface: surface === null ? null : { plane: { ...surface.plane }, z0: surface.z0 },
        measuredAt: new Date().toISOString(),
      };
      return {
        records: { ...s.records, [jobId]: rec },
        ...(setupId === null ? {} : { bySetup: { ...s.bySetup, [registrationKey(jobId, setupId)]: rec } }),
        latest: { ...s.latest, [machineKeyOf(target)]: { jobId, setupKey: setupId ?? FIRST_SETUP } },
      };
    }),

  recordSetup: (jobId, setupId, target, plan, outcome, surface = null, stamp) =>
    set((s) => ({
      latest: { ...s.latest, [machineKeyOf(target)]: { jobId, setupKey: setupId } },
      bySetup: {
        ...s.bySetup,
        [registrationKey(jobId, setupId)]: {
          jobId,
          setupId,
          ...(stamp === undefined ? {} : { stamp }),
          target: { host: target.host, port: target.port },
          plan,
          outcome,
          surface: surface === null ? null : { plane: { ...surface.plane }, z0: surface.z0 },
          measuredAt: new Date().toISOString(),
        },
      },
    })),

  restoreJob: (rec) =>
    set((s) => ({
      latest: { ...s.latest, [machineKeyOf(rec.target)]: { jobId: rec.jobId, setupKey: rec.setupId ?? FIRST_SETUP } },
      records: { ...s.records, [rec.jobId]: rec },
      ...(rec.setupId == null
        ? {}
        : { bySetup: { ...s.bySetup, [registrationKey(rec.jobId, rec.setupId)]: rec } }),
    })),

  restoreSetup: (rec) => {
    const setupId = rec.setupId;
    if (setupId == null) return;
    set((s) => ({
      latest: { ...s.latest, [machineKeyOf(rec.target)]: { jobId: rec.jobId, setupKey: setupId } },
      bySetup: { ...s.bySetup, [registrationKey(rec.jobId, setupId)]: rec },
    }));
  },

  measureSurface: (jobId, target, assessment, probeRefZ = null) =>
    set((s) => ({
      surfaces: {
        ...s.surfaces,
        [jobId]: { jobId, target: { host: target.host, port: target.port }, assessment, probeRefZ },
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
      // Clearing a job's records must NOT erase "the origin on this machine is no longer another job's":
      // where this job held the mark, the mark becomes an owner nobody is, so every other job is refused.
      const latest = Object.fromEntries(
        Object.entries(s.latest).map(([k, v]) => [k, v.jobId === jobId ? { jobId: CLEARED, setupKey: '' } : v]),
      );
      return { records, bySetup, surfaces, latest };
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

/**
 * #1286 (SAFETY) — A PROGRAM IS NOT SENT TO THE MACHINE, AND NOT PLAYED, UNTIL ITS SETUP IS REGISTERED.
 *
 * Registration is what writes the work origin. A program uploaded and played without one runs at
 * whatever G54 the controller last held: the cutter descends where nobody measured. Before this
 * gate only the Register STEP read "refused" — the Start card, the release and the run store all
 * went on without it (found by a no-seam walk, 2026-11-14).
 *
 * A registration counts only if it is THIS job's, THIS setup's, on THIS machine, usable, measured on
 * THIS blank and THIS hold, and the LATEST origin written on the machine. A refused, stopped or failed
 * registration writes no record at all, so it cannot satisfy this. Every answer is a code and a
 * sentence, so every control that starts anything says the same words:
 *   registration-missing · registration-unusable · registration-other-blank · registration-other-hold ·
 *   registration-superseded · registration-unstamped · registration-no-machine · registration-no-setup
 */
/** The `latest` owner of a machine whose offsets a bed-setup measurement (a tap, a centre find) touched: no job's. */
export const MACHINE_SETUP_OWNER = '(machine setup)';

/** A run that is not a job's registration (a bed-setup measurement, a retouch) changed the machine's offsets. */
export function markMachineChanged(target: { host: string; port: number }): void {
  useEngraveRegistrationStore.getState().markWriting(target, MACHINE_SETUP_OWNER, null);
}

export type RegistrationGateCode =
  | 'registration-missing'
  | 'registration-unusable'
  | 'registration-other-blank'
  | 'registration-other-hold'
  | 'registration-superseded'
  | 'registration-unstamped'
  | 'registration-no-machine'
  | 'registration-no-setup';
export type RegistrationGate = { code: RegistrationGateCode; sentence: string };

/** How the piece is seated, as far as the origin is concerned: the stock, and the mount's own facts. */
export function holdKeyOf(job: EngraveJob): string {
  const w = job.workholding;
  const mount =
    w.kind === 'vise'
      ? { kind: 'vise', seat: w.vise.seat, proud: w.vise.stockProud, board: job.sacrificial?.under?.thickness ?? null }
      : w.kind === 'bracket'
        ? { kind: 'bracket', anchor: w.bracket.anchor, placement: w.bracket.placement ?? 'anchored', variant: w.bracket.variant }
        : { kind: w.kind };
  return JSON.stringify({ stock: [job.stock.length, job.stock.width, job.stock.thickness], hold: jobHold(job), mount });
}

export interface RunGateInput {
  job: EngraveJob;
  /** 1-based, the frozen programs' own numbering. */
  setupIndex: number | null;
  setupId: string | null;
  target: { host: string; port: number } | null;
  /** The machine's current blank id for this job (`currentBlank[jobId]`), or null when it has none. */
  blankId: string | null;
}

export function setupRunGate(input: RunGateInput): RegistrationGate | null {
  const { job, setupIndex, setupId, target, blankId } = input;
  if (target === null) {
    return { code: 'registration-no-machine', sentence: 'Choose the machine first — registration is a measurement on a machine.' };
  }
  if (setupIndex === null) {
    return { code: 'registration-no-setup', sentence: 'This program does not say which setup it cuts, so its registration cannot be checked — generate the job again.' };
  }
  const state = useEngraveRegistrationStore.getState();
  const first = setupIndex <= 1;
  // The first setup is the JOB's first (`job.setups[0]`), whatever id the program carries; a record that
  // names another setup never stands in for it, and a record that names none is the job-keyed entry of a
  // job that states no setups.
  const firstId = job.setups?.[0]?.id ?? null;
  const own = (rec: FirstRegistration | undefined): FirstRegistration | null => {
    const m = matching(rec, target);
    if (m === null) return null;
    if (first) return (m.setupId ?? null) === firstId ? m : null;
    return m.setupId === setupId ? m : null;
  };
  const rec = first
    ? (own(state.records[job.id]) ?? (firstId === null ? null : own(state.bySetup[registrationKey(job.id, firstId)])))
    : setupId === null
      ? null
      : own(state.bySetup[registrationKey(job.id, setupId)]);
  const which = first ? 'this job' : `side ${setupIndex}`;
  if (rec === null) {
    return {
      code: 'registration-missing',
      sentence: `Register ${which} first — no origin is on record for it on this machine, so nothing is uploaded or played.`,
    };
  }
  if (!rec.outcome.usable) {
    return {
      code: 'registration-unusable',
      sentence: `The registration of ${which} did not give a usable origin — register it again before anything is uploaded or played.`,
    };
  }
  if (rec.stamp === undefined) {
    return {
      code: 'registration-unstamped',
      sentence: `The registration of ${which} came back from the house's note without the blank it was measured on — register it again.`,
    };
  }
  if (rec.stamp.blankId !== blankId) {
    return {
      code: 'registration-other-blank',
      sentence: `This blank has not been registered — ${which} was measured on ${rec.stamp.blankId === null ? 'a blank the machine had no name for' : 'an earlier blank'}. Register it again.`,
    };
  }
  if (rec.stamp.holdKey !== holdKeyOf(job)) {
    return {
      code: 'registration-other-hold',
      sentence: `The hold of ${which} has changed since it was registered (the seat, the mount or the stock) — register it again.`,
    };
  }
  const key = machineKeyOf(target);
  const latest = state.latest[key];
  const keys = first ? [FIRST_SETUP, firstId] : [setupId];
  // UNDEFINED is a refusal too: with no mark on the machine nothing says whose origin it holds.
  if (latest === undefined || !(latest.jobId === job.id && keys.includes(latest.setupKey))) {
    return {
      code: 'registration-superseded',
      sentence: `Another registration has been written on this machine since — its origin is not ${which}'s any more. Register ${which} again.`,
    };
  }
  return null;
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
  useEngraveRegistrationStore.setState({ records: {}, bySetup: {}, surfaces: {}, latest: {} });
}
