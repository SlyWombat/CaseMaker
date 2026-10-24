/**
 * The mount context both the Setups row and the machine card's Bed block read: the probe checked out
 * to a machine, its measured jaw-top datum, and the machine-XY point a "tap the fixed jaw" touches.
 *
 * Shared (#603) so the machine card offers the same tap the Setups row got in #599, computed from
 * one set of rules rather than two copies that can drift.
 */

import type { MachineRecord } from '@/platform/locationClient';
import type { MountDatum, ProbeSpec } from '@/engine/cnc/registration/plan';
import { accessoriesFor } from '@/store/locationStore';
import { newestViseRegistration, viseFrameFromRegistration, type RegistrationSource } from '@/platform/bedProfiles';
import { Z1_VISE } from '@/engine/cnc/fixture';
import { viseTapPoint } from '@/engine/cnc/mounts/vise';

/** A finite number out of an accessory's open `unit` map, or null. */
export function mountNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** #598 — the probe checked out to `machine`, or null when there is none or its tip values are missing. */
export function probeFor(machine: MachineRecord | null): ProbeSpec | null {
  if (machine === null) return null;
  const acc = accessoriesFor(machine).find((a) => a.kind === 'probe');
  if (acc === undefined) return null;
  const diameterMm = mountNum(acc.unit.tipDiameterMm);
  const rimOffsetMm = mountNum(acc.unit.rimOffsetMm);
  const rimOffsetUncertaintyMm = mountNum(acc.unit.rimOffsetUncertaintyMm);
  if (diameterMm === null || rimOffsetMm === null || rimOffsetUncertaintyMm === null) return null;
  return { id: acc.id, variant: acc.variant ?? null, tip: { diameterMm, rimOffsetMm, rimOffsetUncertaintyMm } };
}

/** #603 — the checked-out probe's display name (its product), or null when none is checked out. */
export function probeNameFor(machine: MachineRecord | null): string | null {
  if (machine === null) return null;
  const acc = accessoriesFor(machine).find((a) => a.kind === 'probe');
  return acc === undefined ? null : (acc.product ?? 'probe');
}

/** #604 — the mount accessory's name for the job's holding kind, or the kind word when none is checked out. */
export function mountNameFor(machine: MachineRecord | null, kind: string): string {
  if (machine === null) return kind;
  return accessoriesFor(machine).find((a) => a.kind === kind)?.product ?? kind;
}

/** #598 — the active bed profile's measured jaw-top datum, or null when it has none. */
export function mountDatumFor(machine: MachineRecord | null): MountDatum | null {
  if (machine === null || machine.bedProfiles === undefined || machine.activeBedProfileId === undefined) return null;
  const profile = machine.bedProfiles.find((p) => p.id === machine.activeBedProfileId);
  const datum = profile?.datums.viseJawTopZ ?? null;
  if (datum === null) return null;
  return { jawTopZ: datum.value, measuredAt: datum.measuredAt, by: datum.by };
}

/** #599 — the mount tap point (machine XY) for the vise, from the bed placement or the newest registration. */
export function mountTapFor(
  machine: MachineRecord | null,
  registrations: RegistrationSource[],
  seekFromMachineZ: number,
  jawStartY: number,
): { x: number; y: number; fromMachineZ: number; label: string } | null {
  if (machine === null) return null;
  const profile = machine.bedProfiles?.find((p) => p.id === machine.activeBedProfileId);
  const placement = profile?.placements.find((p) => p.where.kind === 'pins' && p.where.pins === 'vise');
  const viseAcc = accessoriesFor(machine).find((a) => a.kind === 'vise');
  const jawBarWidth = mountNum(viseAcc?.constants.jawBarWidth) ?? Z1_VISE.fixedJawThickness;
  const jawLength = mountNum(viseAcc?.constants.jawLength) ?? Z1_VISE.jawLength;

  // The frame source order: the measured placement frame, else the newest usable registration, else none.
  const f = placement?.frame ?? null;
  let frame: { fixedJawFaceX: number; jawStartY: number } | null = null;
  if (f !== null && f.fixedJawFaceX !== null && f.jawStartY !== null) {
    frame = { fixedJawFaceX: f.fixedJawFaceX, jawStartY: f.jawStartY };
  } else {
    const reg = newestViseRegistration(registrations, machine.address);
    frame = reg === null ? null : viseFrameFromRegistration(reg, jawStartY);
  }
  if (frame === null) return null;
  const point = viseTapPoint(frame, { jawBarWidth, jawLength });
  return { x: point.x, y: point.y, fromMachineZ: seekFromMachineZ, label: 'the vise fixed-jaw top' };
}
