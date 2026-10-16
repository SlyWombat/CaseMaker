/**
 * Registration after a remount (#428 → #430): the #430 planner's input for a setup's up face, and the
 * features cut in earlier setups that pass through to it — candidate references (#429).
 *
 * The EXPECTED SURFACE is the caller's to state (#430: never G54 Z): this takes the machine Z of what
 * the stock SITS on — the vise's ledge, the board's top — and adds the stock's height this way up.
 */

import { LEDGE_STEP } from '../fixture';
import { planRegistration, type PlanResult, type RegistrationSettings } from '../registration';
import { machineSize, toMachine, type Vec } from './orient';
import type { MountSpec, Setup } from './types';

export interface ReferenceFeature {
  itemId: string;
  name: string;
  /** Its centre in the new setup's work XY (origin at the stock's front-left corner as mounted). */
  at: { x: number; y: number };
}

/** Earlier cuts that open to BOTH an earlier face and this up face — through features visible now. */
export function referenceFeatures(setup: Setup): ReferenceFeature[] {
  const b = setup.stockBefore.bounds;
  return setup.stockBefore.cuts
    .filter((c) => c.opensTo.includes(setup.faceUp) && c.opensTo.length > 1)
    .map((c) => {
      const centre: Vec = [0, 1, 2].map((i) => (c.box.min[i]! + c.box.max[i]!) / 2) as Vec;
      const p = toMachine(setup.rotation, b, centre);
      return { itemId: c.id, name: c.name, at: { x: Math.round(p[0] * 1000) / 1000, y: Math.round(p[1] * 1000) / 1000 } };
    });
}

export function registrationFor(
  setup: Setup,
  mount: MountSpec,
  input: { seatMachineZ: number; cornerRadius: number; bracketOrigin?: { x: number; y: number; from: string } },
  settings: RegistrationSettings,
): { plan: PlanResult; references: ReferenceFeature[] } {
  const dims = machineSize(setup.rotation, setup.stockBefore.bounds);
  const plan = planRegistration(
    {
      stock: { xMin: 0, yMin: 0, xMax: dims.x, yMax: dims.y, cornerRadius: input.cornerRadius },
      mount: mount.kind,
      expectedSurface: { machineZ: input.seatMachineZ + dims.z, from: `the seat at machine Z ${input.seatMachineZ} + the stock's ${dims.z} mm this way up (setup ${setup.index})` },
      fixtureBelowSurfaceMm: mount.kind === 'vise' ? dims.z - LEDGE_STEP : undefined,
      bracketOrigin: input.bracketOrigin,
    },
    settings,
  );
  return { plan, references: referenceFeatures(setup) };
}
