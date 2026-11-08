/**
 * #1070, 6b's ruling — THE FIRST-RUN SEAT PRESS, as data.
 *
 * A seat plan (`planRegistration`'s predecessor here: the Cut step's attempt with no seat datum)
 * carries ONE mount tap and no scans: the reading it writes IS the bracket seat. The press runs it
 * through the STANDALONE mount tap (`runMountTap`), not the registration executor — and it hands
 * the tap the plan's own seek bound (`seek.travelMm`), so a probe that never triggers stops at the
 * band's floor less the scan reach, never at the machine's work-envelope floor.
 */

import type { PlanMountTap, RegistrationPlan } from './plan';

/** True for the one-touch seat plan: a bracket-seat mount tap and no scans. */
export function isSeatPlan(plan: RegistrationPlan): boolean {
  return plan.mountTap !== null && plan.mountTap.reference === 'bracket-seat' && plan.scans.length === 0;
}

/** The standalone tap's arguments for a seat plan, or null when this plan is not one. */
export function seatTapArgs(
  plan: RegistrationPlan,
): ({ x: number; y: number; fromMachineZ: number } & Pick<PlanMountTap, 'reference' | 'datumOffsetMm'> & { planTravelMm: number | null }) | null {
  const tap = plan.mountTap;
  if (tap === null || !isSeatPlan(plan)) return null;
  return {
    x: tap.x,
    y: tap.y,
    fromMachineZ: tap.fromMachineZ,
    reference: 'bracket-seat',
    // The reading IS the seat (the touch is on the wasteboard, not the arm).
    datumOffsetMm: tap.datumOffsetMm ?? 0,
    planTravelMm: Number.isFinite(plan.seek.travelMm) && plan.seek.travelMm > 0 ? plan.seek.travelMm : null,
  };
}
