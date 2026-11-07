/**
 * #1070 — A FOOTPRINT PLAN, IN THE CUT STEP'S OWN PLAN SHAPE.
 *
 * The Cut step, the Design → Setups row and the sheet already read one `RegistrationPlan`
 * (`registration/plan.ts`): its summary, its touches and its expected-accuracy words are written
 * from that shape. The footprint planner (`footprint.ts`) plans Z-only scans of the cut region on
 * a bed-held mount; this maps its plan into `RegistrationPlan` so those readers need no second
 * vocabulary — the corner is the #525 corner path (`front-left`, the two touched edges), the
 * scans are the same `EdgeScan`s, and the origin is the seed placed by the touches.
 *
 * Pure: no store, no machine.
 */

import type { EdgeScan, PlanObstacle, ProbeSpec, RegistrationPlan } from '@/engine/cnc/registration/plan';
import type { RegistrationSettings } from '@/engine/cnc/registration/settings';
import type { FootprintInput, FootprintPlan } from '@/engine/cnc/registration/footprint';
import type { Mount } from '@/engine/cnc/setups/types';

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

export function footprintToRegistrationPlan(args: {
  input: FootprintInput;
  plan: FootprintPlan;
  mount: Mount;
  settings: RegistrationSettings;
  probe: ProbeSpec | null;
  obstacles: readonly PlanObstacle[];
  /** #509 — the bracket's offset from the anchor was measured, not seeded. */
  offsetMeasured: boolean;
}): RegistrationPlan {
  const { input, plan, mount, settings } = args;
  const tol = input.settings.surfaceToleranceMm;
  const scans: EdgeScan[] = plan.scans.map((s) => ({
    edge: s.edge,
    along: s.along,
    expectedAt: s.expectedAt,
    outward: s.edge === 'right' || s.edge === 'back' ? 1 : -1,
    start: s.start,
    limit: s.limit,
    coarseStep: settings.coarseStepMm,
    fineStep: settings.fineStepMm,
  }));
  const first = plan.corners[0]!;
  return {
    mount,
    stock: {
      xMin: 0,
      yMin: 0,
      xMax: input.stock.length,
      yMax: input.stock.width,
      cornerRadius: input.stock.cornerRadius ?? 0,
    },
    // #525 — the origin is the corner the two touched edge lines intersect at.
    corner: { id: 'front-left', xEdge: 'left', yEdge: 'front' },
    stockThicknessMm: input.stock.thickness,
    surfacePoint: { x: first.x, y: first.y },
    seek: {
      fromMachineZ: input.seekFromMachineZ,
      travelMm: r3(input.seekFromMachineZ - (input.expectedSurface.machineZ - tol)),
      band: { min: r3(input.expectedSurface.machineZ - tol), max: r3(input.expectedSurface.machineZ + tol) },
    },
    mountDatum: null,
    probe: args.probe,
    mountTap: null,
    scans,
    // The anchor seed PLACES the machine coordinates; the touches derive the origin. A tape job
    // has no bracket datum to name, so its plan leaves the word to the scans (bracketOrigin null).
    bracketOrigin:
      mount === 'bracket'
        ? { x: plan.origin.x, y: plan.origin.y, from: plan.origin.from, offsetMeasured: args.offsetMeasured }
        : null,
    mountObstacles: [...args.obstacles],
    settings,
    notes: [...plan.notes, plan.origin.derivedFrom],
  };
}
