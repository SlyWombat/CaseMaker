/**
 * #1073 follow-up (b) — THE VENDOR METHOD'S AVAILABILITY, MEASURED FROM THE PART'S OUTLINE.
 *
 * The vendor method (`free-then-flip`) poses the FREED part against the bracket's two arms, so it
 * needs a straight front edge long enough to read the turn on (6b's answer 2). A disc — or any
 * organic outline — has none: the method is shown UNAVAILABLE with the reason and the frame method
 * stays pre-selected. The measurement, so the choice is never a guess:
 *
 *   - the goal's mesh in work coordinates — the SAME mesh the flip plan samples (`goalWorkMesh`);
 *   - its footprint on the coverage field's grid (`sampleCoverageField`, the flip plan's own
 *     sampler), giving the part's extents and the FRONT profile: the lowest covered row per column;
 *   - the longest run of columns whose front stays within `FRONT_STRAIGHT_TOLERANCE_MM` of the
 *     run's first value. A straight wall reads as its whole length; a disc's tangent reads as a
 *     few millimetres.
 *
 * Availability is then the REGISTRATION PLANNER's own verdict on that run (`planFlipRegistration`
 * with the vendor method) — one rule, so the row and the plan cannot disagree — never a second
 * threshold kept in the UI. With no measurable outline the option is left standing: "unknown" is
 * not "unavailable", and the planner still refuses by name when it is asked to plan.
 */
import { planFlipRegistration } from '@/engine/cnc/registration/plan';
import type { RegistrationSettings } from '@/engine/cnc/registration/settings';
import type { EngraveTargetObject } from '@/types/engraveJob';

import { goalWorkMesh } from './goalFlipFindings';
import { sampleCoverageField } from './goalCoverage';

/** The outline's sampling pitch, mm — coarse on purpose: the run measure needs the wall, not detail. */
export const FRONT_SILHOUETTE_PITCH_MM = 0.5;

/** How close to the run's first value the front must stay, mm — a wall's rasterisation is exact;
 *  a curved edge drifts away of it at once. */
export const FRONT_STRAIGHT_TOLERANCE_MM = 0.05;

export interface PartSilhouette {
  /** The part's footprint in side-1 work XY, mm. */
  box: { minX: number; minY: number; maxX: number; maxY: number };
  /** The longest straight run on the front edge, mm. */
  frontStraightMm: number;
  /** The run's X extent — the planner's `frontStraight` input — or null when it has no length. */
  frontStraight: { minX: number; maxX: number } | null;
  /** The grid the measure came from, for the sentence. */
  resolutionNote: string;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The part's outline as the vendor method needs it, or null when the goal's mesh cannot be read. */
export function partSilhouetteOf(goal: EngraveTargetObject): PartSilhouette | null {
  const mesh = goalWorkMesh(goal);
  if (mesh === null) return null;
  let field: ReturnType<typeof sampleCoverageField>;
  try {
    field = sampleCoverageField(mesh, FRONT_SILHOUETTE_PITCH_MM);
  } catch {
    return null;
  }
  if (field.coveredCount === 0) return null;
  const { nx, ny, x0, y0, pitch, covered } = field;

  // The footprint's extents, from the covered cells.
  let minI = nx, maxI = -1, minJ = ny, maxJ = -1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (covered[j * nx + i] === 0) continue;
      if (i < minI) minI = i;
      if (i > maxI) maxI = i;
      if (j < minJ) minJ = j;
      if (j > maxJ) maxJ = j;
    }
  }
  if (maxI < minI || maxJ < minJ) return null;
  const box = {
    minX: r3(x0 + minI * pitch),
    maxX: r3(x0 + maxI * pitch),
    minY: r3(y0 + minJ * pitch),
    maxY: r3(y0 + maxJ * pitch),
  };

  // The front profile: the lowest covered row in each column (null where the column is empty).
  const front: (number | null)[] = new Array(nx).fill(null);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (covered[j * nx + i] === 1) {
        front[i] = y0 + j * pitch;
        break;
      }
    }
  }

  // The longest run within the tolerance of the run's FIRST value. Every column is tried as a
  // start, so a run that begins after a break is not lost.
  let lo = -1;
  let hi = -1;
  let i = 0;
  while (i < nx) {
    if (front[i] === null) {
      i += 1;
      continue;
    }
    const at = front[i]!;
    let end = i;
    while (end + 1 < nx && front[end + 1] !== null && Math.abs(front[end + 1]! - at) <= FRONT_STRAIGHT_TOLERANCE_MM) end += 1;
    if (end - i > hi - lo) {
      lo = i;
      hi = end;
    }
    i = end + 1;
  }

  if (lo < 0 || hi <= lo) {
    return { box, frontStraightMm: 0, frontStraight: null, resolutionNote: field.resolutionNote };
  }
  const frontStraightMm = r3((hi - lo) * pitch);
  return {
    box,
    frontStraightMm,
    frontStraight: { minX: r3(x0 + lo * pitch), maxX: r3(x0 + hi * pitch) },
    resolutionNote: field.resolutionNote,
  };
}

/** What the Setups row says about the vendor method, in one record. */
export interface VendorOffer {
  available: boolean;
  /** Why it is unavailable, in the planner's words; null when it is (or cannot be proven not). */
  reason: string | null;
}

/**
 * Is the vendor method available for this part? The REGISTRATION PLANNER answers, with the same
 * settings the Setups step plans under — so the row's "unavailable" and the plan's refusal are
 * one statement. Null (no measurable outline) keeps the option standing.
 */
export function vendorMethodOffer(silhouette: PartSilhouette | null, settings: RegistrationSettings): VendorOffer {
  if (silhouette === null) return { available: true, reason: null };
  const plan = planFlipRegistration({
    method: 'free-then-flip',
    stock: { xMin: silhouette.box.minX, yMin: silhouette.box.minY, xMax: silhouette.box.maxX, yMax: silhouette.box.maxY, cornerRadius: 0 },
    ...(silhouette.frontStraight === null ? {} : { frontStraight: silhouette.frontStraight }),
    settings,
  });
  return plan.ok ? { available: true, reason: null } : { available: false, reason: plan.reason };
}
