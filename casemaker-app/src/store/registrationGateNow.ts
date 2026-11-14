/**
 * #1286 — THE REGISTRATION GATE, READ AGAINST THE STORES AS THEY STAND NOW.
 *
 * `setupRunGate` (engraveRegistrationStore) is pure over its input; this reads the one input that
 * lives elsewhere — the machine's current blank id for the job — from the location store, so every
 * caller (the Cut card, the release, the run store's last line) asks the same question the same way.
 */
import { machineForJob } from '@/platform/bedProfiles';
import type { EngraveJob } from '@/types/engraveJob';
import { setupRunGate, type RegistrationGate } from './engraveRegistrationStore';
import { useLocationStore } from './locationStore';

/** The machine's current blank id for this job, or null when it names none (a legacy machine or job). */
export function currentBlankIdFor(job: Pick<EngraveJob, 'id' | 'machineId'>): string | null {
  const machine = machineForJob(useLocationStore.getState().location, job.machineId);
  return machine?.currentBlank?.[job.id] ?? null;
}

export function registrationGateNow(
  job: EngraveJob,
  setupIndex: number | null,
  setupId: string | null,
  target: { host: string; port: number } | null,
): RegistrationGate | null {
  const g = setupRunGate({ job, setupIndex, setupId, target, blankId: currentBlankIdFor(job) });
  return g;
}

/**
 * The card's one honest line for a registration that STANDS on a job with no blank id (a legacy
 * machine, or a job that never pressed "This is a new blank"): it was measured on a blank the
 * machine has no name for, so it stands only until the job gets one.
 */
export function registrationNoteNow(
  job: EngraveJob,
  setupIndex: number | null,
  setupId: string | null,
  target: { host: string; port: number } | null,
): string | null {
  if (target === null || setupIndex === null) return null;
  if (registrationGateNow(job, setupIndex, setupId, target) !== null) return null;
  if (currentBlankIdFor(job) !== null) return null;
  return 'Registered in this session on a blank the machine has no name for yet — it stands until this job is given one ("This is a new blank"), then it must be registered again.';
}
