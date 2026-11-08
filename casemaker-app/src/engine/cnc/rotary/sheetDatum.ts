/**
 * #1059 — THE ROTARY DATUMS A RUN SHEET PRINTS, read off the bed profile the job was planned on.
 *
 * A rotary job's origin is the AXIS and its A zero is the stock's own levelled face, not a probed
 * corner: the sheet's mount/origin sections have to state both, with the numbers when they were
 * measured and a plain "not measured" when they were not. The sheet itself is pure data built in
 * realms with no stores (the sim worker, the bench CLI), so its callers resolve the datums here and
 * pass them in `RunSheetOptions.rotaryDatum`.
 *
 * The bound profile wins (`job.bed.profileId`), else the machine's active profile; the job's own
 * machine is tried first so a two-machine location cannot hand this job the other mill's datum.
 * Only a SQUARE section carries a face angle — a round rod has no face to level.
 */

import { rotaryMapOf } from './wrap';
import type { EngraveJob } from '@/types/engraveJob';

/** The axis line, in machine terms: Z in `value`, the line's Y in `at[1]`, and the body radius. */
export interface RotarySheetAxis {
  y: number;
  z: number;
  radiusMm: number | null;
  measuredAt: string;
}

/** The levelled A zero of the stock's own face, degrees, with the step's residual when it had one. */
export interface RotarySheetFaceAngle {
  degrees: number;
  residualMm: number | null;
  measuredAt: string;
}

export interface RotarySheetDatum {
  axis: RotarySheetAxis | null;
  faceAngle: RotarySheetFaceAngle | null;
}

/** The datum shape the client's `MeasuredDatumSchema`/`MeasuredAngleDatumSchema` both parse to. */
type DatumLike =
  | {
      value: number;
      measuredAt: string;
      at: [number, number] | null;
      radiusMm?: number | null;
      residualMm?: number;
    }
  | null
  | undefined;

/** The slice of a loaded location this resolver reads — typed structurally so the CLI and app share it. */
export interface RotarySheetLocationLike {
  machines: readonly {
    profileId?: string | null;
    activeBedProfileId?: string;
    bedProfiles?: readonly {
      id: string;
      datums: { rotaryAxis?: DatumLike; rotaryFaceAngle?: DatumLike };
    }[];
  }[];
}

/** The nothing case: no square stock, no location, or nothing measured on the profile it names. */
const NONE: RotarySheetDatum = { axis: null, faceAngle: null };

export function rotarySheetDatumFor(job: EngraveJob, location: RotarySheetLocationLike | null | undefined): RotarySheetDatum {
  const section = rotaryMapOf(job)?.section;
  if (section === undefined || section.kind !== 'rect') return NONE;
  const bound = job.bed?.profileId;
  // The job's own machine first; the rest keep their order as the fallback.
  const machines = [...(location?.machines ?? [])].sort((a, b) => {
    const own = (m: (typeof machines)[number]): number => (m.profileId === job.machineId ? 0 : 1);
    return own(a) - own(b);
  });
  for (const machine of machines) {
    const profile =
      bound === undefined ? machine.bedProfiles?.find((p) => p.id === machine.activeBedProfileId) : machine.bedProfiles?.find((p) => p.id === bound);
    if (profile === undefined) continue;
    const axis = profile.datums.rotaryAxis ?? null;
    const face = profile.datums.rotaryFaceAngle ?? null;
    if (axis === null && face === null) continue;
    return {
      // The axis line's Y is `at[1]`; a datum without a point states no line this sheet can print.
      axis: axis === null || axis.at === null ? null : { y: axis.at[1], z: axis.value, radiusMm: axis.radiusMm ?? null, measuredAt: axis.measuredAt },
      faceAngle: face === null ? null : { degrees: face.value, residualMm: face.residualMm ?? null, measuredAt: face.measuredAt },
    };
  }
  return NONE;
}
