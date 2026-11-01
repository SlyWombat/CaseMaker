/**
 * #884 — WHICH OUTPUT ROWS THE MACHINE CARD SHOWS, from the MACHINE PROFILE.
 *
 * Bench, 2026-11-01: on the Z1 the **external output** (M851/M852) is wired to the **vacuum** —
 * the maintainer watched it switch the vacuum off and on twice — so listing "Vacuum" and "External
 * output" as two rows describes one plug twice. And the Z1's 3D probe is wired and powered through
 * M831, so the **wireless-probe charger** (M841/M842) has nothing on the end of it: a row with
 * On/Off for it is noise on every Z1.
 *
 * The facts are the PROFILE's, not the app's: a Carvera keeps its own wiring, so its card keeps
 * the separate rows. A new machine's row goes in this table (the same adaptability rule as
 * `profileForDiscoveredName`).
 */

export interface MachineOutputPlan {
  /** The external output drives the vacuum: ONE row, named for both, no separate external row. */
  externalOutputIsVacuum: boolean;
  /** Show the wireless-probe charger row (the Z1 has no device on that output). */
  showProbeCharger: boolean;
}

/** The Z1's wiring, observed on the bench 2026-11-01. */
const Z1_PLAN: MachineOutputPlan = { externalOutputIsVacuum: true, showProbeCharger: false };

/** Every other machine: the firmware's four switches as separate, truthful rows. */
const DEFAULT_PLAN: MachineOutputPlan = { externalOutputIsVacuum: false, showProbeCharger: true };

export function outputPlanFor(profileId: string | null): MachineOutputPlan {
  return profileId === 'Z1' ? Z1_PLAN : DEFAULT_PLAN;
}
