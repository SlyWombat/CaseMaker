// #1286 — a UNIT-SPEC stand-in for "the operator registered this job on this machine".
//
// Nothing is uploaded or played for a setup that has no registration, so a spec that exercises the
// Start card, the release or the run store records one first. The e2e gate specs do NOT use this:
// they register with real presses on the fake console.
import { holdKeyOf, useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
import type { EngraveJob } from '@/types/engraveJob';
import type { RegistrationOutcome } from '@/engine/cnc/registration/outcome';
import { planRegistration } from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';

export function registerForTest(
  job: EngraveJob,
  target: { host: string; port: number } = { host: '192.0.2.10', port: 2222 },
  setupId: string | null = null,
): void {
  const outcome = {
    surfaceZ: -56.172,
    probeRefZ: -80,
    seekFromMachineZ: -3,
    currentG54: { x: -181.55, y: -184.8 },
    correctedG54: { x: -181.55, y: -184.8 },
    xyChecked: true,
    usable: true,
    problems: [],
    notes: [],
  } as unknown as RegistrationOutcome;
  const { settings } = registrationSettings(null);
  const planned = planRegistration(
    {
      stock: { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 },
      mount: 'vise',
      expectedSurface: { machineZ: outcome.surfaceZ, from: 'a test registration' },
      seekFromMachineZ: outcome.seekFromMachineZ,
      fixtureBelowSurfaceMm: 0.72,
      cutCentre: { x: 24, y: 43 },
    },
    settings,
  );
  if (!planned.ok) throw new Error(planned.reason);
  useEngraveRegistrationStore.getState().record(job.id, target, planned.plan, outcome, null, setupId, { blankId: null, holdKey: holdKeyOf(job) });
}
